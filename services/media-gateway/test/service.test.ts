import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticationPort,
  Principal,
  RadioSnapshot,
} from '@signaldock/contracts';
import { TxSupervisor } from '@signaldock/radio-runtime/tx';
import { MediaService } from '../src/service.js';
import { LiveKitCredentials } from '../src/livekit.js';

const cleanup: MediaService[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((media) => media.close()));
});
function fixture() {
  const principal: Principal = {
    instanceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    username: 'operator',
    role: 'operator',
    radioPermissions: [],
  };
  const radioId = crypto.randomUUID(),
    generation = crypto.randomUUID();
  let denied = false;
  const auth: AuthenticationPort = {
    authenticate: async () => principal,
    authorize: async () => {
      if (denied) throw new Error('revoked');
    },
  };
  const snapshot: RadioSnapshot = {
    radioId,
    generation,
    revision: 1,
    connection: 'ready',
    tuningConfidence: 'confirmed',
    observedTuning: { rxHz: 145000000, mode: 'FM' },
    txState: 'idle',
  };
  const supervisor = new TxSupervisor({
    runtime: {
      snapshot: () => snapshot,
      validateControl: () => ({ fencing: 1, expiresAt: Date.now() + 30000 }),
      reserveTransmission: () => undefined,
      releaseTransmission: () => undefined,
    },
    driver: () => ({
      prepare: async () => undefined,
      write: async () => undefined,
      renew: async () => undefined,
      end: async () => ({ state: 'idle', physicallyConfirmed: true }),
      observe: async () => ({ state: 'idle', physicallyConfirmed: true }),
    }),
  });
  const credentials = new LiveKitCredentials({
    serverUrl: 'ws://127.0.0.1:7885',
    apiKey: 'test',
    apiSecret: 'synthetic-secret-for-tests',
  });
  vi.spyOn(credentials, 'revoke').mockResolvedValue();
  const media = new MediaService({
    instanceId: principal.instanceId,
    auth,
    credentials,
    supervisor,
    rxSource: () => {
      throw new Error('No physical radio in this test.');
    },
  });
  vi.spyOn(media, 'attachRadio').mockResolvedValue();
  cleanup.push(media);
  const start = () =>
    media.startTx(principal, {
      radioId,
      generation,
      controlGrant: crypto.randomUUID(),
      expectedRevision: 1,
    });
  return {
    media,
    principal,
    radioId,
    start,
    supervisor,
    deny: () => {
      denied = true;
    },
  };
}
describe('media enrollment', () => {
  it('binds grants and media sessions to both account and login session', async () => {
    const f = fixture();
    const tx = await f.start();
    const other = { ...f.principal, sessionId: crypto.randomUUID() };
    await expect(
      f.media.createSession(other, 'token', {
        radioId: f.radioId,
        mode: 'transmit',
        txGrantId: tx.grant.txGrantId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const enrolled = await f.media.createSession(f.principal, 'token', {
      radioId: f.radioId,
      mode: 'listen',
    });
    await expect(
      f.media.removeSession(enrolled.id, other),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects duplicate transmit participants and stops on login revocation', async () => {
    const f = fixture();
    const tx = await f.start();
    const input = {
      radioId: f.radioId,
      mode: 'transmit' as const,
      txGrantId: tx.grant.txGrantId,
    };
    const first = f.media.createSession(f.principal, 'token', input);
    await expect(
      f.media.createSession(f.principal, 'token', input),
    ).rejects.toMatchObject({ code: 'CONTROL_BUSY' });
    await first;
    await f.media.revokeSession(f.principal.sessionId);
    expect(f.supervisor.get(tx.grant.txGrantId).state).toBe('idle');
  });
  it('requires permission for admission and renewal while retaining owned stop', async () => {
    const f = fixture();
    const tx = await f.start();
    f.deny();
    await expect(
      f.media.renewTx(tx.grant.txGrantId, f.principal),
    ).rejects.toThrow('revoked');
    expect((await f.media.stopTx(tx.grant.txGrantId, f.principal)).state).toBe(
      'idle',
    );
    await expect(
      f.media.createSession(f.principal, 'token', {
        radioId: f.radioId,
        mode: 'listen',
      }),
    ).rejects.toThrow('revoked');
  });
  it('rejects late admissions and transmission starts after shutdown', async () => {
    const f = fixture();
    await f.media.close();
    await expect(f.start()).rejects.toMatchObject({
      code: 'RADIO_UNAVAILABLE',
    });
    await expect(
      f.media.createSession(f.principal, 'token', {
        radioId: f.radioId,
        mode: 'listen',
      }),
    ).rejects.toMatchObject({ code: 'RADIO_UNAVAILABLE' });
  });
});
