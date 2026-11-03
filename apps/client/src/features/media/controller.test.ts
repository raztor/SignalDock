import { describe, expect, it } from 'vitest';
import type {
  ClientSession,
  MediaSession,
  TxGrant,
} from '@signaldock/contracts';
import {
  RadioMediaController,
  stopActiveMedia,
  stopActiveTransmit,
  type BrowserMediaPort,
  type MediaConnection,
  type MediaControlLink,
  type MediaUiState,
} from './controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  options: { level?: () => number; control?: MediaControlLink } = {},
) {
  const radioId = crypto.randomUUID(),
    instanceId = crypto.randomUUID(),
    userId = crypto.randomUUID();
  let session = {
    instanceId,
    baseUrl: 'https://one.example/',
    accessToken: 'private',
    user: { id: userId },
  } as ClientSession;
  const calls: {
    session: ClientSession;
    path: string;
    method: string;
    body?: string;
  }[] = [];
  const controlGrantId = crypto.randomUUID();
  let stopped = 0,
    published = 0,
    disconnected = 0;
  let state: MediaUiState | undefined;
  const mic = {
    stop: () => {
      stopped++;
    },
  };
  const microphone = deferred<typeof mic>();
  const tx = deferred<{ grant: TxGrant; state: 'granted' }>();
  const grant = { radioId, txGrantId: crypto.randomUUID() } as TxGrant;
  const port: BrowserMediaPort = {
    microphone: () => microphone.promise,
    connect: async (admitted) => {
      const connection: MediaConnection = {
        disconnect: async () => {
          disconnected++;
        },
        publish: async () => {
          published++;
        },
      };
      if (options.level && admitted.mode === 'listen')
        connection.level = options.level;
      return connection;
    },
  };
  const controller = new RadioMediaController({
    session: () => session,
    radioId,
    port,
    onState: (value) => {
      state = value;
    },
    ...(options.control ? { control: options.control } : {}),
    request: async <T>(
      context: ClientSession,
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push({
        session: context,
        path,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (path.endsWith('/state'))
        return { generation: crypto.randomUUID(), revision: 4 } as T;
      if (path.endsWith('/control'))
        return {
          grantId: controlGrantId,
          generation: 'control-generation',
        } as T;
      if (path.endsWith('/tx-sessions') && init?.method === 'POST')
        return (await tx.promise) as T;
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { mode?: MediaSession['mode'] })
          : {};
      return {
        id: crypto.randomUUID(),
        instanceId,
        radioId,
        mode: body.mode ?? 'listen',
      } as MediaSession as T;
    },
  });
  return {
    controller,
    controlGrantId,
    microphone,
    tx,
    grant,
    calls,
    mic,
    get stopped() {
      return stopped;
    },
    get published() {
      return published;
    },
    get disconnected() {
      return disconnected;
    },
    get state() {
      return state;
    },
    changeServer: () => {
      session = {
        ...session,
        instanceId: crypto.randomUUID(),
        baseUrl: 'https://two.example/',
        accessToken: 'other',
      };
    },
  };
}
describe('browser PTT cancellation', () => {
  it('aborts a pending listening connection before accepting another context', async () => {
    const connection = deferred<{
      disconnect: () => Promise<void>;
      publish: () => Promise<void>;
    }>();
    let signal: AbortSignal | undefined;
    let disconnected = 0;
    const states: MediaUiState[] = [];
    const controller = new RadioMediaController({
      session: () =>
        ({
          instanceId: crypto.randomUUID(),
          baseUrl: 'https://example.test/',
          accessToken: 'token',
          user: { id: 'user' },
        }) as ClientSession,
      radioId: crypto.randomUUID(),
      port: {
        microphone: async () => {
          throw new Error('Not used.');
        },
        connect: async (_session, _interrupted, cancellation) => {
          signal = cancellation;
          return connection.promise;
        },
      },
      onState: (state) => states.push(state),
      request: async <T>() => ({ id: crypto.randomUUID() }) as T,
    });
    const opening = controller.listen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signal?.aborted).toBe(false);
    await controller.stop('Switching context.');
    expect(signal?.aborted).toBe(true);
    connection.resolve({
      disconnect: async () => {
        disconnected++;
      },
      publish: async () => undefined,
    });
    await opening;
    expect(disconnected).toBeGreaterThan(0);
    expect(states.every((state) => !state.listening)).toBe(true);
    await controller.dispose();
  });
  it('never creates a TX grant after release during microphone permission', async () => {
    const f = fixture();
    const opening = f.controller.startTransmit();
    await f.controller.stopTransmit();
    f.microphone.resolve(f.mic);
    await opening;
    expect(f.stopped).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(0);
    await f.controller.dispose();
  });
  it('releases a late grant and never publishes stale audio', async () => {
    const f = fixture();
    const opening = f.controller.startTransmit();
    f.microphone.resolve(f.mic);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.controller.stopTransmit();
    f.tx.resolve({ grant: f.grant, state: 'granted' });
    await opening;
    expect(f.published).toBe(0);
    expect(
      f.calls.some(
        (call) =>
          call.path.endsWith(f.grant.txGrantId) && call.method === 'DELETE',
      ),
    ).toBe(true);
    await f.controller.dispose();
  });
  it('stops a known microphone synchronously and keeps cleanup on its original server', async () => {
    const f = fixture();
    const opening = f.controller.startTransmit();
    f.microphone.resolve(f.mic);
    f.tx.resolve({ grant: f.grant, state: 'granted' });
    await opening;
    expect(f.published).toBe(1);
    f.changeServer();
    const cleanup = stopActiveMedia('Switching server.', {
      instanceId: f.calls[0]!.session.instanceId,
    });
    expect(f.stopped).toBeGreaterThan(0);
    expect(f.state?.transmitting).toBe(false);
    await cleanup;
    expect(
      f.calls.every((call) => call.session.baseUrl === 'https://one.example/'),
    ).toBe(true);
    await f.controller.dispose();
  });
});
describe('workspace-level media helpers', () => {
  it('stops only transmission and keeps listening', async () => {
    const f = fixture();
    await f.controller.listen();
    expect(f.state?.listening).toBe(true);
    const opening = f.controller.startTransmit();
    f.microphone.resolve(f.mic);
    f.tx.resolve({ grant: f.grant, state: 'granted' });
    await opening;
    expect(f.state?.transmitting).toBe(true);
    const disconnectsBefore = f.disconnected;
    const stopping = stopActiveTransmit('Navigation changed.', {
      radioId: f.controller.radioId,
    });
    // The microphone stops before the first await.
    expect(f.stopped).toBeGreaterThan(0);
    await stopping;
    expect(f.state).toMatchObject({
      listening: true,
      transmitting: false,
      pending: false,
      message: 'Navigation changed.',
    });
    expect(f.disconnected).toBe(disconnectsBefore + 1);
    expect(
      f.calls.some(
        (call) =>
          call.path.endsWith(f.grant.txGrantId) && call.method === 'DELETE',
      ),
    ).toBe(true);
    await f.controller.dispose();
  });
  it('cancels a pending transmission without creating a grant', async () => {
    const f = fixture();
    const opening = f.controller.startTransmit();
    expect(f.state?.pending).toBe(true);
    await stopActiveTransmit('Window lost focus.');
    f.microphone.resolve(f.mic);
    await opening;
    expect(f.stopped).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(0);
    expect(f.state?.pending).toBe(false);
    await f.controller.dispose();
  });
  it('ignores controllers outside the scope', async () => {
    const f = fixture();
    const opening = f.controller.startTransmit();
    f.microphone.resolve(f.mic);
    f.tx.resolve({ grant: f.grant, state: 'granted' });
    await opening;
    await stopActiveTransmit('Other radio.', { radioId: crypto.randomUUID() });
    await stopActiveTransmit('Other server.', {
      instanceId: crypto.randomUUID(),
    });
    expect(f.state?.transmitting).toBe(true);
    expect(f.stopped).toBe(0);
    await f.controller.dispose();
    expect(f.state?.transmitting).toBe(false);
  });
  it('does not affect disposed controllers', async () => {
    const f = fixture();
    await f.controller.listen();
    await f.controller.dispose();
    await stopActiveTransmit('After dispose.');
    expect(f.state?.message).toBe('Media context closed.');
  });
  it('reports a clamped received level only while listening', async () => {
    let value = 0.4;
    const f = fixture({ level: () => value });
    expect(f.controller.rxLevelSupported).toBe(false);
    expect(f.controller.rxLevel()).toBe(0);
    await f.controller.listen();
    expect(f.controller.rxLevelSupported).toBe(true);
    expect(f.controller.rxLevel()).toBe(0.4);
    value = 3;
    expect(f.controller.rxLevel()).toBe(1);
    value = -1;
    expect(f.controller.rxLevel()).toBe(0);
    value = Number.NaN;
    expect(f.controller.rxLevel()).toBe(0);
    await f.controller.stop('Listening stopped.');
    expect(f.controller.rxLevelSupported).toBe(false);
    expect(f.controller.rxLevel()).toBe(0);
    await f.controller.dispose();
  });
  it('returns 0 when the port cannot measure or throws', async () => {
    const plain = fixture();
    await plain.controller.listen();
    expect(plain.controller.rxLevelSupported).toBe(false);
    expect(plain.controller.rxLevel()).toBe(0);
    await plain.controller.dispose();
    const failing = fixture({
      level: () => {
        throw new Error('Audio context closed.');
      },
    });
    await failing.controller.listen();
    expect(failing.controller.rxLevel()).toBe(0);
    await failing.controller.dispose();
  });
});
describe('status messages and control leases', () => {
  it('keeps the previous message when stopTransmit runs while idle', async () => {
    const f = fixture();
    await f.controller.listen();
    await f.controller.stop('Listening authorization expired.');
    expect(f.state?.message).toBe('Listening authorization expired.');
    await f.controller.stopTransmit('Transmission interrupted.');
    await stopActiveTransmit('Navigation changed.');
    expect(f.state).toMatchObject({
      listening: false,
      transmitting: false,
      pending: false,
      message: 'Listening authorization expired.',
    });
    await f.controller.dispose();
    expect(f.state?.message).toBe('Media context closed.');
  });
  it('still reports the reason when an active transmission stops', async () => {
    const f = fixture();
    const opening = f.controller.startTransmit();
    f.microphone.resolve(f.mic);
    f.tx.resolve({ grant: f.grant, state: 'granted' });
    await opening;
    await f.controller.stopTransmit(
      'Transmission stopped at the 30-second limit.',
    );
    expect(f.state?.message).toBe(
      'Transmission stopped at the 30-second limit.',
    );
    await f.controller.dispose();
  });
  it('reports its control grant and releases a lease it created', async () => {
    const acquired: string[] = [];
    const f = fixture({
      control: {
        held: () => undefined,
        acquired: (grantId) => acquired.push(grantId),
      },
    });
    const opening = f.controller.startTransmit();
    f.microphone.resolve(f.mic);
    f.tx.resolve({ grant: f.grant, state: 'granted' });
    await opening;
    expect(acquired).toEqual([f.controlGrantId]);
    await f.controller.stopTransmit();
    const release = f.calls.find(
      (call) => call.path.endsWith('/control') && call.method === 'DELETE',
    );
    expect(release).toBeDefined();
    expect(JSON.parse(release!.body ?? '{}')).toEqual({
      controlGrant: f.controlGrantId,
      generation: 'control-generation',
    });
    await f.controller.dispose();
  });
  it('never releases the station lease it reused', async () => {
    let held: string | undefined;
    const f = fixture({ control: { held: () => held } });
    held = f.controlGrantId;
    const opening = f.controller.startTransmit();
    f.microphone.resolve(f.mic);
    f.tx.resolve({ grant: f.grant, state: 'granted' });
    await opening;
    await f.controller.stopTransmit();
    expect(
      f.calls.some(
        (call) => call.path.endsWith('/control') && call.method === 'DELETE',
      ),
    ).toBe(false);
    await f.controller.dispose();
  });
  it('keeps a lease the station adopted during transmission', async () => {
    let held: string | undefined;
    const f = fixture({ control: { held: () => held } });
    const opening = f.controller.startTransmit();
    f.microphone.resolve(f.mic);
    f.tx.resolve({ grant: f.grant, state: 'granted' });
    await opening;
    held = f.controlGrantId;
    await f.controller.stopTransmit();
    expect(
      f.calls.some(
        (call) => call.path.endsWith('/control') && call.method === 'DELETE',
      ),
    ).toBe(false);
    await f.controller.dispose();
  });
});
