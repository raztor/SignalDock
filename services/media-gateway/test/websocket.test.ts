import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SignalDockError,
  PCM_WEBSOCKET_FORMAT,
  encodePcmSocketFrame,
  decodePcmSocketFrame,
  type AuthenticationPort,
  type PcmAudioFrame,
  type Principal,
  type RadioSnapshot,
} from '@signaldock/contracts';
import { TxSupervisor } from '@signaldock/radio-runtime/tx';
import { MediaService } from '../src/service.js';
import {
  WebSocketCredentials,
  WebSocketRadioBridge,
} from '../src/websocket.js';
import type { MediaSocket } from '../src/bridge-port.js';

class Socket implements MediaSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  code?: number;
  private messages = new Set<(data: Uint8Array, binary: boolean) => void>();
  private closing: (() => void)[] = [];
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code: number) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.code = code;
    for (const callback of this.closing) callback();
  }
  onMessage(callback: (data: Uint8Array, binary: boolean) => void) {
    this.messages.add(callback);
    return () => this.messages.delete(callback);
  }
  onClose(callback: () => void) {
    this.closing.push(callback);
  }
  onError(_callback: () => void) {}
  receive(data: Uint8Array, binary = true) {
    for (const callback of this.messages) callback(data, binary);
  }
}
class Feed {
  private queue: PcmAudioFrame[] = [];
  private wake: (() => void) | undefined;
  push(frame: PcmAudioFrame) {
    this.queue.push(frame);
    this.wake?.();
  }
  async *frames(signal: AbortSignal): AsyncIterable<PcmAudioFrame> {
    const wake = () => this.wake?.();
    signal.addEventListener('abort', wake, { once: true });
    try {
      while (!signal.aborted) {
        if (this.queue.length) yield this.queue.shift()!;
        else
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            if (signal.aborted) resolve();
          });
      }
    } finally {
      signal.removeEventListener('abort', wake);
      this.wake = undefined;
    }
  }
}
const cleanup: MediaService[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((media) => media.close()));
  vi.useRealTimers();
});

function fixture() {
  const principal: Principal = {
    instanceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    username: 'fixture',
    role: 'operator',
    radioPermissions: [],
  };
  const radioId = crypto.randomUUID(),
    generation = crypto.randomUUID();
  let denied = false;
  const auth: AuthenticationPort = {
    authenticate: async (token) => {
      if (token !== 'fixture-access')
        throw new SignalDockError('UNAUTHORIZED', 'Invalid fixture');
      return principal;
    },
    authorize: async () => {
      if (denied)
        throw new SignalDockError('FORBIDDEN', 'Fixture access revoked');
    },
  };
  const snapshot: RadioSnapshot = {
    radioId,
    generation,
    revision: 1,
    connection: 'ready',
    tuningConfidence: 'confirmed',
    observedTuning: { rxHz: 145000000, mode: 'FM' },
    txState: 'idle',
  };
  const write = vi.fn(async () => undefined);
  const end = vi.fn(async () => ({
    state: 'idle' as const,
    physicallyConfirmed: true,
  }));
  const supervisor = new TxSupervisor({
    runtime: {
      snapshot: () => snapshot,
      validateControl: () => ({ fencing: 1, expiresAt: Date.now() + 30000 }),
      reserveTransmission: () => undefined,
      releaseTransmission: () => undefined,
    },
    driver: () => ({
      prepare: async () => undefined,
      write,
      renew: async () => undefined,
      end,
      observe: end,
    }),
  });
  const feed = new Feed();
  const archive = vi.fn();
  const errors = vi.fn();
  const media = new MediaService({
    instanceId: principal.instanceId,
    auth,
    supervisor,
    credentials: new WebSocketCredentials(
      'wss://station.test/api/v1/media/socket',
    ),
    bridgeFactory: (options) => new WebSocketRadioBridge(options),
    rxSource: () => ({
      generation,
      format: PCM_WEBSOCKET_FORMAT,
      frames: (signal) => feed.frames(signal),
    }),
    onFrame: archive,
    onError: errors,
  });
  cleanup.push(media);
  return {
    media,
    auth,
    principal,
    radioId,
    feed,
    write,
    end,
    archive,
    errors,
    supervisor,
    deny: () => {
      denied = true;
    },
    frame: (sequence = 0): PcmAudioFrame => ({
      streamId: generation,
      sequence,
      mediaTimeUs: sequence * 20000,
      format: PCM_WEBSOCKET_FORMAT,
      data: new Uint8Array(1280).fill(7),
      tuningRevision: 1,
      attributionConfidence: 'confirmed',
      discontinuity: false,
    }),
    session: (mode: 'listen' | 'transmit', txGrantId?: string) =>
      media.createSession(principal, 'fixture-access', {
        radioId,
        mode,
        ...(txGrantId ? { txGrantId } : {}),
      }),
    start: () =>
      media.startTx(principal, {
        radioId,
        generation,
        controlGrant: crypto.randomUUID(),
        expectedRevision: 1,
      }),
  };
}

describe('authorized PCM WebSocket bridge', () => {
  it('keeps a quiet channel alive through HTTPS and closes an unresponsive socket', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const socket = Object.assign(new Socket(), {
      ping: vi.fn(),
      onPong: (_listener: () => void) => undefined,
    });
    const session = await f.session('listen');
    await f.media.openWebSocket(session.id, session.token, socket);
    await vi.advanceTimersByTimeAsync(20000);
    expect(socket.ping).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(socket.code).toBe(1001);
  });
  it('delivers RX only after ticket admission, revokes immediately, and preserves unknown attribution', async () => {
    const f = fixture(),
      socket = new Socket();
    const session = await f.session('listen');
    await expect(
      f.media.openWebSocket(session.id, 'x'.repeat(43), socket),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    f.feed.push(f.frame());
    await vi.waitFor(() => expect(f.archive).toHaveBeenCalledOnce());
    expect(socket.sent).toEqual([]);
    await f.media.openWebSocket(session.id, session.token, socket);
    expect(JSON.parse(socket.sent[0] as string).type).toBe('ready');
    f.feed.push(f.frame(1));
    await vi.waitFor(() => expect(socket.sent.length).toBe(2));
    expect(decodePcmSocketFrame(socket.sent[1] as Uint8Array).data).toEqual(
      f.frame().data,
    );
    expect(f.archive.mock.calls[0]![1].attributionConfidence).toBe('unknown');
    await f.media.removeSession(session.id, f.principal);
    expect(socket.readyState).toBe(3);
    f.feed.push(f.frame(2));
    await vi.waitFor(() => expect(f.archive).toHaveBeenCalledTimes(3));
    expect(socket.sent.length).toBe(2);
    await expect(
      f.media.openWebSocket(session.id, session.token, new Socket()),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('rejects concurrent ticket reuse and a permission revoked during admission', async () => {
    const f = fixture(),
      first = new Socket();
    const session = await f.session('listen');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.auth, 'authenticate').mockImplementation(async () => {
      await pending;
      return f.principal;
    });
    const admission = f.media.openWebSocket(session.id, session.token, first);
    await expect(
      f.media.openWebSocket(session.id, session.token, new Socket()),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    f.deny();
    release();
    await expect(admission).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(first.sent).toEqual([]);
  });
  it('serializes TX through the supervisor and stops on socket loss without resuming', async () => {
    const f = fixture(),
      socket = new Socket();
    const tx = await f.start(),
      session = await f.session('transmit', tx.grant.txGrantId);
    await f.media.openWebSocket(session.id, session.token, socket);
    socket.receive(encodePcmSocketFrame(f.frame()));
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    socket.close(1000);
    await vi.waitFor(() =>
      expect(f.supervisor.get(tx.grant.txGrantId).state).toBe('idle'),
    );
    socket.receive(encodePcmSocketFrame(f.frame(1)));
    expect(f.write).toHaveBeenCalledOnce();
    await expect(
      f.media.openWebSocket(session.id, session.token, new Socket()),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('rejects a replay and never accepts microphone data from a listener', async () => {
    const f = fixture(),
      socket = new Socket();
    const tx = await f.start(),
      session = await f.session('transmit', tx.grant.txGrantId);
    await f.media.openWebSocket(session.id, session.token, socket);
    socket.receive(encodePcmSocketFrame(f.frame()));
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    socket.receive(encodePcmSocketFrame(f.frame()));
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(f.write).toHaveBeenCalledOnce();
    const listen = await f.session('listen'),
      listener = new Socket();
    await f.media.openWebSocket(listen.id, listen.token, listener);
    listener.receive(encodePcmSocketFrame(f.frame()));
    expect(listener.code).toBe(1008);
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('bounds TX queues while an admitted write is delayed and drops unsent audio', async () => {
    const f = fixture(),
      socket = new Socket();
    let finish!: () => void;
    f.write.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const tx = await f.start(),
      session = await f.session('transmit', tx.grant.txGrantId);
    await f.media.openWebSocket(session.id, session.token, socket);
    socket.receive(encodePcmSocketFrame(f.frame()));
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    for (let index = 1; index <= 11; index++)
      socket.receive(encodePcmSocketFrame(f.frame(index)));
    expect(socket.readyState).toBe(3);
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.supervisor.get(tx.grant.txGrantId).state).not.toBe('idle');
    finish();
    await vi.waitFor(async () =>
      expect(await f.supervisor.reconcile(f.radioId)).toBe(true),
    );
    await vi.waitFor(() =>
      expect(f.supervisor.get(tx.grant.txGrantId).state).toBe('idle'),
    );
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('paces a bounded TCP microphone batch instead of rejecting or bursting it', async () => {
    const f = fixture(),
      socket = new Socket();
    const times: number[] = [];
    f.write.mockImplementation(async () => {
      times.push(performance.now());
    });
    const tx = await f.start(),
      session = await f.session('transmit', tx.grant.txGrantId);
    await f.media.openWebSocket(session.id, session.token, socket);
    for (let index = 0; index < 8; index++)
      socket.receive(encodePcmSocketFrame(f.frame(index)));
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(8));
    expect(socket.readyState).toBe(1);
    expect(times[7]! - times[0]!).toBeGreaterThanOrEqual(120);
  });
  it('drops buffered audio immediately when the socket closes during pacing', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      socket = new Socket();
    const tx = await f.start(),
      session = await f.session('transmit', tx.grant.txGrantId);
    await f.media.openWebSocket(session.id, session.token, socket);
    socket.receive(encodePcmSocketFrame(f.frame()));
    socket.receive(encodePcmSocketFrame(f.frame(1)));
    await vi.advanceTimersByTimeAsync(0);
    socket.close(1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.supervisor.get(tx.grant.txGrantId).state).toBe('idle');
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('still rejects stale microphone audio with bounded numeric diagnostics', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      socket = new Socket();
    const tx = await f.start(),
      session = await f.session('transmit', tx.grant.txGrantId);
    await f.media.openWebSocket(session.id, session.token, socket);
    socket.receive(encodePcmSocketFrame(f.frame()));
    await vi.advanceTimersByTimeAsync(1260);
    socket.receive(encodePcmSocketFrame(f.frame(1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.code).toBe(1008);
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.errors.mock.calls[0]?.[1]).toMatchObject({
      code: 'INVALID_ARGUMENT',
      diagnostic: {
        reason: 'clock',
        sequence: 1,
        expectedSequence: 1,
        lagMs: 1240,
      },
    });
  });
  it('tolerates a public HTTPS stall without extending authorization or queueing a burst', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      socket = new Socket();
    const tx = await f.start(),
      session = await f.session('transmit', tx.grant.txGrantId);
    await f.media.openWebSocket(session.id, session.token, socket);
    socket.receive(encodePcmSocketFrame(f.frame()));
    await vi.advanceTimersByTimeAsync(460);
    socket.receive(encodePcmSocketFrame(f.frame(1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.write).toHaveBeenCalledTimes(2);
    expect(socket.readyState).toBe(1);
    expect(f.supervisor.get(tx.grant.txGrantId).grant.expiresAt).toBe(
      tx.grant.expiresAt,
    );
    expect(f.errors).not.toHaveBeenCalled();
  });
  it('disconnects a slow RX socket without blocking another listener', async () => {
    const f = fixture(),
      slow = new Socket(),
      fast = new Socket();
    const a = await f.session('listen'),
      b = await f.session('listen');
    await f.media.openWebSocket(a.id, a.token, slow);
    await f.media.openWebSocket(b.id, b.token, fast);
    slow.bufferedAmount = 100000;
    f.feed.push(f.frame());
    await vi.waitFor(() => expect(fast.sent.length).toBe(2));
    expect(slow.code).toBe(1013);
    expect(fast.readyState).toBe(1);
  });
  it('closes an established listener after login revocation', async () => {
    const f = fixture(),
      socket = new Socket(),
      session = await f.session('listen');
    await f.media.openWebSocket(session.id, session.token, socket);
    await f.media.revokeSession(f.principal.sessionId);
    expect(socket.readyState).toBe(3);
    await expect(
      f.media.openWebSocket(session.id, session.token, new Socket()),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
