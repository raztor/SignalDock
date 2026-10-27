import { describe, expect, it } from 'vitest';
import {
  SimulatedRadioDriver,
  simulationDescriptors,
} from '@signaldock/radio-driver-sdk';
import { RadioRuntime } from '../src/index.js';

const epoch = Date.parse('2026-10-26T12:00:00Z');
async function fixture() {
  let now = epoch;
  const runtime = new RadioRuntime(() => now);
  const descriptor = simulationDescriptors()[0]!;
  descriptor.capabilities.ptt = 'explicit';
  descriptor.capabilities.txAudio = true;
  descriptor.capabilities.physicalTxObservation = true;
  const driver = new SimulatedRadioDriver(descriptor, () => now);
  await driver.connect();
  runtime.register(driver);
  const ownerId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const lease = runtime.acquireControl(descriptor.radioId, ownerId, sessionId);
  return {
    runtime,
    driver,
    ownerId,
    sessionId,
    lease,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('session-fenced control and TX exclusion', () => {
  it('reports unconfirmed TX separately while blocking mutations without changing the tuning revision', async () => {
    const f = await fixture();
    const txGrantId = crypto.randomUUID();
    const before = f.runtime.snapshot(f.lease.radioId);
    f.runtime.reserveTransmission({
      radioId: f.lease.radioId,
      generation: f.lease.generation,
      ownerId: f.ownerId,
      sessionId: f.sessionId,
      controlGrant: f.lease.grantId,
      txGrantId,
    });
    f.runtime.setTransmissionState(
      f.lease.radioId,
      txGrantId,
      'tx_unconfirmed',
    );
    const current = f.runtime.snapshot(f.lease.radioId);
    expect(current.txState).toBe('tx_unconfirmed');
    expect(current.revision).toBe(before.revision);
    expect(current.observedTuning).toEqual(before.observedTuning);
    const context = {
      operationId: crypto.randomUUID(),
      radioId: f.lease.radioId,
      generation: before.generation,
      expectedRevision: before.revision,
      controlGrant: f.lease.grantId,
      deadline: new Date(epoch + 10000).toISOString(),
    };
    await expect(
      f.runtime.applyTuning({
        context,
        tuning: { rxHz: 146000000, mode: 'FM' },
      }),
    ).rejects.toMatchObject({ code: 'CONTROL_BUSY' });
    await expect(
      f.runtime.selectMemory(
        { ...context, operationId: crypto.randomUUID() },
        '1',
      ),
    ).rejects.toMatchObject({ code: 'CONTROL_BUSY' });
    f.runtime.releaseTransmission(f.lease.radioId, txGrantId, false);
    expect(() =>
      f.runtime.setTransmissionState(
        f.lease.radioId,
        txGrantId,
        'transmitting',
      ),
    ).toThrow(expect.objectContaining({ code: 'CONTROL_REQUIRED' }));
    expect(f.runtime.snapshot(f.lease.radioId).txState).toBe(
      'stop_unconfirmed',
    );
  });
  it('does not let another session reuse a user control grant', async () => {
    const f = await fixture();
    expect(() =>
      f.runtime.acquireControl(f.lease.radioId, f.ownerId, crypto.randomUUID()),
    ).toThrow(expect.objectContaining({ code: 'CONTROL_BUSY' }));
    expect(() =>
      f.runtime.validateControl({
        radioId: f.lease.radioId,
        grantId: f.lease.grantId,
        ownerId: f.ownerId,
        sessionId: crypto.randomUUID(),
        generation: f.lease.generation,
      }),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    const renewed = f.runtime.renewControl({
      radioId: f.lease.radioId,
      grantId: f.lease.grantId,
      ownerId: f.ownerId,
      sessionId: f.sessionId,
      generation: f.lease.generation,
    });
    expect(renewed.fencing).toBe(f.lease.fencing);
  });
  it('increments fencing after expiry and reports session revocation', async () => {
    const f = await fixture();
    const reasons: string[] = [];
    f.runtime.onControlInvalidated((event) => {
      reasons.push(event.reason);
    });
    f.advance(16000);
    const replacement = f.runtime.acquireControl(
      f.lease.radioId,
      f.ownerId,
      f.sessionId,
    );
    expect(replacement.fencing).toBeGreaterThan(f.lease.fencing);
    expect(replacement.grantId).not.toBe(f.lease.grantId);
    f.runtime.revokeSession(f.sessionId);
    expect(f.runtime.currentControl(f.lease.radioId)).toBeNull();
    expect(reasons).toEqual(['expired', 'session_revoked']);
  });
  it('blocks retuning and keeps an uncertain transmitter locked across reconcile', async () => {
    const f = await fixture();
    const txGrantId = crypto.randomUUID();
    f.runtime.reserveTransmission({
      radioId: f.lease.radioId,
      generation: f.lease.generation,
      ownerId: f.ownerId,
      sessionId: f.sessionId,
      controlGrant: f.lease.grantId,
      txGrantId,
    });
    const snapshot = f.runtime.snapshot(f.lease.radioId);
    await expect(
      f.runtime.applyTuning({
        context: {
          operationId: crypto.randomUUID(),
          radioId: f.lease.radioId,
          generation: snapshot.generation,
          expectedRevision: snapshot.revision,
          controlGrant: f.lease.grantId,
          deadline: new Date(epoch + 10000).toISOString(),
        },
        tuning: { rxHz: 146000000, mode: 'FM' },
      }),
    ).rejects.toMatchObject({ code: 'CONTROL_BUSY' });
    f.runtime.releaseTransmission(f.lease.radioId, txGrantId, false);
    expect((await f.runtime.reconcile(f.lease.radioId)).txState).toBe(
      'stop_unconfirmed',
    );
    expect(() =>
      f.runtime.acquireControl(f.lease.radioId, f.ownerId, f.sessionId),
    ).toThrow(expect.objectContaining({ code: 'CONTROL_BUSY' }));
    f.runtime.releaseTransmission(f.lease.radioId, txGrantId, true);
    expect(
      f.runtime.acquireControl(f.lease.radioId, f.ownerId, f.sessionId).fencing,
    ).toBeGreaterThan(f.lease.fencing);
  });
  it('invalidates a lease after driver restart without replaying a transmission', async () => {
    const f = await fixture();
    const next = await f.driver.connect();
    f.runtime.observeSnapshot(next);
    expect(f.runtime.currentControl(f.lease.radioId)).toBeNull();
    expect(f.runtime.snapshot(f.lease.radioId).txState).toBe('idle');
    expect(() =>
      f.runtime.validateControl({
        radioId: f.lease.radioId,
        grantId: f.lease.grantId,
        ownerId: f.ownerId,
        sessionId: f.sessionId,
        generation: f.lease.generation,
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_GENERATION' }));
  });
});
