/**
 * Pure history logic: filters → query strings, heatmap grid, coverage gaps,
 * timeline interleaving, waveform resampling and debouncing. No React Native
 * imports so it runs in the node test environment.
 */
import type {
  Communication,
  Conversation,
  CoverageInterval,
} from '@signaldock/contracts';
import { formatFrequency } from '../station/station-model';

export const SEARCH_DEBOUNCE_MS = 350;
export const HISTORY_PAGE_LIMIT = 30;
export const ACTIVITY_DAYS = 7;
export const HEATMAP_LEVELS = 4;
export const WAVEFORM_POINTS = 64;
/** Coverage breaks shorter than this are reconnect blips, not gaps. */
export const MIN_GAP_MS = 1000;
/** Characters of a transcript shown before "Show more". */
export const TRANSCRIPT_PREVIEW_CHARS = 180;
/** Frequency chips shown before "More frequencies". */
export const FREQUENCY_CHIP_LIMIT = 12;
/**
 * Lowest possible UUID. With `beforeStartedAt=T` it makes the cursor
 * `(started_at, id) < (T, nil)` select exactly `started_at < T`.
 */
export const CURSOR_FLOOR_ID = '00000000-0000-0000-0000-000000000000';
/** Exact message of the API's unknown-route handler. */
export const MISSING_ROUTE_MESSAGE = 'This endpoint is not available.';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ─── Filters ───────────────────────────────────────────────────────────────

export type DirectionFilter =
  'all' | 'received' | 'transmitted' | 'notes' | 'digital';
export const DIRECTION_FILTERS: readonly {
  value: DirectionFilter;
  label: string;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'received', label: 'Received' },
  { value: 'transmitted', label: 'Transmitted' },
  { value: 'notes', label: 'Notes' },
  { value: 'digital', label: 'Digital' },
];

export type DateRangeFilter = 'today' | '24h' | '7d' | 'all';
export const DATE_RANGE_FILTERS: readonly {
  value: DateRangeFilter;
  label: string;
}[] = [
  { value: 'today', label: 'Today' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 days' },
  { value: 'all', label: 'All' },
];

export interface HistoryFilters {
  direction: DirectionFilter;
  range: DateRangeFilter;
  /** Applied (debounced) search text. */
  search: string;
  /** ISO instant chosen from the heatmap: only communications before it. */
  before?: string;
}
export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  direction: 'all',
  range: 'all',
  search: '',
};

export type ConversationScope = Pick<
  Conversation,
  'id' | 'radioId' | 'frequencyHz'
>;
export interface HistoryScope {
  /** Radio selected in the workspace, if any. */
  radioId?: string;
  /** Frequency group chosen in the filters, if any. */
  conversation?: ConversationScope;
  timeZone: string;
  /** Epoch ms. */
  now: number;
}
export interface PageCursor {
  id: string;
  startedAt: string;
}

/** The server filters by direction; Digital is filtered on the client. */
export function serverDirection(
  direction: DirectionFilter,
): 'rx' | 'tx' | 'internal' | undefined {
  switch (direction) {
    case 'received':
      return 'rx';
    case 'transmitted':
      return 'tx';
    case 'notes':
      return 'internal';
    default:
      return undefined;
  }
}

/** Radio the screen is scoped to: the frequency group's radio wins. */
export function scopeRadioId(
  scope: Pick<HistoryScope, 'radioId' | 'conversation'>,
): string | undefined {
  return scope.conversation?.radioId ?? scope.radioId;
}

export function normalizeSearch(text: string): string {
  return text.trim().slice(0, 2000);
}

function query(params: URLSearchParams): string {
  // The API decodes %20, not '+', as a space.
  return params.toString().replace(/\+/g, '%20');
}

/** `communications?…` for the first page or, with `cursor`, an earlier page. */
export function communicationsPath(
  filters: HistoryFilters,
  scope: Pick<HistoryScope, 'radioId' | 'conversation'>,
  cursor?: PageCursor,
  limit = HISTORY_PAGE_LIMIT,
): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (scope.conversation) params.set('conversationId', scope.conversation.id);
  const radio = scopeRadioId(scope);
  if (radio) params.set('radioId', radio);
  if (scope.conversation?.frequencyHz)
    params.set('frequencyHz', String(scope.conversation.frequencyHz));
  const search = normalizeSearch(filters.search);
  if (search) params.set('search', search);
  const direction = serverDirection(filters.direction);
  if (direction) params.set('direction', direction);
  if (cursor) {
    params.set('beforeId', cursor.id);
    params.set('beforeStartedAt', cursor.startedAt);
  } else if (filters.before) {
    params.set('beforeId', CURSOR_FLOOR_ID);
    params.set('beforeStartedAt', filters.before);
  }
  return `communications?${query(params)}`;
}

/** `history/activity?…` scoped like the timeline (radio, frequency, direction). */
export function activityPath(
  filters: Pick<HistoryFilters, 'direction'>,
  scope: Pick<HistoryScope, 'radioId' | 'conversation' | 'timeZone'>,
  days = ACTIVITY_DAYS,
): string {
  const params = new URLSearchParams({
    days: String(days),
    tz: scope.timeZone,
  });
  const radio = scopeRadioId(scope);
  if (radio) params.set('radioId', radio);
  if (scope.conversation?.frequencyHz)
    params.set('frequencyHz', String(scope.conversation.frequencyHz));
  const direction = serverDirection(filters.direction);
  if (direction) params.set('direction', direction);
  return `history/activity?${query(params)}`;
}

/** Epoch ms where the date range starts, or undefined for All. */
export function rangeStart(
  range: DateRangeFilter,
  now: number,
  timeZone: string,
): number | undefined {
  switch (range) {
    case 'today':
      return zonedTime(localDayKey(now, timeZone), 0, timeZone);
    case '24h':
      return now - DAY_MS;
    case '7d':
      return now - 7 * DAY_MS;
    default:
      return undefined;
  }
}

/** Client-side part of the filters (kind, date range, heatmap cut-off). */
export function matchesFilters(
  item: Pick<Communication, 'kind' | 'direction' | 'startedAt'>,
  filters: HistoryFilters,
  scope: Pick<HistoryScope, 'now' | 'timeZone'>,
): boolean {
  switch (filters.direction) {
    case 'received':
      if (item.direction !== 'rx') return false;
      break;
    case 'transmitted':
      if (item.direction !== 'tx') return false;
      break;
    case 'notes':
      if (item.kind !== 'note') return false;
      break;
    case 'digital':
      if (item.kind !== 'digital') return false;
      break;
  }
  const at = Date.parse(item.startedAt);
  const start = rangeStart(filters.range, scope.now, scope.timeZone);
  if (start !== undefined && at < start) return false;
  if (filters.before && at >= Date.parse(filters.before)) return false;
  return true;
}

/**
 * True once the loaded pages reach past the date range start: pages are
 * newest first, so nothing earlier can match.
 */
export function reachedRangeStart(
  items: readonly Pick<Communication, 'startedAt'>[],
  filters: Pick<HistoryFilters, 'range'>,
  scope: Pick<HistoryScope, 'now' | 'timeZone'>,
): boolean {
  const start = rangeStart(filters.range, scope.now, scope.timeZone);
  const oldest = items.at(-1);
  return (
    start !== undefined &&
    oldest !== undefined &&
    Date.parse(oldest.startedAt) < start
  );
}

/** Heatmap jumps outside the active date range widen it to All. */
export function rangeForBefore(
  range: DateRangeFilter,
  before: string,
  scope: Pick<HistoryScope, 'now' | 'timeZone'>,
): DateRangeFilter {
  const start = rangeStart(range, scope.now, scope.timeZone);
  return start !== undefined && Date.parse(before) <= start ? 'all' : range;
}

/** Appends a page without duplicating rows already shown. */
export function mergePage<T extends { id: string }>(
  prior: readonly T[],
  next: readonly T[],
  append: boolean,
): T[] {
  if (!append) return [...next];
  const seen = new Set(prior.map((item) => item.id));
  return [...prior, ...next.filter((item) => !seen.has(item.id))];
}

/** Whether coverage gap rows belong in the current view. */
export function showCoverageGaps(
  filters: Pick<HistoryFilters, 'search' | 'direction'>,
): boolean {
  return (
    !normalizeSearch(filters.search) &&
    (filters.direction === 'all' || filters.direction === 'received')
  );
}

// ─── Time zone helpers ─────────────────────────────────────────────────────

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, value);
  }
  return value;
}
/** Wall-clock fields of `ms` in `timeZone`. */
export function localParts(ms: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms)))
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}
const pad = (value: number) => String(value).padStart(2, '0');
/** 'YYYY-MM-DD' of `ms` in `timeZone`. */
export function localDayKey(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
function dayFields(day: string): [number, number, number] {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return [y, m, d];
}
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(ms / 1000) * 1000
  );
}
/**
 * Epoch ms of local `day hour:00` in `timeZone` (hour 24 = next midnight).
 * Around daylight-saving changes it tries the offsets in force a day before
 * and after: a repeated local time resolves to its earliest instant, and a
 * skipped one (for example Santiago's missing midnight) to the transition.
 */
export function zonedTime(day: string, hour: number, timeZone: string): number {
  const [y, m, d] = dayFields(day);
  const wall = Date.UTC(y, m - 1, d, hour);
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const valid = [wall - before, wall - after].filter(
    (instant) => offsetAt(instant, timeZone) === wall - instant,
  );
  return valid.length ? Math.min(...valid) : wall - before;
}
/** `count` consecutive day keys ending with `today`, oldest first. */
export function recentDayKeys(today: string, count: number): string[] {
  const [y, m, d] = dayFields(today);
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(Date.UTC(y, m - 1, d - offset));
    keys.push(
      `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    );
  }
  return keys;
}
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
export function weekdayName(day: string, style: 'long' | 'short' = 'long') {
  const [y, m, d] = dayFields(day);
  const name = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  return style === 'short' ? name.slice(0, 3) : name;
}
/** 'Today' | 'Yesterday' | 'Tuesday, Nov 3' (| 'Tuesday, Nov 3, 2025'). */
export function dayHeading(day: string, today: string): string {
  if (day === today) return 'Today';
  if (recentDayKeys(today, 2)[0] === day) return 'Yesterday';
  const [y, m, d] = dayFields(day);
  const [ty] = dayFields(today);
  return `${weekdayName(day)}, ${MONTHS[m - 1] ?? ''} ${d}${y === ty ? '' : `, ${y}`}`;
}
/** 'HH:MM' in `timeZone`. */
export function formatClock(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}
/** 'Tue 22:00' — compact local instant for chips. */
export function formatShortInstant(ms: number, timeZone: string): string {
  return `${weekdayName(localDayKey(ms, timeZone), 'short')} ${formatClock(ms, timeZone)}`;
}

// ─── Activity heatmap ──────────────────────────────────────────────────────

export interface ActivityBucket {
  day: string;
  hour: number;
  count: number;
}
export interface ActivityData {
  /** Days the server covered, oldest first (may be empty). */
  days: string[];
  buckets: ActivityBucket[];
}
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates `GET history/activity`; undefined when the shape is wrong. */
export function parseActivity(json: unknown): ActivityData | undefined {
  if (!isRecord(json) || !Array.isArray(json.buckets)) return undefined;
  const buckets: ActivityBucket[] = [];
  for (const entry of json.buckets) {
    if (
      !isRecord(entry) ||
      typeof entry.day !== 'string' ||
      !DAY_PATTERN.test(entry.day) ||
      typeof entry.hour !== 'number' ||
      !Number.isInteger(entry.hour) ||
      entry.hour < 0 ||
      entry.hour > 23 ||
      typeof entry.count !== 'number' ||
      !Number.isFinite(entry.count) ||
      entry.count < 0
    )
      return undefined;
    buckets.push({ day: entry.day, hour: entry.hour, count: entry.count });
  }
  const days = Array.isArray(json.days)
    ? json.days.filter(
        (day): day is string =>
          typeof day === 'string' && DAY_PATTERN.test(day),
      )
    : [];
  return { days, buckets };
}

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;
/** 0 = no traffic; 1…4 = quartiles of the busiest hour. */
export function intensityLevel(count: number, max: number): HeatmapLevel {
  if (!(count > 0) || !(max > 0)) return 0;
  return Math.min(
    HEATMAP_LEVELS,
    Math.max(1, Math.ceil((count / max) * HEATMAP_LEVELS)),
  ) as HeatmapLevel;
}
export function communicationCount(count: number): string {
  return count === 0
    ? 'no communications'
    : `${count} communication${count === 1 ? '' : 's'}`;
}
/** 'Tuesday 21:00, 12 communications'. */
export function heatmapCellLabel(
  day: string,
  hour: number,
  count: number,
): string {
  return `${weekdayName(day)} ${pad(hour)}:00, ${communicationCount(count)}`;
}

export interface HeatmapCell {
  day: string;
  hour: number;
  count: number;
  level: HeatmapLevel;
  label: string;
  /** ISO end of the hour: the `before` filter a tap applies. */
  endsAt: string;
  /** The hour has not started yet. */
  future: boolean;
}
export interface HeatmapRow {
  day: string;
  shortLabel: string;
  cells: HeatmapCell[];
}
export interface Heatmap {
  rows: HeatmapRow[];
  max: number;
  total: number;
}
/** A heatmap cell by row (day) index and hour. */
export interface HeatmapPosition {
  row: number;
  hour: number;
}
/**
 * The cell keyboard focus starts on (the grid has one Tab stop): the selected
 * hour, else the latest hour that has started.
 */
export function heatmapTabStop(
  heatmap: Heatmap,
  selectedEndsAt: string | undefined,
): HeatmapPosition | undefined {
  let latest: HeatmapPosition | undefined;
  for (const [row, entry] of heatmap.rows.entries())
    for (const cell of entry.cells) {
      if (selectedEndsAt !== undefined && cell.endsAt === selectedEndsAt)
        return { row, hour: cell.hour };
      if (!cell.future) latest = { row, hour: cell.hour };
    }
  return latest;
}
/**
 * Arrow keys move one hour (left/right) or one day (up/down); Home and End
 * jump to the first and last started hour of the row. Hours that have not
 * started cannot be focused. Undefined when the key does not move.
 */
export function heatmapKeyMove(
  key: string,
  from: HeatmapPosition,
  heatmap: Heatmap,
): HeatmapPosition | undefined {
  const started = (position: HeatmapPosition) => {
    const cell = heatmap.rows[position.row]?.cells[position.hour];
    return cell !== undefined && !cell.future;
  };
  const row = heatmap.rows[from.row];
  if (!row) return undefined;
  let target: HeatmapPosition | undefined;
  switch (key) {
    case 'ArrowLeft':
      target = { row: from.row, hour: from.hour - 1 };
      break;
    case 'ArrowRight':
      target = { row: from.row, hour: from.hour + 1 };
      break;
    case 'ArrowUp':
      target = { row: from.row - 1, hour: from.hour };
      break;
    case 'ArrowDown':
      target = { row: from.row + 1, hour: from.hour };
      break;
    case 'Home':
      target = { row: from.row, hour: 0 };
      break;
    case 'End':
      for (let hour = row.cells.length - 1; hour >= 0; hour--)
        if (started({ row: from.row, hour })) {
          target = { row: from.row, hour };
          break;
        }
      break;
    default:
      return undefined;
  }
  if (!target || !started(target)) return undefined;
  return target.row === from.row && target.hour === from.hour
    ? undefined
    : target;
}
export function buildHeatmap(
  data: ActivityData,
  options: { timeZone: string; now: number; days?: number },
): Heatmap {
  const count = options.days ?? ACTIVITY_DAYS;
  const days =
    data.days.length > 0
      ? data.days.slice(-count)
      : recentDayKeys(localDayKey(options.now, options.timeZone), count);
  const known = new Set(days);
  const counts = new Map<string, number>();
  let total = 0;
  for (const bucket of data.buckets) {
    if (!known.has(bucket.day)) continue;
    const key = `${bucket.day}:${bucket.hour}`;
    counts.set(key, (counts.get(key) ?? 0) + bucket.count);
    total += bucket.count;
  }
  const max = Math.max(0, ...counts.values());
  const rows = days.map((day) => ({
    day,
    shortLabel: weekdayName(day, 'short'),
    cells: Array.from({ length: 24 }, (_, hour) => {
      const value = counts.get(`${day}:${hour}`) ?? 0;
      return {
        day,
        hour,
        count: value,
        level: intensityLevel(value, max),
        label: heatmapCellLabel(day, hour, value),
        endsAt: new Date(
          zonedTime(day, hour + 1, options.timeZone),
        ).toISOString(),
        future: zonedTime(day, hour, options.timeZone) > options.now,
      };
    }),
  }));
  return { rows, max, total };
}

// ─── Coverage gaps ─────────────────────────────────────────────────────────

export interface CoverageGap {
  id: string;
  radioId: string;
  startedAt: string;
  /** Undefined while the radio is still not monitoring. */
  endedAt?: string;
  reason?: string;
}

/** Accepts `{ items }` (radios/:id/coverage) or `{ intervals }`. */
export function parseCoverage(json: unknown): CoverageInterval[] | undefined {
  if (!isRecord(json)) return undefined;
  const list = Array.isArray(json.items)
    ? json.items
    : Array.isArray(json.intervals)
      ? json.intervals
      : undefined;
  if (!list) return undefined;
  return list.filter(
    (entry): entry is CoverageInterval =>
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.radioId === 'string' &&
      typeof entry.startedAt === 'string' &&
      Number.isFinite(Date.parse(entry.startedAt)) &&
      (entry.endedAt === undefined ||
        (typeof entry.endedAt === 'string' &&
          Number.isFinite(Date.parse(entry.endedAt)))),
  );
}

/**
 * Coverage intervals say when a radio was monitoring; gaps are the time
 * between them (and after the last closed one), newest first. Nothing is
 * claimed before the oldest known interval.
 */
export function coverageGaps(
  intervals: readonly CoverageInterval[],
  minGapMs = MIN_GAP_MS,
): CoverageGap[] {
  const byRadio = new Map<string, CoverageInterval[]>();
  for (const interval of intervals) {
    const list = byRadio.get(interval.radioId) ?? [];
    list.push(interval);
    byRadio.set(interval.radioId, list);
  }
  const gaps: CoverageGap[] = [];
  for (const [radioId, list] of byRadio) {
    const sorted = [...list].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );
    let coveredUntil: number | undefined;
    let closer: CoverageInterval | undefined;
    for (const interval of sorted) {
      const start = Date.parse(interval.startedAt);
      if (
        coveredUntil !== undefined &&
        Number.isFinite(coveredUntil) &&
        closer &&
        start - coveredUntil >= minGapMs
      )
        gaps.push({
          id: `${closer.id}:${interval.id}`,
          radioId,
          startedAt: new Date(coveredUntil).toISOString(),
          endedAt: interval.startedAt,
          ...(closer.reason ? { reason: closer.reason } : {}),
        });
      const end = interval.endedAt ? Date.parse(interval.endedAt) : Infinity;
      if (coveredUntil === undefined || end >= coveredUntil) {
        coveredUntil = end;
        closer = interval;
      }
    }
    if (coveredUntil !== undefined && Number.isFinite(coveredUntil) && closer)
      gaps.push({
        id: `${closer.id}:open`,
        radioId,
        startedAt: new Date(coveredUntil).toISOString(),
        ...(closer.reason ? { reason: closer.reason } : {}),
      });
  }
  return gaps.sort(
    (a, b) => gapSortTime(b, Infinity) - gapSortTime(a, Infinity),
  );
}
function gapSortTime(gap: CoverageGap, now: number): number {
  return gap.endedAt ? Date.parse(gap.endedAt) : now;
}
/** 'No coverage 21:44 → 21:58 · radio reconnecting'. */
export function gapLabel(gap: CoverageGap, timeZone: string): string {
  const start = Date.parse(gap.startedAt);
  const end = gap.endedAt ? Date.parse(gap.endedAt) : undefined;
  const sameDay =
    end === undefined ||
    localDayKey(start, timeZone) === localDayKey(end, timeZone);
  const from = sameDay
    ? formatClock(start, timeZone)
    : formatShortInstant(start, timeZone);
  const span =
    end === undefined
      ? `No coverage since ${from}`
      : `No coverage ${from} → ${formatClock(end, timeZone)}`;
  return gap.reason ? `${span} · ${gap.reason}` : span;
}

// ─── Timeline ──────────────────────────────────────────────────────────────

export type TimelineEntry =
  | { type: 'day'; key: string; label: string }
  | { type: 'communication'; key: string; communication: Communication }
  | { type: 'gap'; key: string; gap: CoverageGap };

/**
 * Newest-first rows with gaps at their chronological position and a heading
 * at every local day change. Gaps appear only inside the loaded window: down
 * to the oldest loaded row, or the range start once every page is loaded.
 */
export function buildTimeline(input: {
  items: readonly Communication[];
  gaps: readonly CoverageGap[];
  complete: boolean;
  filters: HistoryFilters;
  scope: Pick<HistoryScope, 'now' | 'timeZone'>;
  /** Unfiltered oldest loaded row (pagination edge). */
  oldestLoaded?: string;
}): TimelineEntry[] {
  const { filters, scope } = input;
  const newest = filters.before ? Date.parse(filters.before) : Infinity;
  const start = rangeStart(filters.range, scope.now, scope.timeZone);
  const oldest = input.complete
    ? (start ?? -Infinity)
    : input.oldestLoaded
      ? Date.parse(input.oldestLoaded)
      : Infinity;
  const rows: { at: number; entry: TimelineEntry }[] = input.items.map(
    (communication) => ({
      at: Date.parse(communication.startedAt),
      entry: {
        type: 'communication',
        key: `c:${communication.id}`,
        communication,
      },
    }),
  );
  for (const gap of input.gaps) {
    const gapStart = Date.parse(gap.startedAt);
    const gapEnd = gapSortTime(gap, scope.now);
    if (gapEnd <= oldest || gapStart >= newest) continue;
    rows.push({ at: gapEnd, entry: { type: 'gap', key: `g:${gap.id}`, gap } });
  }
  rows.sort((a, b) => b.at - a.at);
  const today = localDayKey(scope.now, scope.timeZone);
  const result: TimelineEntry[] = [];
  let currentDay: string | undefined;
  for (const row of rows) {
    const day = localDayKey(Math.min(row.at, scope.now), scope.timeZone);
    if (day !== currentDay) {
      currentDay = day;
      result.push({
        type: 'day',
        key: `d:${day}`,
        label: dayHeading(day, today),
      });
    }
    result.push(row.entry);
  }
  return result;
}

// ─── Row presentation ──────────────────────────────────────────────────────

export type DirectionIcon = 'rx' | 'tx' | 'wave' | 'signal' | 'note';
export interface KindPresentation {
  icon: DirectionIcon;
  label: string;
  /** Transmissions use the error (on-air) tone. */
  transmit: boolean;
}
export function kindPresentation(
  item: Pick<Communication, 'kind' | 'direction'>,
): KindPresentation {
  switch (item.kind) {
    case 'received_voice':
      return { icon: 'rx', label: 'Received', transmit: false };
    case 'transmitted_voice':
      return { icon: 'tx', label: 'Transmitted', transmit: true };
    case 'transmitted_tts':
      return { icon: 'wave', label: 'Transmitted speech', transmit: true };
    case 'digital':
      return {
        icon: 'signal',
        label:
          item.direction === 'tx'
            ? 'Digital · transmitted'
            : item.direction === 'rx'
              ? 'Digital · received'
              : 'Digital',
        transmit: item.direction === 'tx',
      };
    default:
      return { icon: 'note', label: 'Note', transmit: false };
  }
}
/** '0:14', '12:03', '1:02:03'. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
export function communicationDurationMs(
  item: Pick<Communication, 'startedAt' | 'endedAt'>,
): number {
  const value = Date.parse(item.endedAt) - Date.parse(item.startedAt);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
export function frequencyChipLabel(hz?: number): string {
  return hz === undefined ? 'Unknown frequency' : formatFrequency(hz);
}
export function attributionLabel(
  attribution: Communication['frequencyAttribution'],
): string {
  return attribution === 'confirmed'
    ? 'confirmed source'
    : attribution === 'inferred'
      ? 'inferred source'
      : 'unknown source';
}
/** '146.520 MHz, inferred source'. */
export function frequencyAccessibilityLabel(
  hz: number | undefined,
  attribution: Communication['frequencyAttribution'],
): string {
  return `${hz === undefined ? 'Unknown frequency' : `${formatFrequency(hz)} MHz`}, ${attributionLabel(attribution)}`;
}
export function transcriptPreview(
  text: string,
  limit = TRANSCRIPT_PREVIEW_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return {
    text: `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`,
    truncated: true,
  };
}

// ─── Waveform ──────────────────────────────────────────────────────────────

export interface WaveformData {
  /** 0..1, empty when the server could not decode the recording. */
  peaks: number[];
  durationMs: number;
}
export function parseWaveform(json: unknown): WaveformData | undefined {
  if (!isRecord(json) || !Array.isArray(json.peaks)) return undefined;
  const peaks = json.peaks.map((peak) =>
    typeof peak === 'number' && Number.isFinite(peak)
      ? Math.min(1, Math.max(0, peak))
      : 0,
  );
  const durationMs =
    typeof json.durationMs === 'number' && Number.isFinite(json.durationMs)
      ? Math.max(0, json.durationMs)
      : 0;
  return { peaks, durationMs };
}
/** Bar count proportional to duration (≈2.5 bars per second). */
export function waveformBarCount(
  durationMs: number,
  options: { min?: number; max?: number; perSecond?: number } = {},
): number {
  const { min = 6, max = WAVEFORM_POINTS, perSecond = 2.5 } = options;
  const seconds = Number.isFinite(durationMs) ? durationMs / 1000 : 0;
  return Math.min(max, Math.max(min, Math.round(seconds * perSecond)));
}
/** Max-pools (or stretches) peaks to `count` bars, clamped to 0..1. */
export function resamplePeaks(
  peaks: readonly number[],
  count: number,
): number[] {
  if (!peaks.length || count <= 0) return [];
  const bars: number[] = [];
  for (let index = 0; index < count; index++) {
    const from = Math.floor((index * peaks.length) / count);
    const to = Math.max(
      from + 1,
      Math.floor(((index + 1) * peaks.length) / count),
    );
    let value = 0;
    for (let source = from; source < to && source < peaks.length; source++) {
      const peak = peaks[source] ?? 0;
      if (Number.isFinite(peak) && peak > value) value = peak;
    }
    bars.push(Math.min(1, value));
  }
  return bars;
}

// ─── Errors ────────────────────────────────────────────────────────────────

/** A route this server does not have (404 unknown route, or 501). */
export function isMissingRoute(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'NOT_FOUND' && error.message === MISSING_ROUTE_MESSAGE)
    return true;
  return /\bHTTP (404|501)\b/.test(error.message);
}
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// ─── Debounce ──────────────────────────────────────────────────────────────

export interface Debouncer<T> {
  /** Restarts the delay with the latest value. */
  schedule(value: T): void;
  /** Runs the pending value now (e.g. on submit). */
  flush(): void;
  cancel(): void;
  pending(): boolean;
}
export interface DebounceTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const defaultTimers: DebounceTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export function createDebouncer<T>(
  callback: (value: T) => void,
  delayMs = SEARCH_DEBOUNCE_MS,
  timers: DebounceTimers = defaultTimers,
): Debouncer<T> {
  let handle: unknown;
  let waiting = false;
  let latest: T | undefined;
  const run = () => {
    if (!waiting) return;
    waiting = false;
    handle = undefined;
    callback(latest as T);
  };
  return {
    schedule(value) {
      latest = value;
      if (waiting) timers.clearTimeout(handle);
      waiting = true;
      handle = timers.setTimeout(run, delayMs);
    },
    flush() {
      if (!waiting) return;
      timers.clearTimeout(handle);
      run();
    },
    cancel() {
      if (waiting) timers.clearTimeout(handle);
      waiting = false;
      handle = undefined;
    },
    pending: () => waiting,
  };
}
