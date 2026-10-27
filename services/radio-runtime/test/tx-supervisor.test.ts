import { describe, expect, it } from 'vitest';
import {
  TxSupervisor,
  type TxDriverPort,
  type TxRuntimePort,
} from '../src/tx/supervisor.js';
import type {
  PcmAudioFrame,
  RadioSnapshot,
  TxGrant,
} from '@signaldock/contracts';

function fixture() {
  let now = 1000000;
  const radioId = crypto.randomUUID();
  const ownerId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const state: RadioSnapshot = {
    radioId,
    generation: crypto.randomUUID(),
    revision: 4,
    connection: 'ready',
    observedTuning: { rxHz: 145000000, mode: 'FM' },
    tuningConfidence: 'confirmed',
    txState: 'idle',
  };
  const releases: boolean[] = [];
  const writes: PcmAudioFrame[] = [];
  const renewals: TxGrant[] = [];
  let carrier = false;
  let endConfirmed = true;
  const runtime: TxRuntimePort = {
    snapshot: () => state,
    validateControl: () => ({ fencing: 7, expiresAt: now + 15000 }),
    reserveTransmission: () => undefined,
    releaseTransmission: (_radio, _grant, confirmed) => {
      releases.push(confirmed);
    },
  };
  const driver: TxDriverPort = {
    prepare: async () => undefined,
    write: async (_grant, frame) => {
      writes.push(frame);
      carrier = true;
    },
    renew: async (grant) => {
      renewals.push(grant);
    },
    observe: async () => ({
      state: carrier ? 'transmitting' : 'idle',
      physicallyConfirmed: true,
    }),
    end: async () => {
      carrier = false;
      return {
        state: endConfirmed ? 'idle' : 'unknown',
        physicallyConfirmed: endConfirmed,
      };
    },
  };
  const supervisor = new TxSupervisor({
    runtime,
    driver: () => driver,
    now: () => now,
    autoWatchdog: false,
    operationTimeoutMs: 30,
  });
  const start = () =>
    supervisor.start(
      {
        radioId,
        ownerId,
        sessionId,
        controlGrant: crypto.randomUUID(),
        generation: state.generation,
        expectedRevision: 4,
      },
      { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
    );
  const frame = (sequence = 0): PcmAudioFrame => ({
    streamId: 'stream-a',
    sequence,
    mediaTimeUs: sequence * 20000,
    format: { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
    data: new Uint8Array(1280),
    tuningRevision: 4,
    attributionConfidence: 'confirmed',
    discontinuity: false,
  });
  return {
    supervisor,
    start,
    frame,
    runtime,
    driver,
    state,
    ownerId,
    sessionId,
    writes,
    releases,
    renewals,
    advance: (ms: number) => {
      now += ms;
    },
    uncertainEnd: () => {
      endConfirmed = false;
    },
    confirmEnd: () => {
      endConfirmed = true;
    },
  };
}

describe('local TX supervisor', () => {
  it('prepares without claiming physical TX and requires observed state after audio', async () => {
    const f = fixture();
    const initial = await f.start();
    expect(initial.state).toBe('granted');
    expect(f.writes).toHaveLength(0);
    await f.supervisor.push(initial.grant.txGrantId, f.frame());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.supervisor.get(initial.grant.txGrantId).state).toBe(
      'transmitting',
    );
    expect((await f.supervisor.stop(initial.grant.txGrantId)).state).toBe(
      'idle',
    );
    expect(f.releases).toEqual([true]);
  });
  it('stops locally after heartbeat expiry without another API request', async () => {
    const f = fixture();
    const tx = await f.start();
    await f.supervisor.push(tx.grant.txGrantId, f.frame());
    f.advance(1501);
    await f.supervisor.sweep();
    expect(f.supervisor.get(tx.grant.txGrantId).state).toBe('idle');
    await expect(
      f.supervisor.push(tx.grant.txGrantId, f.frame(1)),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });
  it('propagates renewals to the driver and keeps an absolute continuous limit', async () => {
    const f = fixture();
    const tx = await f.start();
    for (let n = 0; n < 29; n++) {
      f.advance(1000);
      await f.supervisor.renew(tx.grant.txGrantId, f.ownerId, f.sessionId);
    }
    expect(f.renewals).toHaveLength(29);
    expect(f.renewals.at(-1)!.expiresAt).toBe(tx.grant.maxUntil);
    f.advance(1001);
    await f.supervisor.sweep();
    expect(f.supervisor.get(tx.grant.txGrantId).state).toBe('idle');
  });
  it('rejects another account/session and duplicate frame sequences', async () => {
    const f = fixture();
    const tx = await f.start();
    await expect(
      f.supervisor.renew(tx.grant.txGrantId, crypto.randomUUID(), f.sessionId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.supervisor.push(tx.grant.txGrantId, f.frame());
    await expect(
      f.supervisor.push(tx.grant.txGrantId, f.frame()),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await f.supervisor.close();
  });
  it('blocks retargeted audio after a tuning/generation change', async () => {
    const f = fixture();
    const tx = await f.start();
    f.state.observedTuning = { rxHz: 145500000, mode: 'FM' };
    await expect(
      f.supervisor.push(tx.grant.txGrantId, f.frame()),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(f.writes).toHaveLength(0);
  });
  it('does not label broken-link release idle or permit a new TX', async () => {
    const f = fixture();
    const tx = await f.start();
    f.uncertainEnd();
    expect((await f.supervisor.stop(tx.grant.txGrantId)).state).toBe(
      'stop_unconfirmed',
    );
    expect(f.releases).toEqual([false]);
    await expect(f.start()).rejects.toMatchObject({ code: 'CONTROL_BUSY' });
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(true);
    expect(f.releases).toEqual([false, true]);
  });
  it('fences a delayed prepare that completes after cancellation', async () => {
    const f = fixture();
    let finish!: () => void;
    f.driver.prepare = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const starting = f.start();
    const rejected = expect(starting).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.supervisor.invalidateControl(f.state.radioId, 'context_switched');
    await rejected;
    expect(f.releases).toEqual([false]);
    await expect(f.start()).rejects.toMatchObject({ code: 'CONTROL_BUSY' });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(true);
  });
  it('bounds an unresponsive stop', async () => {
    const f = fixture();
    const tx = await f.start();
    f.driver.end = () => new Promise(() => undefined);
    expect((await f.supervisor.stop(tx.grant.txGrantId)).state).toBe(
      'stop_unconfirmed',
    );
    expect(f.releases).toEqual([false]);
  });
  it('retains uncertainty until a cancelled write settles and idle is observed again', async () => {
    const f = fixture();
    const tx = await f.start();
    let finish!: () => void;
    f.driver.write = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const writing = f.supervisor.push(tx.grant.txGrantId, f.frame());
    const rejected = expect(writing).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await f.supervisor.stop(tx.grant.txGrantId)).state).toBe(
      'stop_unconfirmed',
    );
    await rejected;
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(false);
    expect(f.releases).toEqual([false]);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(true);
    expect(f.releases).toEqual([false, true]);
  });
  it('retains uncertainty while a cancelled renewal is still admitted', async () => {
    const f = fixture();
    const tx = await f.start();
    let finish!: () => void;
    f.driver.renew = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const renewing = f.supervisor.renew(
      tx.grant.txGrantId,
      f.ownerId,
      f.sessionId,
    );
    const rejected = expect(renewing).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await f.supervisor.stop(tx.grant.txGrantId)).state).toBe(
      'stop_unconfirmed',
    );
    await rejected;
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(false);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(true);
  });
  it('settles synchronous preparation failures and stops malformed active audio', async () => {
    const failed = fixture();
    failed.driver.prepare = () => {
      throw new Error('synchronous');
    };
    await expect(failed.start()).rejects.toThrow('synchronous');
    expect(failed.releases).toEqual([true]);
    const f = fixture();
    const tx = await f.start();
    await f.supervisor.push(tx.grant.txGrantId, f.frame());
    await expect(
      f.supervisor.push(tx.grant.txGrantId, { ...f.frame(1), mediaTimeUs: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.supervisor.get(tx.grant.txGrantId).state).toBe('idle');
  });
  it('requires a fresh current-epoch physical proof after reconnection', async () => {
    const f = fixture();
    const tx = await f.start();
    f.uncertainEnd();
    await f.supervisor.stop(tx.grant.txGrantId);
    f.state.generation = crypto.randomUUID();
    f.state.txState = 'idle';
    f.driver.observe = async () => {
      throw new Error('Old generation must not be observed.');
    };
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(false);
    f.driver.observeCurrent = async (context) => ({
      ...context,
      state: 'idle',
      physicallyConfirmed: false,
    });
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(false);
    expect(f.releases).toEqual([false]);
    f.state.txState = 'stop_unconfirmed';
    f.driver.observeCurrent = async (context) => ({
      ...context,
      state: 'idle',
      physicallyConfirmed: true,
    });
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(true);
    expect(f.releases).toEqual([false, true]);
    expect(f.supervisor.get(tx.grant.txGrantId).grant.generation).toBe(
      tx.grant.generation,
    );
    expect((await f.supervisor.stop(tx.grant.txGrantId)).state).toBe('idle');
  });
  it('uses fresh raw physical idle when the same-generation grant record remains uncertain', async () => {
    const f = fixture();
    const tx = await f.start();
    f.uncertainEnd();
    await f.supervisor.stop(tx.grant.txGrantId);
    f.state.txState = 'stop_unconfirmed';
    f.driver.observe = async () => {
      throw new Error('Cached last-transmission record must not be used.');
    };
    f.driver.observeCurrent = async (context) => ({
      ...context,
      state: 'idle',
      physicallyConfirmed: true,
    });
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(true);
    expect(f.releases).toEqual([false, true]);
    expect(f.supervisor.get(tx.grant.txGrantId).state).toBe('idle');
  });
  it('does not replace an uncertain fresh observation with a cached old idle result', async () => {
    const f = fixture();
    const tx = await f.start();
    f.uncertainEnd();
    await f.supervisor.stop(tx.grant.txGrantId);
    f.driver.observeCurrent = async (context) => ({
      ...context,
      state: 'unknown',
      physicallyConfirmed: false,
    });
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(false);
    expect(f.releases).toEqual([false]);
  });
  it('does not release across a changed or mismatched current-epoch observation', async () => {
    const f = fixture();
    const tx = await f.start();
    f.uncertainEnd();
    await f.supervisor.stop(tx.grant.txGrantId);
    f.state.generation = crypto.randomUUID();
    f.driver.observeCurrent = async (context) => {
      f.state.generation = crypto.randomUUID();
      return { ...context, state: 'idle', physicallyConfirmed: true };
    };
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(false);
    f.driver.observeCurrent = async (context) => ({
      ...context,
      radioId: crypto.randomUUID(),
      state: 'idle',
      physicallyConfirmed: true,
    });
    await expect(f.supervisor.reconcile(f.state.radioId)).rejects.toMatchObject(
      { code: 'STALE_GENERATION' },
    );
    expect(f.releases).toEqual([false]);
  });
  it('does not request a new-epoch proof until old admitted writes settle', async () => {
    const f = fixture();
    const tx = await f.start();
    let finish!: () => void;
    let proofs = 0;
    f.driver.write = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const writing = f.supervisor.push(tx.grant.txGrantId, f.frame());
    const rejected = expect(writing).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.supervisor.stop(tx.grant.txGrantId);
    await rejected;
    f.state.generation = crypto.randomUUID();
    f.driver.observeCurrent = async (context) => {
      proofs++;
      return { ...context, state: 'idle', physicallyConfirmed: true };
    };
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(false);
    expect(proofs).toBe(0);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(true);
    expect(proofs).toBe(1);
  });
  it('does not reuse an old-grant idle observation after its epoch changes during the read', async () => {
    const f = fixture();
    const tx = await f.start();
    f.uncertainEnd();
    await f.supervisor.stop(tx.grant.txGrantId);
    f.driver.observe = async () => {
      f.state.generation = crypto.randomUUID();
      return { state: 'idle', physicallyConfirmed: true };
    };
    expect(await f.supervisor.reconcile(f.state.radioId)).toBe(false);
    expect(f.releases).toEqual([false]);
  });
});
