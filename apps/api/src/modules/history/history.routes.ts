import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  CommunicationWaveformSchema,
  HistoryActivitySchema,
  IdSchema,
  SignalDockError,
  type CommunicationWaveform,
  type AuthenticationPort,
  type HistoryQuery,
  type Permission,
  type Principal,
} from '@signaldock/contracts';
import {
  ACTIVITY_SLOT_MINUTES,
  DEFAULT_WAVEFORM_POINTS,
  MAX_ACTIVITY_DAYS,
  MAX_WAVEFORM_POINTS,
  HistoryService,
  activityWindow,
  bucketActivity,
  canonicalTimeZone,
  waveformFromRecording,
} from '@signaldock/history';
import { requirePrincipal } from '../../shared/http/auth.js';
import { LruCache } from './lru-cache.js';

/** Waveform summaries kept in memory, keyed by instance + recording + points. */
export const WAVEFORM_CACHE_ENTRIES = 500;
/** Larger recordings are not decoded for previews; peaks are reported empty. */
export const MAX_WAVEFORM_SOURCE_BYTES = 64 * 1024 * 1024;
type WaveformSummary = Pick<CommunicationWaveform, 'peaks' | 'durationMs'>;

const parameters = z.strictObject({ id: IdSchema });
const querySchema = z.strictObject({
  conversationId: IdSchema.optional(),
  radioId: IdSchema.optional(),
  frequencyHz: z.coerce.number().int().positive().safe().optional(),
  search: z.string().max(2000).optional(),
  direction: z.enum(['rx', 'tx', 'internal']).optional(),
  beforeStartedAt: z.iso.datetime().optional(),
  beforeId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const activityQuerySchema = z.strictObject({
  radioId: IdSchema.optional(),
  frequencyHz: z.coerce.number().int().positive().safe().optional(),
  direction: z.enum(['rx', 'tx', 'internal']).optional(),
  days: z.coerce.number().int().min(1).max(MAX_ACTIVITY_DAYS).optional(),
  tz: z.string().min(1).max(100).optional(),
});
const waveformQuerySchema = z.strictObject({
  points: z.coerce.number().int().min(1).max(MAX_WAVEFORM_POINTS).optional(),
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
  options: {
    auth: AuthenticationPort;
    history: HistoryService;
    /** Clock override for tests. */
    now?: () => Date;
    /** Shared waveform cache; defaults to a private LRU of 500 entries. */
    waveformCache?: LruCache<string, WaveformSummary>;
  },
): Promise<void> {
  const { auth, history } = options;
  const now = options.now ?? (() => new Date());
  const waveforms =
    options.waveformCache ??
    new LruCache<string, WaveformSummary>(WAVEFORM_CACHE_ENTRIES);
  const radios = async (principal: Principal, permission: Permission) => {
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
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
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
  app.get('/history/activity', async (request, reply) => {
    const principal = await requirePrincipal(request, auth);
    const query = activityQuerySchema.parse(request.query);
    // Only canonical IANA names reach the formatter cache and the response.
    const timeZone = canonicalTimeZone(query.tz ?? 'UTC');
    if (!timeZone)
      throw new SignalDockError('INVALID_ARGUMENT', 'Unknown time zone.');
    if (query.radioId)
      await auth.authorize(principal, 'history.read', query.radioId);
    const window = activityWindow(now(), query.days ?? 7, timeZone);
    const slots = await history.activitySlots(
      principal.instanceId,
      {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        slotMinutes: ACTIVITY_SLOT_MINUTES,
        ...(query.radioId ? { radioId: query.radioId } : {}),
        ...(query.frequencyHz === undefined
          ? {}
          : { frequencyHz: query.frequencyHz }),
        ...(query.direction ? { direction: query.direction } : {}),
      },
      await radios(principal, 'history.read'),
    );
    reply.header('Cache-Control', 'no-store');
    return HistoryActivitySchema.parse({
      timeZone,
      days: window.days,
      buckets: bucketActivity(slots, timeZone, window.days),
    });
  });
  app.get('/communications/:id/waveform', async (request, reply) => {
    const principal = await requirePrincipal(request, auth);
    const { id } = parameters.parse(request.params);
    const points =
      waveformQuerySchema.parse(request.query).points ??
      DEFAULT_WAVEFORM_POINTS;
    // Same authorization as playback: history.read on the source radio.
    const communication = await source(principal, id, 'history.read');
    const recording = communication.recording;
    const fallback: WaveformSummary = {
      peaks: [],
      durationMs: Math.max(
        0,
        Date.parse(communication.endedAt) - Date.parse(communication.startedAt),
      ),
    };
    let summary = fallback;
    if (recording?.state === 'available') {
      const key = `${principal.instanceId}:${recording.id}:${points}`;
      const cached = waveforms.get(key);
      if (cached) summary = cached;
      else {
        if (recording.sizeBytes <= MAX_WAVEFORM_SOURCE_BYTES) {
          try {
            const file = await history.readRecording(
              principal.instanceId,
              recording.id,
            );
            summary =
              waveformFromRecording(
                file.bytes,
                file.metadata.contentType,
                points,
              ) ?? fallback;
          } catch (error) {
            // A missing artifact or one that fails its integrity check is
            // reported as empty peaks, like an undecodable recording.
            if (
              !(error instanceof SignalDockError) ||
              !['NOT_FOUND', 'INTERNAL_ERROR'].includes(error.code)
            )
              throw error;
            summary = fallback;
          }
        }
        waveforms.set(key, summary);
      }
    }
    reply.header('Cache-Control', 'no-store');
    return CommunicationWaveformSchema.parse({
      communicationId: communication.id,
      ...(recording ? { recordingId: recording.id } : {}),
      points,
      peaks: summary.peaks,
      durationMs: summary.durationMs,
    });
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
