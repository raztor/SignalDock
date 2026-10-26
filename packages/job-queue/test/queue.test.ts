import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  foundationMigrations,
  migrate,
  PostgresDatabase,
} from '@signaldock/database';
import type { JobInput } from '@signaldock/contracts';
import { PostgresJobQueue } from '../src/index.js';

const url = process.env['TEST_DATABASE_URL'];
async function until(predicate: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Background job did not reach the expected state.');
}
describe.skipIf(!url)('real PostgreSQL job lifecycle', () => {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const schema = `sd_jobtest_${suffix}`;
  const bossSchema = `sd_boss_${suffix}`;
  const admin = new Client({ connectionString: url });
  let db: PostgresDatabase;
  let queue: PostgresJobQueue;
  let release: () => void = () => {};
  let started = false;
  let calls = 0;
  let releaseGuarded: () => void = () => {};
  let guardedStarted = false;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    await migrate(db, foundationMigrations);
    await db.query(
      'CREATE TABLE source_probe(instance_id uuid,id uuid,revision integer,PRIMARY KEY(instance_id,id));CREATE TABLE derived_probe(instance_id uuid,id uuid,PRIMARY KEY(instance_id,id))',
    );
    queue = new PostgresJobQueue(db, {
      connectionString: url!,
      schema: bossSchema,
      validateSource: async (input, tx) => {
        const source = input.source!;
        const row = (
          await tx.query<{ revision: number }>(
            'SELECT revision FROM source_probe WHERE instance_id=$1 AND id=$2 FOR UPDATE',
            [input.instanceId, source.communicationId],
          )
        ).rows[0];
        return row?.revision === source.communicationRevision;
      },
    });
    queue.register('fixture.run', async (input) => {
      calls++;
      return { instanceId: input.instanceId, done: true };
    });
    queue.register('fixture.slow', async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { late: true };
    });
    queue.register('fixture.retry', async () => {
      if (calls++ === 0)
        throw new Error('Temporary failure with secret=not-for-ledger');
      return { ok: true };
    });
    queue.register('fixture.commit', async (input, _signal, execution) =>
      execution.commit(async (tx) => {
        await tx.query('INSERT INTO derived_probe VALUES($1,$2)', [
          input.instanceId,
          input.jobId,
        ]);
        await tx.query(
          'UPDATE source_probe SET revision=revision+1 WHERE instance_id=$1 AND id=$2',
          [input.instanceId, input.source!.communicationId],
        );
        return { committed: true };
      }),
    );
    queue.register('fixture.late-commit', async (input, _signal, execution) => {
      guardedStarted = true;
      await new Promise<void>((resolve) => {
        releaseGuarded = resolve;
      });
      return execution.commit(async (tx) => {
        await tx.query('INSERT INTO derived_probe VALUES($1,$2)', [
          input.instanceId,
          input.jobId,
        ]);
        return { late: true };
      });
    });
  });
  afterAll(async () => {
    release();
    await queue?.stop();
    await db?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  function input(kind = 'fixture.run'): JobInput {
    return {
      instanceId: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      kind,
      payload: { value: 1 },
      idempotencyKey: crypto.randomUUID(),
      deadline: new Date(Date.now() + 30000).toISOString(),
      maxAttempts: 2,
    };
  }
  it('commits job publication with caller domain transaction and deduplicates correctly', async () => {
    const job = input();
    await expect(
      db.transaction(async (tx) => {
        await queue.enqueue(job, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await queue.get(job.instanceId, job.jobId)).toBeNull();
    expect(await queue.enqueue(job)).toEqual({
      jobId: job.jobId,
      duplicate: false,
    });
    expect(await queue.enqueue({ ...job, jobId: crypto.randomUUID() })).toEqual(
      { jobId: job.jobId, duplicate: true },
    );
    await expect(
      queue.enqueue({ ...job, payload: { value: 2 } }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await queue.start();
    await until(
      async () =>
        (await queue.get(job.instanceId, job.jobId))?.state === 'completed',
    );
    expect((await queue.get(job.instanceId, job.jobId))?.attempts).toBe(1);
    expect(await queue.get(crypto.randomUUID(), job.jobId)).toBeNull();
  }, 20000);
  it('handles colliding job IDs in separate instances without suppressing either', async () => {
    const a = input();
    const b = { ...input(), jobId: a.jobId };
    await queue.enqueue(a);
    await queue.enqueue(b);
    await queue.publishPending();
    await until(
      async () =>
        (await queue.get(a.instanceId, a.jobId))?.state === 'completed' &&
        (await queue.get(b.instanceId, b.jobId))?.state === 'completed',
    );
  });
  it('cancels before dispatch and suppresses late completion after cancellation', async () => {
    const before = input();
    await queue.enqueue(before);
    await queue.cancel(before.instanceId, before.jobId);
    await queue.publishPending();
    expect((await queue.get(before.instanceId, before.jobId))?.attempts).toBe(
      0,
    );
    const slow = input('fixture.slow');
    await queue.enqueue(slow);
    await queue.publishPending();
    await until(async () => started);
    await queue.cancel(slow.instanceId, slow.jobId);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await queue.get(slow.instanceId, slow.jobId))?.state).toBe(
      'cancelled',
    );
    expect(
      (
        await db.query(
          'SELECT result FROM sd_jobs WHERE instance_id=$1 AND id=$2',
          [slow.instanceId, slow.jobId],
        )
      ).rows[0]?.['result'],
    ).toBeNull();
  });
  it('rejects stale source references and exposes missing handlers without infinite retries', async () => {
    const stale = {
      ...input(),
      source: {
        communicationId: crypto.randomUUID(),
        communicationRevision: 1,
      },
    };
    const missing = input('fixture.not-installed');
    await queue.enqueue(stale);
    await queue.enqueue(missing);
    await queue.publishPending();
    await until(
      async () =>
        (await queue.get(stale.instanceId, stale.jobId))?.state ===
          'cancelled' &&
        (await queue.get(missing.instanceId, missing.jobId))?.state ===
          'requires_configuration',
    );
    expect((await queue.get(stale.instanceId, stale.jobId))?.attempts).toBe(0);
  });
  it('retries a failed attempt once and records attempt fencing', async () => {
    calls = 0;
    const job = input('fixture.retry');
    await queue.enqueue(job);
    await queue.publishPending();
    await until(
      async () =>
        (await queue.get(job.instanceId, job.jobId))?.state === 'completed',
    );
    expect((await queue.get(job.instanceId, job.jobId))?.attempts).toBe(2);
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS count FROM sd_job_attempts WHERE instance_id=$1 AND job_id=$2',
          [job.instanceId, job.jobId],
        )
      ).rows[0]?.['count'],
    ).toBe(2);
  });
  it('atomically completes a guarded derivative that advances its own source revision', async () => {
    const job = {
      ...input('fixture.commit'),
      source: {
        communicationId: crypto.randomUUID(),
        communicationRevision: 1,
      },
    };
    await db.query('INSERT INTO source_probe VALUES($1,$2,1)', [
      job.instanceId,
      job.source.communicationId,
    ]);
    await queue.enqueue(job);
    await queue.publishPending();
    await until(
      async () =>
        (await queue.get(job.instanceId, job.jobId))?.state === 'completed',
    );
    expect(
      (
        await db.query(
          'SELECT revision FROM source_probe WHERE instance_id=$1 AND id=$2',
          [job.instanceId, job.source.communicationId],
        )
      ).rows[0]?.['revision'],
    ).toBe(2);
    expect(
      (
        await db.query(
          'SELECT id FROM derived_probe WHERE instance_id=$1 AND id=$2',
          [job.instanceId, job.jobId],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('does not let a handler ignoring cancellation commit a late derivative', async () => {
    const job = input('fixture.late-commit');
    await queue.enqueue(job);
    await queue.publishPending();
    await until(async () => guardedStarted);
    await queue.cancel(job.instanceId, job.jobId);
    releaseGuarded();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await queue.get(job.instanceId, job.jobId))?.state).toBe(
      'cancelled',
    );
    expect(
      (
        await db.query(
          'SELECT id FROM derived_probe WHERE instance_id=$1 AND id=$2',
          [job.instanceId, job.jobId],
        )
      ).rows,
    ).toHaveLength(0);
  });
});
