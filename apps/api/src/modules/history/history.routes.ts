import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  IdSchema,
  SignalDockError,
  type AuthenticationPort,
  type HistoryQuery,
  type Permission,
  type Principal,
} from '@signaldock/contracts';
import { HistoryService } from '@signaldock/history';
import { requirePrincipal } from '../../shared/http/auth.js';

const parameters = z.strictObject({ id: IdSchema });
const querySchema = z.strictObject({
  radioId: IdSchema.optional(),
  frequencyHz: z.coerce.number().int().positive().safe().optional(),
  search: z.string().max(2000).optional(),
  direction: z.enum(['rx', 'tx', 'internal']).optional(),
  beforeStartedAt: z.iso.datetime().optional(),
  beforeId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const patchSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  notes: z.array(z.string().max(10000)).max(200).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  retentionHold: z.boolean().optional(),
  frequencyHz: z.number().int().positive().safe().optional(),
  frequencyAttribution: z.enum(['confirmed', 'inferred', 'unknown']).optional(),
});

/** Register below the application's configured /api/v1 prefix. */
export async function registerHistoryRoutes(
  app: FastifyInstance,
  options: { auth: AuthenticationPort; history: HistoryService },
): Promise<void> {
  const { auth, history } = options;
  const radios = async (principal: Principal, permission: Permission) => {
    if (principal.role === 'administrator') return undefined;
    const allowed: string[] = [];
    for (const grant of principal.radioPermissions) {
      try {
        await auth.authorize(principal, permission, grant.radioId);
        allowed.push(grant.radioId);
      } catch {
        /* Unauthorized radios never enter list results. */
      }
    }
    return allowed;
  };
  const source = async (
    principal: Principal,
    id: string,
    permission: Permission,
  ) => {
    const communication = await history.get(principal.instanceId, id);
    if (!communication)
      throw new SignalDockError('NOT_FOUND', 'Communication is unavailable.');
    await auth.authorize(principal, permission, communication.radioId);
    return communication;
  };
  app.get('/communications', async (request, reply) => {
    const principal = await requirePrincipal(request, auth);
    const query = querySchema.parse(request.query);
    if (Boolean(query.beforeId) !== Boolean(query.beforeStartedAt))
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Both cursor fields are required.',
      );
    if (query.radioId)
      await auth.authorize(principal, 'history.read', query.radioId);
    const historyQuery: HistoryQuery = {
      ...(query.radioId ? { radioId: query.radioId } : {}),
      ...(query.frequencyHz === undefined
        ? {}
        : { frequencyHz: query.frequencyHz }),
      ...(query.search ? { search: query.search } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
      ...(query.beforeId && query.beforeStartedAt
        ? { before: { id: query.beforeId, startedAt: query.beforeStartedAt } }
        : {}),
    };
    reply.header('Cache-Control', 'no-store');
    return history.list(
      principal.instanceId,
      historyQuery,
      await radios(principal, 'history.read'),
    );
  });
  app.get('/conversations', async (request, reply) => {
    const principal = await requirePrincipal(request, auth);
    reply.header('Cache-Control', 'no-store');
    return {
      items: await history.conversations(
        principal.instanceId,
        await radios(principal, 'history.read'),
      ),
    };
  });
  app.get('/communications/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, auth);
    const { id } = parameters.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return source(principal, id, 'history.read');
  });
  app.post('/communications/notes', async (request, reply) => {
    const input = z
      .strictObject({
        radioId: IdSchema,
        frequencyHz: z.number().int().positive().safe().optional(),
        text: z.string().min(1).max(10000),
        tags: z.array(z.string().max(100)).max(50).optional(),
      })
      .parse(request.body);
    const principal = await requirePrincipal(
      request,
      auth,
      'history.write',
      input.radioId,
    );
    const at = new Date().toISOString();
    reply.code(201);
    return history.ingest({
      id: randomUUID(),
      instanceId: principal.instanceId,
      radioId: input.radioId,
      kind: 'note',
      direction: 'internal',
      startedAt: at,
      endedAt: at,
      frequencyAttribution: input.frequencyHz ? 'inferred' : 'unknown',
      ...(input.frequencyHz ? { frequencyHz: input.frequencyHz } : {}),
      context: { actorUserId: principal.userId },
      notes: [input.text],
      tags: input.tags ?? [],
    });
  });
  app.patch('/communications/:id', async (request) => {
    const principal = await requirePrincipal(request, auth);
    const { id } = parameters.parse(request.params);
    const input = patchSchema.parse(request.body);
    await source(principal, id, 'history.write');
    if (input.retentionHold !== undefined)
      await auth.authorize(principal, 'instance.admin');
    return history.update(
      principal.instanceId,
      id,
      {
        expectedRevision: input.expectedRevision,
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.retentionHold === undefined
          ? {}
          : { retentionHold: input.retentionHold }),
        ...(input.frequencyHz === undefined
          ? {}
          : { frequencyHz: input.frequencyHz }),
        ...(input.frequencyAttribution
          ? { frequencyAttribution: input.frequencyAttribution }
          : {}),
      },
      principal.userId,
    );
  });
  app.post('/communications/:id/transcripts', async (request, reply) => {
    const principal = await requirePrincipal(request, auth);
    const { id } = parameters.parse(request.params);
    await source(principal, id, 'history.write');
    const input = z
      .strictObject({
        expectedRevision: z.number().int().positive(),
        text: z.string().max(100000),
        language: z.string().max(100).optional(),
      })
      .parse(request.body);
    reply.code(201);
    return history.appendTranscript(principal.instanceId, id, {
      expectedRevision: input.expectedRevision,
      text: input.text,
      ...(input.language ? { language: input.language } : {}),
      source: 'human',
      provenance: { actorUserId: principal.userId },
    });
  });
  app.delete('/communications/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, auth, 'instance.admin');
    const { id } = parameters.parse(request.params);
    await history.delete(principal.instanceId, id, principal.userId);
    return reply.code(204).send();
  });
  app.get('/recordings/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, auth);
    const { id } = parameters.parse(request.params);
    const query = z
      .strictObject({ download: z.enum(['1']).optional() })
      .parse(request.query);
    const recording = await history.recording(principal.instanceId, id);
    if (!recording)
      throw new SignalDockError('NOT_FOUND', 'Recording is unavailable.');
    await auth.authorize(
      principal,
      query.download ? 'recording.export' : 'history.read',
      recording.radio_id,
    );
    let range: { start: number; end: number } | undefined;
    const size = Number(recording.size_bytes);
    if (request.headers.range) {
      range = parseRange(request.headers.range, size);
      if (!range) {
        reply.header('Content-Range', `bytes */${size}`);
        return reply.code(416).send({
          code: 'INVALID_ARGUMENT',
          message: 'Invalid recording range.',
          retryable: false,
        });
      }
    }
    const file = await history.readRecording(principal.instanceId, id, range);
    reply
      .header('Cache-Control', 'no-store')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', file.metadata.contentType)
      .header('Content-Length', file.bytes.byteLength)
      .header('X-Content-Type-Options', 'nosniff');
    if (query.download)
      reply.header(
        'Content-Disposition',
        `attachment; filename="recording-${id}.wav"`,
      );
    if (range)
      reply
        .code(206)
        .header(
          'Content-Range',
          `bytes ${file.start}-${file.end}/${file.totalBytes}`,
        );
    return reply.send(Buffer.from(file.bytes));
  });
  app.get('/radios/:id/coverage', async (request) => {
    const { id } = parameters.parse(request.params);
    const principal = await requirePrincipal(request, auth, 'history.read', id);
    return { items: await history.coverage(principal.instanceId, id) };
  });
}

export function parseRange(
  value: string,
  size: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size <= 0) return undefined;
  const suffix = !match[1];
  const first = Number(match[1] || match[2]);
  const start = suffix ? Math.max(0, size - first) : first;
  const end =
    suffix || !match[2] ? size - 1 : Math.min(Number(match[2]), size - 1);
  return Number.isSafeInteger(first) &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    first >= 0 &&
    (!suffix || first > 0) &&
    start >= 0 &&
    start < size &&
    end >= start
    ? { start, end }
    : undefined;
}
