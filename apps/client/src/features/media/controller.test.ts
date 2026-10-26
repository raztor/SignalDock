import { describe, expect, it } from 'vitest';
import type {
  ClientSession,
  MediaSession,
  TxGrant,
} from '@signaldock/contracts';
import {
  RadioMediaController,
  stopActiveMedia,
  type BrowserMediaPort,
  type MediaUiState,
} from './controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const radioId = crypto.randomUUID(),
    instanceId = crypto.randomUUID(),
    userId = crypto.randomUUID();
  let session = {
    instanceId,
    baseUrl: 'https://one.example/',
    accessToken: 'private',
    user: { id: userId },
  } as ClientSession;
  const calls: { session: ClientSession; path: string; method: string }[] = [];
  let stopped = 0,
    published = 0;
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
    connect: async () => ({
      disconnect: async () => undefined,
      publish: async () => {
        published++;
      },
    }),
  };
  const controller = new RadioMediaController({
    session: () => session,
    radioId,
    port,
    onState: (value) => {
      state = value;
    },
    request: async <T>(
      context: ClientSession,
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push({ session: context, path, method: init?.method ?? 'GET' });
      if (path.endsWith('/state'))
        return { generation: crypto.randomUUID(), revision: 4 } as T;
      if (path.endsWith('/control'))
        return {
          grantId: crypto.randomUUID(),
          generation: crypto.randomUUID(),
        } as T;
      if (path.endsWith('/tx-sessions') && init?.method === 'POST')
        return (await tx.promise) as T;
      return {
        id: crypto.randomUUID(),
        instanceId,
        radioId,
        mode: 'listen',
      } as MediaSession as T;
    },
  });
  return {
    controller,
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
