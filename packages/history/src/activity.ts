/**
 * Pure time-zone-aware bucketing for the history activity heatmap.
 *
 * The database aggregates communications into fixed UTC slots of
 * {@link ACTIVITY_SLOT_MINUTES} minutes. Every current IANA offset is a
 * multiple of 15 minutes, so each slot maps to exactly one local hour; this
 * module converts the slots into local `day`/`hour` buckets for the requested
 * zone without loading individual communications.
 */
export const ACTIVITY_SLOT_MINUTES = 15;
export const MAX_ACTIVITY_DAYS = 31;

export interface ActivitySlot {
  /** Start of the UTC slot. */
  startedAt: string | Date;
  count: number;
}
export interface ActivityBucket {
  /** Local calendar day in the requested zone, `YYYY-MM-DD`. */
  day: string;
  /** Local hour 0..23 in the requested zone. */
  hour: number;
  count: number;
}
export interface ActivityWindow {
  /** Local days covered, oldest first, ending with the local day of `now`. */
  days: string[];
  /** Inclusive conservative UTC lower bound for the slot query. */
  from: Date;
  /** Exclusive UTC upper bound for the slot query. */
  to: Date;
}

/** Formatters are cached per canonical zone; the cap is defence in depth. */
export const MAX_CACHED_TIME_ZONES = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

let canonicalZones: Map<string, string> | undefined;
/** Lower-cased IANA name → canonical spelling, built once per process. */
function zoneAllowlist(): Map<string, string> {
  if (!canonicalZones) {
    const names = [...Intl.supportedValuesOf('timeZone'), 'UTC'];
    canonicalZones = new Map(names.map((name) => [name.toLowerCase(), name]));
  }
  return canonicalZones;
}

/**
 * The canonical IANA name for `timeZone`, or `undefined` when it is not a
 * supported IANA zone. Lookup is case-insensitive; aliases (for example
 * `Asia/Kolkata` or `Etc/UTC`) resolve to the runtime's canonical name.
 * Offset zones such as `+05:30` are rejected: only named zones keep every
 * offset a multiple of 15 minutes.
 */
export function canonicalTimeZone(timeZone: string): string | undefined {
  if (!timeZone || timeZone.length > 100 || /^[+-]/.test(timeZone))
    return undefined;
  const allowlist = zoneAllowlist();
  const direct = allowlist.get(timeZone.toLowerCase());
  if (direct) return direct;
  let resolved: string;
  try {
    // A throwaway formatter resolves aliases; it is never cached.
    resolved = new Intl.DateTimeFormat('en-CA', {
      timeZone,
    }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return allowlist.get(resolved.toLowerCase()) === resolved
    ? resolved
    : undefined;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const zone = canonicalTimeZone(timeZone);
  if (!zone) throw new RangeError('Unsupported time zone.');
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= MAX_CACHED_TIME_ZONES) {
      const oldest = formatters.keys().next().value;
      if (oldest !== undefined) formatters.delete(oldest);
    }
    formatters.set(zone, value);
  }
  return value;
}

/** True when `timeZone` is a supported IANA zone name (see {@link canonicalTimeZone}). */
export function isValidTimeZone(timeZone: string): boolean {
  return canonicalTimeZone(timeZone) !== undefined;
}

/** Number of cached zone formatters (for tests). */
export function cachedTimeZoneCount(): number {
  return formatters.size;
}

/** Local calendar day and hour of an instant in the given zone. */
export function zonedDayHour(
  at: Date,
  timeZone: string,
): { day: string; hour: number } {
  const parts = formatter(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  const hour = Number(part('hour')) % 24;
  return { day: `${part('year')}-${part('month')}-${part('day')}`, hour };
}

/** Shift a `YYYY-MM-DD` calendar date by whole days (no zone involved). */
export function addCalendarDays(day: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new RangeError('Invalid calendar day.');
  const value = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta),
  );
  return value.toISOString().slice(0, 10);
}

/** The local days to report and a UTC query range that safely covers them. */
export function activityWindow(
  now: Date,
  days: number,
  timeZone: string,
): ActivityWindow {
  if (!Number.isInteger(days) || days < 1 || days > MAX_ACTIVITY_DAYS)
    throw new RangeError('Invalid activity day count.');
  const today = zonedDayHour(now, timeZone).day;
  const list: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1)
    list.push(addCalendarDays(today, -offset));
  // One extra day absorbs any zone offset or daylight-saving transition;
  // slots outside the reported local days are discarded while bucketing.
  return {
    days: list,
    from: new Date(now.getTime() - (days + 1) * 86_400_000),
    to: new Date(now.getTime() + 1),
  };
}

/**
 * Build a complete `days × 24` grid (oldest day first, hour ascending).
 * Hours without communications are reported with `count: 0`; slots outside
 * `days` are ignored. Repeated local hours on a daylight-saving fall-back day
 * are merged into the same bucket; skipped spring-forward hours stay at zero.
 */
export function bucketActivity(
  slots: readonly ActivitySlot[],
  timeZone: string,
  days: readonly string[],
): ActivityBucket[] {
  const index = new Map<string, number>();
  const buckets: ActivityBucket[] = [];
  for (const day of days)
    for (let hour = 0; hour < 24; hour += 1) {
      index.set(`${day}T${hour}`, buckets.length);
      buckets.push({ day, hour, count: 0 });
    }
  for (const slot of slots) {
    const at =
      slot.startedAt instanceof Date
        ? slot.startedAt
        : new Date(slot.startedAt);
    if (
      Number.isNaN(at.getTime()) ||
      !Number.isFinite(slot.count) ||
      slot.count <= 0
    )
      continue;
    const local = zonedDayHour(at, timeZone);
    const position = index.get(`${local.day}T${local.hour}`);
    if (position === undefined) continue;
    const bucket = buckets[position];
    if (bucket) bucket.count += Math.trunc(slot.count);
  }
  return buckets;
}
