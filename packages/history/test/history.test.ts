import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresDatabase,
  foundationMigrations,
  migrate,
} from '@signaldock/database';
import { FileArtifactStorage } from '@signaldock/artifact-storage';
import { PostgresJobQueue } from '@signaldock/job-queue';
import {
  HistoryService,
  historyMigrations,
  type CaptureInput,
} from '../src/index.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('PostgreSQL 18 communication lifecycle', () => {
  const schema = `sd_history_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: url });
  const instanceId = randomUUID(),
    otherInstance = randomUUID(),
    radioId = randomUUID(),
    secondRadio = randomUUID();
  let db: PostgresDatabase,
    history: HistoryService,
    directory: string,
    artifacts: FileArtifactStorage;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    await migrate(db, [...foundationMigrations, ...historyMigrations]);
    directory = await mkdtemp(join(tmpdir(), 'sd-history-'));
    artifacts = new FileArtifactStorage(directory);
    history = new HistoryService(db, artifacts);
  });
  afterAll(async () => {
    await db?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  function capture(overrides: Partial<CaptureInput> = {}): CaptureInput {
    return {
      id: randomUUID(),
      instanceId,
      radioId,
      kind: 'received_voice',
      direction: 'rx',
      startedAt: '2026-10-26T10:00:00.000Z',
      endedAt: '2026-10-26T10:00:02.000Z',
      frequencyHz: 147540000,
      frequencyAttribution: 'confirmed',
      context: { generation: randomUUID(), tuningRevision: 3 },
      ...overrides,
    };
  }
  const audio = {
    bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]),
    contentType: 'audio/wav',
  };
  it('groups only same radio/frequency and preserves uncertain source attribution', async () => {
    const a = await history.ingest(capture(), audio),
      b = await history.ingest(capture(), audio);
    const c = await history.ingest(capture({ radioId: secondRadio }), audio);
    const unknown = await history.ingest(
      capture({ frequencyAttribution: 'unknown' }),
      audio,
    );
    expect(a.conversationId).toBe(b.conversationId);
    expect(a.conversationId).not.toBe(c.conversationId);
    expect(unknown.conversationId).not.toBe(a.conversationId);
    const unknownPage = await history.list(
      instanceId,
      { conversationId: unknown.conversationId, limit: 1 },
      [radioId],
    );
    expect(unknownPage.items.map((item) => item.id)).toEqual([unknown.id]);
    expect(unknownPage.nextCursor).toBeUndefined();
    expect(
      (
        await history.list(
          instanceId,
          { conversationId: unknown.conversationId },
          [secondRadio],
        )
      ).items,
    ).toEqual([]);
    expect(
      (await history.conversations(instanceId)).find(
        (x) => x.id === unknown.conversationId,
      ),
    ).not.toHaveProperty('frequencyHz');
    const scoped = await history.list(instanceId, {}, [radioId]);
    expect(scoped.items.every((x) => x.radioId === radioId)).toBe(true);
    expect(await history.get(otherInstance, a.id)).toBeNull();
    const bytes = await history.readRecording(instanceId, a.recording!.id, {
      start: 2,
      end: 5,
    });
    expect([...bytes.bytes]).toEqual([70, 70, 1, 2]);
    expect(await history.recording(otherInstance, a.recording!.id)).toBeNull();
    expect(
      await history.getRecordingContext(instanceId, a.recording!.artifactId),
    ).toMatchObject({
      communicationId: a.id,
      communicationRevision: 1,
      radioId,
      frequencyHz: 147540000,
    });
  });
  it('makes repeated capture idempotent and rejects changed audio or reused timestamps', async () => {
    const input = capture();
    const a = await history.ingest(input, audio);
    expect((await history.ingest(input, audio)).recording?.artifactId).toBe(
      a.recording?.artifactId,
    );
    await expect(
      history.ingest(input, { ...audio, bytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(
      history.ingest({ ...input, endedAt: '2026-10-26T10:00:03.000Z' }, audio),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });
  it('serializes immutable transcript revisions, rejects stale changes and supports search/cursors', async () => {
    const a = await history.ingest(capture(), audio);
    const first = await history.appendTranscript(instanceId, a.id, {
      text: 'Emergency at the mountain',
      source: 'human',
      provenance: { actor: 'fixture' },
      expectedRevision: 1,
    });
    expect(first.revision).toBe(1);
    expect((await history.get(instanceId, a.id))?.revision).toBe(2);
    await expect(
      history.appendTranscript(instanceId, a.id, {
        text: 'stale',
        source: 'human',
        provenance: {},
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    const second = await history.appendTranscript(instanceId, a.id, {
      text: 'Corrected emergency',
      source: 'provider',
      provenance: { provider: 'fixture', model: 'local' },
      expectedRevision: 2,
    });
    expect(second.revision).toBe(2);
    expect(
      (await history.list(instanceId, { search: 'mountain' })).items.map(
        (x) => x.id,
      ),
    ).toContain(a.id);
    const page = await history.list(instanceId, { limit: 2 });
    expect(page.nextCursor).toBeDefined();
    const next = await history.list(instanceId, {
      limit: 2,
      ...(page.nextCursor ? { before: page.nextCursor } : {}),
    });
    expect(next.items.some((x) => page.items.some((y) => x.id === y.id))).toBe(
      false,
    );
    const source = {
      jobId: randomUUID(),
      instanceId,
      kind: 'fixture',
      payload: {},
      idempotencyKey: 'fixture',
      deadline: new Date(Date.now() + 10000).toISOString(),
      source: { communicationId: a.id, communicationRevision: 1 },
    };
    expect(
      await db.transaction((tx) => history.validateJobSource(source, tx)),
    ).toBe(false);
  });
  it('preserves metadata as an explicit gap when disk writes fail or quota is exhausted', async () => {
    const failing = new HistoryService(db, {
      put: async () => {
        throw new Error('disk unavailable');
      },
      read: artifacts.read.bind(artifacts),
      delete: artifacts.delete.bind(artifacts),
    });
    const a = await failing.ingest(capture(), audio);
    expect(a.recording).toMatchObject({
      state: 'gap',
      gapReason: 'Recording storage is unavailable.',
    });
    const limited = new HistoryService(db, artifacts, {
      maxRecordingBytesPerRadio: 1,
    });
    const b = await limited.ingest(capture(), audio);
    expect(b.recording).toMatchObject({
      state: 'gap',
      gapReason: 'Recording quota reached.',
    });
  });
  it('holds prevent deletion; tombstones suppress source access and leave durable cleanup after IO failure', async () => {
    const a = await history.ingest(capture(), audio);
    await history.update(
      instanceId,
      a.id,
      { expectedRevision: 1, retentionHold: true },
      randomUUID(),
    );
    await expect(history.delete(instanceId, a.id)).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
    });
    await history.update(
      instanceId,
      a.id,
      { expectedRevision: 2, retentionHold: false },
      randomUUID(),
    );
    const failing = new HistoryService(db, {
      put: artifacts.put.bind(artifacts),
      read: artifacts.read.bind(artifacts),
      delete: async () => {
        throw new Error('disk busy');
      },
    });
    await expect(failing.delete(instanceId, a.id)).rejects.toThrow('disk busy');
    expect(await history.get(instanceId, a.id)).toBeNull();
    expect(
      await history.getRecordingContext(instanceId, a.recording!.artifactId),
    ).toBeNull();
    expect(
      await history.cleanupDeletedArtifacts(instanceId),
    ).toBeGreaterThanOrEqual(1);
    await history.delete(instanceId, a.id);
    await expect(
      history.readRecording(instanceId, a.recording!.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      history.ingest({ ...capture(), id: a.id }, audio),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });
  it('applies independent audio/text retention with immutable metadata and held records preserved', async () => {
    const a = await history.ingest(
      capture({
        startedAt: '2020-01-01T00:00:00.000Z',
        endedAt: '2020-01-01T00:00:01.000Z',
      }),
      audio,
    );
    await history.appendTranscript(instanceId, a.id, {
      text: 'old transcript',
      source: 'human',
      provenance: {},
      expectedRevision: 1,
    });
    const retained = await history.applyRetention(instanceId, {
      audioBefore: '2021-01-01T00:00:00.000Z',
    });
    expect(retained.audio).toBe(1);
    expect((await history.get(instanceId, a.id))?.transcripts).toHaveLength(1);
    expect((await history.get(instanceId, a.id))?.recording?.state).toBe(
      'deleted',
    );
    await history.applyRetention(instanceId, {
      transcriptsBefore: '2021-01-01T00:00:00.000Z',
    });
    expect((await history.get(instanceId, a.id))?.transcripts).toHaveLength(0);
    await history.applyRetention(instanceId, {
      communicationsBefore: '2021-01-01T00:00:00.000Z',
    });
    expect(await history.get(instanceId, a.id)).toBeNull();
  });
  it('fences actual transcript writes across deletion and commits a valid source revision atomically', async () => {
    const bossSchema = `sd_history_boss_${randomUUID().replaceAll('-', '')}`;
    const queue = new PostgresJobQueue(db, {
      connectionString: url!,
      schema: bossSchema,
      validateSource: history.validateJobSource.bind(history),
    });
    let release: () => void = () => {},
      started = false;
    queue.register('history.test_late', async (job, _signal, execution) => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return execution.commit((tx) =>
        history.appendTranscript(
          job.instanceId,
          job.source!.communicationId,
          {
            text: 'must never persist',
            source: 'provider',
            provenance: {},
            expectedRevision: job.source!.communicationRevision,
          },
          tx,
        ),
      );
    });
    queue.register('history.test_valid', async (job, _signal, execution) =>
      execution.commit((tx) =>
        history.appendTranscript(
          job.instanceId,
          job.source!.communicationId,
          {
            text: 'valid provider result',
            source: 'provider',
            provenance: {},
            expectedRevision: job.source!.communicationRevision,
          },
          tx,
        ),
      ),
    );
    async function until(check: () => Promise<boolean>) {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('History job did not finish.');
    }
    const job = (
      communication: Awaited<ReturnType<HistoryService['ingest']>>,
      kind: string,
    ) => ({
      instanceId,
      jobId: randomUUID(),
      kind,
      payload: {},
      idempotencyKey: randomUUID(),
      deadline: new Date(Date.now() + 30000).toISOString(),
      source: {
        communicationId: communication.id,
        communicationRevision: communication.revision,
        artifactId: communication.recording!.artifactId,
      },
    });
    try {
      await queue.start();
      const doomed = await history.ingest(capture(), audio);
      const late = job(doomed, 'history.test_late');
      await queue.enqueue(late);
      await queue.publishPending();
      await until(async () => started);
      await history.delete(instanceId, doomed.id);
      release();
      await until(
        async () =>
          (await queue.get(instanceId, late.jobId))?.state === 'cancelled',
      );
      expect(
        (
          await db.query(
            'SELECT id FROM sd_transcript_revisions WHERE instance_id=$1 AND communication_id=$2',
            [instanceId, doomed.id],
          )
        ).rows,
      ).toHaveLength(0);
      const valid = await history.ingest(capture(), audio),
        accepted = job(valid, 'history.test_valid');
      await queue.enqueue(accepted);
      await queue.publishPending();
      await until(
        async () =>
          (await queue.get(instanceId, accepted.jobId))?.state === 'completed',
      );
      expect((await history.get(instanceId, valid.id))?.revision).toBe(2);
      expect(
        (await history.get(instanceId, valid.id))?.transcripts[0]?.text,
      ).toBe('valid provider result');
    } finally {
      release();
      await queue.stop();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    }
  }, 25000);
});
