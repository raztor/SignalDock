import type { FastifyInstance } from 'fastify';
import {
  APPLICATION_VERSION,
  ServerInfoSchema,
  toJsonSchema,
} from '@signaldock/contracts';
import type { InstanceIdentity } from './identity-store.js';

export function registerInstanceRoutes(
  app: FastifyInstance,
  prefix: string,
  options: {
    identity: InstanceIdentity;
    displayName: string;
  },
): void {
  const info = ServerInfoSchema.parse({
    product: 'SignalDock',
    ...options.identity,
    displayName: options.displayName,
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
}
