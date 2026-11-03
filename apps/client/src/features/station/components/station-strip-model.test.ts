import { describe, expect, it } from 'vitest';
import type { RadioSnapshot, RadioView } from '@signaldock/contracts';
import {
  showStripPtt,
  stationStripPresentation,
  txStopNotice,
  UNKNOWN_FREQUENCY,
} from './station-strip-model';

const radioId = '6f1c7d2e-0b5a-4c1e-9f3a-2d4b5c6d7e8f';

function radio(snapshot: Partial<RadioSnapshot> | null = {}): RadioView {
  return {
    radioId,
    displayName: 'Base station',
    driverId: 'simulator',
    resourceGroupIds: [],
    enabled: true,
    descriptor: null,
    control: null,
    health: { state: 'connected' },
    snapshot:
      snapshot === null
        ? null
        : {
            radioId,
            generation: 'b0c1d2e3-f4a5-4b6c-8d7e-9f0a1b2c3d4e',
            revision: 3,
            connection: 'ready',
            observedTuning: { rxHz: 146_520_000, mode: 'FM' },
            tuningConfidence: 'confirmed',
            txState: 'idle',
            ...snapshot,
          },
  };
}

describe('stationStripPresentation', () => {
  it('shows a confirmed, idle radio without TX pill or request', () => {
    const view = stationStripPresentation({ selected: radio(), loaded: true });
    expect(view).toMatchObject({
      name: 'Base station',
      status: { tone: 'ok', label: 'Ready' },
      frequency: '146.520 FM',
      known: true,
      confidence: { style: 'solid' },
      requested: '',
      tx: undefined,
    });
    expect(view.accessibilityLabel).toBe('Base station, 146.520 FM, confirmed');
  });

  it('marks inferred tuning as dotted', () => {
    const view = stationStripPresentation({
      selected: radio({ tuningConfidence: 'inferred' }),
      loaded: true,
    });
    expect(view.confidence).toEqual({ style: 'dotted', label: 'Inferred' });
    expect(view.accessibilityLabel).toContain('inferred');
  });

  it('never shows a missing observed tuning as a frequency', () => {
    const view = stationStripPresentation({
      selected: radio({ observedTuning: undefined }),
      loaded: true,
    });
    expect(view.frequency).toBe(UNKNOWN_FREQUENCY);
    expect(view.known).toBe(false);
    expect(view.confidence.style).toBe('none');
    expect(view.accessibilityLabel).toContain('frequency unknown');
  });

  it('shows desired tuning separately while it differs from observed', () => {
    const pending = stationStripPresentation({
      selected: radio({
        desiredTuning: { rxHz: 146_550_000, mode: 'FM' },
        tuningConfidence: 'inferred',
      }),
      loaded: true,
    });
    expect(pending.frequency).toBe('146.520 FM');
    expect(pending.requested).toBe('146.550 FM');
    expect(pending.accessibilityLabel).toContain('requested 146.550 FM');

    const settled = stationStripPresentation({
      selected: radio({ desiredTuning: { rxHz: 146_520_000, mode: 'FM' } }),
      loaded: true,
    });
    expect(settled.requested).toBe('');
  });

  it('treats a different TX offset as a pending request', () => {
    const view = stationStripPresentation({
      selected: radio({
        desiredTuning: { rxHz: 146_520_000, txHz: 145_920_000, mode: 'FM' },
      }),
      loaded: true,
    });
    expect(view.requested).toBe('146.520 FM');
  });

  it('shows non-idle and unknown TX states, on-air in the error tone', () => {
    const onAir = stationStripPresentation({
      selected: radio({ txState: 'transmitting' }),
      loaded: true,
    });
    expect(onAir.tx).toMatchObject({ onAir: true, tone: 'error' });
    const unknown = stationStripPresentation({
      selected: radio({ txState: 'unknown' }),
      loaded: true,
    });
    expect(unknown.tx).toMatchObject({ label: 'TX state unknown' });
  });

  it('reports a radio without snapshot through its connection status', () => {
    const view = stationStripPresentation({
      selected: { ...radio(null), health: { state: 'configured' } },
      loaded: true,
    });
    expect(view.tx).toBeUndefined();
    expect(view.frequency).toBe(UNKNOWN_FREQUENCY);
    expect(view.status).toMatchObject({ tone: 'pending', label: 'Connecting' });
  });

  it('distinguishes loading from an unavailable selected radio', () => {
    expect(
      stationStripPresentation({ selected: undefined, loaded: false }).status,
    ).toMatchObject({ tone: 'pending', label: 'Loading radio' });
    const missing = stationStripPresentation({
      selected: undefined,
      loaded: true,
    });
    expect(missing.status).toMatchObject({
      tone: 'error',
      label: 'Radio unavailable',
    });
    expect(missing.name).toBe('Selected radio');
  });
});

describe('showStripPtt', () => {
  const base = {
    available: true,
    canTransmit: false,
    transmitting: false,
    pending: false,
  };
  it('requires live audio to be available', () => {
    expect(showStripPtt({ ...base, available: false, canTransmit: true })).toBe(
      false,
    );
  });
  it('shows when transmit is allowed', () => {
    expect(showStripPtt({ ...base, canTransmit: true })).toBe(true);
    expect(showStripPtt(base)).toBe(false);
  });
  it('stays mounted during an active press even if access is lost', () => {
    expect(showStripPtt({ ...base, pending: true })).toBe(true);
    expect(showStripPtt({ ...base, transmitting: true })).toBe(true);
  });
});

describe('txStopNotice', () => {
  it('reports why a transmission ended on its own', () => {
    expect(
      txStopNotice({
        wasActive: true,
        active: false,
        message: 'Transmission stopped at the 30-second limit.',
      }),
    ).toBe('Transmission stopped at the 30-second limit.');
    expect(
      txStopNotice({
        wasActive: true,
        active: false,
        message: 'Transmission interrupted.',
      }),
    ).toBe('Transmission interrupted.');
  });

  it('stays quiet for a normal release, while active or when idle', () => {
    expect(
      txStopNotice({ wasActive: true, active: false, message: 'Released.' }),
    ).toBeUndefined();
    expect(
      txStopNotice({ wasActive: true, active: true, message: 'Preparing…' }),
    ).toBeUndefined();
    expect(
      txStopNotice({
        wasActive: false,
        active: false,
        message: 'Listening stopped.',
      }),
    ).toBeUndefined();
    expect(
      txStopNotice({ wasActive: true, active: false, message: '  ' }),
    ).toBeUndefined();
  });
});
