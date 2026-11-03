/**
 * Pure station presentation and frequency helpers.
 *
 * Everything here is plain TypeScript so it can be unit tested in node. All
 * frequency math works on integer Hz; decimal text is converted digit by digit
 * and never through a floating-point approximation.
 */
import type {
  RadioCapabilities,
  RadioMemory,
  RadioSnapshot,
  RadioView,
  Tuning,
} from '@signaldock/contracts';

/** Matches the `StatusIndicator` tones exported by `@signaldock/ui`. */
export type StatusTone =
  'ok' | 'pending' | 'warning' | 'error' | 'off' | 'unknown';
export interface StatusPresentation {
  tone: StatusTone;
  label: string;
  pulse: boolean;
}
export type TxState = RadioSnapshot['txState'];
export type TuningConfidence = RadioSnapshot['tuningConfidence'];
export type Verification = RadioCapabilities['verification'];
export type TuningMode = Tuning['mode'];
export interface FrequencyRange {
  minHz: number;
  maxHz: number;
}

const MHZ = 1_000_000;
const KHZ = 1_000;

/* -------------------------------------------------------------------------- */
/* Status presentation                                                        */
/* -------------------------------------------------------------------------- */

/** Connection state of a radio as a tone + label. Unknown is never shown as ready. */
export function connectionPresentation(
  view: Pick<RadioView, 'enabled' | 'health' | 'snapshot'>,
): StatusPresentation {
  if (!view.enabled) return { tone: 'off', label: 'Disabled', pulse: false };
  if (view.health.state === 'failed')
    return { tone: 'error', label: 'Connection failed', pulse: false };
  const connection = view.snapshot?.connection;
  switch (connection) {
    case 'ready':
      return { tone: 'ok', label: 'Ready', pulse: false };
    case 'connecting':
      return { tone: 'pending', label: 'Connecting', pulse: true };
    case 'synchronizing':
      return { tone: 'pending', label: 'Synchronizing', pulse: true };
    case 'recovering':
      return { tone: 'warning', label: 'Recovering', pulse: true };
    case 'degraded':
      return { tone: 'warning', label: 'Degraded', pulse: false };
    case 'disconnected':
      return { tone: 'off', label: 'Disconnected', pulse: false };
    case undefined:
      return view.health.state === 'configured'
        ? { tone: 'pending', label: 'Connecting', pulse: true }
        : { tone: 'unknown', label: 'State unknown', pulse: false };
  }
}

export interface TxPresentation {
  tone: StatusTone;
  label: string;
  /** The carrier may be keyed: render with the error (on-air) tone. */
  onAir: boolean;
  /** The physical carrier state is not confirmed. */
  uncertain: boolean;
}

/** Radio-reported TX state. Pressing PTT is never treated as confirmation. */
export function txPresentation(state: TxState | undefined): TxPresentation {
  switch (state) {
    case 'idle':
      return {
        tone: 'ok',
        label: 'Not transmitting',
        onAir: false,
        uncertain: false,
      };
    case 'preparing':
      return {
        tone: 'pending',
        label: 'Preparing TX',
        onAir: false,
        uncertain: false,
      };
    case 'tx_unconfirmed':
      return {
        tone: 'error',
        label: 'TX audio · carrier unconfirmed',
        onAir: true,
        uncertain: true,
      };
    case 'transmitting':
      return { tone: 'error', label: 'On air', onAir: true, uncertain: false };
    case 'stopping':
      return {
        tone: 'warning',
        label: 'Stopping TX',
        onAir: true,
        uncertain: false,
      };
    case 'stop_unconfirmed':
      return {
        tone: 'error',
        label: 'TX stop unconfirmed',
        onAir: true,
        uncertain: true,
      };
    case 'unknown':
      return {
        tone: 'warning',
        label: 'TX state unknown',
        onAir: false,
        uncertain: true,
      };
    case undefined:
      return {
        tone: 'unknown',
        label: 'TX state unavailable',
        onAir: false,
        uncertain: true,
      };
  }
}

/**
 * How a TX pill is drawn: `on-air` is filled with the error colour, `caution`
 * (pending, stopping, unknown or unavailable state) is amber, `neutral` is
 * only used for idle. Unknown TX state is never drawn like idle.
 */
export function txPillTone(
  presentation: Pick<TxPresentation, 'tone' | 'onAir'>,
): 'on-air' | 'caution' | 'neutral' {
  if (presentation.onAir) return 'on-air';
  return presentation.tone === 'ok' || presentation.tone === 'off'
    ? 'neutral'
    : 'caution';
}

export interface ConfidencePresentation {
  style: 'solid' | 'dotted' | 'none';
  label: string;
}
export function confidencePresentation(
  confidence: TuningConfidence | undefined,
): ConfidencePresentation {
  switch (confidence) {
    case 'confirmed':
      return { style: 'solid', label: 'Confirmed' };
    case 'inferred':
      return { style: 'dotted', label: 'Inferred' };
    default:
      return { style: 'none', label: 'Unknown' };
  }
}

export function verificationLabel(
  verification: Verification | undefined,
): 'Simulated' | 'Experimental' | 'Hardware verified' | 'Unverified' {
  switch (verification) {
    case 'simulated':
      return 'Simulated';
    case 'experimental':
      return 'Experimental';
    case 'hardware_verified':
      return 'Hardware verified';
    default:
      return 'Unverified';
  }
}

/* -------------------------------------------------------------------------- */
/* Frequency formatting                                                       */
/* -------------------------------------------------------------------------- */

function assertHz(hz: number, name = 'Frequency'): void {
  if (!Number.isSafeInteger(hz) || hz < 0)
    throw new RangeError(
      `${name} must be a non-negative integer number of Hz.`,
    );
}

export interface FrequencyParts {
  mhz: string;
  khz: string;
  hz: string;
}
/** 146_520_000 → { mhz: '146', khz: '520', hz: '000' }. */
export function frequencyParts(hz: number): FrequencyParts {
  assertHz(hz);
  return {
    mhz: String(Math.floor(hz / MHZ)),
    khz: String(Math.floor((hz % MHZ) / KHZ)).padStart(3, '0'),
    hz: String(hz % KHZ).padStart(3, '0'),
  };
}

/** '146.520' when the Hz digits are zero, otherwise '146.520125'. */
export function formatFrequency(hz: number): string {
  const parts = frequencyParts(hz);
  return parts.hz === '000'
    ? `${parts.mhz}.${parts.khz}`
    : `${parts.mhz}.${parts.khz}${parts.hz}`;
}
/** '146.550 FM'. */
export function formatTuning(tuning: Pick<Tuning, 'rxHz' | 'mode'>): string {
  return `${formatFrequency(tuning.rxHz)} ${tuning.mode}`;
}
/** Decimal text of `value / unit` without floating point, trailing zeros trimmed. */
function decimal(value: number, unit: number, digits: number): string {
  const whole = Math.floor(value / unit);
  const fraction = String(value % unit)
    .padStart(digits, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
/** Compact MHz label for range edges and band names: '146', '146.52', '0.5'. */
export function formatMegahertzShort(hz: number): string {
  assertHz(hz);
  return decimal(hz, MHZ, 6);
}
/** '136–174 MHz'. */
export function formatRange(range: FrequencyRange): string {
  return `${formatMegahertzShort(range.minHz)}–${formatMegahertzShort(range.maxHz)} MHz`;
}

/* -------------------------------------------------------------------------- */
/* Ranges and stepping                                                        */
/* -------------------------------------------------------------------------- */

export function isInRanges(
  hz: number,
  ranges: readonly FrequencyRange[],
): boolean {
  return (
    Number.isSafeInteger(hz) &&
    ranges.some((range) => hz >= range.minHz && hz <= range.maxHz)
  );
}

function distance(hz: number, range: FrequencyRange): number {
  return hz < range.minHz
    ? range.minHz - hz
    : hz > range.maxHz
      ? hz - range.maxHz
      : 0;
}
/** The range containing `hz`, otherwise the closest one (first wins on ties). */
export function nearestRange<T extends FrequencyRange>(
  hz: number,
  ranges: readonly T[],
): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const range of ranges) {
    const value = distance(hz, range);
    if (value < bestDistance) {
      best = range;
      bestDistance = value;
    }
  }
  return best;
}
/** The closest frequency inside the ranges (unchanged when already inside). */
export function clampToRanges(
  hz: number,
  ranges: readonly FrequencyRange[],
): number | undefined {
  const range = nearestRange(hz, ranges);
  if (!range) return undefined;
  return Math.min(Math.max(hz, range.minHz), range.maxHz);
}

/** `hz + deltaHz`, or undefined when the result is outside every range. */
export function stepFrequency(
  hz: number,
  deltaHz: number,
  ranges: readonly FrequencyRange[],
): number | undefined {
  if (!Number.isSafeInteger(hz) || !Number.isSafeInteger(deltaHz))
    return undefined;
  const next = hz + deltaHz;
  return next > 0 && isInRanges(next, ranges) ? next : undefined;
}

/** Rounds to the nearest multiple of `stepHz` (halves round up). */
export function snapToStep(hz: number, stepHz: number): number {
  assertHz(hz);
  if (!Number.isSafeInteger(stepHz) || stepHz <= 0) return hz;
  const remainder = hz % stepHz;
  return remainder * 2 >= stepHz ? hz - remainder + stepHz : hz - remainder;
}

/* -------------------------------------------------------------------------- */
/* Bands                                                                      */
/* -------------------------------------------------------------------------- */

interface Band {
  label: string;
  minHz: number;
  maxHz: number;
}
/** Narrow allocations first so they win over the wider amateur bands they overlap. */
const bands: readonly Band[] = [
  { label: 'PMR446', minHz: 446_000_000, maxHz: 446_200_000 },
  { label: 'FRS/GMRS', minHz: 462_550_000, maxHz: 467_725_000 },
  { label: '10 m', minHz: 28_000_000, maxHz: 29_700_000 },
  { label: '6 m', minHz: 50_000_000, maxHz: 54_000_000 },
  { label: 'Air', minHz: 108_000_000, maxHz: 137_000_000 },
  { label: '2 m', minHz: 144_000_000, maxHz: 148_000_000 },
  { label: 'Marine VHF', minHz: 156_000_000, maxHz: 162_025_000 },
  { label: '1.25 m', minHz: 219_000_000, maxHz: 225_000_000 },
  { label: '70 cm', minHz: 420_000_000, maxHz: 450_000_000 },
  { label: '33 cm', minHz: 902_000_000, maxHz: 928_000_000 },
  { label: '23 cm', minHz: 1_240_000_000, maxHz: 1_300_000_000 },
];
/** Common band name for a frequency, else '173 MHz'. */
export function bandLabel(hz: number): string {
  const band = bands.find((item) => hz >= item.minHz && hz <= item.maxHz);
  return band ? band.label : `${Math.floor(hz / MHZ)} MHz`;
}

/* -------------------------------------------------------------------------- */
/* TX offsets                                                                 */
/* -------------------------------------------------------------------------- */

const MINUS = '−';
/** 0 → 'Simplex', 600_000 → '+600 kHz', -5_000_000 → '−5 MHz', 12_500 → '+12.5 kHz'. */
export function formatOffset(offsetHz: number): string {
  if (!Number.isSafeInteger(offsetHz))
    throw new RangeError('Offset must be an integer number of Hz.');
  if (offsetHz === 0) return 'Simplex';
  const sign = offsetHz > 0 ? '+' : MINUS;
  const size = Math.abs(offsetHz);
  const text =
    size >= MHZ
      ? `${decimal(size, MHZ, 6)} MHz`
      : size >= KHZ
        ? `${decimal(size, KHZ, 3)} kHz`
        : `${size} Hz`;
  return `${sign}${text}`;
}
/** TX offset of a tuning; a missing `txHz` follows RX (simplex). */
export function offsetOf(tuning: Pick<Tuning, 'rxHz' | 'txHz'>): number {
  return tuning.txHz === undefined ? 0 : tuning.txHz - tuning.rxHz;
}
/**
 * The `txHz` field for an offset: undefined for simplex (TX follows RX).
 * Throws when the result is not a positive integer frequency.
 */
export function applyOffset(
  rxHz: number,
  offsetHz: number,
): number | undefined {
  assertHz(rxHz);
  if (!Number.isSafeInteger(offsetHz))
    throw new RangeError('Offset must be an integer number of Hz.');
  if (offsetHz === 0) return undefined;
  const txHz = rxHz + offsetHz;
  if (!Number.isSafeInteger(txHz) || txHz <= 0)
    throw new RangeError('The TX offset produces an invalid frequency.');
  return txHz;
}
/** A complete tuning for RX, mode and offset (omits `txHz` for simplex). */
export function tuningWithOffset(
  rxHz: number,
  mode: TuningMode,
  offsetHz: number,
): Tuning {
  const txHz = applyOffset(rxHz, offsetHz);
  return txHz === undefined ? { rxHz, mode } : { rxHz, txHz, mode };
}
/** True when both tunings would put the radio in the same state. */
export function sameTuning(
  a: Tuning | undefined,
  b: Tuning | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.rxHz === b.rxHz && a.mode === b.mode && offsetOf(a) === offsetOf(b);
}

export interface OffsetPreset {
  /** Stable string key for segmented controls. */
  key: string;
  offsetHz: number;
  label: string;
  kind: 'simplex' | 'preset' | 'custom';
}
/**
 * Simplex plus the standard repeater shifts for the band of `rxHz`
 * (±600 kHz on 2 m, ±5 MHz on 70 cm). A current offset that is not one of
 * those is appended as 'custom' so it stays selectable.
 */
export function offsetPresets(
  rxHz: number,
  currentOffsetHz = 0,
): OffsetPreset[] {
  const values = [0];
  if (rxHz >= 144_000_000 && rxHz <= 148_000_000)
    values.push(-600_000, 600_000);
  else if (rxHz >= 420_000_000 && rxHz <= 450_000_000)
    values.push(-5_000_000, 5_000_000);
  const presets: OffsetPreset[] = values.map((offsetHz) => ({
    key: String(offsetHz),
    offsetHz,
    label: formatOffset(offsetHz),
    kind: offsetHz === 0 ? 'simplex' : 'preset',
  }));
  if (
    Number.isSafeInteger(currentOffsetHz) &&
    !values.includes(currentOffsetHz)
  )
    presets.push({
      key: String(currentOffsetHz),
      offsetHz: currentOffsetHz,
      label: formatOffset(currentOffsetHz),
      kind: 'custom',
    });
  return presets;
}

/* -------------------------------------------------------------------------- */
/* Frequency text input                                                       */
/* -------------------------------------------------------------------------- */

export type FrequencyParseResult =
  { ok: true; hz: number } | { ok: false; error: string };

const unitDigits: Record<string, { digits: number; name: string }> = {
  hz: { digits: 0, name: 'Hz' },
  khz: { digits: 3, name: 'kHz' },
  mhz: { digits: 6, name: 'MHz' },
  ghz: { digits: 9, name: 'GHz' },
};

/**
 * Parses typed frequencies into integer Hz.
 *
 * Accepts '146.52', '146,52', '146.520.000' (MHz then 3-digit groups),
 * '146.520 000', '146520000 Hz', '146520 kHz', '146.52 MHz' and '1.2965 GHz'.
 * A bare integer of seven or more digits is read as Hz, otherwise bare
 * numbers are MHz. When `ranges` is given the result must be inside one.
 */
export function parseFrequencyInput(
  text: string,
  ranges?: readonly FrequencyRange[],
): FrequencyParseResult {
  const compact = text.trim().replace(/[\s_'   ]+/g, '');
  if (!compact) return { ok: false, error: 'Enter a frequency.' };
  const match = /^(\d[\d.,]*)([a-zA-Z]*)$/.exec(compact);
  if (!match)
    return { ok: false, error: 'Enter a frequency like 146.520 MHz.' };
  const number = match[1]!.replace(/,/g, '.');
  const unitText = match[2]!.toLowerCase();
  let unit = unitText ? unitDigits[unitText] : undefined;
  if (unitText && !unit)
    return { ok: false, error: 'Use Hz, kHz, MHz or GHz as the unit.' };
  const groups = number.split('.');
  const whole = groups[0]!;
  let fraction: string;
  if (groups.length === 1) fraction = '';
  else if (groups.length === 2) fraction = groups[1]!;
  else {
    // Dotted thousands grouping: '146.520.000' = 146 MHz, 520 kHz, 000 Hz.
    const rest = groups.slice(1);
    if (rest.some((group) => !/^\d{3}$/.test(group)))
      return {
        ok: false,
        error:
          'Group digits after the first point in threes, like 146.520.000.',
      };
    fraction = rest.join('');
  }
  if (!/^\d+$/.test(whole) || (groups.length > 1 && !/^\d+$/.test(fraction)))
    return { ok: false, error: 'Enter a frequency like 146.520 MHz.' };
  if (!unit)
    unit =
      groups.length === 1 && whole.length >= 7
        ? unitDigits.hz!
        : unitDigits.mhz!;
  if (fraction.length > unit.digits)
    return {
      ok: false,
      error:
        unit.digits === 0
          ? 'Hz values must be whole numbers.'
          : `Use at most ${unit.digits} decimal places for ${unit.name}.`,
    };
  const digits = `${whole}${fraction.padEnd(unit.digits, '0')}`.replace(
    /^0+(?=\d)/,
    '',
  );
  if (digits.length > 15)
    return { ok: false, error: 'That frequency is too large.' };
  const hz = Number(digits);
  if (!Number.isSafeInteger(hz))
    return { ok: false, error: 'That frequency is too large.' };
  if (hz <= 0)
    return { ok: false, error: 'Frequency must be greater than zero.' };
  if (ranges && ranges.length && !isInRanges(hz, ranges))
    return {
      ok: false,
      error: `${formatFrequency(hz)} MHz is outside this radio's ranges (${ranges.map(formatRange).join(', ')}).`,
    };
  return { ok: true, hz };
}

/* -------------------------------------------------------------------------- */
/* Memories                                                                   */
/* -------------------------------------------------------------------------- */

export interface MemoryBandGroup {
  band: string;
  memories: RadioMemory[];
}
/** Groups memories by `bandLabel`, bands ordered by their lowest frequency; memory order is kept. */
export function groupMemoriesByBand(
  memories: readonly RadioMemory[],
): MemoryBandGroup[] {
  const groups = new Map<string, { lowest: number; memories: RadioMemory[] }>();
  for (const memory of memories) {
    const band = bandLabel(memory.tuning.rxHz);
    const group = groups.get(band);
    if (group) {
      group.memories.push(memory);
      group.lowest = Math.min(group.lowest, memory.tuning.rxHz);
    } else groups.set(band, { lowest: memory.tuning.rxHz, memories: [memory] });
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].lowest - b[1].lowest)
    .map(([band, group]) => ({ band, memories: group.memories }));
}
/** The memory the snapshot reports as active, if it is in the list. */
export function activeMemory(
  memories: readonly RadioMemory[],
  snapshot: Pick<RadioSnapshot, 'selectedMemoryId'> | null | undefined,
): RadioMemory | undefined {
  const id = snapshot?.selectedMemoryId;
  return id === undefined
    ? undefined
    : memories.find((memory) => memory.memoryId === id);
}

/* -------------------------------------------------------------------------- */
/* Control ownership                                                          */
/* -------------------------------------------------------------------------- */

export type ControlState = 'mine' | 'other' | 'available' | 'unavailable';
export interface ControlPresentation {
  state: ControlState;
  label: string;
  tone: 'primary' | 'warning' | 'neutral';
  /** `lock` while a lease holds the radio (ours or another's), else `user`. */
  icon: 'lock' | 'user';
}
export interface ControlViewer {
  userId: string;
  /** The account is enabled (disabled accounts cannot take control). */
  userEnabled: boolean;
  /** Grant id of the lease this client holds, when it is for this radio. */
  leaseGrantId?: string | undefined;
  /** Recent grant ids this client obtained (an orphaned lease of its own). */
  ownGrantIds?: readonly string[];
  radioPermissions: readonly {
    radioId: string;
    permissions: readonly string[];
  }[];
  now: number;
}

/**
 * Who holds control of a radio. The single source for the station's control
 * state, the faceplate chip, the strip badge and the ownership row, so every
 * surface shows the same label, tone and icon.
 */
export function controlPresentation(
  radio:
    Pick<RadioView, 'radioId' | 'enabled' | 'control' | 'snapshot'> | undefined,
  viewer: ControlViewer,
): ControlPresentation {
  if (!radio)
    return {
      state: 'unavailable',
      label: 'Select a radio.',
      tone: 'neutral',
      icon: 'user',
    };
  if (viewer.leaseGrantId)
    return {
      state: 'mine',
      label: 'You have control',
      tone: 'primary',
      icon: 'lock',
    };
  const live =
    radio.control && radio.control.expiresAt > viewer.now
      ? radio.control
      : null;
  const ownPrevious = Boolean(
    live && viewer.ownGrantIds?.includes(live.grantId),
  );
  if (live && !ownPrevious)
    return {
      state: 'other',
      label:
        live.ownerId === viewer.userId
          ? 'Controlled by another session'
          : 'Controlled by another operator',
      tone: 'warning',
      icon: 'lock',
    };
  const permitted =
    viewer.userEnabled &&
    viewer.radioPermissions.some(
      (entry) =>
        entry.radioId === radio.radioId &&
        entry.permissions.includes('radio.control'),
    );
  if (!permitted)
    return {
      state: 'unavailable',
      label: 'You do not have control permission for this radio.',
      tone: 'neutral',
      icon: 'user',
    };
  if (!radio.enabled || radio.snapshot?.connection !== 'ready')
    return {
      state: 'unavailable',
      label: 'The radio must be ready before taking control.',
      tone: 'neutral',
      icon: 'user',
    };
  return ownPrevious
    ? {
        state: 'available',
        label: 'Your previous lease is still active',
        tone: 'neutral',
        icon: 'user',
      }
    : {
        state: 'available',
        label: 'Control available',
        tone: 'neutral',
        icon: 'user',
      };
}

/* -------------------------------------------------------------------------- */
/* Identity preservation                                                      */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * `next`, reusing every part of `previous` that is structurally equal (plain
 * objects, arrays and primitives). Returns `previous` itself when nothing
 * changed, so React consumers keyed on identity do not re-render for a poll
 * that returned the same data.
 */
export function preserveIdentity<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let same = previous.length === next.length;
    const merged = next.map((item: unknown, index) => {
      const kept = preserveIdentity(previous[index], item);
      if (!Object.is(kept, previous[index])) same = false;
      return kept;
    });
    return (same ? previous : merged) as T;
  }
  if (isPlainObject(next)) {
    if (!isPlainObject(previous)) return next;
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(previous).length;
    const merged: Record<string, unknown> = {};
    for (const key of keys) {
      const kept = preserveIdentity(previous[key], next[key]);
      if (!(key in previous) || !Object.is(kept, previous[key])) same = false;
      merged[key] = kept;
    }
    return (same ? previous : merged) as T;
  }
  return next;
}
/** True when both values hold the same plain data. */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  return Object.is(preserveIdentity(a, b), a);
}

/* -------------------------------------------------------------------------- */
/* Radio list merging                                                         */
/* -------------------------------------------------------------------------- */

/** `next` is the same or a later state than `previous` (a new generation always wins). */
export function isNewerSnapshot(
  next: RadioSnapshot,
  previous: RadioSnapshot | null | undefined,
): boolean {
  return (
    !previous ||
    previous.generation !== next.generation ||
    next.revision >= previous.revision
  );
}
/** Applies a live snapshot; returns `radios` itself when it changes nothing. */
export function mergeRadioSnapshot(
  radios: RadioView[],
  snapshot: RadioSnapshot,
): RadioView[] {
  let changed = false;
  const next = radios.map((radio) => {
    if (
      radio.radioId !== snapshot.radioId ||
      !isNewerSnapshot(snapshot, radio.snapshot)
    )
      return radio;
    const kept = preserveIdentity(radio.snapshot, snapshot);
    if (kept === radio.snapshot) return radio;
    changed = true;
    return { ...radio, snapshot: kept };
  });
  return changed ? next : radios;
}
/**
 * Merges a radio list response into the current list. A live snapshot newer
 * than the response's is kept, and unchanged radios (and unchanged parts of
 * changed radios) keep their identity. Returns `previous` itself when the
 * response changes nothing.
 *
 * `ownGrantId` is the lease this client holds: its renewals only move
 * `expiresAt`, which the client never relies on for its own lease, so they do
 * not count as a change. Other operators' leases always take the response.
 */
export function mergeRadioList(
  previous: RadioView[],
  incoming: RadioView[],
  ownGrantId?: string,
): RadioView[] {
  const known = new Map(previous.map((radio) => [radio.radioId, radio]));
  const next = incoming.map((radio) => {
    const current = known.get(radio.radioId);
    if (!current) return radio;
    const snapshot =
      current.snapshot &&
      radio.snapshot &&
      !isNewerSnapshot(radio.snapshot, current.snapshot)
        ? current.snapshot
        : radio.snapshot;
    const control =
      ownGrantId !== undefined &&
      radio.control?.grantId === ownGrantId &&
      sameLease(current.control, radio.control)
        ? current.control
        : radio.control;
    return preserveIdentity(current, { ...radio, snapshot, control });
  });
  return next.length === previous.length &&
    next.every((radio, index) => radio === previous[index])
    ? previous
    : next;
}
/**
 * Shows our own lease as the radio's control. Returns `radios` itself when the
 * radio already shows this grant (a renewal only moves `expiresAt`, which the
 * client never reads for its own lease).
 */
export function withOwnLease(
  radios: RadioView[],
  lease: NonNullable<RadioView['control']>,
): RadioView[] {
  let changed = false;
  const next = radios.map((radio) => {
    if (
      radio.radioId !== lease.radioId ||
      (radio.control?.grantId === lease.grantId &&
        radio.control.generation === lease.generation &&
        radio.control.fencing === lease.fencing)
    )
      return radio;
    changed = true;
    return { ...radio, control: lease };
  });
  return changed ? next : radios;
}
/** A renewal that keeps the same grant: nothing but `expiresAt` may differ. */
export function sameLease(
  a: NonNullable<RadioView['control']> | null | undefined,
  b: NonNullable<RadioView['control']> | null | undefined,
): boolean {
  return Boolean(
    a &&
    b &&
    a.grantId === b.grantId &&
    a.radioId === b.radioId &&
    a.generation === b.generation &&
    a.fencing === b.fencing,
  );
}

/* -------------------------------------------------------------------------- */
/* Memory list refresh                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What can change the memory list as seen from a snapshot: a radio restart
 * (new generation), the selected memory, and the tuning while a memory is
 * selected (some drivers edit the active channel in place). TX and
 * connection-only revisions do not refetch the list.
 */
export function memoriesFetchKey(
  snapshot:
    | Pick<RadioSnapshot, 'generation' | 'selectedMemoryId' | 'observedTuning'>
    | null
    | undefined,
): string {
  if (!snapshot) return '';
  const memoryId = snapshot.selectedMemoryId;
  const tuning = snapshot.observedTuning;
  return [
    snapshot.generation,
    memoryId ?? '',
    memoryId !== undefined && tuning
      ? `${tuning.rxHz}/${tuning.txHz ?? ''}/${tuning.mode}`
      : '',
  ].join('|');
}
