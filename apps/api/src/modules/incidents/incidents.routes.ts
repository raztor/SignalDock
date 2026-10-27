import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  IdSchema,
  SignalDockError,
  type AuthenticationPort,
} from '@signaldock/contracts';
import { EmergencyRuleSchema } from '@signaldock/processing-tasks';
import { authorizeRequest } from '../../shared/http/auth.js';
import type { IncidentService } from './service.js';
export { incidentMigrations } from './migrations.js';
export { IncidentService } from './service.js';
export { SqlIncidentRepository } from './repository.js';

const state = z.enum([
  'new',
  'acknowledged',
  'in_progress',
  'resolved',
  'dismissed',
]);
const updateSchema = z
  .strictObject({
    expectedRevision: z.number().int().positive(),
    state: state.optional(),
    ownerUserId: IdSchema.nullable().optional(),
    retentionHold: z.boolean().optional(),
    note: z.string().max(2000).optional(),
  })
  .refine(
    (value) =>
      value.state !== undefined ||
      value.ownerUserId !== undefined ||
      value.retentionHold !== undefined ||
      !!value.note?.trim(),
    'Supply an incident update.',
  );
const listSchema = z.strictObject({
  radioId: IdSchema.optional(),
  state: state.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const cursorSchema = z.strictObject({
  updatedAt: z.iso.datetime(),
  id: IdSchema,
});

export function registerIncidentRoutes(
  app: FastifyInstance,
  options: {
    prefix: string;
    auth: AuthenticationPort;
    service: IncidentService;
  },
): void {
  const { prefix, auth, service } = options;
  app.get(`${prefix}/incidents/rules`, async (request) => ({
    items: await service.rules(await authorizeRequest(request, auth)),
  }));
  app.post(`${prefix}/incidents/rules`, async (request, reply) => {
    const principal = await authorizeRequest(request, auth);
    const body =
      typeof request.body === 'object' &&
      request.body !== null &&
      !Array.isArray(request.body)
        ? request.body
        : {};
    const rule = EmergencyRuleSchema.parse({
      ...body,
      ...('id' in body ? {} : { id: randomUUID() }),
    });
    return reply.code(201).send(await service.saveRule(principal, rule));
  });
  app.delete<{ Params: { id: string } }>(
    `${prefix}/incidents/rules/:id`,
    async (request, reply) => {
      await service.removeRule(
        await authorizeRequest(request, auth),
        request.params.id,
      );
      return reply.code(204).send();
    },
  );
  app.get(`${prefix}/incidents`, async (request) => {
    const principal = await authorizeRequest(request, auth);
    const query = listSchema.parse(request.query);
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Incident cursor is invalid.',
        );
      }
    }
    return service.list(principal, {
      limit: query.limit,
      ...(query.radioId ? { radioId: query.radioId } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(cursor ? { cursor } : {}),
    });
  });
  app.get<{ Params: { id: string } }>(
    `${prefix}/incidents/:id`,
    async (request) =>
      service.detail(await authorizeRequest(request, auth), request.params.id),
  );
  app.patch<{ Params: { id: string } }>(
    `${prefix}/incidents/:id`,
    async (request) => {
      const principal = await authorizeRequest(request, auth);
      return service.update(
        principal,
        request.params.id,
        updateSchema.parse(request.body),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    `${prefix}/communications/:id/analysis`,
    async (request) => ({
      items: await service.sourceAnalyses(
        await authorizeRequest(request, auth),
        request.params.id,
      ),
    }),
  );
}
