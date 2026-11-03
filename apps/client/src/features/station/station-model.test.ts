import { describe, expect, it } from 'vitest';
import type { RadioMemory, RadioView } from '@signaldock/contracts';
import {
  activeMemory,
  applyOffset,
  bandLabel,
  clampToRanges,
  confidencePresentation,
  connectionPresentation,
  formatFrequency,
  formatMegahertzShort,
  formatOffset,
  formatRange,
  formatTuning,
  frequencyParts,
  groupMemoriesByBand,
  isInRanges,
  nearestRange,
  offsetOf,
  offsetPresets,
  parseFrequencyInput,
  sameTuning,
  snapToStep,
  stepFrequency,
  tuningWithOffset,
  txPresentation,
  verificationLabel,
} from './station-model';

const vhf = { minHz: 136_000_000, maxHz: 174_000_000 };
const uhf = { minHz: 400_000_000, maxHz: 520_000_000 };
const ranges = [vhf, uhf];

function view(
  patch: Partial<Pick<RadioView, 'enabled' | 'health'>> & {
    connection?: NonNullable<RadioView['snapshot']>['connection'];
    noSnapshot?: boolean;
  } = {},
): Pick<RadioView, 'enabled' | 'health' | 'snapshot'> {
  return {
    enabled: patch.enabled ?? true,
    health: patch.health ?? { state: 'connected' },
    snapshot: patch.noSnapshot
      ? null
      : {
          radioId: crypto.randomUUID(),
          generation: crypto.randomUUID(),
          revision: 1,
          connection: patch.connection ?? 'ready',
          tuningConfidence: 'confirmed',
          txState: 'idle',
        },
  };
}
function memory(name: string, rxHz: number, txHz?: number): RadioMemory {
  return {
    memoryId: name,
    name,
    tuning:
      txHz === undefined ? { rxHz, mode: 'FM' } : { rxHz, txHz, mode: 'FM' },
  };
}

describe('connectionPresentation', () => {
  it('maps every snapshot connection state', () => {
    expect(connectionPresentation(view({ connection: 'ready' }))).toEqual({
      tone: 'ok',
      label: 'Ready',
      pulse: false,
    });
    expect(
      connectionPresentation(view({ connection: 'connecting' })),
    ).toMatchObject({
      tone: 'pending',
      pulse: true,
    });
    expect(
      connectionPresentation(view({ connection: 'synchronizing' })),
    ).toMatchObject({
      tone: 'pending',
      label: 'Synchronizing',
    });
    expect(
      connectionPresentation(view({ connection: 'recovering' })),
    ).toMatchObject({
      tone: 'warning',
      pulse: true,
    });
    expect(
      connectionPresentation(view({ connection: 'degraded' })),
    ).toMatchObject({
      tone: 'warning',
      label: 'Degraded',
    });
    expect(
      connectionPresentation(view({ connection: 'disconnected' })),
    ).toMatchObject({
      tone: 'off',
      label: 'Disconnected',
    });
  });
  it('gives disabled and failed radios priority over the snapshot', () => {
    expect(connectionPresentation(view({ enabled: false }))).toMatchObject({
      tone: 'off',
      label: 'Disabled',
    });
    expect(
      connectionPresentation(
        view({ health: { state: 'failed', errorCode: 'RADIO_UNAVAILABLE' } }),
      ),
    ).toMatchObject({ tone: 'error', label: 'Connection failed' });
  });
  it('never presents a missing snapshot as ready', () => {
    expect(
      connectionPresentation(
        view({ noSnapshot: true, health: { state: 'configured' } }),
      ),
    ).toMatchObject({ tone: 'pending', label: 'Connecting' });
    expect(connectionPresentation(view({ noSnapshot: true }))).toMatchObject({
      tone: 'unknown',
      label: 'State unknown',
    });
  });
});

describe('txPresentation', () => {
  it('marks idle as not on air and certain', () => {
    expect(txPresentation('idle')).toMatchObject({
      tone: 'ok',
      onAir: false,
      uncertain: false,
    });
  });
  it('uses the error tone for every on-air state', () => {
    for (const state of [
      'tx_unconfirmed',
      'transmitting',
      'stop_unconfirmed',
    ] as const)
      expect(txPresentation(state)).toMatchObject({
        tone: 'error',
        onAir: true,
      });
    expect(txPresentation('transmitting').uncertain).toBe(false);
    expect(txPresentation('tx_unconfirmed').uncertain).toBe(true);
    expect(txPresentation('stop_unconfirmed').uncertain).toBe(true);
  });
  it('treats stopping as still on air and preparing as pending', () => {
    expect(txPresentation('stopping')).toMatchObject({
      tone: 'warning',
      onAir: true,
    });
    expect(txPresentation('preparing')).toMatchObject({
      tone: 'pending',
      onAir: false,
    });
  });
  it('never renders unknown or missing state as idle', () => {
    expect(txPresentation('unknown')).toMatchObject({
      tone: 'warning',
      uncertain: true,
    });
    expect(txPresentation(undefined)).toMatchObject({
      tone: 'unknown',
      uncertain: true,
    });
    expect(txPresentation(undefined).label).not.toBe(
      txPresentation('idle').label,
    );
  });
});

describe('confidence and verification', () => {
  it('maps confidence to underline styles', () => {
    expect(confidencePresentation('confirmed')).toEqual({
      style: 'solid',
      label: 'Confirmed',
    });
    expect(confidencePresentation('inferred')).toEqual({
      style: 'dotted',
      label: 'Inferred',
    });
    expect(confidencePresentation('unknown')).toEqual({
      style: 'none',
      label: 'Unknown',
    });
    expect(confidencePresentation(undefined).style).toBe('none');
  });
  it('labels verification levels', () => {
    expect(verificationLabel('simulated')).toBe('Simulated');
    expect(verificationLabel('experimental')).toBe('Experimental');
    expect(verificationLabel('hardware_verified')).toBe('Hardware verified');
    expect(verificationLabel(undefined)).toBe('Unverified');
  });
});

describe('frequency formatting', () => {
  it('splits integer Hz into padded parts', () => {
    expect(frequencyParts(146_520_000)).toEqual({
      mhz: '146',
      khz: '520',
      hz: '000',
    });
    expect(frequencyParts(7_074_250)).toEqual({
      mhz: '7',
      khz: '074',
      hz: '250',
    });
    expect(frequencyParts(1)).toEqual({ mhz: '0', khz: '000', hz: '001' });
    expect(frequencyParts(0)).toEqual({ mhz: '0', khz: '000', hz: '000' });
    expect(frequencyParts(1_296_000_001)).toEqual({
      mhz: '1296',
      khz: '000',
      hz: '001',
    });
  });
  it('rejects non-integer or negative Hz', () => {
    expect(() => frequencyParts(146.52)).toThrow(RangeError);
    expect(() => frequencyParts(-1)).toThrow(RangeError);
    expect(() => frequencyParts(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      RangeError,
    );
  });
  it('formats MHz text without floating point drift', () => {
    expect(formatFrequency(146_520_000)).toBe('146.520');
    expect(formatFrequency(446_006_250)).toBe('446.006250');
    expect(formatFrequency(Number.MAX_SAFE_INTEGER)).toBe('9007199254.740991');
    expect(formatTuning({ rxHz: 146_550_000, mode: 'FM' })).toBe('146.550 FM');
    expect(formatMegahertzShort(136_000_000)).toBe('136');
    expect(formatMegahertzShort(146_520_000)).toBe('146.52');
    expect(formatMegahertzShort(500_000)).toBe('0.5');
    expect(formatRange(vhf)).toBe('136–174 MHz');
  });
});

describe('ranges and stepping', () => {
  it('includes both range edges', () => {
    expect(isInRanges(136_000_000, ranges)).toBe(true);
    expect(isInRanges(174_000_000, ranges)).toBe(true);
    expect(isInRanges(135_999_999, ranges)).toBe(false);
    expect(isInRanges(174_000_001, ranges)).toBe(false);
    expect(isInRanges(300_000_000, ranges)).toBe(false);
    expect(isInRanges(146_520_000.5, ranges)).toBe(false);
    expect(isInRanges(146_520_000, [])).toBe(false);
  });
  it('steps inside ranges and refuses to leave them', () => {
    expect(stepFrequency(146_520_000, 12_500, ranges)).toBe(146_532_500);
    expect(stepFrequency(146_520_000, -12_500, ranges)).toBe(146_507_500);
    expect(stepFrequency(173_990_000, 10_000, ranges)).toBe(174_000_000);
    expect(stepFrequency(174_000_000, 1, ranges)).toBeUndefined();
    expect(stepFrequency(136_000_000, -1, ranges)).toBeUndefined();
    // Never jumps across the gap between ranges.
    expect(stepFrequency(174_000_000, 100_000_000, ranges)).toBeUndefined();
    expect(stepFrequency(174_000_000, 226_000_000, ranges)).toBe(400_000_000);
    expect(stepFrequency(146_520_000, 0.5, ranges)).toBeUndefined();
    expect(stepFrequency(5, -10, [{ minHz: 1, maxHz: 100 }])).toBeUndefined();
  });
  it('snaps to the nearest step with integer arithmetic', () => {
    expect(snapToStep(146_523_000, 12_500)).toBe(146_525_000);
    expect(snapToStep(146_518_749, 12_500)).toBe(146_512_500);
    expect(snapToStep(146_518_750, 12_500)).toBe(146_525_000);
    expect(snapToStep(446_009_000, 6_250)).toBe(446_006_250);
    expect(snapToStep(446_009_375, 6_250)).toBe(446_012_500);
    expect(snapToStep(146_525_000, 12_500)).toBe(146_525_000);
    // 146.520 is not on a 12.5 kHz grid counted from 0 Hz.
    expect(snapToStep(146_520_000, 12_500)).toBe(146_525_000);
    expect(snapToStep(146_520_000, 5_000)).toBe(146_520_000);
    expect(snapToStep(146_520_001, 0)).toBe(146_520_001);
    expect(snapToStep(146_520_001, 2.5)).toBe(146_520_001);
  });
  it('finds the nearest range and clamps into it', () => {
    expect(nearestRange(150_000_000, ranges)).toBe(vhf);
    expect(nearestRange(200_000_000, ranges)).toBe(vhf);
    expect(nearestRange(380_000_000, ranges)).toBe(uhf);
    expect(nearestRange(1, [])).toBeUndefined();
    expect(clampToRanges(200_000_000, ranges)).toBe(174_000_000);
    expect(clampToRanges(390_000_000, ranges)).toBe(400_000_000);
    expect(clampToRanges(146_520_000, ranges)).toBe(146_520_000);
    expect(clampToRanges(1, [])).toBeUndefined();
  });
});

describe('bandLabel', () => {
  it('names common bands', () => {
    expect(bandLabel(28_400_000)).toBe('10 m');
    expect(bandLabel(50_125_000)).toBe('6 m');
    expect(bandLabel(118_100_000)).toBe('Air');
    expect(bandLabel(144_000_000)).toBe('2 m');
    expect(bandLabel(148_000_000)).toBe('2 m');
    expect(bandLabel(156_800_000)).toBe('Marine VHF');
    expect(bandLabel(223_500_000)).toBe('1.25 m');
    expect(bandLabel(433_500_000)).toBe('70 cm');
    expect(bandLabel(446_006_250)).toBe('PMR446');
    expect(bandLabel(462_562_500)).toBe('FRS/GMRS');
    expect(bandLabel(915_000_000)).toBe('33 cm');
    expect(bandLabel(1_296_000_000)).toBe('23 cm');
  });
  it('falls back to whole MHz', () => {
    expect(bandLabel(173_225_000)).toBe('173 MHz');
    expect(bandLabel(148_000_001)).toBe('148 MHz');
  });
});

describe('TX offsets', () => {
  it('formats offsets with a true minus sign', () => {
    expect(formatOffset(0)).toBe('Simplex');
    expect(formatOffset(600_000)).toBe('+600 kHz');
    expect(formatOffset(-600_000)).toBe('−600 kHz');
    expect(formatOffset(-5_000_000)).toBe('−5 MHz');
    expect(formatOffset(1_600_000)).toBe('+1.6 MHz');
    expect(formatOffset(12_500)).toBe('+12.5 kHz');
    expect(formatOffset(-250)).toBe('−250 Hz');
    expect(() => formatOffset(0.5)).toThrow(RangeError);
  });
  it('derives and applies offsets', () => {
    expect(offsetOf({ rxHz: 146_520_000 })).toBe(0);
    expect(offsetOf({ rxHz: 146_940_000, txHz: 146_340_000 })).toBe(-600_000);
    expect(offsetOf({ rxHz: 146_520_000, txHz: 146_520_000 })).toBe(0);
    expect(applyOffset(146_940_000, -600_000)).toBe(146_340_000);
    expect(applyOffset(146_940_000, 0)).toBeUndefined();
    expect(() => applyOffset(100, -100)).toThrow(RangeError);
    expect(() => applyOffset(146_940_000, 0.5)).toThrow(RangeError);
    expect(tuningWithOffset(442_100_000, 'FM', 5_000_000)).toEqual({
      rxHz: 442_100_000,
      txHz: 447_100_000,
      mode: 'FM',
    });
    expect(tuningWithOffset(146_520_000, 'AM', 0)).toEqual({
      rxHz: 146_520_000,
      mode: 'AM',
    });
  });
  it('compares tunings by RX, mode and effective offset', () => {
    expect(
      sameTuning(
        { rxHz: 146_520_000, mode: 'FM' },
        { rxHz: 146_520_000, txHz: 146_520_000, mode: 'FM' },
      ),
    ).toBe(true);
    expect(
      sameTuning(
        { rxHz: 146_520_000, mode: 'FM' },
        { rxHz: 146_520_000, mode: 'AM' },
      ),
    ).toBe(false);
    expect(sameTuning(undefined, undefined)).toBe(true);
    expect(sameTuning({ rxHz: 1, mode: 'FM' }, undefined)).toBe(false);
  });
  it('offers band presets and keeps a custom current offset', () => {
    expect(offsetPresets(146_940_000).map((item) => item.offsetHz)).toEqual([
      0, -600_000, 600_000,
    ]);
    expect(offsetPresets(442_100_000).map((item) => item.label)).toEqual([
      'Simplex',
      '−5 MHz',
      '+5 MHz',
    ]);
    expect(offsetPresets(156_800_000).map((item) => item.kind)).toEqual([
      'simplex',
    ]);
    const custom = offsetPresets(146_940_000, -1_000_000);
    expect(custom.at(-1)).toEqual({
      key: '-1000000',
      offsetHz: -1_000_000,
      label: '−1 MHz',
      kind: 'custom',
    });
    expect(offsetPresets(146_940_000, 600_000)).toHaveLength(3);
    expect(new Set(custom.map((item) => item.key)).size).toBe(custom.length);
  });
});

describe('parseFrequencyInput', () => {
  const hz = (text: string, limits?: typeof ranges) => {
    const result = parseFrequencyInput(text, limits);
    return result.ok ? result.hz : result.error;
  };
  it('accepts the documented variants', () => {
    expect(hz('146.52')).toBe(146_520_000);
    expect(hz('146.520.000')).toBe(146_520_000);
    expect(hz('146520000 Hz')).toBe(146_520_000);
    expect(hz('146,52')).toBe(146_520_000);
    expect(hz('146520 kHz')).toBe(146_520_000);
  });
  it('accepts units, spacing and grouping', () => {
    expect(hz(' 146.52 MHz ')).toBe(146_520_000);
    expect(hz('146.52mhz')).toBe(146_520_000);
    expect(hz('146.520 000')).toBe(146_520_000);
    expect(hz('146,520,000')).toBe(146_520_000);
    expect(hz('146.520.125')).toBe(146_520_125);
    expect(hz('446.00625')).toBe(446_006_250);
    expect(hz('146520.5 kHz')).toBe(146_520_500);
    expect(hz('1.2965 GHz')).toBe(1_296_500_000);
    expect(hz('146')).toBe(146_000_000);
    expect(hz('0.5')).toBe(500_000);
    expect(hz('146520000')).toBe(146_520_000);
    expect(hz('146_520_000 Hz')).toBe(146_520_000);
  });
  it('does not round decimal text through floating point', () => {
    expect(hz('146.519999')).toBe(146_519_999);
    expect(hz('0.000001')).toBe(1);
  });
  it('rejects malformed input with a message', () => {
    for (const text of [
      '',
      '   ',
      'abc',
      '-146.52',
      '146.',
      '.5',
      '146.52.1',
      '146.5200001',
      '146.5 Hz',
      '146520.0001 kHz',
      '146 furlongs',
      '1e6',
      '0',
      '0.0',
      '99999999999999999 Hz',
    ]) {
      const result = parseFrequencyInput(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    }
  });
  it('checks ranges when given', () => {
    expect(hz('146.52', ranges)).toBe(146_520_000);
    expect(hz('174', ranges)).toBe(174_000_000);
    expect(hz('300', ranges)).toMatch(
      /outside this radio's ranges \(136–174 MHz, 400–520 MHz\)/,
    );
  });
});

describe('memories', () => {
  it('groups by band ordered by frequency, keeping memory order', () => {
    const items = [
      memory('Repeater UHF', 442_100_000, 447_100_000),
      memory('Calling', 146_520_000),
      memory('Repeater', 146_940_000, 146_340_000),
      memory('Odd', 173_225_000),
      memory('Low', 145_000_000),
    ];
    const groups = groupMemoriesByBand(items);
    expect(groups.map((group) => group.band)).toEqual([
      '2 m',
      '173 MHz',
      '70 cm',
    ]);
    expect(groups[0]!.memories.map((item) => item.name)).toEqual([
      'Calling',
      'Repeater',
      'Low',
    ]);
    expect(groupMemoriesByBand([])).toEqual([]);
  });
  it('finds the active memory', () => {
    const items = [memory('A', 146_520_000), memory('B', 146_550_000)];
    expect(activeMemory(items, { selectedMemoryId: 'B' })?.name).toBe('B');
    expect(activeMemory(items, { selectedMemoryId: 'C' })).toBeUndefined();
    expect(activeMemory(items, {})).toBeUndefined();
    expect(activeMemory(items, null)).toBeUndefined();
  });
});
