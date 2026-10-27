import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InstallationEnrollmentClient,
  type GrantRequest,
  type RelaySend,
} from '@signaldock/notification-sdk';
import {
  hashSecret,
  signRelayPayload,
  TokenVault,
} from '@signaldock/notification-sdk/server';
import { RelayService } from '../src/service.js';
import { buildRelayServer } from '../src/server.js';
import { ExpoPushTransport } from '../src/expo.js';
import { FixturePushTransport, FixtureRelayStore } from './fixtures.js';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    privateKey: pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}
function context() {
  const store = new FixtureRelayStore();
  const push = new FixturePushTransport();
  let now = Date.parse('2026-10-26T12:00:00Z');
  const projectId = randomUUID(),
    installationId = randomUUID(),
    instanceId = randomUUID(),
    radioId = randomUUID();
  const device = keys(),
    instance = keys();
  const vault = new TokenVault(randomBytes(32));
  const service = new RelayService(
    store,
    vault,
    push,
    {
      mode: 'private-test',
      projectId,
      enrollmentSecretHash: hashSecret('private-invitation'),
    },
    () => now,
  );
  return {
    store,
    push,
    service,
    vault,
    projectId,
    installationId,
    instanceId,
    radioId,
    device,
    instance,
    time: () => new Date(now).toISOString(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function enrollment(
  c: ReturnType<typeof context>,
  pushToken = 'ExpoPushToken[fixture-device]',
) {
  const nonce = randomBytes(24).toString('hex');
  const request = await c.service.requestChallenge(
    {
      installationId: c.installationId,
      projectId: c.projectId,
      publicKey: c.device.publicKey,
      clientNonce: nonce,
      pushToken,
    },
    'private-invitation',
  );
  const challenge = c.push.messages.at(-1)!.data['challenge']!;
  const payload = {
    challengeId: request.challengeId,
    installationId: c.installationId,
    challenge,
    clientNonce: nonce,
  };
  await c.service.acknowledgeChallenge({
    payload,
    signature: signRelayPayload('enrollment-ack', payload, c.device.privateKey),
  });
  return { request, payload };
}
async function grant(
  c: ReturnType<typeof context>,
  pushToken = 'ExpoPushToken[fixture-device]',
) {
  await enrollment(c, pushToken);
  const payload: GrantRequest = {
    installationId: c.installationId,
    requestId: randomUUID(),
    nonce: randomUUID(),
    sentAt: c.time(),
    instanceId: c.instanceId,
    instancePublicKey: c.instance.publicKey,
    subscriptionRef: randomUUID(),
    categories: ['communication', 'incident'],
    radioIds: [c.radioId],
    expiresAt: new Date(Date.parse(c.time()) + 3600000).toISOString(),
  };
  return c.service.authorizeGrant({
    payload,
    signature: signRelayPayload('grant', payload, c.device.privateKey),
  });
}
function event(c: ReturnType<typeof context>, grantId: string): RelaySend {
  return {
    grantId,
    instanceId: c.instanceId,
    requestId: randomUUID(),
    nonce: randomUUID(),
    notificationId: randomUUID(),
    eventId: randomUUID(),
    category: 'communication',
    radioId: c.radioId,
    sentAt: c.time(),
    expiresAt: new Date(Date.parse(c.time()) + 120000).toISOString(),
  };
}

describe('private relay security and delivery', () => {
  it('requires a private invitation and proves token receipt without returning the challenge over HTTP', async () => {
    const c = context();
    const input = {
      installationId: c.installationId,
      projectId: c.projectId,
      publicKey: c.device.publicKey,
      clientNonce: 'a'.repeat(48),
      pushToken: 'ExpoPushToken[fixture-device]',
    };
    await expect(
      c.service.requestChallenge(input, 'wrong'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const result = await c.service.requestChallenge(
      input,
      'private-invitation',
    );
    expect(Object.keys(result).sort()).toEqual(['challengeId', 'expiresAt']);
    expect(c.push.messages[0]!.data['challenge']).toHaveLength(64);
    const pending = c.store.state.challenges.get(result.challengeId)!;
    expect(pending.tokenCiphertext).not.toContain(input.pushToken);
    expect(pending.challengeHash).not.toBe(
      c.push.messages[0]!.data['challenge'],
    );
    const payload = {
      challengeId: result.challengeId,
      installationId: c.installationId,
      clientNonce: input.clientNonce,
      challenge: '0'.repeat(64),
    };
    await expect(
      c.service.acknowledgeChallenge({
        payload,
        signature: signRelayPayload(
          'enrollment-ack',
          payload,
          c.device.privateKey,
        ),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('binds verification to the installation key and consumes a challenge exactly once', async () => {
    const c = context();
    const { payload } = await enrollment(c);
    expect(c.store.state.installations.get(c.installationId)?.verifiedAt).toBe(
      c.time(),
    );
    await expect(
      c.service.acknowledgeChallenge({
        payload,
        signature: signRelayPayload(
          'enrollment-ack',
          payload,
          c.device.privateKey,
        ),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const wrong = keys();
    await expect(
      c.service.requestChallenge(
        {
          installationId: c.installationId,
          projectId: c.projectId,
          publicKey: wrong.publicKey,
          clientNonce: 'n'.repeat(48),
          pushToken: 'ExpoPushToken[other]',
        },
        'private-invitation',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects forged signatures, forbidden radios/categories, and unknown grants', async () => {
    const c = context();
    const g = await grant(c);
    const payload = event(c, g.grantId);
    await expect(
      c.service.send({
        payload,
        signature: signRelayPayload('send', payload, c.device.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const wrong = { ...payload, radioId: randomUUID() };
    await expect(
      c.service.send({
        payload: wrong,
        signature: signRelayPayload('send', wrong, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const category = { ...payload, category: 'storage' as const };
    await expect(
      c.service.send({
        payload: category,
        signature: signRelayPayload('send', category, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const unknown = { ...payload, grantId: randomUUID() };
    await expect(
      c.service.send({
        payload: unknown,
        signature: signRelayPayload('send', unknown, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('deduplicates concurrent delivery and sends only opaque references', async () => {
    const c = context();
    const g = await grant(c);
    const payload = event(c, g.grantId);
    const signed = {
      payload,
      signature: signRelayPayload('send', payload, c.instance.privateKey),
    };
    await Promise.all([c.service.send(signed), c.service.send(signed)]);
    expect(c.push.messages).toHaveLength(2); // One challenge, one activity push.
    expect(c.push.messages[1]!.data).toEqual({
      instanceId: c.instanceId,
      radioId: c.radioId,
      eventId: payload.eventId,
      notificationId: payload.notificationId,
    });
    const changed = { ...payload, eventId: randomUUID() };
    await expect(
      c.service.send({
        payload: changed,
        signature: signRelayPayload('send', changed, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'REPLAY' });
    const replay = { ...payload, requestId: randomUUID() };
    await expect(
      c.service.send({
        payload: replay,
        signature: signRelayPayload('send', replay, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'REPLAY' });
  });
  it('allows independent instance grants and revokes one directly without its backend', async () => {
    const c = context();
    const a = await grant(c);
    const second = keys();
    const request: GrantRequest = {
      installationId: c.installationId,
      requestId: randomUUID(),
      nonce: randomUUID(),
      sentAt: c.time(),
      instanceId: randomUUID(),
      instancePublicKey: second.publicKey,
      subscriptionRef: randomUUID(),
      categories: ['communication'],
      radioIds: [c.radioId],
      expiresAt: a.expiresAt,
    };
    const b = await c.service.authorizeGrant({
      payload: request,
      signature: signRelayPayload('grant', request, c.device.privateKey),
    });
    const revoke = {
      installationId: c.installationId,
      grantId: a.grantId,
      requestId: randomUUID(),
      nonce: randomUUID(),
      sentAt: c.time(),
    };
    await c.service.revoke({
      payload: revoke,
      signature: signRelayPayload('revoke', revoke, c.device.privateKey),
    });
    const payload = event(c, a.grantId);
    await expect(
      c.service.send({
        payload,
        signature: signRelayPayload('send', payload, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(c.store.state.grants.get(b.grantId)?.revokedAt).toBeNull();
  });
  it('enforces bounded TTL, timestamp windows and per-installation quota', async () => {
    const c = context();
    const g = await grant(c);
    const late = {
      ...event(c, g.grantId),
      expiresAt: new Date(Date.parse(c.time()) + 600000).toISOString(),
    };
    await expect(
      c.service.send({
        payload: late,
        signature: signRelayPayload('send', late, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const stale = event(c, g.grantId);
    c.advance(61000);
    await expect(
      c.service.send({
        payload: stale,
        signature: signRelayPayload('send', stale, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    const limited = new RelayService(
      c.store,
      c.vault,
      c.push,
      {
        mode: 'private-test',
        projectId: c.projectId,
        enrollmentSecretHash: hashSecret('private-invitation'),
        maxGrantSendsPerMinute: 1,
      },
      () => Date.parse(c.time()),
    );
    for (let i = 0; i < 2; i++) {
      const payload = event(c, g.grantId);
      const promise = limited.send({
        payload,
        signature: signRelayPayload('send', payload, c.instance.privateKey),
      });
      if (i === 0) await promise;
      else
        await expect(promise).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    }
  });
  it('allows a backend to revoke only its own installation grant', async () => {
    const c = context();
    const g = await grant(c);
    const wrong = {
      grantId: g.grantId,
      instanceId: randomUUID(),
      nonce: randomUUID(),
      sentAt: c.time(),
    };
    await expect(
      c.service.revokeFromInstance({
        payload: wrong,
        signature: signRelayPayload(
          'instance-revoke',
          wrong,
          c.instance.privateKey,
        ),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const payload = { ...wrong, instanceId: c.instanceId };
    await c.service.revokeFromInstance({
      payload,
      signature: signRelayPayload(
        'instance-revoke',
        payload,
        c.instance.privateKey,
      ),
    });
    const send = event(c, g.grantId);
    await expect(
      c.service.send({
        payload: send,
        signature: signRelayPayload('send', send, c.instance.privateKey),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('cleans invalid registrations from provider receipts without claiming user visibility', async () => {
    const c = context();
    const g = await grant(c);
    const payload = event(c, g.grantId);
    await c.service.send({
      payload,
      signature: signRelayPayload('send', payload, c.instance.privateKey),
    });
    c.push.invalidDevice = true;
    expect(await c.service.pollReceipts()).toBe(1);
    expect(
      c.store.state.installations.get(c.installationId)?.tokenCiphertext,
    ).toBe('');
    expect(c.store.state.grants.get(g.grantId)?.revokedAt).toBe(c.time());
    expect(c.store.state.deliveries.get(payload.requestId)?.state).toBe(
      'failed',
    );
  });
  it('does not revoke a newly verified registration when an old token receipt arrives late', async () => {
    const c = context(),
      old = await grant(c);
    const payload = event(c, old.grantId);
    await c.service.send({
      payload,
      signature: signRelayPayload('send', payload, c.instance.privateKey),
    });
    const reserved = c.store.state.deliveries.get(
      payload.requestId,
    )!.registrationId;
    c.advance(1);
    const fresh = await grant(c, 'ExpoPushToken[rotated-device]');
    const current = structuredClone(
      c.store.state.installations.get(c.installationId)!,
    );
    expect(current.registrationId).not.toBe(reserved);
    c.push.invalidDevice = true;
    await c.service.pollReceipts();
    expect(c.store.state.installations.get(c.installationId)).toEqual(current);
    expect(c.store.state.grants.get(fresh.grantId)?.revokedAt).toBeNull();
    expect(c.store.state.deliveries.get(payload.requestId)?.state).toBe(
      'failed',
    );
  });
  it('ignores an immediate invalid-token response from a send overtaken by reenrollment', async () => {
    const c = context(),
      old = await grant(c);
    const payload = event(c, old.grantId);
    let sending!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      sending = resolve;
    });
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = c.push.send.bind(c.push);
    c.push.send = async (message) => {
      if (message.title === 'SignalDock') {
        sending();
        await providerGate;
        return { status: 'error' as const, error: 'DeviceNotRegistered' };
      }
      return original(message);
    };
    const pending = c.service.send({
      payload,
      signature: signRelayPayload('send', payload, c.instance.privateKey),
    });
    await sendStarted;
    c.advance(1);
    const fresh = await grant(c, 'ExpoPushToken[replacement-device]');
    const current = structuredClone(
      c.store.state.installations.get(c.installationId)!,
    );
    release();
    await pending;
    expect(c.store.state.installations.get(c.installationId)).toEqual(current);
    expect(c.store.state.grants.get(fresh.grantId)?.revokedAt).toBeNull();
  });
  it('never disables a registration from a legacy receipt with unknown token generation', async () => {
    const c = context(),
      g = await grant(c);
    const payload = event(c, g.grantId);
    await c.service.send({
      payload,
      signature: signRelayPayload('send', payload, c.instance.privateKey),
    });
    c.store.state.deliveries.get(payload.requestId)!.registrationId = null;
    const current = structuredClone(
      c.store.state.installations.get(c.installationId)!,
    );
    c.push.invalidDevice = true;
    await c.service.pollReceipts();
    expect(c.store.state.installations.get(c.installationId)).toEqual(current);
    expect(c.store.state.grants.get(g.grantId)?.revokedAt).toBeNull();
  });
  it('refuses public activation and invalid HTTP payloads', async () => {
    const c = context();
    expect(
      () =>
        new RelayService(c.store, c.vault, c.push, {
          mode: 'public' as never,
          projectId: c.projectId,
          enrollmentSecretHash: hashSecret('x'),
        }),
    ).toThrow();
    const app = buildRelayServer(c.service);
    try {
      expect((await app.inject('/health')).json()).toMatchObject({
        publicEnrollment: false,
      });
      const result = await app.inject({
        method: 'POST',
        url: '/v1/deliveries',
        payload: {
          payload: { url: 'http://internal.invalid' },
          signature: 'fake',
        },
      });
      expect(result.statusCode).toBe(400);
      expect(result.body).not.toContain('internal.invalid');
    } finally {
      await app.close();
    }
  });
  it('uses only the fixed Expo HTTPS destination and an isolated publisher credential', async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      captured = { url: String(url), init };
      return Response.json({ data: { id: 'receipt', status: 'ok' } });
    };
    const transport = new ExpoPushTransport('publisher-secret', fetcher);
    await transport.send({
      token: 'ExpoPushToken[fixture]',
      title: 'SignalDock',
      body: 'Update',
      expiresAt: '2026-10-26T12:02:00Z',
      data: { eventId: randomUUID() },
    });
    expect(captured?.url).toBe('https://exp.host/--/api/v2/push/send');
    expect(captured?.init?.redirect).toBe('error');
    expect(captured?.init?.headers).toMatchObject({
      Authorization: 'Bearer publisher-secret',
    });
    expect(JSON.parse(String(captured?.init?.body)).expiration).toBe(
      Date.parse('2026-10-26T12:02:00Z') / 1000,
    );
  });
  it('accepts a device challenge only for a locally initiated enrollment', async () => {
    const c = context();
    const app = buildRelayServer(c.service);
    const fetcher: typeof fetch = async (url, init) => {
      const response = await app.inject({
        method: 'POST',
        url: new URL(String(url)).pathname,
        headers: init?.headers as Record<string, string>,
        payload: JSON.parse(String(init?.body)),
      });
      return new Response(response.body || null, {
        status: response.statusCode,
      });
    };
    const client = new InstallationEnrollmentClient(
      'http://localhost:3001',
      c.installationId,
      {
        publicKey: c.device.publicKey,
        sign: async (bytes) => {
          const { sign } = await import('node:crypto');
          return sign(null, bytes, c.device.privateKey).toString('base64url');
        },
      },
      fetcher,
      () => Date.parse(c.time()),
    );
    try {
      await client.begin(
        'ExpoPushToken[fixture-device]',
        c.projectId,
        'private-invitation',
        'a'.repeat(48),
      );
      const received = c.push.messages[0]!.data;
      await expect(
        client.acknowledgeReceivedChallenge({
          ...received,
          clientNonce: 'b'.repeat(48),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await client.acknowledgeReceivedChallenge(received);
      expect(c.store.state.installations.has(c.installationId)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
