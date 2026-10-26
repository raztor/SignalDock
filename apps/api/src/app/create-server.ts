import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import type { InstanceIdentity } from '../modules/instance/identity-store.js';
import { registerInstanceRoutes } from '../modules/instance/instance.routes.js';
import { registerHealthRoutes } from '../modules/health/health.routes.js';
import { configureHttp } from '../shared/http/configure-http.js';
import { normalizeBasePath } from './base-path.js';

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
  configureHttp(app);
  registerInstanceRoutes(app, prefix, {
    identity: options.identity,
    displayName: options.displayName ?? 'SignalDock station',
  });
  registerHealthRoutes(app, prefix);
  return app;
}
