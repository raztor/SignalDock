import type { FastifyInstance } from 'fastify';
import type { ApiError } from '@signaldock/contracts';

export function configureHttp(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.setNotFoundHandler((request, reply) => {
    const error: ApiError = {
      code: 'NOT_FOUND',
      message: 'This endpoint is not available.',
      correlationId: request.id,
      retryable: false,
    };
    return reply.code(404).send(error);
  });
  app.setErrorHandler((error, request, reply) => {
    const suppliedStatus =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const status =
      typeof suppliedStatus === 'number' &&
      suppliedStatus >= 400 &&
      suppliedStatus < 500
        ? suppliedStatus
        : 500;
    const body: ApiError = {
      code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_ARGUMENT',
      message:
        status === 500
          ? 'An internal error occurred.'
          : 'The request is invalid.',
      correlationId: request.id,
      retryable: status === 500,
    };
    return reply.code(status).send(body);
  });
}
