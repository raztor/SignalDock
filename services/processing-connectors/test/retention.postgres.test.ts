import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabasePort } from '@signaldock/contracts';
import { processingMigrations } from '../../../apps/api/src/modules/processing/migrations.js';
import { removeProcessingSourceDerivatives } from '../src/retention.js';

const url = process.env['TEST_DATABASE_URL'];
function transactionPort(client: PoolClient): DatabasePort {
  const port: DatabasePort = {
    query: async (text, values = []) => {
      const result = await client.query(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    transaction: async (action) => action(port),
  };
  return port;
}
describe.skipIf(!url)('real PostgreSQL processing retention', () => {
  const schema = `sd_processing_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema},public`,
  });
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    // Queue columns used by this adapter match the shared foundation; domain DDL is the real migration.
    await pool.query(`CREATE TABLE sd_jobs(instance_id uuid NOT NULL,id uuid NOT NULL,kind text NOT NULL,payload jsonb NOT NULL,source jsonb,result jsonb,error text,state text NOT NULL,cancelled_at timestamptz,updated_at timestamptz DEFAULT now(),PRIMARY KEY(instance_id,id));
      CREATE TABLE sd_job_attempts(instance_id uuid NOT NULL,id uuid NOT NULL,job_id uuid NOT NULL,error text,PRIMARY KEY(instance_id,id));`);
    for (const migration of processingMigrations)
      await pool.query(migration.sql);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });
  it('atomically removes copied text/results, cancels in-flight jobs, and preserves other sources/instances', async () => {
    const instanceId = randomUUID();
    const otherInstance = randomUUID();
    const sourceId = randomUUID();
    const otherSource = randomUUID();
    const jobId = randomUUID();
    const runningJob = randomUUID();
    const unrelatedJob = randomUUID();
    const owner = randomUUID();
    const profileId = randomUUID();
    const connectionId = randomUUID();
    for (const instance of [instanceId, otherInstance]) {
      await pool.query(
        'INSERT INTO sd_processing_connections(instance_id,id,connector_id,display_name,endpoint,capabilities) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [
          instance,
          connectionId,
          'fixture.text',
          'Fixture',
          'http://localhost',
          '["text.structured"]',
        ],
      );
      await pool.query(
        'INSERT INTO sd_processing_profiles(instance_id,id,connection_id,revision,profile) VALUES($1,$2,$3,1,$4::jsonb)',
        [
          instance,
          profileId,
          connectionId,
          JSON.stringify({
            profileId,
            connectionId,
            revision: 1,
            capability: 'text.structured',
            model: 'fixture',
            allowCloud: false,
          }),
        ],
      );
    }
    const seed = async (
      instance: string,
      id: string,
      communicationId: string,
      state: string,
    ) => {
      const source = {
        communicationId,
        communicationRevision: 1,
        transcriptRevisionId: randomUUID(),
      };
      const request = {
        instanceId: instance,
        jobId: id,
        profileId,
        profileRevision: 1,
        task: 'conversation.summarize',
        taskVersion: 1,
        deadline: new Date(Date.now() + 60000).toISOString(),
        input: {
          kind: 'text',
          text: 'Synthetic private source text',
          communicationIds: [communicationId],
        },
      };
      const result = {
        output: { kind: 'summary', text: 'Synthetic derived private text' },
      };
      await pool.query(
        'INSERT INTO sd_processing_jobs(instance_id,id,owner_user_id,profile_id,request,actor,source,state,result,fingerprint,idempotency_key) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10,$11)',
        [
          instance,
          id,
          owner,
          profileId,
          JSON.stringify(request),
          JSON.stringify({ userId: owner, instanceId: instance }),
          JSON.stringify(source),
          state,
          JSON.stringify(result),
          id,
          id,
        ],
      );
      await pool.query(
        'INSERT INTO sd_jobs(instance_id,id,kind,payload,source,state,result,error) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8)',
        [
          instance,
          id,
          'processing.execute',
          JSON.stringify({
            processingJobId: id,
            diagnostic: 'Synthetic private source text',
          }),
          JSON.stringify(source),
          state,
          JSON.stringify(result),
          'Synthetic private diagnostic',
        ],
      );
      await pool.query(
        'INSERT INTO sd_job_attempts(instance_id,id,job_id,error) VALUES($1,$2,$3,$4)',
        [instance, randomUUID(), id, 'Synthetic private diagnostic'],
      );
    };
    await seed(instanceId, jobId, sourceId, 'completed');
    await seed(instanceId, runningJob, sourceId, 'running');
    await seed(instanceId, unrelatedJob, otherSource, 'completed');
    await seed(otherInstance, jobId, sourceId, 'completed');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await removeProcessingSourceDerivatives(
        transactionPort(client),
        instanceId,
        sourceId,
      );
      await client.query('ROLLBACK');
      expect(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM sd_processing_jobs WHERE instance_id=$1',
              [instanceId],
            )
          ).rows[0].count,
        ),
      ).toBe(3);
      await client.query('BEGIN');
      expect(
        await removeProcessingSourceDerivatives(
          transactionPort(client),
          instanceId,
          sourceId,
        ),
      ).toEqual({ domainJobsDeleted: 2, sharedJobsCleared: 2 });
      await client.query('COMMIT');
      expect(
        (
          await pool.query(
            'SELECT id FROM sd_processing_jobs WHERE instance_id=$1',
            [instanceId],
          )
        ).rows,
      ).toEqual([{ id: unrelatedJob }]);
      expect(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM sd_processing_jobs WHERE instance_id=$1',
              [otherInstance],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      const scrubbed = (
        await pool.query(
          'SELECT id,result,error,payload,state FROM sd_jobs WHERE instance_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
          [instanceId, [jobId, runningJob]],
        )
      ).rows;
      expect(
        scrubbed.every(
          (row) =>
            row.result === null &&
            row.error === null &&
            row.payload.sourceRemoved === true &&
            !JSON.stringify(row).includes('Synthetic'),
        ),
      ).toBe(true);
      expect(scrubbed.find((row) => row.id === runningJob)?.state).toBe(
        'cancelled',
      );
      expect(
        (
          await pool.query(
            'SELECT error FROM sd_job_attempts WHERE instance_id=$1 AND job_id=ANY($2::uuid[])',
            [instanceId, [jobId, runningJob]],
          )
        ).rows.every((row) => row.error === null),
      ).toBe(true);
      await client.query('BEGIN');
      expect(
        await removeProcessingSourceDerivatives(
          transactionPort(client),
          instanceId,
          sourceId,
        ),
      ).toEqual({ domainJobsDeleted: 0, sharedJobsCleared: 2 });
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
