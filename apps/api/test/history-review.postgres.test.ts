import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunicationWaveformSchema,
  HistoryActivitySchema,
  SignalDockError,
  type AuthenticationPort,
  type Principal,
} from '@signaldock/contracts';
import {
  PostgresDatabase,
  foundationMigrations,
  migrate,
} from '@signaldock/database';
import { FileArtifactStorage } from '@signaldock/artifact-storage';
import { HistoryService, historyMigrations, wav } from '@signaldock/history';
import { configureHttp } from '../src/shared/http/configure-http.js';
import { registerHistoryRoutes } from '../src/modules/history/history.routes.js';
import { LruCache } from '../src/modules/history/lru-cache.js';

function tone(frames: number, amplitude: number): Uint8Array {
  const bytes = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1)
    bytes.writeInt16LE(index % 2 ? -amplitude : amplitude, index * 2);
  return bytes;
}

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('history review aggregates with PostgreSQL 18', () => {
  const schema = `sd_history_review_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: url });
  const instanceId = randomUUID(),
    radioId = randomUUID(),
    hiddenRadioId = randomUUID(),
    otherRadioId = randomUUID();
  const now = new Date('2026-11-03T12:00:00.000Z');
  const cache = new LruCache<string, { peaks: number[]; durationMs: number }>(
    500,
  );
  let db: PostgresDatabase,
    history: HistoryService,
    app: FastifyInstance,
    directory: string,
    voiceId: string,
    brokenId: string,
    noteId: string,
    hiddenId: string;
  const viewer: Principal = {
    instanceId,
    userId: randomUUID(),
    sessionId: randomUUID(),
    username: 'viewer',
    role: 'listener',
    radioPermissions: [
      { radioId, permissions: ['history.read'] },
      { radioId: otherRadioId, permissions: ['radio.listen'] },
    ],
  };
  const auth: AuthenticationPort = {
    authenticate: async (token) => {
      if (token === 'viewer') return viewer;
      if (token === 'admin') return { ...viewer, role: 'administrator' };
      throw new SignalDockError('UNAUTHORIZED', 'Invalid session.');
    },
    authorize: async (p, permission, radio) => {
      if (
        p.role === 'administrator' ||
        (radio &&
          p.radioPermissions.some(
            (g) => g.radioId === radio && g.permissions.includes(permission),
          ))
      )
        return;
      throw new SignalDockError('FORBIDDEN', 'Permission required.');
    },
  };
  const ingest = (
    radio: string,
    startedAt: string,
    endedAt: string,
    audio?: { bytes: Uint8Array; contentType: string },
    kind: 'received_voice' | 'note' = 'received_voice',
  ) =>
    history.ingest(
      {
        id: randomUUID(),
        instanceId,
        radioId: radio,
        kind,
        direction: kind === 'note' ? 'internal' : 'rx',
        startedAt,
        endedAt,
        frequencyHz: 147540000,
        frequencyAttribution: 'confirmed',
        context: {},
      },
      audio,
    );
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    await migrate(db, [...foundationMigrations, ...historyMigrations]);
    directory = await mkdtemp(join(tmpdir(), 'sd-history-review-'));
    history = new HistoryService(db, new FileArtifactStorage(directory));
    voiceId = (
      await ingest(
        radioId,
        '2026-11-03T10:05:00.000Z',
        '2026-11-03T10:05:01.000Z',
        { bytes: wav([tone(8000, 16384)], 8000, 1), contentType: 'audio/wav' },
      )
    ).id;
    brokenId = (
      await ingest(
        radioId,
        '2026-11-03T10:20:00.000Z',
        '2026-11-03T10:20:02.500Z',
        { bytes: new Uint8Array([0, 1, 2, 3]), contentType: 'audio/wav' },
      )
    ).id;
    noteId = (
      await ingest(
        radioId,
        '2026-11-02T23:30:00.000Z',
        '2026-11-02T23:30:00.000Z',
        undefined,
        'note',
      )
    ).id;
    // Outside the 7-day window.
    await ingest(
      radioId,
      '2026-10-20T10:00:00.000Z',
      '2026-10-20T10:00:01.000Z',
    );
    hiddenId = (
      await ingest(
        hiddenRadioId,
        '2026-11-03T10:10:00.000Z',
        '2026-11-03T10:10:01.000Z',
        { bytes: wav([tone(800, 1000)], 8000, 1), contentType: 'audio/wav' },
      )
    ).id;
    await ingest(
      otherRadioId,
      '2026-11-03T10:30:00.000Z',
      '2026-11-03T10:30:01.000Z',
    );
    app = Fastify();
    configureHttp(app);
    await app.register(
      async (routes) =>
        registerHistoryRoutes(routes, {
          auth,
          history,
          now: () => now,
          waveformCache: cache,
        }),
      { prefix: '/api/v1' },
    );
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const headers = { authorization: 'Bearer viewer' };
  const total = (buckets: { count: number }[]) =>
    buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  it('returns a complete time-zone-aware activity grid for readable radios only', async () => {
    expect(
      (await app.inject({ url: '/api/v1/history/activity' })).statusCode,
    ).toBe(401);
    const utc = await app.inject({
      url: '/api/v1/history/activity?days=7&tz=UTC',
      headers,
    });
    expect(utc.statusCode).toBe(200);
    expect(utc.headers['cache-control']).toBe('no-store');
    const body = HistoryActivitySchema.parse(utc.json());
    expect(body.timeZone).toBe('UTC');
    expect(body.days).toHaveLength(7);
    expect(body.days.at(-1)).toBe('2026-11-03');
    expect(body.buckets).toHaveLength(7 * 24);
    expect(total(body.buckets)).toBe(3);
    expect(
      body.buckets.find((b) => b.day === '2026-11-03' && b.hour === 10)?.count,
    ).toBe(2);
    expect(
      body.buckets.find((b) => b.day === '2026-11-02' && b.hour === 23)?.count,
    ).toBe(1);

    const santiago = HistoryActivitySchema.parse(
      (
        await app.inject({
          url: '/api/v1/history/activity?tz=America%2FSantiago&direction=rx',
          headers,
        })
      ).json(),
    );
    expect(total(santiago.buckets)).toBe(2);
    expect(
      santiago.buckets.find((b) => b.day === '2026-11-03' && b.hour === 7)
        ?.count,
    ).toBe(2);

    const oneDay = HistoryActivitySchema.parse(
      (
        await app.inject({
          url: `/api/v1/history/activity?days=1&radioId=${radioId}`,
          headers,
        })
      ).json(),
    );
    expect(oneDay.days).toEqual(['2026-11-03']);
    expect(oneDay.buckets).toHaveLength(24);
    expect(total(oneDay.buckets)).toBe(2);
  });

  it('scopes activity exactly like list queries, including administrators', async () => {
    for (const radio of [hiddenRadioId, otherRadioId])
      expect(
        (
          await app.inject({
            url: `/api/v1/history/activity?radioId=${radio}`,
            headers,
          })
        ).statusCode,
      ).toBe(403);
    const adminActivity = HistoryActivitySchema.parse(
      (
        await app.inject({
          url: '/api/v1/history/activity',
          headers: { authorization: 'Bearer admin' },
        })
      ).json(),
    );
    // Activity totals match the administrator's own list scope (explicit grants).
    const list = (
      await app.inject({
        url: '/api/v1/communications?limit=100',
        headers: { authorization: 'Bearer admin' },
      })
    ).json() as { items: { radioId: string; startedAt: string }[] };
    const inWindow = list.items.filter(
      (item) => item.startedAt >= '2026-10-28T00:00:00.000Z',
    );
    expect(total(adminActivity.buckets)).toBe(inWindow.length);
    expect(list.items.some((item) => item.radioId === hiddenRadioId)).toBe(
      false,
    );
  });

  it('canonicalizes time-zone spellings and aliases', async () => {
    for (const [tz, canonical] of [
      ['america%2Fsantiago', 'America/Santiago'],
      ['AmErIcA%2FSaNtIaGo', 'America/Santiago'],
      ['utc', 'UTC'],
      ['Etc%2FUTC', 'UTC'],
    ] as const) {
      const response = await app.inject({
        url: `/api/v1/history/activity?tz=${tz}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(HistoryActivitySchema.parse(response.json()).timeZone).toBe(
        canonical,
      );
    }
  });

  it('rejects invalid activity parameters', async () => {
    for (const query of [
      'tz=Not%2FAZone',
      'tz=%2B05%3A07',
      'tz=-0130',
      'days=0',
      'days=32',
      'direction=sideways',
      'unknown=1',
    ])
      expect(
        (
          await app.inject({
            url: `/api/v1/history/activity?${query}`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
  });

  it('returns cached waveform peaks with playback authorization', async () => {
    expect(
      (await app.inject({ url: `/api/v1/communications/${voiceId}/waveform` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: `/api/v1/communications/${hiddenId}/waveform`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/v1/communications/${randomUUID()}/waveform`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    const response = await app.inject({
      url: `/api/v1/communications/${voiceId}/waveform`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = CommunicationWaveformSchema.parse(response.json());
    expect(body.communicationId).toBe(voiceId);
    expect(body.recordingId).toBeDefined();
    expect(body.points).toBe(64);
    expect(body.durationMs).toBe(1000);
    expect(body.peaks).toHaveLength(64);
    expect(body.peaks.every((peak) => peak === 0.5)).toBe(true);
    expect(cache.size).toBe(1);
    const small = CommunicationWaveformSchema.parse(
      (
        await app.inject({
          url: `/api/v1/communications/${voiceId}/waveform?points=8`,
          headers,
        })
      ).json(),
    );
    expect(small.peaks).toHaveLength(8);
    expect(cache.size).toBe(2);
    // A cached entry never bypasses the per-request authentication check.
    expect(
      (
        await app.inject({
          url: `/api/v1/communications/${voiceId}/waveform`,
          headers: { authorization: 'Bearer nobody' },
        })
      ).statusCode,
    ).toBe(401);
    for (const query of ['points=0', 'points=513', 'points=abc', 'x=1'])
      expect(
        (
          await app.inject({
            url: `/api/v1/communications/${voiceId}/waveform?${query}`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
  });

  it('reports empty peaks with the communication duration when audio is unavailable', async () => {
    const broken = CommunicationWaveformSchema.parse(
      (
        await app.inject({
          url: `/api/v1/communications/${brokenId}/waveform`,
          headers,
        })
      ).json(),
    );
    expect(broken.peaks).toEqual([]);
    expect(broken.durationMs).toBe(2500);
    const note = CommunicationWaveformSchema.parse(
      (
        await app.inject({
          url: `/api/v1/communications/${noteId}/waveform`,
          headers,
        })
      ).json(),
    );
    expect(note.recordingId).toBeUndefined();
    expect(note).toMatchObject({ peaks: [], durationMs: 0, points: 64 });
  });

  it('reports empty peaks when the stored artifact is missing', async () => {
    const missing = await ingest(
      radioId,
      '2026-11-03T11:00:00.000Z',
      '2026-11-03T11:00:01.500Z',
      { bytes: wav([tone(8000, 8000)], 8000, 1), contentType: 'audio/wav' },
    );
    const row = await db.query<{ artifact_id: string }>(
      'SELECT artifact_id FROM sd_recordings WHERE instance_id=$1 AND communication_id=$2',
      [instanceId, missing.id],
    );
    const artifactId = row.rows[0]?.artifact_id;
    expect(artifactId).toBeDefined();
    await unlink(join(directory, instanceId, `${artifactId}.bin`));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        url: `/api/v1/communications/${missing.id}/waveform`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(CommunicationWaveformSchema.parse(response.json())).toMatchObject({
        peaks: [],
        durationMs: 1500,
      });
    }
  });

  it('stops serving waveforms for deleted communications', async () => {
    await history.delete(instanceId, voiceId, viewer.userId);
    expect(
      (
        await app.inject({
          url: `/api/v1/communications/${voiceId}/waveform`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });
});
