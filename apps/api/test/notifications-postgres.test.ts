import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresDatabase,
  foundationMigrations,
  migrate,
} from '@signaldock/database';
import type { DatabasePort } from '@signaldock/contracts';
import { notificationMigrations } from '../src/modules/notifications/migrations.js';
import {
  PostgresNotificationRepository,
  type StoredNotification,
} from '../src/modules/notifications/repository.js';

const url = process.env['SIGNALDOCK_TEST_DATABASE_URL'];
describe.skipIf(!url)('notification PostgreSQL integrity', () => {
  let admin: PostgresDatabase;
  let database: PostgresDatabase;
  let schema: string;
  beforeEach(async () => {
    schema = `sd_notification_test_${randomUUID().replaceAll('-', '')}`;
    admin = new PostgresDatabase({ connectionString: url! });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = new PostgresDatabase({
      connectionString: url!,
      options: `-c search_path=${schema},public`,
    });
    await migrate(database, [
      ...foundationMigrations,
      ...notificationMigrations,
    ]);
  });
  afterEach(async () => {
    await database?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
    }
  });
  function record(): StoredNotification {
    const createdAt = new Date().toISOString();
    return {
      record: {
        id: randomUUID(),
        instanceId: randomUUID(),
        userId: randomUUID(),
        radioId: randomUUID(),
        eventId: randomUUID(),
        category: 'communication',
        createdAt,
        deliveryState: 'queued',
      },
      frequencyHz: 145500000,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
  }
  it('deduplicates concurrent events and commits their outbox atomically', async () => {
    const repository = new PostgresNotificationRepository(database);
    const input = record();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => repository.create(input)),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(
      (
        await database.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM sd_event_outbox',
        )
      ).rows[0]?.count,
    ).toBe('1');
    expect(
      await repository.find(
        input.record.instanceId,
        randomUUID(),
        input.record.id,
      ),
    ).toBeNull();
    expect(
      await repository.find(randomUUID(), input.record.userId, input.record.id),
    ).toBeNull();
    const result = (
      await repository.list(input.record.instanceId, input.record.userId, 10)
    )[0]!;
    expect(result.record.id).toBe(input.record.id);
    expect(result.frequencyHz).toBe(145500000);
  });
  it('rolls back visible notification state if the transactional outbox append fails', async () => {
    const failing: DatabasePort = {
      query: (text, values) => database.query(text, values),
      transaction: (action) =>
        database.transaction((tx) =>
          action({
            query: (text, values) => {
              if (text.startsWith('INSERT INTO sd_event_outbox'))
                throw new Error('Injected outbox failure');
              return tx.query(text, values);
            },
            transaction: (run) => tx.transaction(run),
          }),
        ),
    };
    await expect(
      new PostgresNotificationRepository(failing).create(record()),
    ).rejects.toThrow('outbox failure');
    expect(
      (
        await database.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM sd_notifications',
        )
      ).rows[0]?.count,
    ).toBe('0');
  });
  it('revokes a subscription and queues relay revocation in the same transaction', async () => {
    const repository = new PostgresNotificationRepository(database);
    const input = record();
    const subscription = {
      id: randomUUID(),
      instanceId: input.record.instanceId,
      userId: input.record.userId,
      sessionId: randomUUID(),
      deviceRef: randomUUID(),
      grantRef: randomUUID(),
      categories: ['communication'],
      radioIds: [input.record.radioId!],
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    await repository.saveSubscription(subscription);
    await repository.revokeSubscription(
      subscription.instanceId,
      subscription.userId,
      subscription.id,
      new Date().toISOString(),
    );
    await repository.revokeSubscription(
      subscription.instanceId,
      subscription.userId,
      subscription.id,
      new Date().toISOString(),
    );
    expect(
      (
        await repository.subscriptions(
          subscription.instanceId,
          subscription.userId,
        )
      )[0]?.revokedAt,
    ).not.toBeNull();
    expect(
      (
        await database.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM sd_event_outbox WHERE type='notification.subscription_revoked'",
        )
      ).rows[0]?.count,
    ).toBe('1');
  });
  it('revokes superseded relay grants when the same installation enrolls again', async () => {
    const repository = new PostgresNotificationRepository(database);
    const input = record();
    const first = {
      id: randomUUID(),
      instanceId: input.record.instanceId,
      userId: input.record.userId,
      sessionId: randomUUID(),
      deviceRef: randomUUID(),
      grantRef: randomUUID(),
      categories: ['communication'],
      radioIds: [],
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    await repository.saveSubscription(first);
    const replacement = { ...first, id: randomUUID(), grantRef: randomUUID() };
    await repository.saveSubscription(replacement);
    expect(
      await repository.subscriptions(first.instanceId, first.userId),
    ).toHaveLength(1);
    const outbox = await database.query<{ payload: { grantId: string } }>(
      "SELECT payload FROM sd_event_outbox WHERE type='notification.subscription_revoked'",
    );
    expect(outbox.rows[0]?.payload.grantId).toBe(first.grantRef);
  });
});
