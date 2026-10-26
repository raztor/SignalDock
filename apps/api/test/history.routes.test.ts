import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
import { HistoryService, historyMigrations } from '@signaldock/history';
import { configureHttp } from '../src/shared/http/configure-http.js';
import {
  parseRange,
  registerHistoryRoutes,
} from '../src/modules/history/history.routes.js';

describe('recording HTTP byte range parser', () => {
  it('supports bounded/open/suffix ranges and rejects multiple or unsatisfiable ranges', () => {
    expect(parseRange('bytes=0-3', 8)).toEqual({ start: 0, end: 3 });
    expect(parseRange('bytes=4-', 8)).toEqual({ start: 4, end: 7 });
    expect(parseRange('bytes=-3', 8)).toEqual({ start: 5, end: 7 });
    for (const invalid of [
      'bytes=',
      'bytes=-0',
      'bytes=8-',
      'bytes=5-4',
      'bytes=0-1,4-5',
      'items=0-1',
    ])
      expect(parseRange(invalid, 8)).toBeUndefined();
  });
});
const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('authenticated history API with PostgreSQL 18', () => {
  const schema = `sd_history_http_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: url });
  const instanceId = randomUUID(),
    radioId = randomUUID(),
    hiddenRadioId = randomUUID();
  let db: PostgresDatabase,
    history: HistoryService,
    app: FastifyInstance,
    directory: string,
    id: string,
    recordingId: string;
  const viewer: Principal = {
    instanceId,
    userId: randomUUID(),
    sessionId: randomUUID(),
    username: 'viewer',
    role: 'listener',
    radioPermissions: [{ radioId, permissions: ['history.read'] }],
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
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    await migrate(db, [...foundationMigrations, ...historyMigrations]);
    directory = await mkdtemp(join(tmpdir(), 'sd-history-http-'));
    history = new HistoryService(db, new FileArtifactStorage(directory));
    for (const radio of [radioId, hiddenRadioId]) {
      const c = await history.ingest(
        {
          id: randomUUID(),
          instanceId,
          radioId: radio,
          kind: 'received_voice',
          direction: 'rx',
          startedAt: '2026-10-26T01:00:00.000Z',
          endedAt: '2026-10-26T01:00:01.000Z',
          frequencyHz: 147540000,
          frequencyAttribution: 'confirmed',
          context: {},
        },
        {
          bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
          contentType: 'audio/wav',
        },
      );
      if (radio === radioId) {
        id = c.id;
        recordingId = c.recording!.id;
      }
    }
    app = Fastify();
    configureHttp(app);
    await app.register(
      async (routes) => registerHistoryRoutes(routes, { auth, history }),
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
  it('filters radio scopes before list pagination and rechecks authentication for every playback', async () => {
    expect(
      (await app.inject({ url: '/api/v1/communications' })).statusCode,
    ).toBe(401);
    const list = await app.inject({ url: '/api/v1/communications', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].id).toBe(id);
    expect(
      (
        await app.inject({
          url: `/api/v1/communications?radioId=${hiddenRadioId}`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/api/v1/recordings/${recordingId}` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: `/api/v1/recordings/${recordingId}?download=1`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('returns private byte ranges and exact HTTP416 semantics', async () => {
    const partial = await app.inject({
      url: `/api/v1/recordings/${recordingId}`,
      headers: { ...headers, range: 'bytes=2-5' },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 2-5/8');
    expect([...partial.rawPayload]).toEqual([2, 3, 4, 5]);
    expect(partial.headers['cache-control']).toBe('no-store');
    const invalid = await app.inject({
      url: `/api/v1/recordings/${recordingId}`,
      headers: { ...headers, range: 'bytes=20-' },
    });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */8');
  });
  it('publishes normalized coverage and filters frequency conversations before pagination', async () => {
    const generation = randomUUID();
    const coverageId = await history.openCoverage({
      instanceId,
      radioId,
      generation,
      frequencyHz: 147540000,
      attribution: 'confirmed',
      startedAt: '2026-10-26T01:00:00.000Z',
    });
    await history.closeCoverage(
      instanceId,
      coverageId,
      '2026-10-26T01:02:00.000Z',
      'radio_disconnected',
    );
    const coverage = await app.inject({
      url: `/api/v1/radios/${radioId}/coverage`,
      headers,
    });
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json().items).toEqual([
      {
        id: coverageId,
        radioId,
        generation,
        frequencyHz: 147540000,
        attribution: 'confirmed',
        startedAt: '2026-10-26T01:00:00.000Z',
        endedAt: '2026-10-26T01:02:00.000Z',
        reason: 'radio_disconnected',
      },
    ]);
    expect(
      (
        await app.inject({
          url: `/api/v1/radios/${hiddenRadioId}/coverage`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    const unknown = await history.ingest({
      id: randomUUID(),
      instanceId,
      radioId,
      kind: 'received_voice',
      direction: 'rx',
      frequencyAttribution: 'unknown',
      startedAt: '2000-01-01T00:00:00.000Z',
      endedAt: '2000-01-01T00:00:01.000Z',
      context: {},
    });
    const page = await app.inject({
      url: `/api/v1/communications?conversationId=${unknown.conversationId}&limit=1`,
      headers,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().items.map((item: { id: string }) => item.id)).toEqual([
      unknown.id,
    ]);
    expect(page.json().nextCursor).toBeUndefined();
  });
  it('requires write permission and handles stale operator changes explicitly', async () => {
    const body = { expectedRevision: 1, notes: ['test'] };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/communications/${id}`,
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const adminHeaders = { authorization: 'Bearer admin' };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/communications/${id}`,
          headers: adminHeaders,
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/communications/${id}`,
          headers: adminHeaders,
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/communications/${id}`,
          headers: adminHeaders,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ url: `/api/v1/recordings/${recordingId}`, headers }))
        .statusCode,
    ).toBe(404);
  });
});
