/**
 * Pure helpers behind `MemoryGrid`: tile text, band filters, and the reasons a
 * memory can or cannot be recalled or overwritten. No React Native imports so
 * it can be unit tested in node.
 */
import type {
  RadioMemory,
  RadioSnapshot,
  RadioView,
  Tuning,
} from '@signaldock/contracts';
import {
  bandLabel,
  formatFrequency,
  formatOffset,
  formatTuning,
  groupMemoriesByBand,
  offsetOf,
} from '../../station/station-model';

/** Band filter chips appear only above this many memories. */
export const MEMORY_FILTER_THRESHOLD = 8;
/** Narrowest tile before the grid drops a column. */
export const MEMORY_TILE_MIN_WIDTH = 148;

/** Visible memory name, kept in its original language; unnamed slots get a fallback. */
export function memoryDisplayName(memory: RadioMemory): string {
  const name = memory.name.trim();
  return name || `Memory ${memory.memoryId}`;
}

export interface MemoryTileSummary {
  name: string;
  /** '146.520' (MHz, more decimals only when needed). */
  frequency: string;
  mode: Tuning['mode'];
  /** 'Simplex' | '+600 kHz' | '−5 MHz'. */
  offset: string;
  band: string;
  /** 'FM · −600 kHz · 2 m'. */
  detail: string;
  /** Screen reader text: 'Repeater, 145.430 MHz FM, −600 kHz offset, 2 m'. */
  spoken: string;
}
export function memoryTileSummary(memory: RadioMemory): MemoryTileSummary {
  const name = memoryDisplayName(memory);
  const frequency = formatFrequency(memory.tuning.rxHz);
  const offsetHz = offsetOf(memory.tuning);
  const offset = formatOffset(offsetHz);
  const band = bandLabel(memory.tuning.rxHz);
  return {
    name,
    frequency,
    mode: memory.tuning.mode,
    offset,
    band,
    detail: `${memory.tuning.mode} · ${offset} · ${band}`,
    spoken: `${name}, ${frequency} MHz ${memory.tuning.mode}, ${
      offsetHz === 0 ? 'simplex' : `${offset} offset`
    }, ${band}`,
  };
}

export interface MemoryBandFilter {
  band: string;
  count: number;
}
/** Band chips for the filter row; empty when the list is short or has one band. */
export function memoryBandFilters(
  memories: readonly RadioMemory[],
): MemoryBandFilter[] {
  if (memories.length <= MEMORY_FILTER_THRESHOLD) return [];
  const groups = groupMemoriesByBand(memories);
  return groups.length < 2
    ? []
    : groups.map((group) => ({
        band: group.band,
        count: group.memories.length,
      }));
}
/** The memories in `band`, or all of them when no band (or an unknown one) is set. */
export function filterMemoriesByBand(
  memories: readonly RadioMemory[],
  band: string | undefined,
): RadioMemory[] {
  if (band === undefined) return [...memories];
  const matching = memories.filter(
    (memory) => bandLabel(memory.tuning.rxHz) === band,
  );
  return matching.length ? matching : [...memories];
}

/** Columns and tile width that fill `width` with tiles at least `minWidth` wide. */
export function memoryGridColumns(
  width: number,
  gap: number,
  minWidth = MEMORY_TILE_MIN_WIDTH,
): { columns: number; tileWidth: number } {
  if (!Number.isFinite(width) || width <= 0)
    return { columns: 1, tileWidth: minWidth };
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  return {
    columns,
    tileWidth: Math.floor((width - gap * (columns - 1)) / columns),
  };
}

export type ActiveMemoryState = 'confirmed' | 'inferred' | 'unconfirmed';
/** How sure the radio is that the highlighted memory is really active. */
export function activeMemoryState(
  snapshot: Pick<RadioSnapshot, 'tuningConfidence'> | null | undefined,
): ActiveMemoryState {
  return snapshot?.tuningConfidence === 'confirmed'
    ? 'confirmed'
    : snapshot?.tuningConfidence === 'inferred'
      ? 'inferred'
      : 'unconfirmed';
}
export function activeMemoryLabel(state: ActiveMemoryState): string {
  return state === 'confirmed'
    ? 'Active'
    : state === 'inferred'
      ? 'Active · inferred'
      : 'Last selected · unconfirmed';
}

export type MemoryControlState = 'mine' | 'other' | 'available' | 'unavailable';
export interface MemoryAccessInput {
  radio: RadioView | undefined;
  editable: boolean;
  controlState: MemoryControlState;
  canControl: boolean;
  busy: boolean;
}
export interface MemoryAccess {
  /** The driver exposes the memory list. */
  readable: boolean;
  /** A tile press recalls the memory right now. */
  canRecall: boolean;
  /** Why tiles are informational (undefined when `canRecall`). */
  recallReason: string | undefined;
  /** The driver can overwrite memories, so tiles show the store action. */
  writable: boolean;
  /** The store action can run right now (still needs a known tuning). */
  canStore: boolean;
  storeReason: string | undefined;
}

/** Shared explanation for why a write is not possible right now. */
function writeBlocker(input: MemoryAccessInput): string | undefined {
  const { radio, editable, controlState, canControl, busy } = input;
  if (editable) return undefined;
  if (!radio) return 'Select a radio first.';
  if (!canControl)
    return 'You can view memories but this account cannot control the radio.';
  if (controlState === 'other') return 'Another operator has control.';
  if (controlState === 'available') return 'Take control to use memories.';
  if (controlState === 'unavailable')
    return 'The radio must be ready before taking control.';
  const snapshot = radio.snapshot;
  if (!snapshot || snapshot.connection !== 'ready')
    return 'The radio must be ready to use memories.';
  if (snapshot.txState !== 'idle') return 'Wait until transmission ends.';
  if (busy) return 'Another radio operation is in progress.';
  return 'Radio state changed · waiting for control to refresh.';
}

export function memoryAccess(input: MemoryAccessInput): MemoryAccess {
  const capabilities = input.radio?.descriptor?.capabilities.memories;
  const readable = Boolean(capabilities?.read);
  const selectable = Boolean(capabilities?.select);
  const writable = Boolean(capabilities?.write);
  const blocker = writeBlocker(input);
  const recallReason =
    input.radio && !selectable
      ? 'This radio cannot recall memories remotely.'
      : blocker;
  return {
    readable,
    canRecall: selectable && blocker === undefined,
    recallReason,
    writable,
    canStore: writable && blocker === undefined,
    storeReason:
      input.radio && !writable
        ? 'This radio cannot store memories remotely.'
        : blocker,
  };
}

export type StoreCandidate =
  | { ok: true; tuning: Tuning; inferred: boolean }
  | { ok: false; reason: string };
/**
 * The tuning "Store current tuning here" writes: the radio's observed tuning.
 * An unknown or missing tuning is never stored.
 */
export function storeCandidate(
  snapshot:
    | Pick<RadioSnapshot, 'observedTuning' | 'tuningConfidence'>
    | null
    | undefined,
): StoreCandidate {
  const observed = snapshot?.observedTuning;
  if (!observed || snapshot.tuningConfidence === 'unknown')
    return {
      ok: false,
      reason: "The radio's current tuning is unknown, so it cannot be stored.",
    };
  const tuning: Tuning = {
    rxHz: observed.rxHz,
    ...(observed.txHz === undefined ? {} : { txHz: observed.txHz }),
    mode: observed.mode,
  };
  return {
    ok: true,
    tuning,
    inferred: snapshot.tuningConfidence !== 'confirmed',
  };
}

/** 'Overwrite Club UHF with 439.100 FM? This changes the radio's stored memory.' */
export function overwriteMessage(
  memory: RadioMemory,
  tuning: Tuning,
  inferred: boolean,
): string {
  const offsetHz = offsetOf(tuning);
  const offset = offsetHz === 0 ? '' : ` (${formatOffset(offsetHz)})`;
  return `Overwrite ${memoryDisplayName(memory)} with ${formatTuning(tuning)}${offset}? This changes the radio's stored memory.${
    inferred ? ' The radio has not confirmed this tuning yet.' : ''
  }`;
}
