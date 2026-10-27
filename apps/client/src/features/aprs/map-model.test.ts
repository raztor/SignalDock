import { describe, expect, it } from 'vitest';
import type { PositionRecord } from '@signaldock/contracts';
import {
  latestStations,
  positionAge,
  positionCollection,
  trackCollection,
} from './map-model';

function point(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    positionId: crypto.randomUUID(),
    packetId: crypto.randomUUID(),
    instanceId: '00000000-0000-4000-8000-000000000001',
    radioId: '00000000-0000-4000-8000-000000000002',
    callsign: 'N0CALL',
    lat: 49,
    lon: -72,
    receivedAt: '2026-10-26T12:00:00Z',
    source: 'native',
    ...overrides,
  };
}
describe('map evidence model', () => {
  it('chooses latest received evidence independently per instance/radio/station', () => {
    const old = point();
    const recent = point({ receivedAt: '2026-10-26T12:10:00Z' });
    const other = point({ instanceId: crypto.randomUUID() });
    expect(latestStations([old, recent, other])).toHaveLength(2);
    expect(
      latestStations([old, recent]).map((item) => item.positionId),
    ).toEqual([recent.positionId]);
  });
  it('marks old/future timestamps rather than calling them current', () => {
    expect(
      positionAge(point(), Date.parse('2026-10-26T13:00:00Z')),
    ).toMatchObject({ ageSeconds: 3600, stale: true });
    expect(
      positionAge(point(), Date.parse('2026-10-26T11:00:00Z')),
    ).toMatchObject({ ageSeconds: 0, clockSkew: true });
  });
  it('does not mix independent source tracks or invent interpolated points', () => {
    const points = [
      point(),
      point({ receivedAt: '2026-10-26T12:01:00Z', lat: 50 }),
      point({ source: 'aprs_is' }),
    ];
    expect(trackCollection(points).features[0]?.geometry.coordinates).toEqual([
      [-72, 49],
      [-72, 50],
    ]);
    expect(positionCollection(points).features).toHaveLength(1);
  });
});
