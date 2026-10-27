import Fastify from 'fastify';
import { z } from 'zod';
import { RelayError, SignatureSchema } from '@signaldock/notification-sdk';
import type { RelayService } from './service.js';

const signed = z.strictObject({
  payload: z.unknown(),
  signature: SignatureSchema,
});

export function buildRelayServer(service: RelayService) {
  const app = Fastify({
    bodyLimit: 16384,
    requestTimeout: 15000,
    logger: false,
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RelayError) {
      const status = {
        INVALID_REQUEST: 400,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        EXPIRED: 410,
        REPLAY: 409,
        RATE_LIMITED: 429,
        UNAVAILABLE: 503,
      }[error.code];
      return reply
        .code(status)
        .send({ code: error.code, message: error.message });
    }
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: 'The relay request does not match the supported protocol.',
      });
    return reply.code(500).send({
      code: 'UNAVAILABLE',
      message: 'The relay could not complete this request.',
    });
  });
  app.get('/health', async () => ({
    status: 'ok',
    mode: 'private-test',
    publicEnrollment: false,
  }));
  app.post('/v1/enrollment/challenges', async (request) => {
    const authorization = request.headers.authorization;
    const secret = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    return service.requestChallenge(request.body, secret);
  });
  app.post('/v1/enrollment/acknowledge', async (request) =>
    service.acknowledgeChallenge(signed.parse(request.body)),
  );
  app.post('/v1/grants', async (request) =>
    service.authorizeGrant(signed.parse(request.body)),
  );
  app.post('/v1/grants/inspect', async (request) =>
    service.inspectGrant(signed.parse(request.body)),
  );
  app.post('/v1/grants/revoke', async (request, reply) => {
    await service.revokeFromInstance(signed.parse(request.body));
    return reply.code(204).send();
  });
  app.post('/v1/deliveries', async (request) =>
    service.send(signed.parse(request.body)),
  );
  app.post('/v1/revocations', async (request, reply) => {
    await service.revoke(signed.parse(request.body));
    return reply.code(204).send();
  });
  return app;
}
