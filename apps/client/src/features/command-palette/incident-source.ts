import { apiRequest } from '@signaldock/client-sdk';
import {
  IncidentRecordSchema,
  type ClientSession,
  type IncidentRecord,
} from '@signaldock/contracts';
import {
  OPEN_INCIDENT_STATES,
  PALETTE_INCIDENT_LIMIT,
  mergeOpenIncidents,
} from './command-model';

/**
 * The most recently updated open incidents (new, acknowledged, in progress)
 * for the palette: one `GET incidents?state=…&limit=20` per open state,
 * validated with `IncidentRecordSchema` and scoped to the session's instance.
 * Invalid rows are skipped rather than failing the whole search.
 */
export async function fetchOpenIncidents(
  session: ClientSession,
  signal: AbortSignal,
): Promise<IncidentRecord[]> {
  const lists = await Promise.all(
    OPEN_INCIDENT_STATES.map(async (state) => {
      const query = new URLSearchParams({
        state,
        limit: String(PALETTE_INCIDENT_LIMIT),
      });
      const data = await apiRequest<unknown>(session, `incidents?${query}`, {
        signal,
      });
      const items =
        typeof data === 'object' && data !== null && 'items' in data
          ? (data as { items: unknown }).items
          : undefined;
      if (!Array.isArray(items))
        throw new Error('The server returned an invalid incident list.');
      return items.flatMap((item) => {
        const parsed = IncidentRecordSchema.safeParse(item);
        return parsed.success && parsed.data.instanceId === session.instanceId
          ? [parsed.data]
          : [];
      });
    }),
  );
  return mergeOpenIncidents(lists, PALETTE_INCIDENT_LIMIT);
}
