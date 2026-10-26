import type { FastifyInstance } from 'fastify';
import {
  IdSchema,
  MediaSessionSchema,
  RevisionSchema,
  SignalDockError,
  TxGrantSchema,
  type AuthenticationPort,
} from '@signaldock/contracts';
import type { MediaService } from '@signaldock/media-gateway';
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
  dependencies: { auth: AuthenticationPort; media: MediaService },
): void {
  const { auth, media } = dependencies;
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
