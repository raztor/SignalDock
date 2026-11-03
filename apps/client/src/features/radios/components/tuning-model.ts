/**
 * Pure layout and interaction math for the tuning components (frequency dial,
 * band bar, tuning panel and faceplate). Plain TypeScript so it can be unit
 * tested in node; every frequency is an integer number of Hz.
 */
import type { RadioSnapshot, Tuning } from '@signaldock/contracts';
import {
  formatFrequency,
  formatMegahertzShort,
  formatRange,
  isInRanges,
  offsetOf,
  sameTuning,
  type FrequencyRange,
  type TuningMode,
} from '../../station/station-model';

const MHZ = 1_000_000;

/* -------------------------------------------------------------------------- */
/* Frequency dial                                                             */
/* -------------------------------------------------------------------------- */

export type DigitGroup = 'ghz' | 'mhz' | 'khz' | 'hz';
export interface DialDigit {
  /** Place value of the digit in Hz (1, 10, … 100 MHz). */
  weight: number;
  /** 0–9. */
  digit: number;
  group: DigitGroup;
  /** '10 MHz', '100 kHz', '1 Hz'. */
  label: string;
  /** Zero to the left of the most significant non-zero digit. */
  leading: boolean;
}

/** The dial always shows 100 MHz … 1 Hz; ranges above 1 GHz add GHz digits. */
export function dialDigitWeights(maxHz = 0): number[] {
  let top = 100 * MHZ;
  while (Number.isSafeInteger(top * 10) && top * 10 <= maxHz) top *= 10;
  const weights: number[] = [];
  for (let weight = top; weight >= 1; weight /= 10) weights.push(weight);
  return weights;
}

/**
 * Highest frequency the dial must be able to show: the top of every range and
 * the current value (a radio can report a frequency outside the advertised
 * ranges, which must never be shown with its leading digits cut off).
 */
export function dialMaxHz(
  ranges: readonly { maxHz: number }[],
  valueHz: number,
): number {
  return ranges.reduce(
    (max, range) => Math.max(max, range.maxHz),
    Number.isSafeInteger(valueHz) && valueHz > 0 ? valueHz : 0,
  );
}

export function digitGroup(weight: number): DigitGroup {
  if (weight >= 1_000 * MHZ) return 'ghz';
  if (weight >= MHZ) return 'mhz';
  if (weight >= 1_000) return 'khz';
  return 'hz';
}

/** 10_000_000 → '10 MHz', 12_500 is not a place value but still → '12.5 kHz'. */
export function stepLabel(hz: number): string {
  if (hz >= 1_000 * MHZ && hz % (1_000 * MHZ) === 0)
    return `${hz / (1_000 * MHZ)} GHz`;
  if (hz >= MHZ) return `${formatMegahertzShort(hz)} MHz`;
  if (hz >= 1_000) {
    const whole = Math.floor(hz / 1_000);
    const fraction = String(hz % 1_000)
      .padStart(3, '0')
      .replace(/0+$/, '');
    return `${fraction ? `${whole}.${fraction}` : whole} kHz`;
  }
  return `${hz} Hz`;
}

/** Digits of `hz` for the given place values (most significant first). */
export function dialDigits(
  hz: number,
  weights: readonly number[],
): DialDigit[] {
  let seenNonZero = false;
  return weights.map((weight, index) => {
    const digit = Math.floor(hz / weight) % 10;
    if (digit !== 0) seenNonZero = true;
    // The 1 MHz digit is never "leading": '0.500' MHz keeps its zero.
    const leading = !seenNonZero && weight > MHZ && index < weights.length - 1;
    return {
      weight,
      digit,
      group: digitGroup(weight),
      label: stepLabel(weight),
      leading,
    };
  });
}

/**
 * `hz + direction × deltaHz` when the result stays inside one of the ranges,
 * otherwise undefined (the control is blocked at the edge).
 */
export function stepDigit(
  hz: number,
  deltaHz: number,
  direction: 1 | -1,
  ranges: readonly FrequencyRange[],
): number | undefined {
  if (!Number.isSafeInteger(hz) || !Number.isSafeInteger(deltaHz))
    return undefined;
  const next = hz + direction * deltaHz;
  return next > 0 && isInRanges(next, ranges) ? next : undefined;
}

/** Why a step was refused, for the dial's inline message. */
export function edgeMessage(
  hz: number,
  direction: 1 | -1,
  ranges: readonly FrequencyRange[],
): string {
  const inside = ranges.find((range) => hz >= range.minHz && hz <= range.maxHz);
  if (!inside)
    return `${formatFrequency(hz)} MHz is outside this radio's ranges.`;
  return direction === 1
    ? `Upper edge of ${formatRange(inside)}.`
    : `Lower edge of ${formatRange(inside)}.`;
}

export type DialKeyAction =
  | { kind: 'step'; direction: 1 | -1 }
  | { kind: 'megahertz'; direction: 1 | -1 }
  | { kind: 'focus'; delta: 1 | -1 }
  | { kind: 'submit' }
  | { kind: 'revert' };

/** Keyboard map for the focused dial (web). */
export function dialKeyAction(key: string): DialKeyAction | undefined {
  switch (key) {
    case 'ArrowUp':
      return { kind: 'step', direction: 1 };
    case 'ArrowDown':
      return { kind: 'step', direction: -1 };
    case 'PageUp':
      return { kind: 'megahertz', direction: 1 };
    case 'PageDown':
      return { kind: 'megahertz', direction: -1 };
    case 'ArrowLeft':
      return { kind: 'focus', delta: -1 };
    case 'ArrowRight':
      return { kind: 'focus', delta: 1 };
    case 'Enter':
      return { kind: 'submit' };
    case 'Escape':
      return { kind: 'revert' };
    default:
      return undefined;
  }
}

/**
 * Moves the focused digit. `undefined` means "no digit focused" (arrow keys
 * use the tuning step); moving from there starts at `fallback`.
 */
export function moveDigitFocus(
  index: number | undefined,
  delta: 1 | -1,
  count: number,
  fallback: number,
): number {
  if (count <= 0) return 0;
  const start = index ?? fallback - delta;
  return Math.min(Math.max(start + delta, 0), count - 1);
}

/** Index of the largest place value not above the step (10 kHz for 12.5 kHz). */
export function stepDigitIndex(
  weights: readonly number[],
  stepHz: number,
): number {
  const index = weights.findIndex((weight) => weight <= stepHz);
  return index === -1 ? Math.max(weights.length - 1, 0) : index;
}

export const WHEEL_THRESHOLD = 40;
/**
 * Accumulates wheel deltas so a trackpad does not spin the dial wildly.
 * Negative delta (wheel up) increases the frequency.
 */
export function wheelSteps(
  accumulated: number,
  deltaY: number,
  threshold = WHEEL_THRESHOLD,
): { steps: number; remainder: number } {
  const total = accumulated + deltaY;
  const steps = Math.trunc(total / threshold);
  return {
    steps: steps === 0 ? 0 : -steps,
    remainder: total - steps * threshold,
  };
}

/** Spoken value of the dial: '146.520 MHz'. */
export function dialAccessibilityValue(hz: number): string {
  return Number.isSafeInteger(hz) && hz >= 0
    ? `${formatFrequency(hz)} MHz`
    : 'Unknown frequency';
}

/* -------------------------------------------------------------------------- */
/* Band bar                                                                   */
/* -------------------------------------------------------------------------- */

export interface BandSegment extends FrequencyRange {
  x0: number;
  x1: number;
}
export interface BandScale {
  width: number;
  segments: BandSegment[];
  /** Position of `hz`; outside every range it sits on the nearest edge. */
  x(hz: number): number | undefined;
  /** Frequency under `x`, always inside a range (rounded to whole Hz). */
  hzAt(x: number): number | undefined;
}

/** Sorted ranges with overlaps and touching ranges merged. */
export function mergeRanges(
  ranges: readonly FrequencyRange[],
): FrequencyRange[] {
  const sorted = ranges
    .filter(
      (range) =>
        Number.isSafeInteger(range.minHz) &&
        Number.isSafeInteger(range.maxHz) &&
        range.minHz <= range.maxHz,
    )
    .map((range) => ({ minHz: range.minHz, maxHz: range.maxHz }))
    .sort((a, b) => a.minHz - b.minHz || a.maxHz - b.maxHz);
  const merged: FrequencyRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.minHz <= last.maxHz + 1)
      last.maxHz = Math.max(last.maxHz, range.maxHz);
    else merged.push(range);
  }
  return merged;
}

export interface BandScaleOptions {
  /** Pixels between two ranges. */
  gap?: number;
  /** Smallest share of the drawable width a range may get (0–1). */
  minShare?: number;
}

/**
 * Piecewise-linear scale: each range gets width proportional to the square
 * root of its span (with a floor), so 136–174 and 400–520 MHz are both
 * clearly visible; inside a range the mapping is linear.
 */
export function createBandScale(
  ranges: readonly FrequencyRange[],
  width: number,
  { gap = 12, minShare = 0.12 }: BandScaleOptions = {},
): BandScale {
  const merged = mergeRanges(ranges);
  const safeWidth = Math.max(0, width);
  const gaps = Math.max(0, merged.length - 1);
  const drawable = Math.max(0, safeWidth - gaps * gap);
  const raw = merged.map((range) => Math.sqrt(range.maxHz - range.minHz + 1));
  const rawTotal = raw.reduce((sum, value) => sum + value, 0);
  const floored = raw.map((value) =>
    Math.max(value, rawTotal * Math.min(Math.max(minShare, 0), 1)),
  );
  const total = floored.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = 0;
  const segments: BandSegment[] = merged.map((range, index) => {
    const size = ((floored[index] ?? 0) / total) * drawable;
    const segment = { ...range, x0: cursor, x1: cursor + size };
    cursor += size + gap;
    return segment;
  });
  function x(hz: number): number | undefined {
    if (!segments.length || !Number.isFinite(hz)) return undefined;
    let best: BandSegment | undefined;
    let bestDistance = Infinity;
    for (const segment of segments) {
      const distance =
        hz < segment.minHz
          ? segment.minHz - hz
          : hz > segment.maxHz
            ? hz - segment.maxHz
            : 0;
      if (distance < bestDistance) {
        best = segment;
        bestDistance = distance;
      }
    }
    if (!best) return undefined;
    const span = best.maxHz - best.minHz;
    const clamped = Math.min(Math.max(hz, best.minHz), best.maxHz);
    return span === 0
      ? (best.x0 + best.x1) / 2
      : best.x0 + ((clamped - best.minHz) / span) * (best.x1 - best.x0);
  }
  function hzAt(position: number): number | undefined {
    if (!segments.length || !Number.isFinite(position)) return undefined;
    let best: BandSegment | undefined;
    let bestDistance = Infinity;
    for (const segment of segments) {
      const distance =
        position < segment.x0
          ? segment.x0 - position
          : position > segment.x1
            ? position - segment.x1
            : 0;
      if (distance < bestDistance) {
        best = segment;
        bestDistance = distance;
      }
    }
    if (!best) return undefined;
    const size = best.x1 - best.x0;
    if (size <= 0) return best.minHz;
    const ratio = Math.min(Math.max((position - best.x0) / size, 0), 1);
    return best.minHz + Math.round(ratio * (best.maxHz - best.minHz));
  }
  return { width: safeWidth, segments, x, hzAt };
}

export interface BandEdgeLabel {
  x: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
}
/**
 * MHz labels for every range edge. A label that would overlap the previous
 * one is dropped; the very last label gets the 'MHz' unit.
 */
export function bandEdgeLabels(
  segments: readonly BandSegment[],
  charWidth = 6,
  padding = 4,
): BandEdgeLabel[] {
  const candidates: BandEdgeLabel[] = [];
  segments.forEach((segment) => {
    candidates.push({
      x: segment.x0,
      text: formatMegahertzShort(segment.minHz),
      anchor: 'start',
    });
    if (segment.maxHz !== segment.minHz)
      candidates.push({
        x: segment.x1,
        text: formatMegahertzShort(segment.maxHz),
        anchor: 'end',
      });
  });
  const last = candidates[candidates.length - 1];
  if (last) last.text = `${last.text} MHz`;
  const bounds = (label: BandEdgeLabel) => {
    const size = label.text.length * charWidth;
    const left =
      label.anchor === 'start'
        ? label.x
        : label.anchor === 'end'
          ? label.x - size
          : label.x - size / 2;
    return { left, right: left + size };
  };
  const kept: BandEdgeLabel[] = [];
  for (const label of candidates) {
    const previous = kept[kept.length - 1];
    if (previous && bounds(label).left < bounds(previous).right + padding) {
      if (label !== last) continue;
      // The final label carries the unit: drop earlier labels it would hit.
      while (
        kept.length &&
        bounds(label).left < bounds(kept[kept.length - 1]!).right + padding
      )
        kept.pop();
    }
    kept.push(label);
  }
  return kept;
}

/** Text alternative for the band bar. */
export function bandAccessibilityLabel(
  ranges: readonly FrequencyRange[],
  markers: { confirmedHz?: number; desiredHz?: number; draftHz?: number },
): string {
  const parts = [
    `Tuning ranges ${mergeRanges(ranges).map(formatRange).join(', ')}`,
  ];
  if (markers.confirmedHz !== undefined)
    parts.push(`radio at ${formatFrequency(markers.confirmedHz)} MHz`);
  if (
    markers.desiredHz !== undefined &&
    markers.desiredHz !== markers.confirmedHz
  )
    parts.push(`requested ${formatFrequency(markers.desiredHz)} MHz`);
  if (
    markers.draftHz !== undefined &&
    markers.draftHz !== markers.confirmedHz &&
    markers.draftHz !== markers.desiredHz
  )
    parts.push(`draft ${formatFrequency(markers.draftHz)} MHz`);
  return `${parts.join('; ')}.`;
}

/* -------------------------------------------------------------------------- */
/* Tuning panel                                                               */
/* -------------------------------------------------------------------------- */

export const TUNING_STEPS_HZ = [5_000, 6_250, 12_500, 25_000, 100_000] as const;
export const DEFAULT_STEP_HZ = 12_500;
export const STEP_STORAGE_KEY = 'signaldock.tuning.step';

/** Stored step text → a supported step, or the default. */
export function parseStoredStep(value: string | null | undefined): number {
  const step = Number(value);
  return (TUNING_STEPS_HZ as readonly number[]).includes(step)
    ? step
    : DEFAULT_STEP_HZ;
}

export interface TuningDraft {
  rxHz: number;
  mode: TuningMode;
  /** TX − RX in Hz; 0 is simplex. */
  offsetHz: number;
}

type SnapshotTuning = Pick<RadioSnapshot, 'observedTuning' | 'desiredTuning'>;

/** The tuning the radio reports (shown as confirmed/inferred by confidence). */
export function confirmedTuning(
  snapshot: SnapshotTuning | null | undefined,
): Tuning | undefined {
  return snapshot?.observedTuning;
}
/** The requested tuning while the radio has not reported it yet. */
export function pendingTuning(
  snapshot: SnapshotTuning | null | undefined,
): Tuning | undefined {
  const desired = snapshot?.desiredTuning;
  return desired && !sameTuning(desired, snapshot?.observedTuning)
    ? desired
    : undefined;
}

export function draftFromTuning(tuning: Tuning): TuningDraft {
  return { rxHz: tuning.rxHz, mode: tuning.mode, offsetHz: offsetOf(tuning) };
}

/**
 * Where a fresh draft starts: the pending request (so the dial does not jump
 * back while the radio catches up), else the reported tuning, else the bottom
 * of the first range in the first advertised mode.
 */
export function draftSeed(
  snapshot: SnapshotTuning | null | undefined,
  ranges: readonly FrequencyRange[],
  modes: readonly TuningMode[],
): TuningDraft | undefined {
  const tuning = pendingTuning(snapshot) ?? confirmedTuning(snapshot);
  if (tuning) return draftFromTuning(tuning);
  const range = mergeRanges(ranges)[0];
  const mode = modes[0];
  return range && mode ? { rxHz: range.minHz, mode, offsetHz: 0 } : undefined;
}

/** The command a draft would send, or an error when the offset is invalid. */
export function draftTuning(
  draft: TuningDraft,
): { ok: true; tuning: Tuning } | { ok: false; error: string } {
  const txHz = draft.rxHz + draft.offsetHz;
  if (
    !Number.isSafeInteger(draft.rxHz) ||
    !Number.isSafeInteger(draft.offsetHz) ||
    draft.rxHz <= 0
  )
    return { ok: false, error: 'Enter a valid frequency.' };
  if (draft.offsetHz === 0)
    return { ok: true, tuning: { rxHz: draft.rxHz, mode: draft.mode } };
  if (!Number.isSafeInteger(txHz) || txHz <= 0)
    return {
      ok: false,
      error: 'The TX offset produces an invalid frequency.',
    };
  return {
    ok: true,
    tuning: { rxHz: draft.rxHz, txHz, mode: draft.mode },
  };
}

export interface TuningGate {
  writable: boolean;
  /** The account may control this radio (otherwise everything is read-only). */
  canControl: boolean;
  controlState: 'mine' | 'other' | 'available' | 'unavailable';
  /** Lease generation matches the snapshot generation. */
  leaseCurrent: boolean;
  connection: RadioSnapshot['connection'] | undefined;
  txState: RadioSnapshot['txState'] | undefined;
  busy: boolean;
}
/** Why writes are blocked right now, or undefined when the radio is editable. */
export function tuningBlockReason(gate: TuningGate): string | undefined {
  if (!gate.writable)
    return 'This driver does not support free tuning — use channel memories.';
  if (!gate.canControl)
    return 'You can listen to this radio but not control it.';
  if (gate.connection !== 'ready') return 'The radio must be ready to tune.';
  if (gate.controlState === 'other')
    return 'Another session has control of this radio.';
  if (gate.controlState !== 'mine') return 'Take control to apply tuning.';
  if (!gate.leaseCurrent)
    return 'The radio restarted. Take control again to tune.';
  if (gate.txState !== 'idle')
    return gate.txState === undefined || gate.txState === 'unknown'
      ? 'TX state is unknown, so tuning is blocked.'
      : 'Wait until the radio stops transmitting.';
  if (gate.busy) return 'Another operation is in progress.';
  return undefined;
}

export interface ApplyState {
  enabled: boolean;
  /** The tuning Apply would send (present whenever the draft is valid). */
  tuning?: Tuning;
  /** Why Apply is disabled; undefined when it is enabled or nothing changed. */
  reason?: string;
  /** The draft differs from the radio's reported tuning. */
  changed: boolean;
}
/** Whether Apply may send the draft. */
export function applyState(input: {
  draft: TuningDraft | undefined;
  snapshot: SnapshotTuning | null | undefined;
  ranges: readonly FrequencyRange[];
  modes: readonly TuningMode[];
  txAudio: boolean;
  blockReason: string | undefined;
}): ApplyState {
  if (!input.draft)
    return {
      enabled: false,
      changed: false,
      reason: 'No tuning information yet.',
    };
  const built = draftTuning(input.draft);
  if (!built.ok) return { enabled: false, changed: true, reason: built.error };
  const { tuning } = built;
  const changed = !sameTuning(tuning, confirmedTuning(input.snapshot));
  const result = (reason?: string): ApplyState => ({
    enabled: reason === undefined && changed,
    tuning,
    changed,
    ...(reason === undefined ? {} : { reason }),
  });
  if (!isInRanges(tuning.rxHz, input.ranges))
    return result(
      `${formatFrequency(tuning.rxHz)} MHz is outside this radio's ranges.`,
    );
  if (!input.modes.includes(tuning.mode))
    return result(`${tuning.mode} is not supported by this radio.`);
  if (tuning.txHz !== undefined && !input.txAudio)
    return result('This radio cannot transmit, so it has no TX offset.');
  if (tuning.txHz !== undefined && !isInRanges(tuning.txHz, input.ranges))
    return result(
      `TX ${formatFrequency(tuning.txHz)} MHz is outside this radio's ranges.`,
    );
  if (!changed) return result();
  const pending = pendingTuning(input.snapshot);
  if (pending && sameTuning(pending, tuning))
    return result('Already requested · waiting for radio confirmation.');
  return result(input.blockReason);
}
