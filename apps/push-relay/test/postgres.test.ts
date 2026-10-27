import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDatabase, migrate } from '@signaldock/database';
import type { DatabasePort } from '@signaldock/contracts';
import {
  TokenVault,
  hashSecret,
  signRelayPayload,
} from '@signaldock/notification-sdk/server';
import type { GrantRequest, RelaySend } from '@signaldock/notification-sdk';
import {
  PostgresRelayStore,
  relaySchemaFor,
  relayMigrations,
  type StoredDelivery,
} from '../src/store.js';
import { RelayService } from '../src/service.js';
import { FixturePushTransport } from './fixtures.js';

const url = process.env['SIGNALDOCK_TEST_DATABASE_URL'];
function keys() {
  const value = generateKeyPairSync('ed25519');
  return {
    publicKey: value.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    privateKey: value.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}
describe.skipIf(!url)('persistent private relay', () => {
  let database: PostgresDatabase;
  let schema: string;
  beforeEach(async () => {
    database = new PostgresDatabase({ connectionString: url! });
    schema = `sd_relay_test_${randomUUID().replaceAll('-', '')}`;
    await database.query(relaySchemaFor(schema));
  });
  afterEach(async () => {
    if (database) {
      await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await database.close();
    }
  });
  it('preserves replay/idempotency protection across service restart without resending a push', async () => {
    const push = new FixturePushTransport(),
      device = keys(),
      instance = keys(),
      installationId = randomUUID(),
      projectId = randomUUID(),
      instanceId = randomUUID(),
      radioId = randomUUID();
    const options = {
      mode: 'private-test' as const,
      projectId,
      enrollmentSecretHash: hashSecret('private'),
    };
    const vault = new TokenVault(randomBytes(32));
    const make = () =>
      new RelayService(
        new PostgresRelayStore(database, schema),
        vault,
        push,
        options,
      );
    const service = make();
    const nonce = 'n'.repeat(48);
    const pending = await service.requestChallenge(
      {
        installationId,
        projectId,
        publicKey: device.publicKey,
        clientNonce: nonce,
        pushToken: 'ExpoPushToken[test-device]',
      },
      'private',
    );
    const ack = {
      challengeId: pending.challengeId,
      installationId,
      challenge: push.messages[0]!.data['challenge']!,
      clientNonce: nonce,
    };
    await service.acknowledgeChallenge({
      payload: ack,
      signature: signRelayPayload('enrollment-ack', ack, device.privateKey),
    });
    const request: GrantRequest = {
      installationId,
      requestId: randomUUID(),
      nonce: randomUUID(),
      sentAt: new Date().toISOString(),
      instanceId,
      instancePublicKey: instance.publicKey,
      subscriptionRef: randomUUID(),
      categories: ['communication'],
      radioIds: [radioId],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const grant = await service.authorizeGrant({
      payload: request,
      signature: signRelayPayload('grant', request, device.privateKey),
    });
    const event: RelaySend = {
      grantId: grant.grantId,
      instanceId,
      requestId: randomUUID(),
      nonce: randomUUID(),
      notificationId: randomUUID(),
      eventId: randomUUID(),
      category: 'communication',
      radioId,
      sentAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    };
    const signed = {
      payload: event,
      signature: signRelayPayload('send', event, instance.privateKey),
    };
    await Promise.all([service.send(signed), service.send(signed)]);
    expect((await make().send(signed)).state).toBe('provider_accepted');
    expect(push.messages).toHaveLength(2);
    const records = await database.query<{
      document: { tokenCiphertext: string };
    }>(`SELECT document FROM ${schema}.installations`);
    expect(JSON.stringify(records.rows)).not.toContain('ExpoPushToken');
    expect(records.rows[0]?.document.tokenCiphertext).toBeTruthy();
    const altered = { ...event, requestId: randomUUID() };
    await expect(
      make().send({
        payload: altered,
        signature: signRelayPayload('send', altered, instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'REPLAY' });
  });
  it.each(['send', 'inspect'] as const)(
    'rechecks a grant revoked while %s waited on its installation lock',
    async (mode) => {
      const store = new PostgresRelayStore(database, schema),
        push = new FixturePushTransport(),
        device = keys(),
        instance = keys();
      const installationId = randomUUID(),
        instanceId = randomUUID(),
        grantId = randomUUID(),
        now = new Date().toISOString(),
        vault = new TokenVault(randomBytes(32));
      await store.transaction(async (tx) => {
        await tx.saveInstallation({
          installationId,
          registrationId: randomUUID(),
          publicKey: device.publicKey,
          projectId: randomUUID(),
          tokenCiphertext: vault.encrypt(
            installationId,
            'ExpoPushToken[fixture]',
          ),
          verifiedAt: now,
          revokedAt: null,
        });
        await tx.saveGrant({
          grantId,
          installationId,
          instanceId,
          instancePublicKey: instance.publicKey,
          subscriptionRef: randomUUID(),
          categories: ['communication'],
          radioIds: [],
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          revokedAt: null,
        });
      });
      let locked!: () => void;
      const revocationLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let commit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        commit = resolve;
      });
      const revocation = store.transaction(async (tx) => {
        await tx.getInstallation(installationId);
        await tx.revokeGrants(
          installationId,
          new Date().toISOString(),
          grantId,
        );
        locked();
        await commitGate;
      });
      await revocationLocked;
      let waiting!: () => void;
      const lockRequested = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      const watch = (db: DatabasePort): DatabasePort => ({
        query: (text, values) => {
          if (
            text.includes(`${schema}.installations`) &&
            text.includes('FOR UPDATE')
          )
            waiting();
          return db.query(text, values);
        },
        transaction: (action) => db.transaction((tx) => action(watch(tx))),
      });
      const service = new RelayService(
        new PostgresRelayStore(watch(database), schema),
        vault,
        push,
        {
          mode: 'private-test',
          projectId: randomUUID(),
          enrollmentSecretHash: hashSecret('private'),
        },
      );
      const payload = { grantId, instanceId, nonce: randomUUID(), sentAt: now };
      const event: RelaySend = {
        ...payload,
        requestId: randomUUID(),
        notificationId: randomUUID(),
        eventId: randomUUID(),
        category: 'communication',
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      };
      const pending =
        mode === 'inspect'
          ? service.inspectGrant({
              payload,
              signature: signRelayPayload(
                'inspect',
                payload,
                instance.privateKey,
              ),
            })
          : service.send({
              payload: event,
              signature: signRelayPayload('send', event, instance.privateKey),
            });
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await lockRequested;
      commit();
      await revocation;
      await rejected;
      expect(push.messages).toHaveLength(0);
    },
  );
  it('upgrades legacy metadata without rewriting migration 001 or binding unknown receipts to a current token', async () => {
    const isolated = new PostgresDatabase({
      connectionString: url!,
      options: `-c search_path=${schema},public`,
    });
    const definitions = relayMigrations.map((migration) => ({
      ...migration,
      sql: migration.sql.replaceAll('sd_relay', schema),
    }));
    try {
      await migrate(isolated, definitions.slice(0, 1));
      const installationId = randomUUID(),
        requestId = randomUUID();
      await isolated.query(
        `INSERT INTO ${schema}.installations(id,document) VALUES($1,$2)`,
        [
          installationId,
          { installationId, tokenCiphertext: 'legacy-encrypted-token' },
        ],
      );
      await isolated.query(
        `INSERT INTO ${schema}.deliveries(id,installation_id,grant_id,created_at,document) VALUES($1,$2,$3,now(),$4)`,
        [
          requestId,
          installationId,
          randomUUID(),
          { requestId, state: 'provider_accepted' },
        ],
      );
      const first = (
        await isolated.query<{ checksum: string }>(
          'SELECT checksum FROM sd_schema_migrations WHERE id=$1',
          ['001_private_relay'],
        )
      ).rows[0]!.checksum;
      await migrate(isolated, definitions);
      await migrate(isolated, definitions);
      expect(
        (
          await isolated.query<{ checksum: string }>(
            'SELECT checksum FROM sd_schema_migrations WHERE id=$1',
            ['001_private_relay'],
          )
        ).rows[0]!.checksum,
      ).toBe(first);
      expect(
        (
          await isolated.query<{ document: { registrationId: string } }>(
            `SELECT document FROM ${schema}.installations WHERE id=$1`,
            [installationId],
          )
        ).rows[0]!.document.registrationId,
      ).toMatch(/^[a-f0-9-]{36}$/);
      expect(
        (
          await isolated.query<{ document: { registrationId: null } }>(
            `SELECT document FROM ${schema}.deliveries WHERE id=$1`,
            [requestId],
          )
        ).rows[0]!.document.registrationId,
      ).toBeNull();
    } finally {
      await isolated.close();
    }
  });
  it('persists fair receipt scheduling across restart with121 missing tickets before a newer invalid ticket', async () => {
    const store = new PostgresRelayStore(database, schema),
      push = new FixturePushTransport(),
      vault = new TokenVault(randomBytes(32)),
      device = keys(),
      installationId = randomUUID(),
      registrationId = randomUUID(),
      now = new Date().toISOString(),
      old = new Date(Date.now() - 3600000).toISOString(),
      future = new Date(Date.now() + 86400000).toISOString();
    const delivery: StoredDelivery = {
      requestId: randomUUID(),
      installationId,
      registrationId,
      grantId: randomUUID(),
      fingerprint: 'fixture',
      createdAt: now,
      expiresAt: future,
      state: 'provider_accepted',
      receiptChecked: false,
      ticketId: 'new-invalid',
      receiptAttempts: 0,
      receiptNextCheckAt: now,
      receiptRetryUntil: future,
      receiptLastCheckedAt: null,
    };
    await store.transaction(async (tx) => {
      await tx.saveInstallation({
        installationId,
        registrationId,
        publicKey: device.publicKey,
        projectId: randomUUID(),
        tokenCiphertext: vault.encrypt(
          installationId,
          'ExpoPushToken[current]',
        ),
        verifiedAt: now,
        revokedAt: null,
      });
      for (let i = 0; i < 121; i++)
        await tx.saveDelivery({
          ...delivery,
          requestId: randomUUID(),
          createdAt: old,
          receiptNextCheckAt: old,
          ticketId: `missing-${i}`,
        });
      await tx.saveDelivery(delivery);
    });
    push.receipts = async (ids) =>
      Object.fromEntries(
        ids
          .filter((id) => id === 'new-invalid')
          .map((id) => [
            id,
            { status: 'error' as const, error: 'DeviceNotRegistered' },
          ]),
      );
    const make = () =>
      new RelayService(new PostgresRelayStore(database, schema), vault, push, {
        mode: 'private-test',
        projectId: randomUUID(),
        enrollmentSecretHash: hashSecret('fixture'),
      });
    expect(await make().pollReceipts()).toBe(100);
    expect(
      (await store.transaction((tx) => tx.getInstallation(installationId)))
        ?.revokedAt,
    ).toBeNull();
    expect(await make().pollReceipts()).toBe(22);
    expect(
      (await store.transaction((tx) => tx.getInstallation(installationId)))
        ?.tokenCiphertext,
    ).toBe('');
    expect(
      (await store.transaction((tx) => tx.getDelivery(delivery.requestId)))
        ?.receiptChecked,
    ).toBe(true);
  });
  it.each(['rotation', 'revocation'] as const)(
    'does not let a stale receipt alter a concurrent %s of a newer registration',
    async (mode) => {
      const store = new PostgresRelayStore(database, schema),
        push = new FixturePushTransport(),
        vault = new TokenVault(randomBytes(32)),
        device = keys(),
        instance = keys();
      const installationId = randomUUID(),
        instanceId = randomUUID(),
        oldRegistration = randomUUID(),
        newRegistration = randomUUID(),
        grantId = randomUUID(),
        createdAt = new Date().toISOString(),
        expiresAt = new Date(Date.now() + 3600000).toISOString();
      const old = {
        installationId,
        registrationId: oldRegistration,
        publicKey: device.publicKey,
        projectId: randomUUID(),
        tokenCiphertext: vault.encrypt(installationId, 'ExpoPushToken[old]'),
        verifiedAt: createdAt,
        revokedAt: null,
      };
      const newer = {
        ...old,
        registrationId: newRegistration,
        tokenCiphertext: vault.encrypt(installationId, 'ExpoPushToken[new]'),
      };
      const delivery: StoredDelivery = {
        requestId: randomUUID(),
        installationId,
        registrationId: oldRegistration,
        grantId,
        fingerprint: 'immutable-fixture',
        createdAt,
        expiresAt,
        state: 'provider_accepted',
        receiptChecked: false,
        receiptAttempts: 0,
        receiptNextCheckAt: createdAt,
        receiptRetryUntil: expiresAt,
        receiptLastCheckedAt: null,
        ticketId: 'old-ticket',
      };
      await store.transaction(async (tx) => {
        await tx.saveInstallation(mode === 'rotation' ? old : newer);
        await tx.saveGrant({
          grantId,
          installationId,
          instanceId,
          instancePublicKey: instance.publicKey,
          subscriptionRef: randomUUID(),
          categories: ['communication'],
          radioIds: [],
          expiresAt,
          revokedAt: null,
        });
        await tx.saveDelivery(delivery);
      });
      await expect(
        store.transaction((tx) =>
          tx.saveDelivery({ ...delivery, registrationId: newRegistration }),
        ),
      ).rejects.toMatchObject({ code: 'REPLAY' });
      let locked!: () => void;
      const changed = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let commit!: () => void;
      const gate = new Promise<void>((resolve) => {
        commit = resolve;
      });
      const revokedAt = '2026-10-26T00:00:00.000Z';
      const current =
        mode === 'rotation'
          ? newer
          : { ...newer, tokenCiphertext: '', revokedAt };
      const update = store.transaction(async (tx) => {
        await tx.getInstallation(installationId);
        await tx.saveInstallation(current);
        if (mode === 'revocation')
          await tx.revokeGrants(installationId, revokedAt);
        locked();
        await gate;
      });
      await changed;
      let waiting!: () => void;
      const cleanupWaiting = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      const watch = (db: DatabasePort): DatabasePort => ({
        query: (text, values) => {
          if (
            text.includes(`${schema}.installations`) &&
            text.includes('FOR UPDATE')
          )
            waiting();
          return db.query(text, values);
        },
        transaction: (action) => db.transaction((tx) => action(watch(tx))),
      });
      push.invalidDevice = true;
      const service = new RelayService(
        new PostgresRelayStore(watch(database), schema),
        vault,
        push,
        {
          mode: 'private-test',
          projectId: old.projectId,
          enrollmentSecretHash: hashSecret('fixture'),
        },
      );
      const poll = service.pollReceipts();
      await cleanupWaiting;
      commit();
      await update;
      expect(await poll).toBe(1);
      const observed = await store.transaction((tx) =>
        tx.getInstallation(installationId),
      );
      expect(observed).toEqual(current);
      const grant = await store.transaction((tx) => tx.getGrant(grantId));
      expect(grant?.revokedAt).toBe(mode === 'rotation' ? null : revokedAt);
      const failed = await store.transaction((tx) =>
        tx.getDelivery(delivery.requestId),
      );
      expect(failed?.state).toBe('failed');
      expect(failed?.registrationId).toBe(oldRegistration);
    },
  );
});
