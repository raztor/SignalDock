import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresDatabase,
  foundationMigrations,
  migrate,
} from '@signaldock/database';
import type {
  DatabasePort,
  Principal,
  AuthenticationPort,
  NotificationAudiencePort,
} from '@signaldock/contracts';
import type {
  RelayDeliveryPort,
  RelayGrantInspection,
} from '@signaldock/notification-sdk/server';
import { identityMigrations } from '../src/modules/identity/identity.migrations.js';
import { NotificationService } from '../src/modules/notifications/service.js';
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
      ...identityMigrations,
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
  async function seedSession(
    value: { instanceId: string; userId: string; sessionId: string },
    options: { refreshExpiresAt?: string; accessExpiresAt?: string } = {},
  ) {
    const now = new Date().toISOString(),
      future = new Date(Date.now() + 3600000).toISOString();
    await database.query(
      "INSERT INTO sd_users(instance_id,id,username,password_hash,role,created_at,updated_at) VALUES($1,$2,$3,'unused','listener',$4,$4) ON CONFLICT DO NOTHING",
      [
        value.instanceId,
        value.userId,
        `u${value.userId.replaceAll('-', '')}`,
        now,
      ],
    );
    await database.query(
      "INSERT INTO sd_sessions(instance_id,id,user_id,access_token_hash,csrf_token_hash,mode,access_expires_at,refresh_expires_at,created_at,last_seen_at) VALUES($1,$2,$3,$4,'unused','token',$5,$6,$7,$7)",
      [
        value.instanceId,
        value.sessionId,
        value.userId,
        randomUUID(),
        options.accessExpiresAt ?? future,
        options.refreshExpiresAt ?? future,
        now,
      ],
    );
  }
  function serviceFixture(principal: Principal, relay: RelayDeliveryPort) {
    const repository = new PostgresNotificationRepository(database);
    const auth: AuthenticationPort = {
      authenticate: async () => principal,
      authorize: async () => undefined,
    };
    const { sessionId: _session, ...audienceUser } = principal;
    const audience: NotificationAudiencePort = {
      resolveUser: async () => audienceUser,
      authorizeUser: async () => undefined,
    };
    return new NotificationService(repository, auth, audience, relay);
  }
  function enrollment() {
    const principal: Principal = {
      instanceId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      username: 'listener',
      role: 'listener',
      radioPermissions: [],
    };
    const grant: RelayGrantInspection = {
      grantId: randomUUID(),
      installationId: randomUUID(),
      instanceId: principal.instanceId,
      instancePublicKey: 'fixture',
      subscriptionRef: principal.userId,
      categories: ['communication'],
      radioIds: [],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      revokedAt: null,
    };
    return { principal, grant };
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
  it('admits exactly one simultaneous notification per cooldown and permits its other channel', async () => {
    const repository = new PostgresNotificationRepository(database),
      base = record();
    const rows = await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.create({
          ...base,
          record: { ...base.record, id: randomUUID(), eventId: randomUUID() },
        }),
      ),
    );
    const admissions = await Promise.all(
      rows.map((row) =>
        repository.admit(
          row.notification,
          'foreground',
          base.record.createdAt,
          30,
        ),
      ),
    );
    expect(admissions.filter(Boolean)).toHaveLength(1);
    const winner = rows[admissions.indexOf(true)]!.notification;
    expect(
      await repository.admit(winner, 'relay', base.record.createdAt, 30),
    ).toBe(true);
    expect(
      await repository.admit(winner, 'foreground', base.record.createdAt, 30),
    ).toBe(false);
    expect(
      await repository.list(base.record.instanceId, base.record.userId, 10),
    ).toHaveLength(6);
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
    await seedSession(subscription);
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
    await seedSession(first);
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
  it('rejects enrollment when relay inspection returns after logout and its callback completed', async () => {
    const { principal, grant } = enrollment();
    await seedSession(principal);
    let inspected!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => {
      inspected = resolve;
    });
    let release!: () => void;
    const inspectionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = serviceFixture(principal, {
      inspect: async () => {
        inspected();
        await inspectionGate;
        return grant;
      },
      send: async (payload) => ({
        requestId: payload.requestId,
        state: 'provider_accepted',
      }),
    });
    const pending = service.subscribe(principal, {
      deviceRef: grant.installationId,
      grantRef: grant.grantId,
    });
    await inspectionStarted;
    await database.query(
      'UPDATE sd_sessions SET revoked_at=clock_timestamp() WHERE instance_id=$1 AND id=$2',
      [principal.instanceId, principal.sessionId],
    );
    await service.revokeForUser(
      principal.instanceId,
      principal.userId,
      principal.sessionId,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    release();
    await rejected;
    expect(
      await new PostgresNotificationRepository(database).subscriptions(
        principal.instanceId,
        principal.userId,
      ),
    ).toHaveLength(0);
  });
  it('serializes subscription creation against an uncommitted session revocation', async () => {
    const { principal, grant } = enrollment();
    await seedSession(principal);
    const repository = new PostgresNotificationRepository(database);
    let revoked!: () => void;
    const revocationLocked = new Promise<void>((resolve) => {
      revoked = resolve;
    });
    let commit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const revocation = database.transaction(async (tx) => {
      await tx.query(
        'UPDATE sd_sessions SET revoked_at=clock_timestamp() WHERE instance_id=$1 AND id=$2',
        [principal.instanceId, principal.sessionId],
      );
      revoked();
      await commitGate;
    });
    await revocationLocked;
    const pending = repository.saveSubscription({
      id: randomUUID(),
      instanceId: principal.instanceId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      deviceRef: grant.installationId,
      grantRef: grant.grantId,
      categories: grant.categories,
      radioIds: [],
      expiresAt: grant.expiresAt,
      revokedAt: null,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    commit();
    await revocation;
    await rejected;
  });
  it('rechecks revoked and absolute refresh expiry for delivery without requiring a fresh access token', async () => {
    for (const mode of [
      'access_expired',
      'refresh_expired',
      'revoked',
    ] as const) {
      const { principal, grant } = enrollment();
      await seedSession(principal, {
        accessExpiresAt: new Date(Date.now() - 60000).toISOString(),
      });
      let sends = 0;
      const service = serviceFixture(principal, {
        inspect: async () => grant,
        send: async (payload) => {
          sends++;
          return { requestId: payload.requestId, state: 'provider_accepted' };
        },
      });
      await service.subscribe(principal, {
        deviceRef: grant.installationId,
        grantRef: grant.grantId,
      });
      if (mode === 'refresh_expired')
        await database.query(
          "UPDATE sd_sessions SET refresh_expires_at=clock_timestamp()-interval '1 second' WHERE instance_id=$1 AND id=$2",
          [principal.instanceId, principal.sessionId],
        );
      if (mode === 'revoked')
        await database.query(
          'UPDATE sd_sessions SET revoked_at=clock_timestamp() WHERE instance_id=$1 AND id=$2',
          [principal.instanceId, principal.sessionId],
        );
      const notification = await service.publishForUser(principal.userId, {
        instanceId: principal.instanceId,
        eventId: randomUUID(),
        category: 'communication',
        occurredAt: new Date().toISOString(),
      });
      await service.deliver(principal.instanceId, notification!.id);
      expect(sends).toBe(mode === 'access_expired' ? 1 : 0);
    }
  });
});
