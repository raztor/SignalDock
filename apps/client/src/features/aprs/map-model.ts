import type { PositionRecord } from '@signaldock/contracts';

export function latestStations(
  positions: readonly PositionRecord[],
): PositionRecord[] {
  const stations = new Map<string, PositionRecord>();
  for (const position of positions) {
    const key = `${position.instanceId}:${position.radioId}:${position.callsign}`;
    const previous = stations.get(key);
    if (
      !previous ||
      Date.parse(position.receivedAt) > Date.parse(previous.receivedAt) ||
      (position.receivedAt === previous.receivedAt &&
        position.positionId > previous.positionId)
    )
      stations.set(key, position);
  }
  return [...stations.values()].sort((a, b) =>
    a.callsign.localeCompare(b.callsign),
  );
}

export function positionAge(
  position: PositionRecord,
  now = Date.now(),
  maxAgeSeconds = 1800,
) {
  const difference = now - Date.parse(position.receivedAt);
  return {
    ageSeconds: Math.max(0, Math.floor(difference / 1000)),
    stale: difference > maxAgeSeconds * 1000,
    clockSkew: difference < -60000,
  };
}

export function positionCollection(
  positions: readonly PositionRecord[],
  now = Date.now(),
) {
  return {
    type: 'FeatureCollection' as const,
    features: latestStations(positions).map((position) => ({
      type: 'Feature' as const,
      id: position.positionId,
      properties: {
        packetId: position.packetId,
        callsign: position.callsign,
        source: position.source,
        ...positionAge(position, now),
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [position.lon, position.lat] as [number, number],
      },
    })),
  };
}

/** Track segments join received evidence only; no interpolation or stale-to-current extrapolation. */
export function trackCollection(positions: readonly PositionRecord[]) {
  const groups = new Map<string, PositionRecord[]>();
  for (const position of positions) {
    const key = `${position.instanceId}:${position.radioId}:${position.callsign}:${position.source}`;
    const group = groups.get(key) ?? [];
    group.push(position);
    groups.set(key, group);
  }
  return {
    type: 'FeatureCollection' as const,
    features: [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({
        type: 'Feature' as const,
        properties: { callsign: group[0]!.callsign, source: group[0]!.source },
        geometry: {
          type: 'LineString' as const,
          coordinates: group
            .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
            .map((position) => [position.lon, position.lat]),
        },
      })),
  };
}
