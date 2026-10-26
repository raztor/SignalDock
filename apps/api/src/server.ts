import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import {
  APPLICATION_VERSION,
  ServerInfoSchema,
  HealthSchema,
  toJsonSchema,
  type ApiError,
} from '@signaldock/contracts';
import type { InstanceIdentity } from './identity.js';

export function normalizeBasePath(input: string): string {
  if (!input || input === '/') return '';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)+$/.test(input))
    throw new Error('Base path must contain simple slash-separated segments.');
  return input.replace(/\/+$/, '');
}

export async function buildServer(options: {
  identity: InstanceIdentity;
  displayName?: string;
  basePath?: string;
  allowedOrigins?: string[];
  logger?: boolean;
}) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 65536,
    genReqId: () => randomUUID(),
    requestTimeout: 10000,
  });
  const prefix = `${normalizeBasePath(options.basePath ?? '')}/api/v1`;
  await app.register(cors, {
    origin: options.allowedOrigins ?? [],
    credentials: false,
  });
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
  const info = ServerInfoSchema.parse({
    product: 'SignalDock',
    ...options.identity,
    displayName: options.displayName ?? 'SignalDock station',
    version: APPLICATION_VERSION,
    protocol: { min: 1, max: 1 },
    routes: { api: 'api/v1', events: 'api/v1/events', media: 'api/v1/media' },
    features: {
      multiRadio: false,
      authentication: 'unavailable',
      radioControl: false,
      liveAudio: false,
      pushRelay: 'unavailable',
    },
  });
  app.get(
    `${prefix}/server-info`,
    { schema: { response: { 200: toJsonSchema(ServerInfoSchema) } } },
    async () => info,
  );
  app.get(
    `${prefix}/health`,
    { schema: { response: { 200: toJsonSchema(HealthSchema) } } },
    async () => ({ status: 'ok', version: APPLICATION_VERSION }),
  );
  return app;
}
