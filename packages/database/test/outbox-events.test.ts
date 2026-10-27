import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendOutbox,
  dispatchOutbox,
  foundationMigrations,
  migrate,
  PostgresDatabase,
  PostgresOutboxEvents,
  type OutboxEvent,
} from '../src/index.js';

const url = process.env['TEST_DATABASE_URL'];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(15);
  }
  throw new Error('Outbox fanout did not reach the expected state.');
}
describe.skipIf(!url)('PostgreSQL cross-process outbox refresh fanout', () => {
  const schema = `sd_outbox_events_${randomUUID().replaceAll('-', '')}`,
    instanceA = randomUUID(),
    instanceB = randomUUID(),
    radioId = randomUUID();
  const admin = new Client({ connectionString: url });
  let database: PostgresDatabase,
    brokerA: PostgresOutboxEvents,
    brokerB: PostgresOutboxEvents,
    connectionString: string;
  const eventsA: OutboxEvent[] = [],
    eventsB: OutboxEvent[] = [],
    errors: Error[] = [];
  let reconnects = 0;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    connectionString = scoped.href;
    database = new PostgresDatabase({ connectionString });
    await migrate(database, foundationMigrations);
    brokerA = new PostgresOutboxEvents({
      connectionString,
      instanceId: instanceA,
      reconnectDelayMs: 25,
      onError: (error) => errors.push(error),
      onReconnect: () => {
        reconnects++;
      },
    });
    brokerB = new PostgresOutboxEvents({
      connectionString,
      instanceId: instanceB,
      onError: (error) => errors.push(error),
    });
    await brokerA.start((event) => {
      eventsA.push(event);
    });
    await brokerB.start((event) => {
      eventsB.push(event);
    });
  });
  afterAll(async () => {
    await brokerA?.close();
    await brokerB?.close();
    await database?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  const append = async (
    instanceId: string,
    id = randomUUID(),
    payload: unknown = { fixture: true },
  ) => {
    await appendOutbox(database, {
      instanceId,
      id,
      type: 'fixture.created',
      radioId,
      payload,
    });
    return id;
  };
  it('passes the acknowledgement transaction to delivery and fans out only after its commit', async () => {
    const publisherOnly = new PostgresOutboxEvents({
      connectionString,
      instanceId: instanceA,
    });
    const id = await append(instanceA),
      before = eventsA.length;
    await dispatchOutbox(
      database,
      async (event, tx) => {
        expect(event).toMatchObject({
          instanceId: instanceA,
          id,
          radioId,
          type: 'fixture.created',
        });
        expect(event.occurredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
        await publisherOnly.publish(event.id, tx);
        await pause(60);
        expect(eventsA).toHaveLength(before);
        expect(
          (
            await tx.query<{ delivered_at: Date | null }>(
              'SELECT delivered_at FROM sd_event_outbox WHERE instance_id=$1 AND id=$2',
              [instanceA, id],
            )
          ).rows[0]?.delivered_at,
        ).toBeNull();
      },
      50,
      instanceA,
    );
    await until(() => eventsA.some((event) => event.id === id));
    expect(eventsB).toEqual([]);
    expect(
      (
        await database.query<{ delivered_at: Date | null }>(
          'SELECT delivered_at FROM sd_event_outbox WHERE instance_id=$1 AND id=$2',
          [instanceA, id],
        )
      ).rows[0]?.delivered_at,
    ).toBeInstanceOf(Date);
  });
  it('suppresses rolled-back notifications and retains retryable outbox acknowledgements', async () => {
    const id = await append(instanceA),
      before = eventsA.length;
    await expect(
      dispatchOutbox(
        database,
        async (event, tx) => {
          await brokerA.publish(event.id, tx);
          throw new Error('Synthetic transaction rollback.');
        },
        50,
        instanceA,
      ),
    ).rejects.toThrow('Synthetic transaction rollback.');
    await pause(75);
    expect(eventsA).toHaveLength(before);
    expect(
      (
        await database.query<{ delivered_at: Date | null }>(
          'SELECT delivered_at FROM sd_event_outbox WHERE instance_id=$1 AND id=$2',
          [instanceA, id],
        )
      ).rows[0]?.delivered_at,
    ).toBeNull();
    await dispatchOutbox(
      database,
      async (event, tx) => brokerA.publish(event.id, tx),
      50,
      instanceA,
    );
    await until(() => eventsA.some((event) => event.id === id));
    expect(eventsA.filter((event) => event.id === id)).toHaveLength(1);
    const absent = randomUUID();
    await expect(
      database.transaction(async (tx) => {
        await appendOutbox(tx, {
          instanceId: instanceA,
          id: absent,
          type: 'fixture.rolled_back',
          payload: {},
        });
        await brokerA.publish(absent, tx);
        throw new Error('Rollback insert.');
      }),
    ).rejects.toThrow('Rollback insert.');
    await pause(60);
    expect(eventsA.some((event) => event.id === absent)).toBe(false);
  });
  it('hydrates payloads above the NOTIFY limit and cannot read another instance with a colliding event id', async () => {
    const id = randomUUID(),
      large = 'canonical payload '.repeat(2048);
    await append(instanceA, id, { large, station: 'A' });
    await append(instanceB, id, { station: 'B' });
    await dispatchOutbox(
      database,
      async (event, tx) => brokerA.publish(event.id, tx),
      50,
      instanceA,
    );
    await until(() => eventsA.some((event) => event.id === id));
    expect(eventsA.find((event) => event.id === id)?.payload).toEqual({
      large,
      station: 'A',
    });
    expect(eventsB.some((event) => event.id === id)).toBe(false);
    await dispatchOutbox(
      database,
      async (event, tx) => brokerB.publish(event.id, tx),
      50,
      instanceB,
    );
    await until(() => eventsB.some((event) => event.id === id));
    expect(eventsB.find((event) => event.id === id)?.payload).toEqual({
      station: 'B',
    });
    const foreignOnly = await append(instanceB);
    await database.transaction((tx) => brokerA.publish(foreignOnly, tx));
    await pause(60);
    expect(eventsA.some((event) => event.id === foreignOnly)).toBe(false);
  });
  it('reconnects a dedicated listener, invokes resynchronization only after reconnection, and cleans up its connection', async () => {
    expect(reconnects).toBe(0);
    const name = `sd-outbox:${instanceA}`;
    const old = (
      await admin.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE application_name=$1',
        [name],
      )
    ).rows[0]!;
    expect(old.pid).toBeGreaterThan(0);
    await admin.query('SELECT pg_terminate_backend($1)', [old.pid]);
    await until(
      async () =>
        reconnects === 1 &&
        (
          await admin.query(
            "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND pid<>$2 AND query LIKE 'LISTEN%'",
            [name, old.pid],
          )
        ).rowCount === 1,
    );
    const id = await append(instanceA);
    await database.transaction((tx) => brokerA.publish(id, tx));
    await until(() => eventsA.some((event) => event.id === id));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    await brokerA.close();
    expect(
      (
        await admin.query(
          'SELECT pid FROM pg_stat_activity WHERE application_name=$1',
          [name],
        )
      ).rows,
    ).toEqual([]);
  });
  it('broadcasts one committed reference to separate same-instance listener clients', async () => {
    const instance = randomUUID(),
      received: OutboxEvent[][] = [[], []];
    const first = new PostgresOutboxEvents({
        connectionString,
        instanceId: instance,
      }),
      second = new PostgresOutboxEvents({
        connectionString,
        instanceId: instance,
      });
    const publisher = new PostgresOutboxEvents({
      connectionString,
      instanceId: instance,
    });
    try {
      await first.start((event) => {
        received[0]!.push(event);
      });
      await second.start((event) => {
        received[1]!.push(event);
      });
      const id = await append(instance);
      await dispatchOutbox(
        database,
        async (event, tx) => publisher.publish(event.id, tx),
        50,
        instance,
      );
      await until(() =>
        received.every((events) => events.some((event) => event.id === id)),
      );
      expect(received[0]).toEqual(received[1]);
      expect(received[0]).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
      await publisher.close();
    }
    expect(
      (
        await admin.query(
          'SELECT pid FROM pg_stat_activity WHERE application_name=$1',
          [`sd-outbox:${instance}`],
        )
      ).rows,
    ).toEqual([]);
  });
  it('bounds pending events and closes without waiting forever for a subscriber callback', async () => {
    const instance = randomUUID(),
      overflow: Error[] = [],
      name = `sd-outbox:${instance}`;
    let release: () => void = () => {},
      entered = false,
      callbackSignal: AbortSignal | undefined;
    const broker = new PostgresOutboxEvents({
      connectionString,
      instanceId: instance,
      maxPendingEvents: 1,
      onError: (error) => overflow.push(error),
    });
    try {
      await broker.start(async (_event, signal) => {
        callbackSignal = signal;
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const first = await append(instance);
      await database.transaction((tx) => broker.publish(first, tx));
      await until(() => entered);
      const second = await append(instance);
      await database.transaction((tx) => broker.publish(second, tx));
      await until(() =>
        overflow.some((error) => error.message.includes('queue is full')),
      );
      await Promise.race([
        broker.close(),
        pause(500).then(() => {
          throw new Error('Broker close did not interrupt delivery.');
        }),
      ]);
      expect(callbackSignal?.aborted).toBe(true);
      expect(
        (
          await admin.query(
            'SELECT pid FROM pg_stat_activity WHERE application_name=$1',
            [name],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      release();
      await broker.close();
    }
  });
});
