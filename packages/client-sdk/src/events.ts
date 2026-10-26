import {
  DomainEventSchema,
  type ClientSession,
  type DomainEvent,
} from '@signaldock/contracts';
import { apiFetch } from './index.js';

/** Fetch-based SSE supports bearer authentication on configurable server origins. */
export async function subscribeStationEvents(
  session: ClientSession,
  onEvent: (event: DomainEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await apiFetch(session, 'events', {
    signal,
    headers: { Accept: 'text/event-stream' },
  });
  if (!response.body)
    throw new Error('This client cannot stream station events.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const value = await reader.read();
      if (value.done) return;
      pending += decoder.decode(value.value, { stream: true });
      if (pending.length > 131072)
        throw new Error('The station event exceeded the client buffer limit.');
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const line = frame
          .split('\n')
          .find((item) => item.startsWith('data: '));
        if (!line) continue;
        const event = DomainEventSchema.parse(JSON.parse(line.slice(6)));
        if (
          event.instanceId !== session.instanceId ||
          event.protocolVersion !== 1 ||
          typeof event.eventId !== 'string' ||
          typeof event.type !== 'string'
        )
          throw new Error('The station returned an invalid event.');
        onEvent(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
