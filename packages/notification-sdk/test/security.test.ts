import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  relaySigningMessage,
  resolveNotificationReference,
} from '../src/index.js';
import {
  signRelayPayload,
  TokenVault,
  verifyRelayPayload,
} from '../src/server/index.js';

describe('notification client trust boundary', () => {
  it('selects only saved instances and rejects payload-supplied credential destinations', () => {
    const instanceId = randomUUID();
    const payload = {
      instanceId,
      eventId: randomUUID(),
      notificationId: randomUUID(),
    };
    const saved = [{ instanceId, baseUrl: 'https://station.example/prefix' }];
    expect(resolveNotificationReference(payload, saved)?.baseUrl).toBe(
      saved[0]!.baseUrl,
    );
    expect(
      resolveNotificationReference(
        { ...payload, backendUrl: 'https://other.example' },
        saved,
      ),
    ).toBeNull();
    expect(
      resolveNotificationReference(
        { ...payload, instanceId: randomUUID() },
        saved,
      ),
    ).toBeNull();
  });
  it('authenticates token ciphertext to one installation and rejects corruption', () => {
    const vault = new TokenVault(randomBytes(32));
    const installationId = randomUUID();
    const encrypted = vault.encrypt(installationId, 'ExpoPushToken[fixture]');
    expect(vault.decrypt(installationId, encrypted)).toBe(
      'ExpoPushToken[fixture]',
    );
    expect(() => vault.decrypt(randomUUID(), encrypted)).toThrow();
    const corrupted = Buffer.from(encrypted, 'base64url');
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    expect(() =>
      vault.decrypt(installationId, corrupted.toString('base64url')),
    ).toThrow();
  });
  it('separates signed request domains with consistent browser/server canonicalization', () => {
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const publicKey = pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const payload = {
      requestId: randomUUID(),
      scope: ['incident'],
      omitted: undefined,
    };
    expect(relaySigningMessage('send', payload)).toBe(
      relaySigningMessage('send', {
        scope: ['incident'],
        requestId: payload.requestId,
      }),
    );
    const signature = signRelayPayload('send', payload, privateKey);
    expect(() =>
      verifyRelayPayload('send', payload, signature, publicKey),
    ).not.toThrow();
    expect(() =>
      verifyRelayPayload('revoke', payload, signature, publicKey),
    ).toThrow();
  });
});
