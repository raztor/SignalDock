import type { FastifyInstance } from 'fastify';
import { SignalDockError, type ApiError } from '@signaldock/contracts';
import { ZodError } from 'zod';

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
    if (error instanceof SignalDockError) {
      const statusByCode: Record<string, number> = {
        INVALID_ARGUMENT: 400,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        API_INCOMPATIBLE: 426,
        INSTANCE_IDENTITY_CHANGED: 409,
        CAPABILITY_UNSUPPORTED: 422,
        CONTROL_BUSY: 409,
        CONTROL_REQUIRED: 409,
        STALE_REVISION: 409,
        STALE_GENERATION: 409,
        OPERATION_CONFLICT: 409,
        DEADLINE_EXCEEDED: 408,
        RADIO_UNAVAILABLE: 503,
        RADIO_STATE_UNCERTAIN: 409,
        TX_LIMIT_REACHED: 429,
        PROVIDER_UNAVAILABLE: 503,
        REQUIRES_CONFIGURATION: 503,
        INTERNAL_ERROR: 500,
      };
      const status = statusByCode[error.code] ?? 500;
      return reply
        .code(status)
        .send({
          code: error.code,
          message:
            status === 500 ? 'An internal error occurred.' : error.message,
          correlationId: request.id,
          retryable: status === 503 && error.code !== 'REQUIRES_CONFIGURATION',
        } satisfies ApiError);
    }
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({
          code: 'INVALID_ARGUMENT',
          message: 'The request does not match the endpoint schema.',
          correlationId: request.id,
          retryable: false,
        } satisfies ApiError);
    }
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
