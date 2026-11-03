import { afterEach, expect, it, vi } from 'vitest';
import type { ClientSession } from '@signaldock/contracts';
import { subscribeStationEvents } from '../src/index.js';

const session: ClientSession = {
  baseUrl: 'https://station.example/',
  instanceId: crypto.randomUUID(),
  accessToken: 'token',
  user: {
    id: crypto.randomUUID(),
    username: 'operator',
    role: 'operator',
    enabled: true,
    radioPermissions: [],
  },
};
afterEach(() => vi.unstubAllGlobals());

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

it('reports the open stream and every frame, comments included', async () => {
  const event = {
    eventId: crypto.randomUUID(),
    instanceId: session.instanceId,
    protocolVersion: 1,
    streamGeneration: crypto.randomUUID(),
    sequence: 0,
    type: 'radio.health',
    payloadVersion: 1,
    occurredAt: new Date().toISOString(),
    payload: {},
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          streamOf([
            ': connected\n\n',
            ': heartbeat\n\n',
            `data: ${JSON.stringify(event)}\n\n`,
          ]),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    ),
  );
  const order: string[] = [];
  const events: unknown[] = [];
  await subscribeStationEvents(
    session,
    (item) => {
      order.push('event');
      events.push(item);
    },
    new AbortController().signal,
    {
      onOpen: () => order.push('open'),
      onFrame: () => order.push('frame'),
    },
  );
  expect(order).toEqual(['open', 'frame', 'frame', 'frame', 'event']);
  expect(events).toHaveLength(1);
});

it('works without hooks', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(streamOf([': connected\n\n']))),
  );
  await expect(
    subscribeStationEvents(
      session,
      () => undefined,
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
});
