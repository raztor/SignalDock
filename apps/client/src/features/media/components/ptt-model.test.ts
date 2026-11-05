import { describe, expect, it } from 'vitest';
import {
  PTT_LIMIT_MS,
  PTT_RELEASE_GRACE_MS,
  pttPresentation,
  remainingFraction,
  secondsLeft,
  type PttInput,
} from './ptt-model';

const base: PttInput = {
  pending: false,
  transmitting: false,
  canTransmit: true,
  transmitReason: '',
  configured: true,
  supported: true,
  radioTxState: 'idle',
  now: 1_000_000,
};
it('shows ordered completion as finishing until the radio acknowledges idle', () => {
  expect(
    pttPresentation({
      ...base,
      transmitting: true,
      finishing: true,
      radioTxState: 'stopping',
    }),
  ).toMatchObject({
    phase: 'stopping',
    label: 'Finishing',
    active: true,
    carrierConfirmed: false,
  });
});

describe('remainingFraction', () => {
  it('is full at the press and empty at the limit', () => {
    expect(remainingFraction(1000, 1000)).toBe(1);
    expect(remainingFraction(1000, 1000 + PTT_LIMIT_MS / 2)).toBe(0.5);
    expect(remainingFraction(1000, 1000 + PTT_LIMIT_MS)).toBe(0);
  });
  it('clamps clock skew and overruns', () => {
    expect(remainingFraction(5000, 1000)).toBe(1);
    expect(remainingFraction(1000, 1000 + PTT_LIMIT_MS * 3)).toBe(0);
  });
  it('treats a missing start as a full ring', () => {
    expect(remainingFraction(undefined, 1000)).toBe(1);
    expect(remainingFraction(Number.NaN, 1000)).toBe(1);
  });
  it('handles a non-positive limit', () => {
    expect(remainingFraction(1000, 1000, 0)).toBe(0);
  });
});

describe('secondsLeft', () => {
  it('rounds up and clamps to 0..limit', () => {
    expect(secondsLeft(0, 0)).toBe(30);
    expect(secondsLeft(0, 1)).toBe(30);
    expect(secondsLeft(0, 7_000)).toBe(23);
    expect(secondsLeft(0, 29_001)).toBe(1);
    expect(secondsLeft(0, 30_000)).toBe(0);
    expect(secondsLeft(0, 99_000)).toBe(0);
    expect(secondsLeft(5_000, 0)).toBe(30);
    expect(secondsLeft(undefined, 0)).toBe(30);
  });
});

describe('pttPresentation', () => {
  it('is ready when transmission is allowed and the radio is idle', () => {
    const p = pttPresentation(base);
    expect(p.phase).toBe('ready');
    expect(p.label).toBe('Hold to talk');
    expect(p.tone).toBe('primary');
    expect(p.pressable).toBe(true);
    expect(p.active).toBe(false);
    expect(p.showRing).toBe(false);
    expect(p.ringFraction).toBe(0);
    expect(p.status).toBe('Ready · 30 s limit per transmission');
  });

  it('shows preparing in warning tone and keeps the press deliverable', () => {
    const p = pttPresentation({
      ...base,
      pending: true,
      txStartedAt: base.now - 2_000,
      canTransmit: false,
      transmitReason: 'irrelevant while pending',
    });
    expect(p.phase).toBe('preparing');
    expect(p.tone).toBe('warning');
    expect(p.label).toBe('Preparing');
    expect(p.detail).toBe('Keep holding');
    expect(p.active).toBe(true);
    expect(p.pressable).toBe(true);
    expect(p.showRing).toBe(true);
    expect(p.secondsLeft).toBe(28);
    expect(p.ringFraction).toBeCloseTo(28 / 30);
  });

  it('shows on air with a countdown while transmitting', () => {
    const p = pttPresentation({
      ...base,
      transmitting: true,
      radioTxState: 'transmitting',
      txStartedAt: base.now - 7_000,
    });
    expect(p.phase).toBe('transmitting');
    expect(p.tone).toBe('error');
    expect(p.label).toBe('On air');
    expect(p.detail).toBe('23 s left');
    expect(p.carrierConfirmed).toBe(true);
    expect(p.status).toBe('Transmitting · release to stop');
    expect(p.accessibilityValue).toBe('On air, 23 seconds left');
    expect(p.ringFraction).toBeCloseTo(23 / 30);
  });

  it('never claims carrier confirmation the radio has not reported', () => {
    for (const radioTxState of [
      'idle',
      'preparing',
      'tx_unconfirmed',
      'unknown',
      undefined,
    ] as const) {
      const p = pttPresentation({
        ...base,
        transmitting: true,
        radioTxState,
        txStartedAt: base.now,
      });
      expect(p.carrierConfirmed).toBe(false);
      expect(p.status).toBe('TX audio active · carrier confirmation pending');
      expect(p.accessibilityValue).toContain('carrier unconfirmed');
    }
  });

  it('uses singular seconds in the spoken value', () => {
    const p = pttPresentation({
      ...base,
      transmitting: true,
      radioTxState: 'transmitting',
      txStartedAt: base.now - 29_500,
    });
    expect(p.accessibilityValue).toBe('On air, 1 second left');
  });

  it('shows a full ring before the start time is known', () => {
    const p = pttPresentation({ ...base, pending: true });
    expect(p.ringFraction).toBe(1);
    expect(p.secondsLeft).toBe(30);
  });

  it('respects a custom limit', () => {
    const p = pttPresentation({
      ...base,
      transmitting: true,
      txStartedAt: base.now - 5_000,
      limitMs: 10_000,
    });
    expect(p.ringFraction).toBe(0.5);
    expect(p.detail).toBe('5 s left');
    expect(pttPresentation({ ...base, limitMs: 10_000 }).detail).toBe(
      '10 s max',
    );
  });

  it('reports unsupported platforms and unconfigured servers', () => {
    const native = pttPresentation({ ...base, supported: false });
    expect(native.phase).toBe('unavailable');
    expect(native.pressable).toBe(false);
    expect(native.reason).toBe('Live audio works in the web app for now.');
    const off = pttPresentation({ ...base, configured: false });
    expect(off.phase).toBe('unavailable');
    expect(off.reason).toBe('Live audio is not configured on this server.');
  });

  it('shows stopping after a release while the radio is still keyed', () => {
    for (const radioTxState of [
      'preparing',
      'tx_unconfirmed',
      'transmitting',
    ] as const) {
      const p = pttPresentation({
        ...base,
        radioTxState,
        releasedAt: base.now - 1_000,
        canTransmit: false,
        transmitReason: 'busy',
      });
      expect(p.phase).toBe('stopping');
      expect(p.label).toBe('Stopping…');
      expect(p.tone).toBe('warning');
      expect(p.pressable).toBe(false);
    }
  });

  it('always shows the radio stopping state as stopping', () => {
    const p = pttPresentation({ ...base, radioTxState: 'stopping' });
    expect(p.phase).toBe('stopping');
    expect(p.pressable).toBe(false);
  });

  it('treats a keyed radio outside the release grace as busy', () => {
    const p = pttPresentation({
      ...base,
      radioTxState: 'transmitting',
      releasedAt: base.now - PTT_RELEASE_GRACE_MS,
      canTransmit: false,
      transmitReason:
        'The radio is transmitting or its carrier state is uncertain.',
    });
    expect(p.phase).toBe('busy');
    expect(p.tone).toBe('error');
    expect(p.label).toBe('Radio on air');
    expect(p.pressable).toBe(false);
    expect(p.reason).toBe(
      'The radio is transmitting or its carrier state is uncertain.',
    );
  });

  it('ignores a release time in the future', () => {
    const p = pttPresentation({
      ...base,
      radioTxState: 'transmitting',
      releasedAt: base.now + 1_000,
    });
    expect(p.phase).toBe('busy');
  });

  it('never renders uncertain radio states as ready', () => {
    const stop = pttPresentation({
      ...base,
      radioTxState: 'stop_unconfirmed',
      releasedAt: base.now - 100,
    });
    expect(stop.phase).toBe('uncertain');
    expect(stop.tone).toBe('error');
    expect(stop.label).toBe('Stop unconfirmed');
    expect(stop.pressable).toBe(false);
    const unknown = pttPresentation({ ...base, radioTxState: 'unknown' });
    expect(unknown.phase).toBe('uncertain');
    expect(unknown.tone).toBe('warning');
    expect(unknown.pressable).toBe(false);
  });

  it('shows the access reason when transmission is not allowed', () => {
    const p = pttPresentation({
      ...base,
      canTransmit: false,
      transmitReason: 'Confirm the radio frequency before transmitting.',
    });
    expect(p.phase).toBe('unavailable');
    expect(p.label).toBe('Unavailable');
    expect(p.reason).toBe('Confirm the radio frequency before transmitting.');
    expect(p.pressable).toBe(false);
    expect(p.accessibilityValue).toBe(
      'Unavailable. Confirm the radio frequency before transmitting.',
    );
  });

  it('falls back to a generic reason', () => {
    const p = pttPresentation({ ...base, canTransmit: false });
    expect(p.reason).toBe('Transmission is unavailable.');
  });

  it('is unavailable without a radio snapshot when access says so', () => {
    const p = pttPresentation({
      ...base,
      radioTxState: undefined,
      canTransmit: false,
      transmitReason: 'The radio must be connected before using live audio.',
    });
    expect(p.phase).toBe('unavailable');
  });
});
