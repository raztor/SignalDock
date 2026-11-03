import { describe, expect, it } from 'vitest';
import type { RadioView } from '@signaldock/contracts';
import type { TuningMode } from '../../station/station-model';
import {
  applyState,
  bandAccessibilityLabel,
  bandEdgeLabels,
  confirmedTuning,
  controlChip,
  createBandScale,
  dialAccessibilityValue,
  dialDigits,
  dialDigitWeights,
  dialKeyAction,
  digitGroup,
  draftFromTuning,
  draftSeed,
  draftTuning,
  edgeMessage,
  mergeRanges,
  moveDigitFocus,
  parseStoredStep,
  pendingTuning,
  stepDigit,
  stepDigitIndex,
  stepLabel,
  tuningBlockReason,
  wheelSteps,
  DEFAULT_STEP_HZ,
  type TuningGate,
  dialMaxHz,
} from './tuning-model';

const vhf = { minHz: 136_000_000, maxHz: 174_000_000 };
const uhf = { minHz: 400_000_000, maxHz: 520_000_000 };
const ranges = [vhf, uhf];

describe('dial digits', () => {
  it('uses 100 MHz … 1 Hz by default and adds GHz digits when needed', () => {
    expect(dialDigitWeights(520_000_000)).toEqual([
      100_000_000, 10_000_000, 1_000_000, 100_000, 10_000, 1_000, 100, 10, 1,
    ]);
    expect(dialDigitWeights()).toHaveLength(9);
    expect(dialDigitWeights(1_300_000_000)[0]).toBe(1_000_000_000);
    expect(dialDigitWeights(1_300_000_000)).toHaveLength(10);
  });

  it('splits a frequency into digits with groups and labels', () => {
    const digits = dialDigits(146_520_125, dialDigitWeights());
    expect(digits.map((item) => item.digit).join('')).toBe('146520125');
    expect(digits.map((item) => item.group)).toEqual([
      'mhz',
      'mhz',
      'mhz',
      'khz',
      'khz',
      'khz',
      'hz',
      'hz',
      'hz',
    ]);
    expect(digits[1]!.label).toBe('10 MHz');
    expect(digits[3]!.label).toBe('100 kHz');
    expect(digits[8]!.label).toBe('1 Hz');
    expect(digits.some((item) => item.leading)).toBe(false);
  });

  it('marks leading zeros above the 1 MHz digit only', () => {
    const digits = dialDigits(27_000_000, dialDigitWeights());
    expect(digits[0]).toMatchObject({ digit: 0, leading: true });
    expect(digits[1]).toMatchObject({ digit: 2, leading: false });
    const small = dialDigits(500_000, dialDigitWeights());
    expect(small.slice(0, 3).map((item) => item.leading)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('labels groups and steps', () => {
    expect(digitGroup(1_000_000_000)).toBe('ghz');
    expect(digitGroup(1_000)).toBe('khz');
    expect(stepLabel(12_500)).toBe('12.5 kHz');
    expect(stepLabel(6_250)).toBe('6.25 kHz');
    expect(stepLabel(100_000)).toBe('100 kHz');
    expect(stepLabel(1_000_000)).toBe('1 MHz');
    expect(stepLabel(1_000_000_000)).toBe('1 GHz');
    expect(stepLabel(10)).toBe('10 Hz');
  });
});

describe('dial stepping', () => {
  it('steps a digit with carry and blocks at range edges', () => {
    expect(stepDigit(146_900_000, 100_000, 1, ranges)).toBe(147_000_000);
    expect(stepDigit(146_520_000, 1, -1, ranges)).toBe(146_519_999);
    expect(stepDigit(174_000_000, 1, 1, ranges)).toBeUndefined();
    expect(stepDigit(136_000_000, 10_000, -1, ranges)).toBeUndefined();
    // Never jumps across the gap between ranges.
    expect(stepDigit(146_000_000, 100_000_000, 1, ranges)).toBeUndefined();
    expect(stepDigit(446_000_000, 100_000_000, -1, ranges)).toBeUndefined();
    expect(stepDigit(146_000_000, 0.5, 1, ranges)).toBeUndefined();
  });

  it('explains blocked steps', () => {
    expect(edgeMessage(174_000_000, 1, ranges)).toBe(
      'Upper edge of 136–174 MHz.',
    );
    expect(edgeMessage(400_000_000, -1, ranges)).toBe(
      'Lower edge of 400–520 MHz.',
    );
    expect(edgeMessage(200_000_000, 1, ranges)).toBe(
      "200.000 MHz is outside this radio's ranges.",
    );
  });

  it('maps keys to dial actions', () => {
    expect(dialKeyAction('ArrowUp')).toEqual({ kind: 'step', direction: 1 });
    expect(dialKeyAction('ArrowDown')).toEqual({
      kind: 'step',
      direction: -1,
    });
    expect(dialKeyAction('PageUp')).toEqual({
      kind: 'megahertz',
      direction: 1,
    });
    expect(dialKeyAction('PageDown')).toEqual({
      kind: 'megahertz',
      direction: -1,
    });
    expect(dialKeyAction('ArrowLeft')).toEqual({ kind: 'focus', delta: -1 });
    expect(dialKeyAction('ArrowRight')).toEqual({ kind: 'focus', delta: 1 });
    expect(dialKeyAction('Enter')).toEqual({ kind: 'submit' });
    expect(dialKeyAction('Escape')).toEqual({ kind: 'revert' });
    expect(dialKeyAction('a')).toBeUndefined();
  });

  it('moves digit focus within bounds', () => {
    expect(moveDigitFocus(undefined, 1, 9, 4)).toBe(4);
    expect(moveDigitFocus(undefined, -1, 9, 4)).toBe(4);
    expect(moveDigitFocus(4, 1, 9, 4)).toBe(5);
    expect(moveDigitFocus(0, -1, 9, 4)).toBe(0);
    expect(moveDigitFocus(8, 1, 9, 4)).toBe(8);
    expect(moveDigitFocus(3, 1, 0, 0)).toBe(0);
  });

  it('finds the digit matching a step', () => {
    const weights = dialDigitWeights();
    expect(stepDigitIndex(weights, 12_500)).toBe(4);
    expect(stepDigitIndex(weights, 100_000)).toBe(3);
    expect(stepDigitIndex(weights, 5_000)).toBe(5);
    expect(stepDigitIndex(weights, 0)).toBe(8);
  });

  it('accumulates wheel deltas into steps', () => {
    expect(wheelSteps(0, -40)).toEqual({ steps: 1, remainder: 0 });
    expect(wheelSteps(0, 100)).toEqual({ steps: -2, remainder: 20 });
    expect(wheelSteps(20, 10)).toEqual({ steps: 0, remainder: 30 });
    expect(wheelSteps(30, 10).steps).toBe(-1);
    expect(wheelSteps(0, -3)).toEqual({ steps: 0, remainder: -3 });
  });

  it('describes the dial value', () => {
    expect(dialAccessibilityValue(146_520_000)).toBe('146.520 MHz');
    expect(dialAccessibilityValue(446_006_250)).toBe('446.006250 MHz');
    expect(dialAccessibilityValue(Number.NaN)).toBe('Unknown frequency');
  });
});

describe('band scale', () => {
  it('merges overlapping and touching ranges', () => {
    expect(
      mergeRanges([
        uhf,
        { minHz: 140_000_000, maxHz: 150_000_000 },
        vhf,
        { minHz: 174_000_001, maxHz: 180_000_000 },
        { minHz: 5, maxHz: 1 },
      ]),
    ).toEqual([{ minHz: 136_000_000, maxHz: 180_000_000 }, uhf]);
  });

  it('gives every range a visible share and keeps order', () => {
    const scale = createBandScale(ranges, 400, { gap: 10 });
    const [low, high] = scale.segments;
    expect(low!.x0).toBe(0);
    expect(high!.x1).toBeCloseTo(400, 6);
    expect(high!.x0 - low!.x1).toBeCloseTo(10, 6);
    // Square-root weighting: 38 MHz still gets well over a quarter.
    expect((low!.x1 - low!.x0) / 390).toBeGreaterThan(0.3);
    expect(high!.x1 - high!.x0).toBeGreaterThan(low!.x1 - low!.x0);
    const tiny = createBandScale(
      [
        { minHz: 1_000_000, maxHz: 1_000_100 },
        { minHz: 400_000_000, maxHz: 1_400_000_000 },
      ],
      400,
      { gap: 0, minShare: 0.12 },
    );
    expect(tiny.segments[0]!.x1).toBeGreaterThan(40);
  });

  it('maps frequencies to positions and back', () => {
    const scale = createBandScale(ranges, 400, { gap: 10 });
    const low = scale.segments[0]!;
    expect(scale.x(vhf.minHz)).toBe(low.x0);
    expect(scale.x(vhf.maxHz)).toBeCloseTo(low.x1, 6);
    const middle = scale.x(155_000_000)!;
    expect(middle).toBeCloseTo((low.x0 + low.x1) / 2, 6);
    expect(scale.hzAt(middle)).toBe(155_000_000);
    // Outside every range: clamped to the nearest edge.
    expect(scale.x(100_000_000)).toBe(low.x0);
    expect(scale.x(200_000_000)).toBeCloseTo(low.x1, 6);
    expect(scale.x(300_000_000)).toBeCloseTo(scale.segments[1]!.x0, 6);
    expect(scale.hzAt(-50)).toBe(vhf.minHz);
    expect(scale.hzAt(1_000)).toBe(uhf.maxHz);
    expect(Number.isInteger(scale.hzAt(123.456)!)).toBe(true);
  });

  it('handles empty input and single-frequency ranges', () => {
    const empty = createBandScale([], 300);
    expect(empty.segments).toEqual([]);
    expect(empty.x(146_000_000)).toBeUndefined();
    expect(empty.hzAt(10)).toBeUndefined();
    const point = createBandScale([{ minHz: 5, maxHz: 5 }], 100);
    expect(point.x(5)).toBe(50);
    expect(point.hzAt(80)).toBe(5);
  });

  it('labels range edges without overlap and ends with the unit', () => {
    const scale = createBandScale(ranges, 400, { gap: 10 });
    expect(bandEdgeLabels(scale.segments).map((label) => label.text)).toEqual([
      '136',
      '174',
      '400',
      '520 MHz',
    ]);
    const narrow = createBandScale(ranges, 60, { gap: 4 });
    const labels = bandEdgeLabels(narrow.segments);
    expect(labels[labels.length - 1]!.text).toBe('520 MHz');
    for (let index = 1; index < labels.length; index += 1) {
      const previous = labels[index - 1]!;
      const current = labels[index]!;
      const previousRight =
        previous.anchor === 'start'
          ? previous.x + previous.text.length * 6
          : previous.x;
      const currentLeft =
        current.anchor === 'start'
          ? current.x
          : current.x - current.text.length * 6;
      expect(currentLeft).toBeGreaterThanOrEqual(previousRight + 4);
    }
  });

  it('describes the bar for screen readers', () => {
    expect(
      bandAccessibilityLabel(ranges, {
        confirmedHz: 146_520_000,
        desiredHz: 146_550_000,
        draftHz: 146_550_000,
      }),
    ).toBe(
      'Tuning ranges 136–174 MHz, 400–520 MHz; radio at 146.520 MHz; requested 146.550 MHz.',
    );
    expect(bandAccessibilityLabel([vhf], { draftHz: 150_000_000 })).toBe(
      'Tuning ranges 136–174 MHz; draft 150.000 MHz.',
    );
  });
});

describe('tuning panel model', () => {
  const observed = { rxHz: 146_520_000, mode: 'FM' as const };
  const desired = { rxHz: 146_550_000, mode: 'FM' as const };

  it('reads stored steps defensively', () => {
    expect(parseStoredStep('6250')).toBe(6_250);
    expect(parseStoredStep('100000')).toBe(100_000);
    expect(parseStoredStep('7000')).toBe(DEFAULT_STEP_HZ);
    expect(parseStoredStep(null)).toBe(DEFAULT_STEP_HZ);
    expect(parseStoredStep('abc')).toBe(DEFAULT_STEP_HZ);
  });

  it('separates confirmed and pending tunings', () => {
    expect(confirmedTuning({ observedTuning: observed })).toEqual(observed);
    expect(
      pendingTuning({ observedTuning: observed, desiredTuning: desired }),
    ).toEqual(desired);
    expect(
      pendingTuning({ observedTuning: observed, desiredTuning: observed }),
    ).toBeUndefined();
    expect(pendingTuning({ desiredTuning: desired })).toEqual(desired);
    expect(pendingTuning(null)).toBeUndefined();
  });

  it('seeds the draft from pending, then reported, then the first range', () => {
    expect(
      draftSeed({ observedTuning: observed, desiredTuning: desired }, ranges, [
        'FM',
      ]),
    ).toEqual({ rxHz: 146_550_000, mode: 'FM', offsetHz: 0 });
    expect(
      draftSeed(
        {
          observedTuning: { rxHz: 145_430_000, txHz: 144_830_000, mode: 'FM' },
        },
        ranges,
        ['FM'],
      ),
    ).toEqual({ rxHz: 145_430_000, mode: 'FM', offsetHz: -600_000 });
    expect(draftSeed(undefined, [uhf, vhf], ['AM', 'FM'])).toEqual({
      rxHz: 136_000_000,
      mode: 'AM',
      offsetHz: 0,
    });
    expect(draftSeed(undefined, [], ['FM'])).toBeUndefined();
  });

  it('builds commands from drafts', () => {
    expect(draftTuning({ rxHz: 146_520_000, mode: 'FM', offsetHz: 0 })).toEqual(
      { ok: true, tuning: observed },
    );
    expect(
      draftTuning({ rxHz: 439_100_000, mode: 'FM', offsetHz: -5_000_000 }),
    ).toEqual({
      ok: true,
      tuning: { rxHz: 439_100_000, txHz: 434_100_000, mode: 'FM' },
    });
    expect(
      draftTuning({ rxHz: 1_000, mode: 'FM', offsetHz: -5_000_000 }).ok,
    ).toBe(false);
    expect(draftTuning({ rxHz: 1.5, mode: 'FM', offsetHz: 0 }).ok).toBe(false);
    expect(
      draftFromTuning({ rxHz: 146_940_000, txHz: 146_340_000, mode: 'FM' }),
    ).toEqual({ rxHz: 146_940_000, mode: 'FM', offsetHz: -600_000 });
  });

  const gate: TuningGate = {
    writable: true,
    canControl: true,
    controlState: 'mine',
    leaseCurrent: true,
    connection: 'ready',
    txState: 'idle',
    busy: false,
  };

  it('explains why tuning is blocked, in safety order', () => {
    expect(tuningBlockReason(gate)).toBeUndefined();
    expect(tuningBlockReason({ ...gate, writable: false })).toMatch(
      /does not support free tuning/,
    );
    expect(tuningBlockReason({ ...gate, canControl: false })).toMatch(
      /listen to this radio but not control/,
    );
    expect(tuningBlockReason({ ...gate, connection: 'degraded' })).toMatch(
      /must be ready/,
    );
    expect(tuningBlockReason({ ...gate, controlState: 'other' })).toMatch(
      /Another session/,
    );
    expect(tuningBlockReason({ ...gate, controlState: 'available' })).toBe(
      'Take control to apply tuning.',
    );
    expect(tuningBlockReason({ ...gate, leaseCurrent: false })).toMatch(
      /restarted/,
    );
    expect(tuningBlockReason({ ...gate, txState: 'transmitting' })).toMatch(
      /stops transmitting/,
    );
    expect(tuningBlockReason({ ...gate, txState: 'unknown' })).toMatch(
      /unknown/,
    );
    expect(tuningBlockReason({ ...gate, txState: undefined })).toMatch(
      /unknown/,
    );
    expect(tuningBlockReason({ ...gate, busy: true })).toMatch(/in progress/);
  });

  const base = {
    ranges,
    modes: ['FM', 'AM'] as TuningMode[],
    txAudio: true,
    blockReason: undefined,
  };

  it('enables Apply only for a changed, valid draft on an editable radio', () => {
    const snapshot = { observedTuning: observed };
    const changed = { rxHz: 146_550_000, mode: 'FM' as const, offsetHz: 0 };
    expect(applyState({ ...base, snapshot, draft: changed })).toEqual({
      enabled: true,
      changed: true,
      tuning: desired,
    });
    expect(
      applyState({
        ...base,
        snapshot,
        draft: { rxHz: 146_520_000, mode: 'FM', offsetHz: 0 },
      }),
    ).toEqual({ enabled: false, changed: false, tuning: observed });
    expect(
      applyState({
        ...base,
        snapshot,
        draft: changed,
        blockReason: 'Take control to apply tuning.',
      }),
    ).toMatchObject({
      enabled: false,
      changed: true,
      reason: 'Take control to apply tuning.',
    });
  });

  it('blocks invalid drafts with a reason', () => {
    const snapshot = { observedTuning: observed };
    expect(
      applyState({
        ...base,
        snapshot,
        draft: { rxHz: 200_000_000, mode: 'FM', offsetHz: 0 },
      }).reason,
    ).toMatch(/outside this radio's ranges/);
    expect(
      applyState({
        ...base,
        snapshot,
        draft: { rxHz: 146_550_000, mode: 'USB', offsetHz: 0 },
      }).reason,
    ).toBe('USB is not supported by this radio.');
    expect(
      applyState({
        ...base,
        txAudio: false,
        snapshot,
        draft: { rxHz: 146_550_000, mode: 'FM', offsetHz: 600_000 },
      }).reason,
    ).toMatch(/cannot transmit/);
    expect(
      applyState({
        ...base,
        snapshot,
        draft: { rxHz: 173_900_000, mode: 'FM', offsetHz: 600_000 },
      }).reason,
    ).toBe("TX 174.500 MHz is outside this radio's ranges.");
    expect(applyState({ ...base, snapshot, draft: undefined })).toMatchObject({
      enabled: false,
    });
  });

  it('does not resend a tuning that is already pending', () => {
    const snapshot = { observedTuning: observed, desiredTuning: desired };
    expect(
      applyState({
        ...base,
        snapshot,
        draft: { rxHz: 146_550_000, mode: 'FM', offsetHz: 0 },
      }),
    ).toMatchObject({
      enabled: false,
      changed: true,
      reason: 'Already requested · waiting for radio confirmation.',
    });
  });
});

describe('control chip', () => {
  const radio: Pick<RadioView, 'radioId' | 'enabled' | 'control' | 'snapshot'> =
    {
      radioId: 'radio-1',
      enabled: true,
      control: null,
      snapshot: {
        radioId: 'radio-1',
        generation: 'gen-1',
        revision: 1,
        connection: 'ready',
        tuningConfidence: 'confirmed',
        txState: 'idle',
      },
    };
  const viewer = {
    userId: 'user-1',
    radioPermissions: [
      { radioId: 'radio-1', permissions: ['radio.listen', 'radio.control'] },
    ],
    now: 1_000,
  };
  const lease = {
    grantId: 'grant-1',
    radioId: 'radio-1',
    ownerId: 'user-1',
    sessionId: 'session-1',
    generation: 'gen-1',
    fencing: 1,
    expiresAt: 5_000,
  };

  it('reports who holds control', () => {
    expect(controlChip(radio, viewer)).toEqual({
      label: 'Control available',
      tone: 'neutral',
    });
    expect(
      controlChip(
        { ...radio, control: lease },
        {
          ...viewer,
          leaseGrantId: 'grant-1',
        },
      ),
    ).toEqual({ label: 'You have control', tone: 'primary' });
    expect(controlChip({ ...radio, control: lease }, viewer)).toEqual({
      label: 'Controlled by another session',
      tone: 'warning',
    });
    expect(
      controlChip(
        { ...radio, control: { ...lease, ownerId: 'user-2' } },
        viewer,
      ),
    ).toEqual({ label: 'Controlled by another operator', tone: 'warning' });
  });

  it("shows this client's own orphaned lease as its own, not another session's", () => {
    expect(
      controlChip(
        { ...radio, control: lease },
        { ...viewer, ownGrantIds: ['grant-0', 'grant-1'] },
      ),
    ).toEqual({
      label: 'Your previous lease is still active',
      tone: 'neutral',
    });
    // Another tab on the same session holds a different grant.
    expect(
      controlChip(
        { ...radio, control: { ...lease, grantId: 'grant-9' } },
        { ...viewer, ownGrantIds: ['grant-1'] },
      ),
    ).toEqual({ label: 'Controlled by another session', tone: 'warning' });
  });

  it('ignores expired leases and hides the chip when control is impossible', () => {
    expect(
      controlChip({ ...radio, control: { ...lease, expiresAt: 500 } }, viewer),
    ).toEqual({ label: 'Control available', tone: 'neutral' });
    expect(
      controlChip(radio, { ...viewer, radioPermissions: [] }),
    ).toBeUndefined();
    expect(controlChip({ ...radio, enabled: false }, viewer)).toBeUndefined();
    expect(controlChip({ ...radio, snapshot: null }, viewer)).toBeUndefined();
  });
});

describe('dialMaxHz', () => {
  const ranges = [
    { minHz: 136_000_000, maxHz: 174_000_000 },
    { minHz: 400_000_000, maxHz: 520_000_000 },
  ];
  it('covers every digit of a value above the range maximum', () => {
    const valueHz = 1_296_000_000;
    const weights = dialDigitWeights(dialMaxHz(ranges, valueHz));
    expect(weights[0]).toBe(1_000_000_000);
    const shown = dialDigits(valueHz, weights)
      .map((digit) => digit.digit)
      .join('');
    expect(shown).toBe('1296000000');
  });
  it('uses the ranges when the value fits, and survives empty ranges', () => {
    expect(dialMaxHz(ranges, 146_520_000)).toBe(520_000_000);
    expect(dialMaxHz([], 146_520_000)).toBe(146_520_000);
    expect(dialMaxHz([], Number.NaN)).toBe(0);
    expect(dialMaxHz([], -5)).toBe(0);
  });
});
