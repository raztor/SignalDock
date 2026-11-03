import { describe, expect, it } from 'vitest';
import type { RadioMemory, RadioView } from '@signaldock/contracts';
import {
  MEMORY_FILTER_THRESHOLD,
  activeMemoryLabel,
  activeMemoryState,
  filterMemoriesByBand,
  memoryAccess,
  memoryBandFilters,
  memoryDisplayName,
  memoryGridColumns,
  memoryTileSummary,
  overwriteMessage,
  storeCandidate,
  type MemoryAccessInput,
} from './memory-grid-model';

const memory = (
  memoryId: string,
  rxHz: number,
  extra: Partial<RadioMemory['tuning']> & { name?: string } = {},
): RadioMemory => {
  const { name = `Mem ${memoryId}`, ...tuning } = extra;
  return { memoryId, name, tuning: { rxHz, mode: 'FM', ...tuning } };
};

const radio = (
  memories: { read: boolean; write: boolean; select: boolean } | undefined,
  snapshot: Partial<NonNullable<RadioView['snapshot']>> = {},
): RadioView => ({
  radioId: 'r1',
  displayName: 'Radio',
  driverId: 'sim',
  resourceGroupIds: [],
  enabled: true,
  descriptor: {
    radioId: 'r1',
    displayName: 'Radio',
    driverId: 'sim',
    resourceGroupIds: [],
    capabilities: {
      ...(memories ? { memories } : {}),
      tuning: {
        writable: true,
        ranges: [{ minHz: 136_000_000, maxHz: 174_000_000 }],
        modes: ['FM'],
      },
      rxAudio: true,
      txAudio: true,
      ptt: 'explicit',
      physicalTxObservation: false,
      independentlyReceivableChannels: 1,
      verification: 'simulated',
    },
  },
  snapshot: {
    radioId: 'r1',
    generation: 'g1',
    revision: 1,
    connection: 'ready',
    tuningConfidence: 'confirmed',
    txState: 'idle',
    ...snapshot,
  },
  control: null,
  health: { state: 'connected' },
});

const full = { read: true, write: true, select: true };
const input = (overrides: Partial<MemoryAccessInput>): MemoryAccessInput => ({
  radio: radio(full),
  editable: true,
  controlState: 'mine',
  canControl: true,
  busy: false,
  ...overrides,
});

describe('memory tiles', () => {
  it('keeps the original name and falls back for unnamed slots', () => {
    expect(
      memoryDisplayName(memory('1', 146_520_000, { name: 'Llamada' })),
    ).toBe('Llamada');
    expect(memoryDisplayName(memory('7', 146_520_000, { name: '  ' }))).toBe(
      'Memory 7',
    );
  });
  it('summarises frequency, mode, offset and band', () => {
    const summary = memoryTileSummary(
      memory('2', 145_430_000, { name: 'Repetidor', txHz: 144_830_000 }),
    );
    expect(summary).toMatchObject({
      frequency: '145.430',
      mode: 'FM',
      offset: '−600 kHz',
      band: '2 m',
      detail: 'FM · −600 kHz · 2 m',
    });
    expect(summary.spoken).toBe(
      'Repetidor, 145.430 MHz FM, −600 kHz offset, 2 m',
    );
    expect(memoryTileSummary(memory('3', 156_800_000)).spoken).toContain(
      'simplex',
    );
  });
});

describe('band filters', () => {
  const two = Array.from({ length: 5 }, (_, i) =>
    memory(`a${i}`, 146_000_000 + i * 25_000),
  );
  const uhf = Array.from({ length: 4 }, (_, i) =>
    memory(`b${i}`, 439_000_000 + i * 25_000),
  );
  it('only appears above the threshold with at least two bands', () => {
    expect(memoryBandFilters(two)).toEqual([]);
    expect(
      memoryBandFilters(
        Array.from({ length: MEMORY_FILTER_THRESHOLD + 1 }, (_, i) =>
          memory(`c${i}`, 146_000_000 + i),
        ),
      ),
    ).toEqual([]);
    expect(memoryBandFilters([...uhf, ...two])).toEqual([
      { band: '2 m', count: 5 },
      { band: '70 cm', count: 4 },
    ]);
  });
  it('filters by band and falls back to everything for unknown bands', () => {
    const all = [...two, ...uhf];
    expect(filterMemoriesByBand(all, '70 cm')).toEqual(uhf);
    expect(filterMemoriesByBand(all, undefined)).toEqual(all);
    expect(filterMemoriesByBand(all, '23 cm')).toEqual(all);
  });
});

describe('grid columns', () => {
  it('fits as many minimum-width tiles as possible', () => {
    expect(memoryGridColumns(0, 8)).toEqual({ columns: 1, tileWidth: 148 });
    expect(memoryGridColumns(300, 8)).toEqual({ columns: 1, tileWidth: 300 });
    expect(memoryGridColumns(312, 8)).toEqual({ columns: 2, tileWidth: 152 });
    expect(memoryGridColumns(304, 8)).toEqual({ columns: 2, tileWidth: 148 });
    expect(memoryGridColumns(120, 8)).toEqual({ columns: 1, tileWidth: 120 });
    expect(memoryGridColumns(800, 8).columns).toBe(5);
  });
});

describe('active memory', () => {
  it('never claims a confirmed selection the radio has not confirmed', () => {
    expect(
      activeMemoryLabel(activeMemoryState({ tuningConfidence: 'confirmed' })),
    ).toBe('Active');
    expect(
      activeMemoryLabel(activeMemoryState({ tuningConfidence: 'inferred' })),
    ).toBe('Active · inferred');
    expect(activeMemoryState({ tuningConfidence: 'unknown' })).toBe(
      'unconfirmed',
    );
    expect(activeMemoryState(null)).toBe('unconfirmed');
  });
});

describe('memory access', () => {
  it('allows recall and store with the lease on a ready, idle radio', () => {
    expect(memoryAccess(input({}))).toEqual({
      readable: true,
      canRecall: true,
      recallReason: undefined,
      writable: true,
      canStore: true,
      storeReason: undefined,
    });
  });
  it('follows the driver capabilities', () => {
    const access = memoryAccess(
      input({ radio: radio({ read: true, write: false, select: false }) }),
    );
    expect(access).toMatchObject({
      readable: true,
      canRecall: false,
      writable: false,
      canStore: false,
    });
    expect(access.recallReason).toMatch(/cannot recall/);
    expect(memoryAccess(input({ radio: radio(undefined) })).readable).toBe(
      false,
    );
  });
  it('never enables writes for listener-only accounts', () => {
    const access = memoryAccess(
      input({ editable: false, canControl: false, controlState: 'other' }),
    );
    expect(access.canRecall).toBe(false);
    expect(access.canStore).toBe(false);
    expect(access.recallReason).toMatch(/cannot control/);
  });
  it('explains each reason writes are blocked', () => {
    const reason = (overrides: Partial<MemoryAccessInput>) =>
      memoryAccess(input({ editable: false, ...overrides })).recallReason;
    expect(reason({ radio: undefined })).toBe('Select a radio first.');
    expect(reason({ controlState: 'other' })).toBe(
      'Another operator has control.',
    );
    expect(reason({ controlState: 'available' })).toBe(
      'Take control to use memories.',
    );
    expect(reason({ controlState: 'unavailable' })).toMatch(/ready/);
    expect(reason({ radio: radio(full, { connection: 'degraded' }) })).toMatch(
      /ready/,
    );
    expect(reason({ radio: radio(full, { txState: 'transmitting' }) })).toBe(
      'Wait until transmission ends.',
    );
    expect(reason({ busy: true })).toMatch(/in progress/);
    expect(reason({})).toMatch(/refresh/);
  });
});

describe('store candidate', () => {
  it('stores the observed tuning and flags inferred tunings', () => {
    expect(
      storeCandidate({
        tuningConfidence: 'confirmed',
        observedTuning: { rxHz: 146_550_000, mode: 'FM' },
      }),
    ).toEqual({
      ok: true,
      tuning: { rxHz: 146_550_000, mode: 'FM' },
      inferred: false,
    });
    expect(
      storeCandidate({
        tuningConfidence: 'inferred',
        observedTuning: { rxHz: 145_430_000, txHz: 144_830_000, mode: 'FM' },
      }),
    ).toEqual({
      ok: true,
      tuning: { rxHz: 145_430_000, txHz: 144_830_000, mode: 'FM' },
      inferred: true,
    });
  });
  it('refuses unknown or missing tunings', () => {
    expect(
      storeCandidate({
        tuningConfidence: 'unknown',
        observedTuning: { rxHz: 146_550_000, mode: 'FM' },
      }).ok,
    ).toBe(false);
    expect(storeCandidate({ tuningConfidence: 'confirmed' }).ok).toBe(false);
    expect(storeCandidate(undefined).ok).toBe(false);
  });
});

describe('overwrite message', () => {
  it('names the memory, the tuning and the consequence', () => {
    expect(
      overwriteMessage(
        memory('1', 146_520_000, { name: 'Simplex llamada' }),
        { rxHz: 146_550_000, mode: 'FM' },
        false,
      ),
    ).toBe(
      "Overwrite Simplex llamada with 146.550 FM? This changes the radio's stored memory.",
    );
    expect(
      overwriteMessage(
        memory('2', 439_100_000, { name: 'Club UHF' }),
        { rxHz: 439_100_000, txHz: 434_100_000, mode: 'FM' },
        true,
      ),
    ).toBe(
      "Overwrite Club UHF with 439.100 FM (−5 MHz)? This changes the radio's stored memory. The radio has not confirmed this tuning yet.",
    );
  });
});
