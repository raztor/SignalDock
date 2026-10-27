import type { FastifyInstance } from 'fastify';
import {
  APPLICATION_VERSION,
  HealthSchema,
  toJsonSchema,
} from '@signaldock/contracts';

export function registerHealthRoutes(
  app: FastifyInstance,
  prefix: string,
): void {
  app.get(
    `${prefix}/health`,
    { schema: { response: { 200: toJsonSchema(HealthSchema) } } },
    async () => ({ status: 'ok', version: APPLICATION_VERSION }),
  );
}
