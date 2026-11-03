import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Communication, CoverageInterval } from '@signaldock/contracts';
import {
  CURSOR_FLOOR_ID,
  DEFAULT_HISTORY_FILTERS,
  MISSING_ROUTE_MESSAGE,
  SEARCH_DEBOUNCE_MS,
  activityPath,
  buildHeatmap,
  heatmapKeyMove,
  heatmapTabStop,
  buildTimeline,
  communicationsPath,
  coverageGaps,
  createDebouncer,
  dayHeading,
  formatClock,
  formatDuration,
  frequencyAccessibilityLabel,
  frequencyChipLabel,
  gapLabel,
  heatmapCellLabel,
  historyRowsState,
  intensityLevel,
  isMissingRoute,
  kindPresentation,
  localDayKey,
  matchesFilters,
  mergePage,
  parseActivity,
  parseCoverage,
  parseWaveform,
  rangeForBefore,
  rangeStart,
  reachedRangeStart,
  recentDayKeys,
  resamplePeaks,
  serverDirection,
  showCoverageGaps,
  transcriptPreview,
  waveformBarCount,
  zonedTime,
  type HistoryFilters,
} from './history-model';

const RADIO = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const UTC = 'UTC';
const SANTIAGO = 'America/Santiago';
/** Tuesday 2026-11-03 21:30 UTC. */
const NOW = Date.parse('2026-11-03T21:30:00Z');

function communication(overrides: Partial<Communication> = {}): Communication {
  return {
    id: crypto.randomUUID(),
    instanceId: '00000000-0000-4000-8000-000000000001',
    radioId: RADIO,
    conversationId: '00000000-0000-4000-8000-000000000009',
    kind: 'received_voice',
    direction: 'rx',
    startedAt: '2026-11-03T21:00:00.000Z',
    endedAt: '2026-11-03T21:00:14.000Z',
    frequencyHz: 146_520_000,
    frequencyAttribution: 'confirmed',
    context: {},
    revision: 1,
    transcripts: [],
    notes: [],
    tags: [],
    retentionHold: false,
    ...overrides,
  };
}
function interval(
  startedAt: string,
  endedAt?: string,
  reason?: string,
  radioId = RADIO,
): CoverageInterval {
  return {
    id: crypto.randomUUID(),
    radioId,
    generation: '00000000-0000-4000-8000-00000000000a',
    attribution: 'confirmed',
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(reason ? { reason } : {}),
  };
}
const filters = (overrides: Partial<HistoryFilters> = {}): HistoryFilters => ({
  ...DEFAULT_HISTORY_FILTERS,
  ...overrides,
});
const params = (path: string) =>
  new URLSearchParams(path.slice(path.indexOf('?') + 1));

describe('filters → query params', () => {
  it('maps direction chips to server directions', () => {
    expect(serverDirection('all')).toBeUndefined();
    expect(serverDirection('received')).toBe('rx');
    expect(serverDirection('transmitted')).toBe('tx');
    expect(serverDirection('notes')).toBe('internal');
    expect(serverDirection('digital')).toBeUndefined();
  });

  it('builds the first page query from scope and filters', () => {
    const path = communicationsPath(
      filters({ search: '  base station  ', direction: 'received' }),
      {
        radioId: OTHER,
        conversation: {
          id: '00000000-0000-4000-8000-000000000009',
          radioId: RADIO,
          frequencyHz: 146_520_000,
        },
      },
    );
    expect(path.startsWith('communications?')).toBe(true);
    expect(path).toContain('search=base%20station');
    expect(path).not.toContain('+');
    const query = params(path);
    expect(query.get('limit')).toBe('30');
    expect(query.get('conversationId')).toBe(
      '00000000-0000-4000-8000-000000000009',
    );
    // The frequency group's radio wins over the workspace radio.
    expect(query.get('radioId')).toBe(RADIO);
    expect(query.get('frequencyHz')).toBe('146520000');
    expect(query.get('direction')).toBe('rx');
    expect(query.has('beforeId')).toBe(false);
  });

  it('omits empty values', () => {
    const query = params(communicationsPath(filters({ search: '   ' }), {}));
    expect([...query.keys()]).toEqual(['limit']);
  });

  it('uses the page cursor before the heatmap cut-off', () => {
    const before = '2026-11-03T21:00:00.000Z';
    const first = params(communicationsPath(filters({ before }), {}));
    expect(first.get('beforeId')).toBe(CURSOR_FLOOR_ID);
    expect(first.get('beforeStartedAt')).toBe(before);
    const next = params(
      communicationsPath(
        filters({ before }),
        {},
        {
          id: RADIO,
          startedAt: '2026-11-03T20:00:00.000Z',
        },
      ),
    );
    expect(next.get('beforeId')).toBe(RADIO);
    expect(next.get('beforeStartedAt')).toBe('2026-11-03T20:00:00.000Z');
  });

  it('scopes the activity query like the timeline', () => {
    const query = params(
      activityPath(
        { direction: 'transmitted' },
        {
          radioId: RADIO,
          conversation: { id: OTHER, radioId: RADIO, frequencyHz: 145_430_000 },
          timeZone: SANTIAGO,
        },
      ),
    );
    expect(query.get('days')).toBe('7');
    expect(query.get('tz')).toBe(SANTIAGO);
    expect(query.get('radioId')).toBe(RADIO);
    expect(query.get('frequencyHz')).toBe('145430000');
    expect(query.get('direction')).toBe('tx');
  });
});

describe('client-side filters', () => {
  const scope = { now: NOW, timeZone: UTC };

  it('filters by kind and direction', () => {
    const note = communication({ kind: 'note', direction: 'internal' });
    const digital = communication({ kind: 'digital', direction: 'tx' });
    const rx = communication();
    expect(matchesFilters(note, filters({ direction: 'notes' }), scope)).toBe(
      true,
    );
    expect(matchesFilters(rx, filters({ direction: 'notes' }), scope)).toBe(
      false,
    );
    expect(
      matchesFilters(digital, filters({ direction: 'digital' }), scope),
    ).toBe(true);
    expect(
      matchesFilters(digital, filters({ direction: 'transmitted' }), scope),
    ).toBe(true);
    expect(
      matchesFilters(digital, filters({ direction: 'received' }), scope),
    ).toBe(false);
  });

  it('applies date ranges in the viewer time zone', () => {
    expect(rangeStart('all', NOW, UTC)).toBeUndefined();
    expect(rangeStart('today', NOW, UTC)).toBe(
      Date.parse('2026-11-03T00:00:00Z'),
    );
    // Santiago is UTC−3 in November (DST).
    expect(rangeStart('today', NOW, SANTIAGO)).toBe(
      Date.parse('2026-11-03T03:00:00Z'),
    );
    expect(rangeStart('24h', NOW, UTC)).toBe(NOW - 86_400_000);
    expect(rangeStart('7d', NOW, UTC)).toBe(NOW - 7 * 86_400_000);
    const yesterday = communication({ startedAt: '2026-11-02T23:00:00.000Z' });
    expect(matchesFilters(yesterday, filters({ range: 'today' }), scope)).toBe(
      false,
    );
    expect(matchesFilters(yesterday, filters({ range: '24h' }), scope)).toBe(
      true,
    );
  });

  it('honours the heatmap cut-off', () => {
    const item = communication({ startedAt: '2026-11-03T21:00:00.000Z' });
    expect(
      matchesFilters(
        item,
        filters({ before: '2026-11-03T21:00:00.000Z' }),
        scope,
      ),
    ).toBe(false);
    expect(
      matchesFilters(
        item,
        filters({ before: '2026-11-03T22:00:00.000Z' }),
        scope,
      ),
    ).toBe(true);
  });

  it('stops paging once the range start is passed', () => {
    const items = [
      communication({ startedAt: '2026-11-03T20:00:00.000Z' }),
      communication({ startedAt: '2026-11-02T20:00:00.000Z' }),
    ];
    expect(reachedRangeStart(items, { range: 'today' }, scope)).toBe(true);
    expect(reachedRangeStart(items, { range: '7d' }, scope)).toBe(false);
    expect(reachedRangeStart(items, { range: 'all' }, scope)).toBe(false);
    expect(reachedRangeStart([], { range: 'today' }, scope)).toBe(false);
  });

  it('widens the range when a heatmap jump falls outside it', () => {
    expect(rangeForBefore('today', '2026-11-01T10:00:00.000Z', scope)).toBe(
      'all',
    );
    expect(rangeForBefore('7d', '2026-11-01T10:00:00.000Z', scope)).toBe('7d');
  });

  it('merges pages without duplicates', () => {
    const a = communication();
    const b = communication();
    expect(mergePage([a], [a, b], true).map((item) => item.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(mergePage([a], [b], false)).toEqual([b]);
  });

  it('shows gaps only for unsearched received/all views', () => {
    expect(showCoverageGaps({ search: '', direction: 'all' })).toBe(true);
    expect(showCoverageGaps({ search: '', direction: 'received' })).toBe(true);
    expect(showCoverageGaps({ search: 'x', direction: 'all' })).toBe(false);
    expect(showCoverageGaps({ search: '', direction: 'notes' })).toBe(false);
  });
});

describe('time zone helpers', () => {
  it('converts local wall time to instants', () => {
    expect(new Date(zonedTime('2026-11-03', 21, UTC)).toISOString()).toBe(
      '2026-11-03T21:00:00.000Z',
    );
    expect(new Date(zonedTime('2026-11-03', 24, UTC)).toISOString()).toBe(
      '2026-11-04T00:00:00.000Z',
    );
    expect(new Date(zonedTime('2026-11-03', 21, SANTIAGO)).toISOString()).toBe(
      '2026-11-04T00:00:00.000Z',
    );
    // Before the September DST change Santiago is UTC−4.
    expect(new Date(zonedTime('2026-07-01', 0, SANTIAGO)).toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
  });

  it('resolves daylight-saving gaps and overlaps', () => {
    const iso = (day: string, hour: number, zone: string) =>
      new Date(zonedTime(day, hour, zone)).toISOString();
    // Santiago skips local midnight on 2026-09-06 (−04 → −03 at 04:00Z).
    expect(iso('2026-09-06', 0, SANTIAGO)).toBe('2026-09-06T04:00:00.000Z');
    expect(iso('2026-09-05', 24, SANTIAGO)).toBe('2026-09-06T04:00:00.000Z');
    expect(iso('2026-09-05', 23, SANTIAGO)).toBe('2026-09-06T03:00:00.000Z');
    expect(iso('2026-09-06', 1, SANTIAGO)).toBe('2026-09-06T04:00:00.000Z');
    // New York springs forward at 02:00 local on 2026-03-08.
    const york = 'America/New_York';
    expect(iso('2026-03-08', 1, york)).toBe('2026-03-08T06:00:00.000Z');
    expect(iso('2026-03-08', 2, york)).toBe('2026-03-08T07:00:00.000Z');
    expect(iso('2026-03-08', 3, york)).toBe('2026-03-08T07:00:00.000Z');
    // …and repeats 01:00 on 2026-11-01: the earliest instant wins.
    expect(iso('2026-11-01', 0, york)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso('2026-11-01', 1, york)).toBe('2026-11-01T05:00:00.000Z');
    expect(iso('2026-11-01', 2, york)).toBe('2026-11-01T07:00:00.000Z');
    // Berlin repeats 02:00 on 2026-10-25.
    const berlin = 'Europe/Berlin';
    expect(iso('2026-10-25', 2, berlin)).toBe('2026-10-25T00:00:00.000Z');
    expect(iso('2026-10-25', 3, berlin)).toBe('2026-10-25T02:00:00.000Z');
  });

  it('formats local days and clocks', () => {
    expect(localDayKey(NOW, UTC)).toBe('2026-11-03');
    expect(localDayKey(Date.parse('2026-11-04T01:00:00Z'), SANTIAGO)).toBe(
      '2026-11-03',
    );
    expect(formatClock(NOW, UTC)).toBe('21:30');
    expect(formatClock(NOW, SANTIAGO)).toBe('18:30');
    expect(recentDayKeys('2026-03-02', 3)).toEqual([
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(dayHeading('2026-11-03', '2026-11-03')).toBe('Today');
    expect(dayHeading('2026-11-02', '2026-11-03')).toBe('Yesterday');
    expect(dayHeading('2026-10-27', '2026-11-03')).toBe('Tuesday, Oct 27');
    expect(dayHeading('2025-12-31', '2026-11-03')).toBe(
      'Wednesday, Dec 31, 2025',
    );
  });
});

describe('activity heatmap', () => {
  it('parses and rejects activity responses', () => {
    expect(
      parseActivity({
        timeZone: UTC,
        days: ['2026-11-03'],
        buckets: [{ day: '2026-11-03', hour: 21, count: 2 }],
      }),
    ).toEqual({
      days: ['2026-11-03'],
      buckets: [{ day: '2026-11-03', hour: 21, count: 2 }],
    });
    expect(parseActivity({ buckets: [] })).toEqual({ days: [], buckets: [] });
    expect(parseActivity({ buckets: [{ day: 'x', hour: 1, count: 1 }] })).toBe(
      undefined,
    );
    expect(
      parseActivity({ buckets: [{ day: '2026-11-03', hour: 24, count: 1 }] }),
    ).toBe(undefined);
    expect(parseActivity(null)).toBeUndefined();
  });

  it('assigns four intensity levels relative to the busiest hour', () => {
    expect(intensityLevel(0, 10)).toBe(0);
    expect(intensityLevel(1, 10)).toBe(1);
    expect(intensityLevel(3, 10)).toBe(2);
    expect(intensityLevel(6, 10)).toBe(3);
    expect(intensityLevel(10, 10)).toBe(4);
    expect(intensityLevel(5, 0)).toBe(0);
  });

  it('labels cells for screen readers', () => {
    expect(heatmapCellLabel('2026-11-03', 21, 12)).toBe(
      'Tuesday 21:00, 12 communications',
    );
    expect(heatmapCellLabel('2026-11-03', 5, 1)).toBe(
      'Tuesday 05:00, 1 communication',
    );
    expect(heatmapCellLabel('2026-11-03', 5, 0)).toBe(
      'Tuesday 05:00, no communications',
    );
  });

  it('builds a 7 × 24 grid oldest day first', () => {
    const heatmap = buildHeatmap(
      {
        days: [],
        buckets: [
          { day: '2026-11-03', hour: 21, count: 8 },
          { day: '2026-11-03', hour: 21, count: 4 },
          { day: '2026-10-28', hour: 9, count: 3 },
          { day: '2026-10-01', hour: 9, count: 99 },
        ],
      },
      { timeZone: UTC, now: NOW },
    );
    expect(heatmap.rows.map((row) => row.day)).toEqual(
      recentDayKeys('2026-11-03', 7),
    );
    expect(heatmap.rows.every((row) => row.cells.length === 24)).toBe(true);
    expect(heatmap.max).toBe(12);
    expect(heatmap.total).toBe(15);
    const today = heatmap.rows.at(-1)!;
    expect(today.shortLabel).toBe('Tue');
    const cell = today.cells[21]!;
    expect(cell.count).toBe(12);
    expect(cell.level).toBe(4);
    expect(cell.endsAt).toBe('2026-11-03T22:00:00.000Z');
    expect(cell.future).toBe(false);
    expect(today.cells[22]!.future).toBe(true);
    expect(heatmap.rows[0]!.cells[9]!.level).toBe(1);
  });

  it('keeps one Tab stop and moves through started hours with the keyboard', () => {
    const heatmap = buildHeatmap(
      { days: [], buckets: [] },
      { timeZone: UTC, now: NOW },
    );
    // NOW is Tuesday 21:30 UTC: the latest started hour is today 21:00.
    expect(heatmapTabStop(heatmap, undefined)).toEqual({ row: 6, hour: 21 });
    const selected = heatmap.rows[2]!.cells[5]!.endsAt;
    expect(heatmapTabStop(heatmap, selected)).toEqual({ row: 2, hour: 5 });
    const at = { row: 6, hour: 21 };
    expect(heatmapKeyMove('ArrowLeft', at, heatmap)).toEqual({
      row: 6,
      hour: 20,
    });
    expect(heatmapKeyMove('ArrowRight', at, heatmap)).toBeUndefined();
    expect(heatmapKeyMove('ArrowDown', at, heatmap)).toBeUndefined();
    expect(heatmapKeyMove('ArrowUp', at, heatmap)).toEqual({
      row: 5,
      hour: 21,
    });
    expect(heatmapKeyMove('Home', at, heatmap)).toEqual({ row: 6, hour: 0 });
    expect(heatmapKeyMove('End', { row: 6, hour: 0 }, heatmap)).toEqual(at);
    expect(heatmapKeyMove('End', { row: 5, hour: 3 }, heatmap)).toEqual({
      row: 5,
      hour: 23,
    });
    expect(heatmapKeyMove('ArrowUp', { row: 0, hour: 3 }, heatmap)).toBe(
      undefined,
    );
    expect(heatmapKeyMove('Enter', at, heatmap)).toBeUndefined();
  });

  it('uses the server day list and time zone for cell ends', () => {
    const heatmap = buildHeatmap(
      {
        days: ['2026-11-02', '2026-11-03'],
        buckets: [{ day: '2026-11-03', hour: 18, count: 1 }],
      },
      { timeZone: SANTIAGO, now: NOW, days: 7 },
    );
    expect(heatmap.rows.map((row) => row.day)).toEqual([
      '2026-11-02',
      '2026-11-03',
    ]);
    expect(heatmap.rows[1]!.cells[18]!.endsAt).toBe('2026-11-03T22:00:00.000Z');
  });
});

describe('coverage gaps', () => {
  it('parses both coverage response shapes', () => {
    const item = interval('2026-11-03T20:00:00.000Z');
    expect(parseCoverage({ items: [item] })).toEqual([item]);
    expect(parseCoverage({ intervals: [item, { id: 1 }] })).toEqual([item]);
    expect(parseCoverage({})).toBeUndefined();
  });

  it('finds gaps between intervals with the closing reason', () => {
    const gaps = coverageGaps([
      interval('2026-11-03T21:59:00.000Z'),
      interval(
        '2026-11-03T21:00:00.000Z',
        '2026-11-03T21:44:00.000Z',
        'radio reconnecting',
      ),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      startedAt: '2026-11-03T21:44:00.000Z',
      endedAt: '2026-11-03T21:59:00.000Z',
      reason: 'radio reconnecting',
    });
    expect(gapLabel(gaps[0]!, UTC)).toBe(
      'No coverage 21:44 → 21:59 · radio reconnecting',
    );
  });

  it('reports an open gap after the last closed interval', () => {
    const gaps = coverageGaps([
      interval('2026-11-03T20:00:00.000Z', '2026-11-03T21:10:00.000Z', 'stop'),
    ]);
    expect(gaps).toEqual([
      expect.objectContaining({
        startedAt: '2026-11-03T21:10:00.000Z',
        reason: 'stop',
      }),
    ]);
    expect(gaps[0]!.endedAt).toBeUndefined();
    expect(gapLabel(gaps[0]!, UTC)).toBe('No coverage since 21:10 · stop');
  });

  it('merges overlaps, ignores blips and separates radios', () => {
    const gaps = coverageGaps([
      interval('2026-11-03T20:00:00.000Z', '2026-11-03T21:00:00.000Z'),
      interval('2026-11-03T20:30:00.000Z', '2026-11-03T20:40:00.000Z'),
      interval('2026-11-03T21:00:00.500Z'),
      interval(
        '2026-11-03T19:00:00.000Z',
        '2026-11-03T19:30:00.000Z',
        undefined,
        OTHER,
      ),
      interval('2026-11-03T20:00:00.000Z', undefined, undefined, OTHER),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      radioId: OTHER,
      startedAt: '2026-11-03T19:30:00.000Z',
      endedAt: '2026-11-03T20:00:00.000Z',
    });
  });

  it('labels gaps spanning days with the start day', () => {
    expect(
      gapLabel(
        {
          id: 'x',
          radioId: RADIO,
          startedAt: '2026-11-02T23:00:00.000Z',
          endedAt: '2026-11-03T01:00:00.000Z',
        },
        UTC,
      ),
    ).toBe('No coverage Mon 23:00 → 01:00');
  });
});

describe('timeline interleaving', () => {
  const scope = { now: NOW, timeZone: UTC };
  const late = communication({ startedAt: '2026-11-03T21:59:00.000Z' });
  const early = communication({ startedAt: '2026-11-03T21:42:00.000Z' });
  const yesterday = communication({ startedAt: '2026-11-02T10:00:00.000Z' });
  const gap = {
    id: 'g1',
    radioId: RADIO,
    startedAt: '2026-11-03T21:44:00.000Z',
    endedAt: '2026-11-03T21:58:00.000Z',
  };

  it('places gaps chronologically with day headings', () => {
    const entries = buildTimeline({
      items: [late, early, yesterday],
      gaps: [gap],
      complete: false,
      filters: filters(),
      scope,
      oldestLoaded: yesterday.startedAt,
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'd:2026-11-03',
      `c:${late.id}`,
      'g:g1',
      `c:${early.id}`,
      'd:2026-11-02',
      `c:${yesterday.id}`,
    ]);
    expect(entries[0]).toMatchObject({ label: 'Today' });
    expect(entries[4]).toMatchObject({ label: 'Yesterday' });
  });

  it('keeps gaps inside the loaded window', () => {
    const old = {
      id: 'old',
      radioId: RADIO,
      startedAt: '2026-11-01T00:00:00.000Z',
      endedAt: '2026-11-01T01:00:00.000Z',
    };
    const partial = buildTimeline({
      items: [late],
      gaps: [old],
      complete: false,
      filters: filters(),
      scope,
      oldestLoaded: late.startedAt,
    });
    expect(partial.some((entry) => entry.type === 'gap')).toBe(false);
    const complete = buildTimeline({
      items: [late],
      gaps: [old],
      complete: true,
      filters: filters(),
      scope,
    });
    expect(complete.some((entry) => entry.type === 'gap')).toBe(true);
    const today = buildTimeline({
      items: [late],
      gaps: [old],
      complete: true,
      filters: filters({ range: 'today' }),
      scope,
    });
    expect(today.some((entry) => entry.type === 'gap')).toBe(false);
  });

  it('drops gaps after the heatmap cut-off and sorts open gaps first', () => {
    const open = {
      id: 'open',
      radioId: RADIO,
      startedAt: '2026-11-03T21:20:00.000Z',
    };
    const cut = buildTimeline({
      items: [],
      gaps: [open],
      complete: true,
      filters: filters({ before: '2026-11-03T21:00:00.000Z' }),
      scope,
    });
    expect(cut).toEqual([]);
    const live = buildTimeline({
      items: [communication({ startedAt: '2026-11-03T21:10:00.000Z' })],
      gaps: [open],
      complete: true,
      filters: filters(),
      scope,
    });
    expect(live.map((entry) => entry.type)).toEqual([
      'day',
      'gap',
      'communication',
    ]);
  });
});

describe('row presentation', () => {
  it('describes kinds with icons and transmit tone', () => {
    expect(
      kindPresentation({ kind: 'received_voice', direction: 'rx' }),
    ).toEqual({ icon: 'rx', label: 'Received', transmit: false });
    expect(
      kindPresentation({ kind: 'transmitted_voice', direction: 'tx' }),
    ).toMatchObject({ icon: 'tx', transmit: true });
    expect(
      kindPresentation({ kind: 'transmitted_tts', direction: 'tx' }),
    ).toMatchObject({ icon: 'wave', label: 'Transmitted speech' });
    expect(
      kindPresentation({ kind: 'digital', direction: 'rx' }),
    ).toMatchObject({
      icon: 'signal',
      label: 'Digital · received',
      transmit: false,
    });
    expect(kindPresentation({ kind: 'note', direction: 'internal' }).icon).toBe(
      'note',
    );
  });

  it('formats durations and frequencies', () => {
    expect(formatDuration(14_000)).toBe('0:14');
    expect(formatDuration(723_400)).toBe('12:03');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(frequencyChipLabel(146_520_000)).toBe('146.520');
    expect(frequencyChipLabel()).toBe('Unknown frequency');
    expect(frequencyAccessibilityLabel(146_520_000, 'inferred')).toBe(
      '146.520 MHz, inferred source',
    );
  });

  it('truncates long transcripts on a word boundary', () => {
    expect(transcriptPreview('short')).toEqual({
      text: 'short',
      truncated: false,
    });
    const long = transcriptPreview('word '.repeat(60), 50);
    expect(long.truncated).toBe(true);
    expect(long.text.endsWith('word…')).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(51);
  });
});

describe('waveform', () => {
  it('parses and clamps peaks', () => {
    expect(
      parseWaveform({ peaks: [0.5, 2, -1, 'x'], durationMs: 1000 }),
    ).toEqual({ peaks: [0.5, 1, 0, 0], durationMs: 1000 });
    expect(parseWaveform(undefined)).toBeUndefined();
    expect(parseWaveform({ peaks: [] })).toEqual({ peaks: [], durationMs: 0 });
  });

  it('sizes bars by duration', () => {
    expect(waveformBarCount(14_000)).toBe(35);
    expect(waveformBarCount(500)).toBe(6);
    expect(waveformBarCount(600_000)).toBe(64);
  });

  it('max-pools and stretches peaks', () => {
    expect(resamplePeaks([0.1, 0.9, 0.2, 0.4], 2)).toEqual([0.9, 0.4]);
    expect(resamplePeaks([0.3, 0.6], 4)).toEqual([0.3, 0.3, 0.6, 0.6]);
    expect(resamplePeaks([], 4)).toEqual([]);
  });
});

describe('errors', () => {
  class CodedError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  it('recognises missing routes only', () => {
    expect(
      isMissingRoute(new CodedError('NOT_FOUND', MISSING_ROUTE_MESSAGE)),
    ).toBe(true);
    expect(
      isMissingRoute(
        new CodedError('INTERNAL_ERROR', 'Request failed (HTTP 501).'),
      ),
    ).toBe(true);
    expect(
      isMissingRoute(
        new CodedError('NOT_FOUND', 'Communication is unavailable.'),
      ),
    ).toBe(false);
    expect(isMissingRoute(new CodedError('FORBIDDEN', 'No.'))).toBe(false);
    expect(isMissingRoute('nope')).toBe(false);
  });
});

describe('debounce', () => {
  afterEach(() => vi.useRealTimers());

  it('runs the latest value after 350 ms of quiet', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const debounced = createDebouncer((value: string) => calls.push(value));
    debounced.schedule('b');
    vi.advanceTimersByTime(200);
    debounced.schedule('ba');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(calls).toEqual([]);
    expect(debounced.pending()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['ba']);
    expect(debounced.pending()).toBe(false);
  });

  it('flushes immediately and cancels', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const debounced = createDebouncer((value: string) => calls.push(value));
    debounced.schedule('base');
    debounced.flush();
    expect(calls).toEqual(['base']);
    debounced.flush();
    expect(calls).toEqual(['base']);
    debounced.schedule('x');
    debounced.cancel();
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual(['base']);
  });

  it('accepts injected timers', () => {
    const scheduled: (() => void)[] = [];
    const calls: number[] = [];
    const debounced = createDebouncer(
      (value: number) => calls.push(value),
      10,
      {
        setTimeout: (callback) => scheduled.push(callback),
        clearTimeout: () => {},
      },
    );
    debounced.schedule(1);
    scheduled.at(-1)!();
    expect(calls).toEqual([1]);
  });
});

describe('historyRowsState', () => {
  const radioA = '/communications?radioId=a';
  const radioB = '/communications?radioId=b';
  const base = {
    pageQuery: radioA,
    failedQuery: undefined,
    currentQuery: radioA,
    busy: false,
    appending: false,
  };

  it('keeps rows that answer the current query, even after a failed refresh', () => {
    expect(historyRowsState(base)).toBe('current');
    expect(historyRowsState({ ...base, failedQuery: radioA })).toBe('current');
    expect(historyRowsState({ ...base, busy: true, appending: true })).toBe(
      'current',
    );
  });

  it('dims older rows while a new first page is loading or about to load', () => {
    expect(
      historyRowsState({ ...base, currentQuery: radioB, busy: true }),
    ).toBe('loading');
    expect(historyRowsState({ ...base, busy: true })).toBe('loading');
    expect(historyRowsState({ ...base, currentQuery: radioB })).toBe('pending');
    expect(
      historyRowsState({ ...base, pageQuery: undefined, currentQuery: radioB }),
    ).toBe('pending');
  });

  it("hides another radio's rows once the new query failed", () => {
    expect(
      historyRowsState({
        ...base,
        currentQuery: radioB,
        failedQuery: radioB,
      }),
    ).toBe('failed');
    expect(
      historyRowsState({
        ...base,
        pageQuery: undefined,
        currentQuery: radioB,
        failedQuery: radioB,
      }),
    ).toBe('failed');
    // A stale failure for another query does not hide current rows.
    expect(historyRowsState({ ...base, failedQuery: radioB })).toBe('current');
  });
});
