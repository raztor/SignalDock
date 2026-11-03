/**
 * Pure notification preference and inbox helpers.
 *
 * Plain TypeScript (no React Native) so it can be unit tested in node. Times
 * of day are whole minutes after midnight (0..1439); the backend stores quiet
 * hours as 'HH:MM' strings in an IANA time zone and treats an equal start and
 * end as "no quiet hours".
 */
import type {
  NotificationCategory,
  NotificationPreference,
  NotificationRecord,
} from '@signaldock/contracts';
import type { IconName } from '@signaldock/ui';
import { dayHeading, formatClock, localDayKey } from '../history/history-model';
import { formatFrequency } from '../station/station-model';

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

export interface CategoryInfo {
  category: NotificationCategory;
  label: string;
  description: string;
  icon: IconName;
  /** Inbox row title. */
  title: string;
}

/** The seven backend categories, in the order the preference cards show them. */
export const NOTIFICATION_CATEGORIES: readonly CategoryInfo[] = [
  {
    category: 'incident',
    label: 'Incidents',
    description: 'A rule matched on air and an incident was opened.',
    icon: 'alert',
    title: 'Incident opened',
  },
  {
    category: 'communication',
    label: 'Communications',
    description: 'New audio was recorded on a radio you can access.',
    icon: 'wave',
    title: 'New communication',
  },
  {
    category: 'transcript',
    label: 'Transcripts',
    description: 'A transcript is ready for a recorded communication.',
    icon: 'note',
    title: 'Transcript ready',
  },
  {
    category: 'control',
    label: 'Control',
    description: 'Changes to who controls a radio.',
    icon: 'lock',
    title: 'Control update',
  },
  {
    category: 'radio',
    label: 'Radio status',
    description: 'Radios connecting, disconnecting or reporting faults.',
    icon: 'radio',
    title: 'Radio status update',
  },
  {
    category: 'storage',
    label: 'Storage',
    description: 'Recording storage and retention updates.',
    icon: 'server',
    title: 'Storage update',
  },
  {
    category: 'processing',
    label: 'Processing',
    description: 'Speech and transcription jobs finishing or failing.',
    icon: 'knob',
    title: 'Processing update',
  },
];

const CATEGORY_ORDER: readonly NotificationCategory[] = [
  'communication',
  'transcript',
  'incident',
  'control',
  'radio',
  'storage',
  'processing',
];

export function categoryInfo(category: NotificationCategory): CategoryInfo {
  return (
    NOTIFICATION_CATEGORIES.find((item) => item.category === category) ?? {
      category,
      label: category,
      description: '',
      icon: 'bell',
      title: 'Station update',
    }
  );
}

/** Categories in the backend's canonical order, without duplicates or unknown values. */
export function canonicalCategories(
  categories: Iterable<NotificationCategory>,
): NotificationCategory[] {
  const set = new Set(categories);
  return CATEGORY_ORDER.filter((item) => set.has(item));
}

/** Adds or removes a category, keeping the canonical order. */
export function toggleCategory(
  categories: readonly NotificationCategory[],
  category: NotificationCategory,
  enabled: boolean,
): NotificationCategory[] {
  const next = new Set(categories);
  if (enabled) next.add(category);
  else next.delete(category);
  return canonicalCategories(next);
}

/* -------------------------------------------------------------------------- */
/* Quiet hours                                                                */
/* -------------------------------------------------------------------------- */

export const MINUTES_PER_DAY = 1440;
export const QUIET_STEP_MINUTES = 30;
export const QUIET_HOUR_COUNT = 24;
export const DEFAULT_QUIET_START = 22 * 60;
export const DEFAULT_QUIET_END = 7 * 60;

/** Start and end as minutes after midnight. `end` is exclusive. */
export interface QuietRange {
  start: number;
  end: number;
}

export function normalizeMinutes(minutes: number): number {
  const whole = Math.trunc(minutes);
  return ((whole % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** 'HH:MM' (00:00–23:59) → minutes, or undefined. Matches the backend pattern. */
export function parseClock(text: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes → 'HH:MM', the format the backend expects. */
export function formatClockMinutes(minutes: number): string {
  const value = normalizeMinutes(minutes);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** Length of the quiet window in minutes; 0 when start equals end (off). */
export function quietSpanMinutes(range: QuietRange): number {
  return normalizeMinutes(range.end - range.start);
}

/** True when the window continues past midnight into the next day. */
export function crossesMidnight(range: QuietRange): boolean {
  const start = normalizeMinutes(range.start);
  const end = normalizeMinutes(range.end);
  return end !== 0 && end < start;
}

/** Same rule as the backend's `withinQuietHours`. */
export function isQuietMinute(minute: number, range: QuietRange): boolean {
  const value = normalizeMinutes(minute);
  const start = normalizeMinutes(range.start);
  const end = normalizeMinutes(range.end);
  if (start === end) return false;
  return start < end
    ? value >= start && value < end
    : value >= start || value < end;
}

function quietSegments(range: QuietRange): [number, number][] {
  const start = normalizeMinutes(range.start);
  const end = normalizeMinutes(range.end);
  if (start === end) return [];
  if (start < end) return [[start, end]];
  return [
    [start, MINUTES_PER_DAY],
    [0, end],
  ];
}

/** Quiet minutes inside hour `hour` (0..60). */
export function quietMinutesInHour(hour: number, range: QuietRange): number {
  const from = hour * 60;
  const to = from + 60;
  let total = 0;
  for (const [a, b] of quietSegments(range))
    total += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return total;
}

export type QuietCellState = 'off' | 'partial' | 'full';

/** State of each of the 24 hour cells of the bar. */
export function quietCellStates(range: QuietRange): QuietCellState[] {
  return Array.from({ length: QUIET_HOUR_COUNT }, (_, hour) => {
    const minutes = quietMinutesInHour(hour, range);
    return minutes >= 60 ? 'full' : minutes > 0 ? 'partial' : 'off';
  });
}

/** '22:00 → 07:00'. */
export function quietRangeLabel(range: QuietRange): string {
  return `${formatClockMinutes(range.start)} → ${formatClockMinutes(range.end)}`;
}

/** '9 h', '8 h 30 min', '45 min'. */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** '9 h · ends the next day' or '2 h'. */
export function quietSummary(range: QuietRange): string {
  const span = quietSpanMinutes(range);
  if (!span) return 'Start and end are the same, so quiet hours are off.';
  return crossesMidnight(range)
    ? `${durationLabel(span)} · ends the next day`
    : durationLabel(span);
}

/** Selection in progress on the 24-hour bar. */
export interface QuietTapState {
  range: QuietRange;
  /** Hour of the first tap while waiting for the second, else undefined. */
  anchor: number | undefined;
}

/**
 * First tap marks the first quiet hour (previewed as one hour); the second tap
 * marks the last quiet hour, wrapping past midnight when it is earlier than
 * the first. A selection of all 24 hours is shortened to 23 h 30 min, because
 * the backend reads an equal start and end as "off".
 */
export function tapQuietHour(
  state: QuietTapState,
  hour: number,
): QuietTapState {
  const tapped = normalizeMinutes(hour * 60) / 60;
  if (state.anchor === undefined)
    return {
      anchor: tapped,
      range: {
        start: tapped * 60,
        end: normalizeMinutes((tapped + 1) * 60),
      },
    };
  const start = state.anchor * 60;
  let end = normalizeMinutes((tapped + 1) * 60);
  if (end === start) end = normalizeMinutes(start - QUIET_STEP_MINUTES);
  return { anchor: undefined, range: { start, end } };
}

/**
 * Moves one boundary by one step (default 30 min), snapping to the step grid
 * first and never landing on the other boundary.
 */
export function stepQuietBoundary(
  range: QuietRange,
  boundary: 'start' | 'end',
  direction: 1 | -1,
  stepMinutes = QUIET_STEP_MINUTES,
): QuietRange {
  const current = normalizeMinutes(range[boundary]);
  const other = normalizeMinutes(
    boundary === 'start' ? range.end : range.start,
  );
  let next =
    direction > 0
      ? Math.floor(current / stepMinutes) * stepMinutes + stepMinutes
      : Math.ceil(current / stepMinutes) * stepMinutes - stepMinutes;
  next = normalizeMinutes(next);
  if (next === other) next = normalizeMinutes(next + direction * stepMinutes);
  return { ...range, [boundary]: next };
}

/** Roving focus for the bar: arrows move one hour (wrapping), Home/End jump. */
export function quietHourKey(key: string, hour: number): number | undefined {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (hour + 1) % QUIET_HOUR_COUNT;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (hour + QUIET_HOUR_COUNT - 1) % QUIET_HOUR_COUNT;
    case 'Home':
      return 0;
    case 'End':
      return QUIET_HOUR_COUNT - 1;
    default:
      return undefined;
  }
}

/** '22:00 to 23:00, quiet'. */
export function quietCellLabel(hour: number, state: QuietCellState): string {
  const from = formatClockMinutes(hour * 60);
  const to = formatClockMinutes((hour + 1) * 60);
  const status =
    state === 'full'
      ? 'quiet'
      : state === 'partial'
        ? 'partly quiet'
        : 'not quiet';
  return `${from} to ${to}, ${status}`;
}

export interface QuietDraft extends QuietRange {
  enabled: boolean;
}

/** The backend `quietHours` value, or undefined when off. */
export function quietHoursValue(
  draft: QuietDraft,
  timeZone: string,
): NotificationPreference['quietHours'] {
  if (!draft.enabled || quietSpanMinutes(draft) === 0) return undefined;
  return {
    start: formatClockMinutes(draft.start),
    end: formatClockMinutes(draft.end),
    timeZone,
  };
}

/* -------------------------------------------------------------------------- */
/* Cooldown                                                                   */
/* -------------------------------------------------------------------------- */

export type CooldownChoice = 'off' | '30s' | '1m' | '5m' | '15m' | 'custom';
export type CooldownPresetChoice = Exclude<CooldownChoice, 'custom'>;

/** Backend limit (`cooldownSeconds` 0..3600). */
export const COOLDOWN_MAX_SECONDS = 3600;
export const COOLDOWN_PRESETS: readonly {
  choice: CooldownPresetChoice;
  seconds: number;
  label: string;
}[] = [
  { choice: 'off', seconds: 0, label: 'Off' },
  { choice: '30s', seconds: 30, label: '30 s' },
  { choice: '1m', seconds: 60, label: '1 min' },
  { choice: '5m', seconds: 300, label: '5 min' },
  { choice: '15m', seconds: 900, label: '15 min' },
];

/** Options for the cooldown SegmentedControl. */
export const COOLDOWN_OPTIONS: readonly {
  value: CooldownChoice;
  label: string;
  accessibilityLabel: string;
}[] = [
  ...COOLDOWN_PRESETS.map((preset) => ({
    value: preset.choice,
    label: preset.label,
    accessibilityLabel:
      preset.seconds === 0 ? 'No cooldown' : `Cooldown ${preset.label}`,
  })),
  { value: 'custom', label: 'Custom', accessibilityLabel: 'Custom cooldown' },
];

export function cooldownChoice(seconds: number): CooldownChoice {
  return (
    COOLDOWN_PRESETS.find((preset) => preset.seconds === seconds)?.choice ??
    'custom'
  );
}

/** Seconds the choice stands for; the custom value for 'custom'. */
export function cooldownSecondsFor(
  choice: CooldownChoice,
  customSeconds: number | undefined,
): number | undefined {
  if (choice === 'custom') return customSeconds;
  return COOLDOWN_PRESETS.find((preset) => preset.choice === choice)?.seconds;
}

export function cooldownError(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return 'Enter a cooldown in seconds.';
  if (!Number.isSafeInteger(seconds)) return 'Use whole seconds.';
  if (seconds < 0 || seconds > COOLDOWN_MAX_SECONDS)
    return 'Choose a cooldown between 0 seconds and 1 hour.';
  return undefined;
}

/** 'Off', '45 s', '1 min', '1 min 30 s', '1 h'. */
export function cooldownLabel(seconds: number): string {
  if (seconds <= 0) return 'Off';
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${rest} s`;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/* -------------------------------------------------------------------------- */
/* Time zones                                                                 */
/* -------------------------------------------------------------------------- */

interface IntlWithSupportedValues {
  supportedValuesOf?: (key: 'timeZone') => string[];
}

/** IANA zones this runtime knows, or undefined when it cannot list them. */
export function supportedTimeZones(
  intl: IntlWithSupportedValues = Intl as unknown as IntlWithSupportedValues,
): string[] | undefined {
  try {
    const zones = intl.supportedValuesOf?.('timeZone');
    if (!zones || !zones.length) return undefined;
    return zones.includes('UTC') ? [...zones] : ['UTC', ...zones];
  } catch {
    return undefined;
  }
}

/** Same check as the backend: the runtime can format a date in the zone. */
export function isKnownTimeZone(zone: string): boolean {
  const value = zone.trim();
  if (!value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** 'America/Argentina/Buenos_Aires' → 'Buenos Aires'. */
export function timeZoneCity(zone: string): string {
  return (zone.split('/').at(-1) ?? zone).replace(/_/g, ' ');
}

const searchable = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[_/]+/g, ' ')
    .trim();

/**
 * Zones matching every word of `query`. Zones whose city or full name starts
 * with the query come first, then the other matches, each in list order.
 * `pinned` zones lead an empty query.
 */
export function filterTimeZones(
  zones: readonly string[],
  query: string,
  limit = 60,
  pinned: readonly string[] = [],
): string[] {
  const words = searchable(query).split(/\s+/).filter(Boolean);
  if (!words.length) {
    const lead = pinned.filter(
      (zone, index) => zones.includes(zone) && pinned.indexOf(zone) === index,
    );
    return [...lead, ...zones.filter((zone) => !lead.includes(zone))].slice(
      0,
      limit,
    );
  }
  const first: string[] = [];
  const rest: string[] = [];
  for (const zone of zones) {
    const text = searchable(zone);
    if (!words.every((word) => text.includes(word))) continue;
    const phrase = words.join(' ');
    if (
      searchable(timeZoneCity(zone)).startsWith(phrase) ||
      text.startsWith(phrase)
    )
      first.push(zone);
    else rest.push(zone);
  }
  return [...first, ...rest].slice(0, limit);
}

/** 'UTC−03:00' style offset for `zone` at `now`, or '' when unavailable. */
export function timeZoneOffsetLabel(zone: string, now: number): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(new Date(now))
      .find((item) => item.type === 'timeZoneName')?.value;
    if (!part) return '';
    return part.replace(/^GMT/, 'UTC').replace('-', '−') || '';
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/* Frequency filter                                                           */
/* -------------------------------------------------------------------------- */

export const FREQUENCY_OPTION_LIMIT = 12;
export type FrequencySource = 'memory' | 'radio' | 'recent' | 'selected';

export interface FrequencyOption {
  hz: number;
  /** '146.520' (MHz). */
  frequency: string;
  /** Short context: 'Repeater · Recent ×3'. */
  detail: string;
  sources: FrequencySource[];
  accessibilityLabel: string;
}

export interface FrequencyOptionInput {
  /** Channel memories (in display order). */
  memories: readonly { name: string; hz: number }[];
  /** Current frequency of radios this account can see. */
  radios: readonly { name: string; hz: number }[];
  /** Recently recorded frequencies, newest first; repeats count. */
  recent: readonly number[];
  /** The saved or chosen filter, always kept in the list. */
  selectedHz?: number | undefined;
  limit?: number;
}

const validHz = (hz: unknown): hz is number =>
  typeof hz === 'number' && Number.isSafeInteger(hz) && hz > 0;

/**
 * Chips for the frequency filter: memories first, then frequencies radios are
 * on now, then recent activity (most frequent first), de-duplicated by Hz.
 * The selected frequency is always included, even past the limit.
 */
export function buildFrequencyOptions(
  input: FrequencyOptionInput,
): FrequencyOption[] {
  const limit = input.limit ?? FREQUENCY_OPTION_LIMIT;
  const order: number[] = [];
  const details = new Map<
    number,
    { sources: FrequencySource[]; parts: string[] }
  >();
  const add = (hz: number, source: FrequencySource, part: string) => {
    if (!validHz(hz)) return;
    let entry = details.get(hz);
    if (!entry) {
      entry = { sources: [], parts: [] };
      details.set(hz, entry);
      order.push(hz);
    }
    if (!entry.sources.includes(source)) entry.sources.push(source);
    if (part && !entry.parts.includes(part)) entry.parts.push(part);
  };
  for (const memory of input.memories)
    add(memory.hz, 'memory', memory.name.trim());
  for (const radio of input.radios) add(radio.hz, 'radio', `On ${radio.name}`);
  const counts = new Map<number, { count: number; first: number }>();
  input.recent.forEach((hz, index) => {
    if (!validHz(hz)) return;
    const entry = counts.get(hz);
    if (entry) entry.count += 1;
    else counts.set(hz, { count: 1, first: index });
  });
  [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .forEach(([hz, { count }]) =>
      add(hz, 'recent', count > 1 ? `Recent ×${count}` : 'Recent'),
    );
  let chosen = order.slice(0, Math.max(0, limit));
  const selected = input.selectedHz;
  if (validHz(selected) && !chosen.includes(selected)) {
    if (!details.has(selected)) add(selected, 'selected', 'Custom');
    chosen = [...chosen, selected];
  }
  return chosen.map((hz) => {
    const entry = details.get(hz) ?? { sources: [], parts: [] };
    const frequency = formatFrequency(hz);
    const detail = entry.parts.slice(0, 2).join(' · ');
    return {
      hz,
      frequency,
      detail,
      sources: entry.sources,
      accessibilityLabel: `${frequency} megahertz${detail ? `, ${detail}` : ''}`,
    };
  });
}

/** Frequencies of a `GET communications` page, read leniently; newest first. */
export function recentFrequencies(page: unknown): number[] {
  if (!page || typeof page !== 'object') return [];
  const items = (page as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: number[] = [];
  for (const item of items) {
    const hz =
      item && typeof item === 'object'
        ? (item as { frequencyHz?: unknown }).frequencyHz
        : undefined;
    if (validHz(hz)) out.push(hz);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Preference draft                                                           */
/* -------------------------------------------------------------------------- */

export interface PreferenceDraft {
  enabled: boolean;
  categories: NotificationCategory[];
  suppressWhileListening: boolean;
  cooldownChoice: CooldownChoice;
  /** Used only while `cooldownChoice` is 'custom'. */
  customCooldownSeconds: number | undefined;
  frequencyHz: number | undefined;
  quiet: QuietDraft;
  /** Zone the quiet hours are read in (stored with them). */
  timeZone: string;
}

/** Editable copy of a stored preference; the zone defaults to the device's. */
export function preferenceDraft(
  preference: NotificationPreference,
  deviceZone: string,
): PreferenceDraft {
  const quiet = preference.quietHours;
  const start = quiet ? parseClock(quiet.start) : undefined;
  const end = quiet ? parseClock(quiet.end) : undefined;
  const hasQuiet = start !== undefined && end !== undefined && start !== end;
  return {
    enabled: preference.enabled,
    categories: canonicalCategories(preference.categories),
    suppressWhileListening: preference.suppressWhileListening,
    cooldownChoice: cooldownChoice(preference.cooldownSeconds),
    customCooldownSeconds: preference.cooldownSeconds,
    frequencyHz: preference.frequencyHz,
    quiet: hasQuiet
      ? { enabled: true, start, end }
      : { enabled: false, start: DEFAULT_QUIET_START, end: DEFAULT_QUIET_END },
    timeZone: quiet?.timeZone || deviceZone,
  };
}

export type PreferenceBodyResult =
  { ok: true; value: NotificationPreference } | { ok: false; error: string };

/**
 * The PUT body: the stored preference with the draft's fields applied. Fields
 * the screen does not edit (such as `radioIds`) are kept as they are.
 */
export function preferenceBody(
  base: NotificationPreference,
  draft: PreferenceDraft,
): PreferenceBodyResult {
  const cooldownSeconds = cooldownSecondsFor(
    draft.cooldownChoice,
    draft.customCooldownSeconds,
  );
  const cooldownProblem = cooldownError(cooldownSeconds);
  if (cooldownProblem || cooldownSeconds === undefined)
    return { ok: false, error: cooldownProblem ?? 'Choose a cooldown.' };
  if (draft.frequencyHz !== undefined && !validHz(draft.frequencyHz))
    return { ok: false, error: 'Choose a valid frequency or Any frequency.' };
  if (draft.quiet.enabled) {
    if (quietSpanMinutes(draft.quiet) === 0)
      return {
        ok: false,
        error: 'Quiet hours need different start and end times.',
      };
    if (!isKnownTimeZone(draft.timeZone))
      return { ok: false, error: 'Choose a known time zone for quiet hours.' };
  }
  const { frequencyHz: _frequency, quietHours: _quiet, ...rest } = base;
  const quietHours = quietHoursValue(draft.quiet, draft.timeZone.trim());
  return {
    ok: true,
    value: {
      ...rest,
      enabled: draft.enabled,
      categories: canonicalCategories(draft.categories),
      suppressWhileListening: draft.suppressWhileListening,
      cooldownSeconds,
      ...(draft.frequencyHz === undefined
        ? {}
        : { frequencyHz: draft.frequencyHz }),
      ...(quietHours ? { quietHours } : {}),
    },
  };
}

function canonical(value: NotificationPreference): string {
  return JSON.stringify({
    enabled: value.enabled,
    categories: [...value.categories].sort(),
    radioIds: [...value.radioIds].sort(),
    suppressWhileListening: value.suppressWhileListening,
    cooldownSeconds: value.cooldownSeconds,
    frequencyHz: value.frequencyHz ?? null,
    quietHours: value.quietHours ?? null,
  });
}

/** True when saving the draft would change the stored preference. */
export function preferenceChanged(
  base: NotificationPreference,
  draft: PreferenceDraft,
  deviceZone: string,
): boolean {
  const body = preferenceBody(base, draft);
  if (!body.ok) return true;
  const stored = preferenceBody(base, preferenceDraft(base, deviceZone));
  return !stored.ok || canonical(body.value) !== canonical(stored.value);
}

/* -------------------------------------------------------------------------- */
/* Inbox                                                                      */
/* -------------------------------------------------------------------------- */

export interface DeliveryPresentation {
  label: string;
  tone: 'neutral' | 'warning';
}

export function deliveryPresentation(
  state: NotificationRecord['deliveryState'],
  relayConfigured: boolean,
): DeliveryPresentation {
  switch (state) {
    case 'queued':
      return {
        label: relayConfigured
          ? 'Queued for delivery'
          : 'Stored in station history',
        tone: 'neutral',
      };
    case 'relay_accepted':
      return { label: 'Sent to relay', tone: 'neutral' };
    case 'provider_accepted':
      return { label: 'Delivered to device service', tone: 'neutral' };
    case 'application_opened':
      return { label: 'Opened on a device', tone: 'neutral' };
    case 'failed':
      return { label: 'Device delivery failed', tone: 'warning' };
    case 'expired':
      return { label: 'Expired before delivery', tone: 'warning' };
    default:
      return { label: String(state).replaceAll('_', ' '), tone: 'neutral' };
  }
}

export function unreadCount(
  records: readonly Pick<NotificationRecord, 'readAt'>[],
): number {
  return records.reduce((total, record) => total + (record.readAt ? 0 : 1), 0);
}

/** Newest first; ties broken by id so the order is stable. */
export function sortNotifications(
  records: readonly NotificationRecord[],
): NotificationRecord[] {
  return [...records].sort((a, b) => {
    const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (delta) return delta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export interface InboxDay {
  /** 'YYYY-MM-DD' in the display zone. */
  day: string;
  /** 'Today', 'Yesterday', 'Tuesday, March 3'. */
  heading: string;
  unread: number;
  items: NotificationRecord[];
}

/** Groups records by local day (newest day first, newest record first). */
export function groupNotificationsByDay(
  records: readonly NotificationRecord[],
  timeZone: string,
  now: number,
): InboxDay[] {
  const today = localDayKey(now, timeZone);
  const days: InboxDay[] = [];
  for (const record of sortNotifications(records)) {
    const ms = Date.parse(record.createdAt);
    if (!Number.isFinite(ms)) continue;
    const day = localDayKey(ms, timeZone);
    let group = days.at(-1);
    if (!group || group.day !== day) {
      group = { day, heading: dayHeading(day, today), unread: 0, items: [] };
      days.push(group);
    }
    group.items.push(record);
    if (!record.readAt) group.unread += 1;
  }
  return days;
}

/** 'HH:MM' of the record in the display zone ('' for a bad timestamp). */
export function notificationTime(
  record: Pick<NotificationRecord, 'createdAt'>,
  timeZone: string,
): string {
  const ms = Date.parse(record.createdAt);
  return Number.isFinite(ms) ? formatClock(ms, timeZone) : '';
}

/** Screen-reader summary: 'Unread. Incident opened, Base station, 22:14. Stored in station history.' */
export function notificationLabel(
  record: NotificationRecord,
  options: { timeZone: string; radioName?: string; relayConfigured: boolean },
): string {
  const parts = [
    categoryInfo(record.category).title,
    options.radioName,
    notificationTime(record, options.timeZone),
  ].filter(Boolean);
  const delivery = deliveryPresentation(
    record.deliveryState,
    options.relayConfigured,
  ).label;
  return `${record.readAt ? 'Read' : 'Unread'}. ${parts.join(', ')}. ${delivery}.`;
}

/** A refreshed first page merged with what is loaded (keeps older pages). */
export function mergeRecentPage(
  current: readonly NotificationRecord[],
  page: readonly NotificationRecord[],
  keepOlder: boolean,
): NotificationRecord[] {
  if (!keepOlder) return [...page];
  const fresh = new Set(page.map((item) => item.id));
  return [...page, ...current.filter((item) => !fresh.has(item.id))];
}

/** An older page appended without duplicates. */
export function appendOlderPage(
  current: readonly NotificationRecord[],
  page: readonly NotificationRecord[],
): NotificationRecord[] {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...page.filter((item) => !known.has(item.id))];
}

/** Replaces one record by id. */
export function replaceNotification(
  current: readonly NotificationRecord[],
  updated: NotificationRecord,
): NotificationRecord[] {
  return current.map((item) => (item.id === updated.id ? updated : item));
}
