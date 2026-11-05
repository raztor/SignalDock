import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PCM_WEBSOCKET_FORMAT,
  PCM_WEBSOCKET_PROTOCOL,
  decodePcmSocketFrame,
  encodePcmSocketFrame,
  type MediaSession,
} from '@signaldock/contracts';
import { connectPcmWebSocket } from './websocket-port.web';

let sockets: FakeSocket[];
let worklets: FakeWorklet[];
let contexts: FakeContext[];
let resume: Promise<void>;
class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  constructor(
    readonly url: URL,
    readonly protocols: string[],
  ) {
    super();
    sockets.push(this);
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'ready',
            protocol: PCM_WEBSOCKET_PROTOCOL,
            format: PCM_WEBSOCKET_FORMAT,
            tuningRevision: 7,
          }),
        }),
      ),
    );
  }
  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}
class FakeWorklet {
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
  };
  onprocessorerror: (() => void) | undefined;
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    worklets.push(this);
  }
}
class FakeContext {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: vi.fn(async (): Promise<void> => undefined) };
  played: Float32Array[] = [];
  constructor() {
    contexts.push(this);
  }
  async resume() {
    await resume;
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createBuffer(_channels: number, samples: number) {
    const data = new Float32Array(samples);
    return { data, getChannelData: () => data };
  }
  createBufferSource() {
    const node = {
      buffer: undefined as { data: Float32Array } | undefined,
      connect: vi.fn(),
      disconnect: vi.fn(),
      onended: undefined,
      stop: vi.fn(),
      start: () => {
        this.played.push(node.buffer!.data);
      },
    };
    return node;
  }
}
beforeEach(() => {
  sockets = [];
  worklets = [];
  contexts = [];
  resume = Promise.resolve();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  vi.stubGlobal('MediaStream', class {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function session(mode: MediaSession['mode']): MediaSession {
  return {
    id: crypto.randomUUID(),
    instanceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    radioId: crypto.randomUUID(),
    participantIdentity: 'fixture',
    mode,
    token: 'x'.repeat(43),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    serverUrl: 'wss://station.test/backend/api/v1/media/socket',
    transport: 'websocket',
  };
}
describe('browser PCM socket', () => {
  it('ends microphone input before waiting for the server completion acknowledgement', async () => {
    const interrupted = vi.fn();
    const connection = await connectPcmWebSocket(
      session('transmit'),
      interrupted,
      new AbortController().signal,
    );
    await connection.publish({
      stop: () => undefined,
      track: { mediaStreamTrack: { readyState: 'live' } },
    } as never);
    const receive = worklets[0]!.port.onmessage!;
    const finishing = connection.finish!();
    receive(new MessageEvent('message', { data: new ArrayBuffer(1280) }));
    expect(sockets[0]!.sent).toEqual(['{"type":"end"}']);
    sockets[0]!.dispatchEvent(
      new MessageEvent('message', { data: '{"type":"ended"}' }),
    );
    sockets[0]!.close();
    await finishing;
    expect(interrupted).not.toHaveBeenCalled();
  });
  it('cancels a pending completion on abort', async () => {
    const abort = new AbortController();
    const connection = await connectPcmWebSocket(
      session('transmit'),
      vi.fn(),
      abort.signal,
    );
    const finishing = connection.finish!();
    abort.abort();
    await expect(finishing).rejects.toThrow('interrupted');
  });
  it('bounds an unacknowledged completion instead of retaining TX indefinitely', async () => {
    vi.useFakeTimers();
    const connection = await connectPcmWebSocket(
      session('transmit'),
      vi.fn(),
      new AbortController().signal,
    );
    const finishing = expect(connection.finish!()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(4000);
    await finishing;
    await connection.disconnect();
  });
  it('registers the ready handler before awaiting audio activation and plays little-endian PCM', async () => {
    let activate!: () => void;
    resume = new Promise<void>((resolve) => {
      activate = resolve;
    });
    const value = session('listen'),
      interrupted = vi.fn();
    const pending = connectPcmWebSocket(
      value,
      interrupted,
      new AbortController().signal,
    );
    await Promise.resolve();
    activate();
    const connection = await pending;
    expect(sockets[0]!.url.pathname).toBe(
      `/backend/api/v1/media/socket/${value.id}`,
    );
    expect(sockets[0]!.url.search).toBe('');
    sockets[0]!.dispatchEvent(
      new MessageEvent('message', {
        data: encodePcmSocketFrame({
          sequence: 0,
          mediaTimeUs: 0,
          tuningRevision: 1,
          data: Uint8Array.of(0, 128, 255, 127),
        }).buffer,
      }),
    );
    expect(contexts[0]!.played[0]![0]).toBe(-1);
    expect(connection.level!()).toBeGreaterThan(0);
    await connection.disconnect();
    expect(interrupted).not.toHaveBeenCalled();
  });
  it('stops microphone delivery synchronously before asynchronous connection cleanup', async () => {
    const stop: (() => void)[] = [];
    const connection = await connectPcmWebSocket(
      session('transmit'),
      vi.fn(),
      new AbortController().signal,
    );
    await connection.publish({
      stop: () => undefined,
      track: { mediaStreamTrack: { readyState: 'live' } },
      onStop: (listener: () => void) => stop.push(listener),
    } as never);
    const receive = worklets[0]!.port.onmessage!;
    receive(new MessageEvent('message', { data: new ArrayBuffer(1280) }));
    expect(decodePcmSocketFrame(sockets[0]!.sent[0]!).tuningRevision).toBe(7);
    for (const listener of stop) listener();
    receive(new MessageEvent('message', { data: new ArrayBuffer(1280) }));
    expect(sockets[0]!.sent.length).toBe(1);
    await connection.disconnect();
  });
  it('does not open microphone nodes after release during worklet initialization', async () => {
    const stopped: (() => void)[] = [];
    const connection = await connectPcmWebSocket(
      session('transmit'),
      vi.fn(),
      new AbortController().signal,
    );
    let finish!: () => void;
    const module = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const add = vi
      .spyOn(FakeContext.prototype, 'resume')
      .mockImplementation(async function (this: FakeContext) {
        this.state = 'running';
        this.audioWorklet.addModule = vi.fn(() => module);
      });
    const publishing = connection.publish({
      stop: () => undefined,
      track: { mediaStreamTrack: { readyState: 'live' } },
      onStop: (listener: () => void) => stopped.push(listener),
    } as never);
    await vi.waitFor(() => expect(stopped.length).toBe(1));
    for (const listener of stopped) listener();
    finish();
    await expect(publishing).rejects.toThrow('cancelled');
    expect(worklets.length).toBe(0);
    expect(sockets[0]!.sent.length).toBe(0);
    add.mockRestore();
  });
});
