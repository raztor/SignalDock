import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import type { InstanceIdentity } from '../modules/instance/identity-store.js';
import { registerInstanceRoutes } from '../modules/instance/instance.routes.js';
import { registerHealthRoutes } from '../modules/health/health.routes.js';
import { configureHttp } from '../shared/http/configure-http.js';
import { normalizeBasePath } from './base-path.js';
import type { FastifyInstance } from 'fastify';
import type { ServerInfo } from '@signaldock/contracts';

export async function buildServer(options: {
  identity: InstanceIdentity;
  displayName?: string;
  basePath?: string;
  allowedOrigins?: string[];
  logger?: boolean;
  features?: ServerInfo['features'];
  register?: (app: FastifyInstance, prefix: string) => Promise<void>;
  cookieOrigin?: string;
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
    credentials: Boolean(options.cookieOrigin),
  });
  configureHttp(app);
  registerInstanceRoutes(app, prefix, {
    identity: options.identity,
    displayName: options.displayName ?? 'SignalDock station',
    ...(options.features ? { features: options.features } : {}),
  });
  registerHealthRoutes(app, prefix);
  await options.register?.(app, prefix);
  return app;
}
