import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  foundationMigrations,
  migrate,
  PostgresDatabase,
} from '@signaldock/database';
import type { JobInput } from '@signaldock/contracts';
import { PostgresJobQueue } from '../src/index.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)(
  'station-scoped PostgreSQL workers sharing business tables',
  () => {
    const instanceA = randomUUID(),
      instanceB = randomUUID(),
      id = randomUUID();
    const schema = `sd_scoped_jobs_${randomUUID().replaceAll('-', '')}`;
    const bossSchema = (instanceId: string) =>
      `sd_queue_${instanceId.replaceAll('-', '')}`;
    const admin = new Client({ connectionString: url });
    let db: PostgresDatabase,
      queueA: PostgresJobQueue,
      queueB: PostgresJobQueue;
    const receivedA: string[] = [],
      receivedB: string[] = [];
    beforeAll(async () => {
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      db = new PostgresDatabase({
        connectionString: url,
        options: `-c search_path=${schema},public`,
      });
      await migrate(db, foundationMigrations);
      queueA = new PostgresJobQueue(db, {
        connectionString: url!,
        instanceId: instanceA,
      });
      queueB = new PostgresJobQueue(db, {
        connectionString: url!,
        instanceId: instanceB,
      });
      queueA.register('station.fixture', async (job) => {
        receivedA.push(job.instanceId);
        return { station: 'A' };
      });
      queueB.register('station.fixture', async (job) => {
        receivedB.push(job.instanceId);
        return { station: 'B' };
      });
    });
    afterAll(async () => {
      await queueA?.stop();
      await queueB?.stop();
      await db?.close();
      for (const owned of [
        schema,
        bossSchema(instanceA),
        bossSchema(instanceB),
      ])
        await admin.query(`DROP SCHEMA IF EXISTS ${owned} CASCADE`);
      await admin.end();
    });
    const job = (instanceId: string): JobInput => ({
      instanceId,
      jobId: id,
      kind: 'station.fixture',
      payload: { station: instanceId },
      idempotencyKey: 'same-idempotency-key',
      deadline: new Date(Date.now() + 30000).toISOString(),
    });
    async function until(check: () => Promise<boolean>) {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Scoped job did not finish.');
    }
    it('does not enqueue/read/cancel another station and publishes only its own older or colliding jobs', async () => {
      await expect(queueA.enqueue(job(instanceB))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await queueA.enqueue(job(instanceA));
      await queueB.enqueue(job(instanceB));
      expect(await queueA.get(instanceB, id)).toBeNull();
      await expect(queueA.cancel(instanceB, id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // Start B first while A's event is older. A must remain untouched.
      await queueB.start();
      await until(
        async () => (await queueB.get(instanceB, id))?.state === 'completed',
      );
      expect((await queueA.get(instanceA, id))?.state).toBe('queued');
      expect(receivedA).toEqual([]);
      expect(receivedB).toEqual([instanceB]);
      const pending = await db.query<{ delivered_at: Date | null }>(
        "SELECT delivered_at FROM sd_event_outbox WHERE instance_id=$1 AND type='job.enqueue'",
        [instanceA],
      );
      expect(pending.rows[0]?.delivered_at).toBeNull();
      await queueA.start();
      await until(
        async () => (await queueA.get(instanceA, id))?.state === 'completed',
      );
      expect(receivedA).toEqual([instanceA]);
      expect(receivedB).toEqual([instanceB]);
      expect((await queueB.get(instanceB, id))?.attempts).toBe(1);
    }, 25000);
  },
);
