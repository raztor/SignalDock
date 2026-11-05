import type { FastifyInstance } from 'fastify';
import {
  IdSchema,
  MediaSessionSchema,
  RevisionSchema,
  SignalDockError,
  TxGrantSchema,
  type AuthenticationPort,
  PCM_WEBSOCKET_PROTOCOL,
} from '@signaldock/contracts';
import type { MediaService, MediaSocket } from '@signaldock/media-gateway';
import { requirePrincipal } from '../../shared/http/auth.js';

const sessionInput = MediaSessionSchema.pick({
  radioId: true,
  mode: true,
}).extend({ txGrantId: IdSchema.optional() });
const startInput = TxGrantSchema.pick({
  generation: true,
  controlGrant: true,
}).extend({ expectedRevision: RevisionSchema });
function identifier(value: unknown): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'A UUID resource identifier is required.',
    );
  return parsed.data;
}

export function registerMediaRoutes(
  app: FastifyInstance,
  prefix: string,
  dependencies: {
    auth: AuthenticationPort;
    media: MediaService;
    allowedOrigins?: readonly string[];
  },
): void {
  const { auth, media } = dependencies;
  if (media.socketEnabled)
    app.get<{ Params: { id: string } }>(
      `${prefix}/media/socket/:id`,
      {
        websocket: true,
        preValidation: async (request) => {
          if (
            !request.headers.origin ||
            !dependencies.allowedOrigins?.includes(request.headers.origin)
          )
            throw new SignalDockError(
              'FORBIDDEN',
              'Audio sockets require an allowed web origin.',
            );
          identifier(request.params.id);
          const protocols =
            request.headers['sec-websocket-protocol']
              ?.split(',')
              .map((value) => value.trim()) ?? [];
          if (
            protocols.length !== 2 ||
            !protocols.includes(PCM_WEBSOCKET_PROTOCOL) ||
            !protocols.some((value) =>
              /^ticket\.[A-Za-z0-9_-]{43}$/.test(value),
            )
          )
            throw new SignalDockError(
              'UNAUTHORIZED',
              'An audio enrollment ticket is required.',
            );
        },
      },
      (socket, request) => {
        const port: MediaSocket = {
          get readyState() {
            return socket.readyState;
          },
          get bufferedAmount() {
            return socket.bufferedAmount;
          },
          ping: () => socket.ping(),
          onPong: (listener) => {
            socket.on('pong', listener);
          },
          send: (data) => socket.send(data),
          close: (code, reason) => {
            socket.close(code, reason);
          },
          onClose: (listener) => {
            socket.once('close', listener);
          },
          onError: (listener) => {
            socket.once('error', listener);
          },
          onMessage: (listener) => {
            const handler = (
              data: Buffer | ArrayBuffer | Buffer[],
              binary: boolean,
            ) => {
              const bytes = Array.isArray(data)
                ? Buffer.concat(data)
                : data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : data;
              listener(bytes, binary);
            };
            socket.on('message', handler);
            return () => socket.off('message', handler);
          },
        };
        const ticket = request.headers['sec-websocket-protocol']!.split(',')
          .map((value) => value.trim())
          .find((value) => value.startsWith('ticket.'))!
          .slice(7);
        let admitted = false;
        const removeGuard = port.onMessage(() => {
          if (!admitted) port.close(1008, 'Audio enrollment pending');
        });
        port.onError(() => undefined);
        void media
          .openWebSocket(request.params.id, ticket, port)
          .then(() => {
            admitted = true;
            removeGuard();
          })
          .catch(() => {
            removeGuard();
            port.close(1008, 'Audio enrollment rejected');
          });
      },
    );
  app.post(`${prefix}/media/sessions`, async (request, reply) => {
    const principal = await requirePrincipal(request, auth);
    const parsed = sessionInput.safeParse(request.body);
    if (!parsed.success)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'A radio ID, mode and optional TX grant are required.',
      );
    return reply
      .code(201)
      .send(
        await media.createSession(
          principal,
          request.headers.authorization!.slice(7),
          parsed.data,
        ),
      );
  });
  app.post<{ Params: { id: string } }>(
    `${prefix}/media/sessions/:id/renew`,
    async (request) => {
      const principal = await requirePrincipal(request, auth);
      return media.renewSession(
        identifier(request.params.id),
        principal,
        request.headers.authorization!.slice(7),
      );
    },
  );
  app.delete<{ Params: { id: string } }>(
    `${prefix}/media/sessions/:id`,
    async (request, reply) => {
      const principal = await requirePrincipal(request, auth);
      await media.removeSession(identifier(request.params.id), principal);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/tx-sessions`,
    async (request, reply) => {
      const radioId = identifier(request.params.radioId);
      const principal = await requirePrincipal(
        request,
        auth,
        'radio.transmit',
        radioId,
      );
      const parsed = startInput.safeParse(request.body);
      if (!parsed.success)
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'A current control grant, generation, and tuning revision are required.',
        );
      return reply
        .code(201)
        .send(await media.startTx(principal, { radioId, ...parsed.data }));
    },
  );
  app.get<{ Params: { radioId: string; id: string } }>(
    `${prefix}/radios/:radioId/tx-sessions/:id`,
    async (request) => {
      const radioId = identifier(request.params.radioId);
      const principal = await requirePrincipal(
        request,
        auth,
        'radio.transmit',
        radioId,
      );
      const status = media.txStatus(identifier(request.params.id), principal);
      if (status.grant.radioId !== radioId)
        throw new SignalDockError(
          'NOT_FOUND',
          'The TX session does not belong to this radio.',
        );
      return status;
    },
  );
  app.post<{ Params: { radioId: string; id: string } }>(
    `${prefix}/radios/:radioId/tx-sessions/:id/renew`,
    async (request) => {
      const radioId = identifier(request.params.radioId);
      const principal = await requirePrincipal(
        request,
        auth,
        'radio.transmit',
        radioId,
      );
      const id = identifier(request.params.id);
      if (media.txStatus(id, principal).grant.radioId !== radioId)
        throw new SignalDockError(
          'NOT_FOUND',
          'The TX session does not belong to this radio.',
        );
      return media.renewTx(id, principal);
    },
  );
  app.delete<{ Params: { radioId: string; id: string } }>(
    `${prefix}/radios/:radioId/tx-sessions/:id`,
    async (request) => {
      // Releasing an owned transmission remains allowed after transmit permission is removed.
      const principal = await requirePrincipal(request, auth);
      const radioId = identifier(request.params.radioId);
      const id = identifier(request.params.id);
      if (media.txStatus(id, principal).grant.radioId !== radioId)
        throw new SignalDockError(
          'NOT_FOUND',
          'The TX session does not belong to this radio.',
        );
      return media.stopTx(id, principal);
    },
  );
}
