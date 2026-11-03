import { describe, expect, it } from 'vitest';
import type {
  NotificationPreference,
  NotificationRecord,
} from '@signaldock/contracts';
import {
  COOLDOWN_OPTIONS,
  NOTIFICATION_CATEGORIES,
  appendOlderPage,
  buildFrequencyOptions,
  canonicalCategories,
  cooldownChoice,
  cooldownError,
  cooldownLabel,
  cooldownSecondsFor,
  crossesMidnight,
  deliveryPresentation,
  filterTimeZones,
  formatClockMinutes,
  groupNotificationsByDay,
  isKnownTimeZone,
  isQuietMinute,
  mergeRecentPage,
  notificationLabel,
  parseClock,
  preferenceBody,
  preferenceChanged,
  preferenceDraft,
  quietCellLabel,
  quietCellStates,
  quietHourKey,
  quietHoursValue,
  quietRangeLabel,
  quietSpanMinutes,
  quietSummary,
  recentFrequencies,
  replaceNotification,
  stepQuietBoundary,
  supportedTimeZones,
  tapQuietHour,
  timeZoneCity,
  toggleCategory,
  unreadCount,
  type PreferenceDraft,
} from './notification-model';

const h = (hours: number, minutes = 0) => hours * 60 + minutes;

describe('categories', () => {
  it('lists the seven backend categories once each with an icon', () => {
    expect(NOTIFICATION_CATEGORIES.map((item) => item.category).sort()).toEqual(
      [
        'communication',
        'control',
        'incident',
        'processing',
        'radio',
        'storage',
        'transcript',
      ],
    );
    for (const item of NOTIFICATION_CATEGORIES) expect(item.icon).toBeTruthy();
  });
  it('toggles in canonical order without duplicates', () => {
    expect(toggleCategory(['incident'], 'communication', true)).toEqual([
      'communication',
      'incident',
    ]);
    expect(toggleCategory(['incident', 'radio'], 'incident', false)).toEqual([
      'radio',
    ]);
    expect(canonicalCategories(['radio', 'radio', 'transcript'])).toEqual([
      'transcript',
      'radio',
    ]);
  });
});

describe('quiet hours', () => {
  it('parses and formats HH:MM like the backend', () => {
    expect(parseClock('22:00')).toBe(h(22));
    expect(parseClock('07:05')).toBe(h(7, 5));
    expect(parseClock('24:00')).toBeUndefined();
    expect(parseClock('7:00')).toBeUndefined();
    expect(formatClockMinutes(h(7))).toBe('07:00');
    expect(formatClockMinutes(h(24))).toBe('00:00');
    expect(formatClockMinutes(-30)).toBe('23:30');
  });
  it('matches the backend rule, including wrap past midnight and equal = off', () => {
    const overnight = { start: h(22), end: h(7) };
    expect(isQuietMinute(h(23), overnight)).toBe(true);
    expect(isQuietMinute(h(6, 59), overnight)).toBe(true);
    expect(isQuietMinute(h(7), overnight)).toBe(false);
    expect(isQuietMinute(h(12), overnight)).toBe(false);
    expect(isQuietMinute(h(5), { start: h(5), end: h(5) })).toBe(false);
    expect(crossesMidnight(overnight)).toBe(true);
    expect(crossesMidnight({ start: h(22), end: 0 })).toBe(false);
    expect(quietSpanMinutes(overnight)).toBe(h(9));
  });
  it('marks full and partial hour cells', () => {
    const cells = quietCellStates({ start: h(22, 30), end: h(7) });
    expect(cells).toHaveLength(24);
    expect(cells[22]).toBe('partial');
    expect(cells[23]).toBe('full');
    expect(cells[0]).toBe('full');
    expect(cells[6]).toBe('full');
    expect(cells[7]).toBe('off');
    expect(cells[12]).toBe('off');
    expect(
      quietCellStates({ start: h(3), end: h(3) }).every((c) => c === 'off'),
    ).toBe(true);
    expect(quietCellLabel(22, 'partial')).toBe('22:00 to 23:00, partly quiet');
  });
  it('labels the range and its duration', () => {
    expect(quietRangeLabel({ start: h(22), end: h(7) })).toBe('22:00 → 07:00');
    expect(quietSummary({ start: h(22), end: h(7) })).toBe(
      '9 h · ends the next day',
    );
    expect(quietSummary({ start: h(13), end: h(14, 30) })).toBe('1 h 30 min');
  });
  it('selects with two taps and wraps past midnight', () => {
    const first = tapQuietHour(
      { range: { start: h(1), end: h(2) }, anchor: undefined },
      22,
    );
    expect(first).toEqual({ anchor: 22, range: { start: h(22), end: h(23) } });
    const second = tapQuietHour(first, 6);
    expect(second).toEqual({
      anchor: undefined,
      range: { start: h(22), end: h(7) },
    });
    expect(quietRangeLabel(second.range)).toBe('22:00 → 07:00');
  });
  it('tapping the same hour twice gives one hour; 23:00 ends at midnight', () => {
    const once = tapQuietHour(
      tapQuietHour({ range: { start: 0, end: 0 }, anchor: undefined }, 23),
      23,
    );
    expect(once.range).toEqual({ start: h(23), end: 0 });
  });
  it('never produces an all-day (equal) range', () => {
    const all = tapQuietHour(
      tapQuietHour({ range: { start: 0, end: 0 }, anchor: undefined }, 0),
      23,
    );
    expect(all.range).toEqual({ start: 0, end: h(23, 30) });
    expect(quietSpanMinutes(all.range)).toBeGreaterThan(0);
  });
  it('steps boundaries by 30 minutes, snapping and wrapping', () => {
    const range = { start: h(22), end: h(7) };
    expect(stepQuietBoundary(range, 'start', 1)).toEqual({
      start: h(22, 30),
      end: h(7),
    });
    expect(stepQuietBoundary(range, 'end', -1)).toEqual({
      start: h(22),
      end: h(6, 30),
    });
    expect(
      stepQuietBoundary({ start: h(22, 15), end: h(7) }, 'start', 1).start,
    ).toBe(h(22, 30));
    expect(
      stepQuietBoundary({ start: h(22, 15), end: h(7) }, 'start', -1).start,
    ).toBe(h(22));
    expect(
      stepQuietBoundary({ start: h(23, 30), end: h(7) }, 'start', 1).start,
    ).toBe(0);
    expect(stepQuietBoundary({ start: 0, end: h(7) }, 'start', -1).start).toBe(
      h(23, 30),
    );
  });
  it('skips over the other boundary instead of turning quiet hours off', () => {
    expect(
      stepQuietBoundary({ start: h(6, 30), end: h(7) }, 'start', 1),
    ).toEqual({
      start: h(7, 30),
      end: h(7),
    });
    expect(
      stepQuietBoundary({ start: h(6, 30), end: h(7) }, 'end', -1),
    ).toEqual({
      start: h(6, 30),
      end: h(6),
    });
  });
  it('moves keyboard focus around the 24 cells', () => {
    expect(quietHourKey('ArrowRight', 23)).toBe(0);
    expect(quietHourKey('ArrowLeft', 0)).toBe(23);
    expect(quietHourKey('ArrowDown', 5)).toBe(6);
    expect(quietHourKey('Home', 12)).toBe(0);
    expect(quietHourKey('End', 12)).toBe(23);
    expect(quietHourKey('Enter', 12)).toBeUndefined();
  });
  it('outputs the backend value only when on and non-empty', () => {
    expect(
      quietHoursValue(
        { enabled: true, start: h(22), end: h(7) },
        'America/Santiago',
      ),
    ).toEqual({ start: '22:00', end: '07:00', timeZone: 'America/Santiago' });
    expect(
      quietHoursValue({ enabled: false, start: h(22), end: h(7) }, 'UTC'),
    ).toBeUndefined();
    expect(
      quietHoursValue({ enabled: true, start: h(5), end: h(5) }, 'UTC'),
    ).toBeUndefined();
  });
});

describe('cooldown', () => {
  it('maps presets and custom values', () => {
    expect(COOLDOWN_OPTIONS.map((option) => option.label)).toEqual([
      'Off',
      '30 s',
      '1 min',
      '5 min',
      '15 min',
      'Custom',
    ]);
    expect(cooldownChoice(0)).toBe('off');
    expect(cooldownChoice(60)).toBe('1m');
    expect(cooldownChoice(900)).toBe('15m');
    expect(cooldownChoice(45)).toBe('custom');
    expect(cooldownSecondsFor('5m', 12)).toBe(300);
    expect(cooldownSecondsFor('custom', 45)).toBe(45);
    expect(cooldownSecondsFor('custom', undefined)).toBeUndefined();
  });
  it('validates the backend range and labels values', () => {
    expect(cooldownError(0)).toBeUndefined();
    expect(cooldownError(3600)).toBeUndefined();
    expect(cooldownError(3601)).toMatch(/between/);
    expect(cooldownError(-1)).toMatch(/between/);
    expect(cooldownError(1.5)).toMatch(/whole/);
    expect(cooldownError(undefined)).toMatch(/Enter/);
    expect(cooldownLabel(0)).toBe('Off');
    expect(cooldownLabel(45)).toBe('45 s');
    expect(cooldownLabel(90)).toBe('1 min 30 s');
    expect(cooldownLabel(3600)).toBe('1 h');
  });
});

describe('time zones', () => {
  it('uses Intl.supportedValuesOf when present and adds UTC', () => {
    expect(
      supportedTimeZones({ supportedValuesOf: () => ['Europe/Madrid'] }),
    ).toEqual(['UTC', 'Europe/Madrid']);
    expect(supportedTimeZones({})).toBeUndefined();
    expect(
      supportedTimeZones({
        supportedValuesOf: () => {
          throw new RangeError('no');
        },
      }),
    ).toBeUndefined();
  });
  it('validates zones like the backend', () => {
    expect(isKnownTimeZone('America/Santiago')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false);
    expect(isKnownTimeZone('')).toBe(false);
  });
  it('searches by city words, city prefixes first', () => {
    const zones = [
      'America/Argentina/Buenos_Aires',
      'America/Santiago',
      'America/Sao_Paulo',
      'Europe/Madrid',
      'UTC',
    ];
    expect(filterTimeZones(zones, 'buenos')).toEqual([
      'America/Argentina/Buenos_Aires',
    ]);
    expect(filterTimeZones(zones, 'america s')[0]).toBe('America/Santiago');
    expect(filterTimeZones(zones, 'sa')).toEqual([
      'America/Santiago',
      'America/Sao_Paulo',
    ]);
    expect(filterTimeZones(zones, '', 2, ['Europe/Madrid'])).toEqual([
      'Europe/Madrid',
      'America/Argentina/Buenos_Aires',
    ]);
    expect(timeZoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });
});

describe('frequency options', () => {
  it('orders memories, radio frequencies, then recent by count; dedupes by Hz', () => {
    const options = buildFrequencyOptions({
      memories: [
        { name: 'Repeater', hz: 146_520_000 },
        { name: 'Simplex', hz: 145_500_000 },
      ],
      radios: [
        { name: 'Base', hz: 146_520_000 },
        { name: 'Mobile', hz: 446_006_250 },
      ],
      recent: [162_550_000, 145_500_000, 162_550_000, 151_000_000, 0, -5],
    });
    expect(options.map((option) => option.hz)).toEqual([
      146_520_000, 145_500_000, 446_006_250, 162_550_000, 151_000_000,
    ]);
    expect(options[0]).toMatchObject({
      frequency: '146.520',
      detail: 'Repeater · On Base',
      sources: ['memory', 'radio'],
    });
    expect(options[1]!.detail).toBe('Simplex · Recent');
    expect(options[3]!.detail).toBe('Recent ×2');
    expect(options[2]!.frequency).toBe('446.006250');
  });
  it('limits the list but always keeps the selected frequency', () => {
    const options = buildFrequencyOptions({
      memories: [],
      radios: [],
      recent: [1_000_000, 2_000_000, 3_000_000],
      selectedHz: 155_000_000,
      limit: 2,
    });
    expect(options.map((option) => option.hz)).toEqual([
      1_000_000, 2_000_000, 155_000_000,
    ]);
    expect(options[2]!.detail).toBe('Custom');
    const known = buildFrequencyOptions({
      memories: [],
      radios: [],
      recent: [1_000_000, 2_000_000, 3_000_000],
      selectedHz: 3_000_000,
      limit: 2,
    });
    expect(known.map((option) => option.hz)).toEqual([
      1_000_000, 2_000_000, 3_000_000,
    ]);
    expect(known[2]!.detail).toBe('Recent');
  });
  it('reads recent frequencies leniently', () => {
    expect(
      recentFrequencies({
        items: [
          { frequencyHz: 146_520_000 },
          { frequencyHz: '1' },
          {},
          null,
          { frequencyHz: 1.5 },
        ],
      }),
    ).toEqual([146_520_000]);
    expect(recentFrequencies(null)).toEqual([]);
    expect(recentFrequencies({ items: 'x' })).toEqual([]);
  });
});

const basePreference: NotificationPreference = {
  categories: ['incident', 'communication'],
  radioIds: ['11111111-1111-4111-8111-111111111111'],
  cooldownSeconds: 30,
  suppressWhileListening: true,
  enabled: true,
};

describe('preference draft', () => {
  it('defaults the zone to the device and quiet hours to off', () => {
    const draft = preferenceDraft(basePreference, 'America/Santiago');
    expect(draft).toMatchObject({
      timeZone: 'America/Santiago',
      quiet: { enabled: false },
      cooldownChoice: '30s',
      categories: ['communication', 'incident'],
      frequencyHz: undefined,
    });
    expect(preferenceChanged(basePreference, draft, 'America/Santiago')).toBe(
      false,
    );
  });
  it('reads stored quiet hours and their zone', () => {
    const draft = preferenceDraft(
      {
        ...basePreference,
        frequencyHz: 146_520_000,
        quietHours: { start: '22:00', end: '07:00', timeZone: 'Europe/Madrid' },
      },
      'America/Santiago',
    );
    expect(draft.quiet).toEqual({ enabled: true, start: h(22), end: h(7) });
    expect(draft.timeZone).toBe('Europe/Madrid');
    expect(draft.frequencyHz).toBe(146_520_000);
  });
  it('builds the PUT body, keeping fields the screen does not edit', () => {
    const draft: PreferenceDraft = {
      ...preferenceDraft(basePreference, 'America/Santiago'),
      cooldownChoice: 'custom',
      customCooldownSeconds: 120,
      frequencyHz: 146_520_000,
      quiet: { enabled: true, start: h(22), end: h(7) },
      categories: ['radio', 'incident'],
    };
    const body = preferenceBody(basePreference, draft);
    expect(body).toEqual({
      ok: true,
      value: {
        categories: ['incident', 'radio'],
        radioIds: basePreference.radioIds,
        cooldownSeconds: 120,
        suppressWhileListening: true,
        enabled: true,
        frequencyHz: 146_520_000,
        quietHours: {
          start: '22:00',
          end: '07:00',
          timeZone: 'America/Santiago',
        },
      },
    });
    expect(preferenceChanged(basePreference, draft, 'America/Santiago')).toBe(
      true,
    );
  });
  it('removes the frequency filter and quiet hours when cleared', () => {
    const stored: NotificationPreference = {
      ...basePreference,
      frequencyHz: 1,
      quietHours: { start: '01:00', end: '02:00', timeZone: 'UTC' },
    };
    const draft = {
      ...preferenceDraft(stored, 'UTC'),
      frequencyHz: undefined,
      quiet: { enabled: false, start: h(1), end: h(2) },
    };
    const body = preferenceBody(stored, draft);
    expect(body.ok && 'frequencyHz' in body.value).toBe(false);
    expect(body.ok && 'quietHours' in body.value).toBe(false);
  });
  it('rejects invalid drafts', () => {
    const draft = preferenceDraft(basePreference, 'UTC');
    expect(
      preferenceBody(basePreference, {
        ...draft,
        cooldownChoice: 'custom',
        customCooldownSeconds: 4000,
      }).ok,
    ).toBe(false);
    expect(
      preferenceBody(basePreference, {
        ...draft,
        quiet: { enabled: true, start: h(3), end: h(3) },
      }).ok,
    ).toBe(false);
    expect(
      preferenceBody(basePreference, {
        ...draft,
        quiet: { enabled: true, start: h(3), end: h(4) },
        timeZone: 'Nowhere/City',
      }).ok,
    ).toBe(false);
    // An unknown zone does not matter while quiet hours are off.
    expect(
      preferenceBody(basePreference, { ...draft, timeZone: 'Nowhere/City' }).ok,
    ).toBe(true);
  });
});

const record = (
  id: string,
  createdAt: string,
  extra: Partial<NotificationRecord> = {},
): NotificationRecord => ({
  id,
  instanceId: 'instance',
  userId: 'user',
  eventId: `event-${id}`,
  category: 'incident',
  createdAt,
  deliveryState: 'queued',
  ...extra,
});

describe('inbox', () => {
  const now = Date.parse('2026-03-10T15:00:00Z');
  it('groups by day in the display zone, newest first, with unread counts', () => {
    const items = [
      record('a', '2026-03-10T02:30:00Z'), // 23:30 on Mar 9 in Santiago (UTC−3)
      record('b', '2026-03-10T14:00:00Z', { readAt: '2026-03-10T14:05:00Z' }),
      record('c', '2026-03-10T12:00:00Z'),
      record('d', '2026-03-05T12:00:00Z'),
    ];
    const days = groupNotificationsByDay(items, 'America/Santiago', now);
    expect(days.map((day) => [day.day, day.heading, day.unread])).toEqual([
      ['2026-03-10', 'Today', 1],
      ['2026-03-09', 'Yesterday', 1],
      ['2026-03-05', 'Thursday, Mar 5', 1],
    ]);
    expect(days[0]!.items.map((item) => item.id)).toEqual(['b', 'c']);
    expect(unreadCount(items)).toBe(3);
    const utc = groupNotificationsByDay(items, 'UTC', now);
    expect(utc[0]!.items.map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });
  it('describes delivery without implying device delivery when there is no relay', () => {
    expect(deliveryPresentation('queued', false).label).toBe(
      'Stored in station history',
    );
    expect(deliveryPresentation('queued', true).label).toBe(
      'Queued for delivery',
    );
    expect(deliveryPresentation('failed', true).tone).toBe('warning');
  });
  it('labels rows with read state in text', () => {
    expect(
      notificationLabel(record('a', '2026-03-10T14:00:00Z'), {
        timeZone: 'UTC',
        radioName: 'Base station',
        relayConfigured: false,
      }),
    ).toBe(
      'Unread. Incident opened, Base station, 14:00. Stored in station history.',
    );
  });
  it('merges pages without duplicates', () => {
    const a = record('a', '2026-03-10T14:00:00Z');
    const b = record('b', '2026-03-10T13:00:00Z');
    const c = record('c', '2026-03-10T12:00:00Z');
    expect(mergeRecentPage([b, c], [a, b], false)).toEqual([a, b]);
    expect(mergeRecentPage([b, c], [a, b], true)).toEqual([a, b, c]);
    expect(appendOlderPage([a, b], [b, c])).toEqual([a, b, c]);
    const read = { ...b, readAt: '2026-03-10T15:00:00Z' };
    expect(replaceNotification([a, b], read)).toEqual([a, read]);
  });
});
