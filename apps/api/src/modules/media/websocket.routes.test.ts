import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PCM_WEBSOCKET_PROTOCOL,
  type AuthenticationPort,
  type SignalDockError,
} from '@signaldock/contracts';
import type { MediaService, MediaSocket } from '@signaldock/media-gateway';
import { registerMediaRoutes } from './media.routes.js';

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});
async function fixture() {
  const app = Fastify();
  await app.register(websocket, {
    options: {
      maxPayload: 1304,
      perMessageDeflate: false,
      handleProtocols: (protocols) =>
        protocols.has(PCM_WEBSOCKET_PROTOCOL) ? PCM_WEBSOCKET_PROTOCOL : false,
    },
  });
  const id = crypto.randomUUID();
  const ticket = 'x'.repeat(43);
  const media = {
    socketEnabled: true,
    openWebSocket: async (
      received: string,
      token: string,
      socket: MediaSocket,
    ) => {
      if (received !== id || token !== ticket)
        throw new Error('Invalid fixture ticket');
      socket.onMessage((data, binary) => {
        if (binary) socket.send(data);
      });
      socket.send('ready');
    },
  } as unknown as MediaService;
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as SignalDockError;
    return reply
      .code(failure.code === 'FORBIDDEN' ? 403 : 401)
      .send({ code: failure.code });
  });
  registerMediaRoutes(app, '/backend/api/v1', {
    auth: {} as AuthenticationPort,
    media,
    allowedOrigins: ['https://station.test'],
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  stops.push(() => app.close());
  return {
    url: address.replace('http:', 'ws:') + `/backend/api/v1/media/socket/${id}`,
    ticket,
  };
}
function connect(url: string, ticket: string, origin = 'https://station.test') {
  const socket = new WebSocket(
    url,
    [PCM_WEBSOCKET_PROTOCOL, `ticket.${ticket}`],
    { origin },
  );
  socket.on('error', () => undefined);
  stops.push(() => {
    socket.terminate();
    return Promise.resolve();
  });
  return socket;
}
describe('PCM WebSocket upgrade route', () => {
  it('upgrades with an allowed origin and scoped ticket, and forwards binary frames', async () => {
    const f = await fixture(),
      socket = connect(f.url, f.ticket);
    const ready = await new Promise<string>((resolve, reject) => {
      socket.once('message', (data) => resolve(data.toString()));
      socket.once('error', reject);
    });
    expect(ready).toBe('ready');
    expect(socket.protocol).toBe(PCM_WEBSOCKET_PROTOCOL);
    const reply = new Promise<Buffer>((resolve) =>
      socket.once('message', (data) => resolve(data as Buffer)),
    );
    socket.send(Uint8Array.of(1, 2, 3, 4));
    expect([...(await reply)]).toEqual([1, 2, 3, 4]);
    socket.close();
  });
  it('rejects a foreign origin before upgrade and rejects a forged ticket without ready/audio', async () => {
    const f = await fixture(),
      foreign = connect(f.url, f.ticket, 'https://other.test');
    await expect(
      new Promise((resolve, reject) => {
        foreign.once('open', resolve);
        foreign.once('error', reject);
      }),
    ).rejects.toThrow('403');
    const forged = connect(f.url, 'y'.repeat(43));
    let messages = 0;
    forged.on('message', () => messages++);
    const code = await new Promise<number>((resolve) =>
      forged.once('close', resolve),
    );
    expect(code).toBe(1008);
    expect(messages).toBe(0);
  });
});
