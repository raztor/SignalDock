import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresDatabase,
  foundationMigrations,
  migrate,
} from '@signaldock/database';
import { FileArtifactStorage } from '@signaldock/artifact-storage';
import { processingMigrations } from '../../../apps/api/src/modules/processing/migrations.js';
import {
  HistoryService,
  historyMigrations,
  type HistoryOptions,
} from '../src/index.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('PostgreSQL transcript-only retention callback', () => {
  let schema: string,
    directory: string,
    db: PostgresDatabase,
    storage: FileArtifactStorage;
  let admin: Client;
  const instanceId = randomUUID(),
    radioId = randomUUID(),
    userId = randomUUID();
  const audio = Buffer.from([82, 73, 70, 70, 0, 1, 2, 3]);
  beforeEach(async () => {
    schema = `sd_transcript_retention_${randomUUID().replaceAll('-', '')}`;
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    await migrate(db, [
      ...foundationMigrations,
      ...historyMigrations,
      ...processingMigrations,
    ]);
    // This branch predates digital-module integration. The probe represents
    // recording-derived packet evidence without declaring decoder acceptance.
    await db.query(
      'CREATE TABLE digital_evidence_probe(instance_id uuid,artifact_id uuid,packet jsonb,PRIMARY KEY(instance_id,artifact_id))',
    );
    directory = await mkdtemp(join(tmpdir(), 'sd-transcript-retention-'));
    storage = new FileArtifactStorage(directory);
  });
  afterEach(async () => {
    await db?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  /** SQL composition stand-in: production supplies removeProcessingSourceDerivatives. */
  const purge: NonNullable<HistoryOptions['onDeleteTranscripts']> = async (
    tx,
    source,
  ) => {
    const copied = await tx.query<{ id: string }>(
      "SELECT id FROM sd_processing_jobs WHERE instance_id=$1 AND source->>'communicationId'=$2",
      [source.instanceId, source.communicationId],
    );
    const ids = copied.rows.map((row) => row.id);
    await tx.query(
      'SELECT id FROM sd_jobs WHERE instance_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [source.instanceId, ids],
    );
    await tx.query(
      "UPDATE sd_jobs SET result=NULL,error=NULL,payload=jsonb_build_object('sourceRemoved',true),state=CASE WHEN state IN ('queued','running','retry_wait') THEN 'cancelled' ELSE state END,cancelled_at=now() WHERE instance_id=$1 AND id=ANY($2::uuid[])",
      [source.instanceId, ids],
    );
    await tx.query(
      'DELETE FROM sd_processing_jobs WHERE instance_id=$1 AND id=ANY($2::uuid[])',
      [source.instanceId, ids],
    );
  };
  async function seed(history: HistoryService) {
    const communication = await history.ingest(
      {
        id: randomUUID(),
        instanceId,
        radioId,
        kind: 'received_voice',
        direction: 'rx',
        startedAt: '2020-01-01T00:00:00.000Z',
        endedAt: '2020-01-01T00:00:01.000Z',
        frequencyHz: 147540000,
        frequencyAttribution: 'confirmed',
        context: {},
      },
      { bytes: audio, contentType: 'audio/wav' },
    );
    const text = 'Private transcript retained in provider request and result.';
    await history.appendTranscript(instanceId, communication.id, {
      text,
      source: 'human',
      provenance: {},
      expectedRevision: 1,
    });
    const connectionId = randomUUID(),
      profileId = randomUUID();
    await db.query(
      "INSERT INTO sd_processing_connections(instance_id,id,connector_id,display_name,endpoint,capabilities) VALUES($1,$2,'fixture.local','Local fixture','https://local.invalid','[]')",
      [instanceId, connectionId],
    );
    await db.query(
      "INSERT INTO sd_processing_profiles(instance_id,id,connection_id,revision,profile) VALUES($1,$2,$3,1,'{}')",
      [instanceId, profileId, connectionId],
    );
    const jobIds = [randomUUID(), randomUUID()];
    for (const [index, jobId] of jobIds.entries()) {
      const state = index ? 'running' : 'completed',
        source = {
          communicationId: communication.id,
          communicationRevision: 2,
        };
      await db.query(
        "INSERT INTO sd_processing_jobs(instance_id,id,owner_user_id,radio_id,profile_id,request,actor,source,state,result,fingerprint,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8,$9,'fixture',$2::uuid::text)",
        [
          instanceId,
          jobId,
          userId,
          radioId,
          profileId,
          JSON.stringify({
            input: { kind: 'text', text, communicationIds: [communication.id] },
          }),
          JSON.stringify(source),
          state,
          JSON.stringify({ text }),
        ],
      );
      await db.query(
        "INSERT INTO sd_jobs(instance_id,id,kind,payload,source,idempotency_key,state,deadline,max_attempts,result) VALUES($1,$2,'processing.execute',$3,$4,$2::uuid::text,$5,now()+interval '5 minutes',1,$6)",
        [
          instanceId,
          jobId,
          JSON.stringify({ processingJobId: jobId }),
          JSON.stringify(source),
          state,
          JSON.stringify({ text }),
        ],
      );
    }
    await db.query('INSERT INTO digital_evidence_probe VALUES($1,$2,$3)', [
      instanceId,
      communication.recording!.artifactId,
      JSON.stringify({
        kind: 'APRS',
        callsign: 'N0CALL',
        latitude: 1,
        longitude: 2,
      }),
    ]);
    return { communication, jobIds, text };
  }
  it('purges copied processing text atomically while preserving playable audio and recorded-packet evidence', async () => {
    let calls = 0;
    const history = new HistoryService(db, storage, {
      onDeleteSource: async () => {
        throw new Error(
          'Transcript retention must not delete the full source.',
        );
      },
      onDeleteTranscripts: async (tx, source) => {
        calls++;
        expect(
          (
            await tx.query(
              'SELECT id FROM sd_transcript_revisions WHERE instance_id=$1 AND communication_id=$2',
              [source.instanceId, source.communicationId],
            )
          ).rows,
        ).toHaveLength(1);
        // A separate connection cannot update the source while this callback runs.
        await expect(
          db.transaction(async (competing) => {
            await competing.query("SET LOCAL lock_timeout='50ms'");
            await competing.query(
              'SELECT id FROM sd_communications WHERE instance_id=$1 AND id=$2 FOR UPDATE',
              [source.instanceId, source.communicationId],
            );
          }),
        ).rejects.toMatchObject({ code: '55P03' });
        await purge(tx, source);
      },
    });
    const { communication, jobIds } = await seed(history);
    expect(
      await history.applyRetention(instanceId, {
        transcriptsBefore: '2021-01-01T00:00:00.000Z',
      }),
    ).toEqual({ audio: 0, transcripts: 1, communications: 0 });
    expect(calls).toBe(1);
    const current = (await history.get(instanceId, communication.id))!;
    expect(current.transcripts).toEqual([]);
    expect(current.revision).toBe(3);
    expect(current.recording).toEqual(communication.recording);
    expect(
      (await history.readRecording(instanceId, current.recording!.id)).bytes,
    ).toEqual(audio);
    expect(
      (
        await db.query(
          'SELECT id FROM sd_processing_jobs WHERE instance_id=$1',
          [instanceId],
        )
      ).rows,
    ).toEqual([]);
    const shared = await db.query<{
      id: string;
      result: unknown;
      state: string;
      payload: unknown;
    }>(
      'SELECT id,result,state,payload FROM sd_jobs WHERE instance_id=$1 ORDER BY id',
      [instanceId],
    );
    expect(shared.rows.map((row) => row.id).sort()).toEqual(jobIds.sort());
    expect(shared.rows.every((row) => row.result === null)).toBe(true);
    expect(shared.rows.some((row) => row.state === 'cancelled')).toBe(true);
    expect(
      shared.rows.every(
        (row) => JSON.stringify(row.payload) === '{"sourceRemoved":true}',
      ),
    ).toBe(true);
    expect(
      (
        await db.query(
          'SELECT packet FROM digital_evidence_probe WHERE instance_id=$1 AND artifact_id=$2',
          [instanceId, current.recording!.artifactId],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('rolls back derivative cleanup, transcript deletion and revision changes when the callback fails', async () => {
    const history = new HistoryService(db, storage, {
      onDeleteTranscripts: async (tx, source) => {
        await purge(tx, source);
        throw new Error('Synthetic purge failure.');
      },
    });
    const { communication, text } = await seed(history);
    await expect(
      history.applyRetention(instanceId, {
        transcriptsBefore: '2021-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('Synthetic purge failure.');
    const current = (await history.get(instanceId, communication.id))!;
    expect(current.revision).toBe(2);
    expect(current.transcripts[0]?.text).toBe(text);
    expect(
      (
        await db.query(
          'SELECT id FROM sd_processing_jobs WHERE instance_id=$1',
          [instanceId],
        )
      ).rows,
    ).toHaveLength(2);
    const shared = await db.query<{ result: { text: string } }>(
      'SELECT result FROM sd_jobs WHERE instance_id=$1',
      [instanceId],
    );
    expect(shared.rows.every((row) => row.result.text === text)).toBe(true);
    expect(
      (await history.readRecording(instanceId, current.recording!.id)).bytes,
    ).toEqual(audio);
  });
});
