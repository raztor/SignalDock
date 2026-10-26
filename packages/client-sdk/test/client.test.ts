import { describe, expect, it, vi } from 'vitest';
import {
  RecentServerStore,
  SignalDockClient,
  normalizeServerUrl,
  type RecentServerStorage,
} from '../src/index.js';
import type { ServerInfo } from '@signaldock/contracts';

function info(): ServerInfo {
  return {
    product: 'SignalDock',
    instanceId: crypto.randomUUID(),
    displayName: 'Test station',
    version: '0.1.0',
    protocol: { min: 1, max: 1 },
    identity: {
      algorithm: 'Ed25519',
      keyId: `sha256:${'a'.repeat(64)}`,
      publicKey: 'fixture-public-key',
    },
    routes: { api: 'api/v1', events: 'api/v1/events', media: 'api/v1/media' },
    features: {
      multiRadio: false,
      authentication: 'unavailable',
      radioControl: false,
      liveAudio: false,
      pushRelay: 'unavailable',
    },
  };
}
function memoryStorage(): RecentServerStorage {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
  };
}

describe('server discovery', () => {
  it('calls the browser fetch implementation with its required global receiver', async () => {
    const server = info();
    vi.stubGlobal('fetch', function (this: unknown) {
      if (this !== globalThis) throw new Error('Illegal invocation');
      return Promise.resolve(Response.json(server));
    });
    try {
      await expect(
        new SignalDockClient('https://station.example').discover(),
      ).resolves.toEqual(server);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('preserves a deployment prefix and sends no credentials', async () => {
    const server = info();
    let captured: RequestInit | undefined;
    let destination = '';
    const fetcher: typeof fetch = async (input, init) => {
      destination = String(input);
      captured = init;
      return Response.json(server);
    };
    await expect(
      new SignalDockClient(
        'https://RADIO.example/station/',
        fetcher,
      ).discover(),
    ).resolves.toEqual(server);
    expect(destination).toBe(
      'https://radio.example/station/api/v1/server-info',
    );
    expect(captured?.credentials).toBe('omit');
    expect(captured?.redirect).toBe('error');
    expect(captured?.headers).toEqual({ Accept: 'application/json' });
  });
  it.each([
    'https://user:password@example.com',
    'https://example.com?token=secret',
    'https://example.com#part',
    'http://example.com',
    'http://localhost.evil.example',
    'file:///tmp/server',
  ])('rejects unsafe server URL %s', (url) => {
    expect(() => normalizeServerUrl(url)).toThrow();
  });
  it('allows development loopback without losing its prefix', () => {
    expect(normalizeServerUrl('http://127.0.0.1:3000/radio')).toBe(
      'http://127.0.0.1:3000/radio/',
    );
  });
  it('rejects incompatible protocol versions', async () => {
    const server = info();
    server.protocol = { min: 2, max: 2 };
    const fetcher: typeof fetch = async () => Response.json(server);
    await expect(
      new SignalDockClient('https://station.example', fetcher).discover(),
    ).rejects.toMatchObject({ code: 'API_INCOMPATIBLE' });
  });
  it('rejects a changed identity at a saved address', async () => {
    const saved = info();
    const replaced = { ...saved, instanceId: crypto.randomUUID() };
    const fetcher: typeof fetch = async () => Response.json(replaced);
    await expect(
      new SignalDockClient('https://station.example', fetcher).discover({
        expected: saved,
      }),
    ).rejects.toMatchObject({ code: 'INSTANCE_IDENTITY_CHANGED' });
  });
});

describe('recent server persistence', () => {
  it('keeps simultaneous additions and removes one server without affecting another', async () => {
    const store = new RecentServerStore(memoryStorage());
    const a = info();
    const b = info();
    await Promise.all([
      store.remember('https://a.example', a),
      store.remember('https://b.example', b),
    ]);
    expect(await store.list()).toHaveLength(2);
    await store.remove('https://a.example');
    expect((await store.list()).map((server) => server.instanceId)).toEqual([
      b.instanceId,
    ]);
  });
  it('requires explicit removal before a remembered identity can be replaced', async () => {
    const store = new RecentServerStore(memoryStorage());
    await store.remember('https://a.example', info());
    await expect(
      store.remember('https://a.example', info()),
    ).rejects.toMatchObject({ code: 'INSTANCE_IDENTITY_CHANGED' });
    await store.remove('https://a.example');
    await store.remember('https://a.example', info());
    expect(await store.list()).toHaveLength(1);
  });
  it('discards malformed data containing unexpected credential fields', async () => {
    const storage = memoryStorage();
    await storage.setItem(
      'signaldock.recent-servers.v1',
      JSON.stringify([
        { baseUrl: 'https://a.example', password: 'not-a-session' },
      ]),
    );
    expect(await new RecentServerStore(storage).list()).toEqual([]);
  });
});
