import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '@signaldock/database';
import {
  TokenVault,
  hashSecret,
  signRelayPayload,
} from '@signaldock/notification-sdk/server';
import type { GrantRequest, RelaySend } from '@signaldock/notification-sdk';
import { PostgresRelayStore, relaySchemaFor } from '../src/store.js';
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
});
