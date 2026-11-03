import { describe, expect, it } from 'vitest';
import {
  activityWindow,
  addCalendarDays,
  bucketActivity,
  cachedTimeZoneCount,
  canonicalTimeZone,
  isValidTimeZone,
  zonedDayHour,
} from '../src/activity.js';

describe('history activity bucketing', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Santiago')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('canonicalizes zone spellings and rejects offset zones', () => {
    expect(canonicalTimeZone('america/santiago')).toBe('America/Santiago');
    expect(canonicalTimeZone('AmErIcA/SaNtIaGo')).toBe('America/Santiago');
    expect(canonicalTimeZone('utc')).toBe('UTC');
    expect(canonicalTimeZone('Etc/UTC')).toBe('UTC');
    expect(canonicalTimeZone('US/Eastern')).toBe('America/New_York');
    expect(canonicalTimeZone('Asia/Kolkata')).toBeDefined();
    for (const offset of ['+05:07', '-0130', '+00:00', '-03'])
      expect(canonicalTimeZone(offset)).toBeUndefined();
    expect(canonicalTimeZone('Not/AZone')).toBeUndefined();
    expect(canonicalTimeZone('x'.repeat(101))).toBeUndefined();
  });

  it('caches one formatter per canonical zone, not per spelling', () => {
    zonedDayHour(new Date(0), 'America/Santiago');
    const before = cachedTimeZoneCount();
    for (const spelling of [
      'america/santiago',
      'AMERICA/SANTIAGO',
      'America/santiago',
      'aMERICA/sANTIAGO',
    ])
      expect(zonedDayHour(new Date(0), spelling)).toEqual(
        zonedDayHour(new Date(0), 'America/Santiago'),
      );
    expect(cachedTimeZoneCount()).toBe(before);
    expect(() => zonedDayHour(new Date(0), '+05:07')).toThrow(RangeError);
  });

  it('maps instants to local day and hour, including fractional offsets', () => {
    const at = new Date('2026-11-03T02:30:00.000Z');
    expect(zonedDayHour(at, 'UTC')).toEqual({ day: '2026-11-03', hour: 2 });
    // Santiago is UTC-3 in November (daylight saving time).
    expect(zonedDayHour(at, 'America/Santiago')).toEqual({
      day: '2026-11-02',
      hour: 23,
    });
    // Kathmandu is UTC+05:45.
    expect(zonedDayHour(at, 'Asia/Kathmandu')).toEqual({
      day: '2026-11-03',
      hour: 8,
    });
  });

  it('shifts calendar days across month and year boundaries', () => {
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(() => addCalendarDays('2026-1-1', 1)).toThrow(RangeError);
  });

  it('builds a local window ending today with a conservative UTC range', () => {
    const now = new Date('2026-11-03T02:30:00.000Z');
    const window = activityWindow(now, 7, 'America/Santiago');
    expect(window.days).toEqual([
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(window.from.toISOString()).toBe('2026-10-26T02:30:00.000Z');
    expect(window.to.getTime()).toBe(now.getTime() + 1);
    expect(() => activityWindow(now, 0, 'UTC')).toThrow(RangeError);
    expect(() => activityWindow(now, 32, 'UTC')).toThrow(RangeError);
  });

  it('returns a complete grid and buckets slots into the requested zone', () => {
    const days = ['2026-11-02', '2026-11-03'];
    const buckets = bucketActivity(
      [
        { startedAt: '2026-11-03T02:00:00.000Z', count: 2 },
        { startedAt: '2026-11-03T02:45:00.000Z', count: 1 },
        { startedAt: new Date('2026-11-03T03:00:00.000Z'), count: 4 },
        // Outside the reported local days.
        { startedAt: '2026-11-01T02:00:00.000Z', count: 9 },
        { startedAt: 'not a date', count: 3 },
        { startedAt: '2026-11-03T05:00:00.000Z', count: 0 },
      ],
      'America/Santiago',
      days,
    );
    expect(buckets).toHaveLength(48);
    expect(buckets[0]).toEqual({ day: '2026-11-02', hour: 0, count: 0 });
    expect(buckets.at(-1)).toEqual({ day: '2026-11-03', hour: 23, count: 0 });
    const nonZero = buckets.filter((bucket) => bucket.count > 0);
    expect(nonZero).toEqual([
      { day: '2026-11-02', hour: 23, count: 3 },
      { day: '2026-11-03', hour: 0, count: 4 },
    ]);
  });

  it('merges repeated hours on a daylight-saving fall-back day', () => {
    // New York falls back on 2026-11-01: 01:00 local occurs at 05:00Z and 06:00Z.
    const buckets = bucketActivity(
      [
        { startedAt: '2026-11-01T05:15:00.000Z', count: 1 },
        { startedAt: '2026-11-01T06:15:00.000Z', count: 2 },
      ],
      'America/New_York',
      ['2026-11-01'],
    );
    expect(buckets.find((bucket) => bucket.hour === 1)?.count).toBe(3);
    expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(3);
  });
});
