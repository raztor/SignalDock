import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  PostgresDatabase,
  foundationMigrations,
  migrate,
  appendOutbox,
  dispatchOutbox,
} from '../src/index.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('real PostgreSQL infrastructure', () => {
  const schema = `sd_test_${crypto.randomUUID().replaceAll('-', '')}`;
  let db: PostgresDatabase;
  const admin = new Client({ connectionString: url });
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    await migrate(db, foundationMigrations);
  });
  afterAll(async () => {
    await db?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  it('uses a real PostgreSQL 18 server', async () => {
    const result = await db.query<{ version: string }>('SHOW server_version');
    expect(String(Object.values(result.rows[0]!)[0])).toMatch(/^18\./);
    expect(await db.health()).toEqual({ available: true });
  });
  it('commits and rolls back on one transaction connection, including nested savepoints', async () => {
    await db.query('CREATE TABLE transaction_probe (id integer PRIMARY KEY)');
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO transaction_probe VALUES(1)');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await db.query('SELECT * FROM transaction_probe')).rows).toEqual(
      [],
    );
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO transaction_probe VALUES(2)');
      await expect(
        tx.transaction(async (inner) => {
          await inner.query('INSERT INTO transaction_probe VALUES(3)');
          throw new Error('nested');
        }),
      ).rejects.toThrow('nested');
      await tx.query('INSERT INTO transaction_probe VALUES(4)');
    });
    expect(
      (await db.query('SELECT id FROM transaction_probe ORDER BY id')).rows,
    ).toEqual([{ id: 2 }, { id: 4 }]);
  });
  it('serializes first migrations and rejects edited migration history', async () => {
    await Promise.all([
      migrate(db, foundationMigrations),
      migrate(db, foundationMigrations),
    ]);
    expect(
      (await db.query('SELECT id FROM sd_schema_migrations')).rows,
    ).toEqual([{ id: '001_foundation' }]);
    await expect(
      migrate(db, [{ id: '001_foundation', sql: 'SELECT 1' }]),
    ).rejects.toThrow('modified');
  });
  it('atomically persists outbox and domain changes and retries failed delivery', async () => {
    const instanceId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await appendOutbox(tx, {
          instanceId,
          id,
          type: 'fixture',
          payload: { value: 1 },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    expect(
      (await db.query('SELECT id FROM sd_event_outbox WHERE id=$1', [id])).rows,
    ).toHaveLength(0);
    await appendOutbox(db, {
      instanceId,
      id,
      type: 'fixture',
      payload: { value: 1 },
    });
    await expect(
      dispatchOutbox(db, async () => {
        throw new Error('unavailable');
      }),
    ).rejects.toThrow('unavailable');
    const received: string[] = [];
    expect(
      await dispatchOutbox(db, async (event) => {
        received.push(event.id);
      }),
    ).toBe(1);
    expect(
      await dispatchOutbox(db, async (event) => {
        received.push(event.id);
      }),
    ).toBe(0);
    expect(received).toEqual([id]);
  });
});
