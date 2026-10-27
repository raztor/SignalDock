import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerInfo, SessionTokens } from '@signaldock/contracts';
import { SessionController } from '../src/features/auth/session-controller';
import {
  createMemoryCredentialStore,
  type CredentialScope,
} from '../src/features/auth/credentials';

function info(name: string): ServerInfo {
  return {
    product: 'SignalDock',
    instanceId: crypto.randomUUID(),
    displayName: name,
    version: '0.1.0',
    protocol: { min: 1, max: 1 },
    identity: {
      algorithm: 'Ed25519',
      keyId: `sha256:${(name === 'a' ? 'a' : 'b').repeat(64)}`,
      publicKey: `${name}-public-key`,
    },
    routes: { api: 'api/v1', events: 'api/v1/events', media: 'api/v1/media' },
    features: {
      multiRadio: true,
      authentication: 'local',
      radioControl: false,
      liveAudio: false,
      pushRelay: 'unavailable',
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const a = { baseUrl: 'https://a.example/station/', info: info('a') };
  const b = { baseUrl: 'https://b.example/', info: info('b') };
  const userId = crypto.randomUUID();
  let count = 0;
  const calls: {
    station: typeof a;
    path: string;
    init: RequestInit | undefined;
    body: Record<string, string>;
  }[] = [];
  let intercept:
    | ((
        call: (typeof calls)[number],
      ) => Promise<Response | undefined> | Response | undefined)
    | undefined;
  const tokens = (station: typeof a, mode = 'token'): SessionTokens => ({
    accessToken: `${station.info.instanceId}.access.${++count}`,
    accessExpiresAt: new Date(Date.now() + 900000).toISOString(),
    ...(mode === 'cookie'
      ? { csrfToken: `${station.info.instanceId}.csrf` }
      : { refreshToken: `${station.info.instanceId}.refresh.${count}` }),
    user: {
      id: userId,
      username: 'same-user',
      role: 'operator',
      enabled: true,
      radioPermissions: [],
    },
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const station = url.origin === new URL(a.baseUrl).origin ? a : b;
    const path = url.pathname
      .slice(new URL(station.baseUrl).pathname.length)
      .replace(/^api\/v1\//, '');
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, string>)
      : {};
    const call = { station, path, init, body };
    calls.push(call);
    const overridden = await intercept?.(call);
    if (overridden) return overridden;
    if (path === 'server-info') return Response.json(station.info);
    if (path === 'auth/bootstrap') return Response.json({ required: false });
    if (path === 'auth/login')
      return Response.json(tokens(station, body.sessionMode));
    if (path === 'auth/refresh')
      return Response.json(
        tokens(
          station,
          init?.credentials === 'same-origin' ? 'cookie' : 'token',
        ),
      );
    if (path === 'auth/logout') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fixture route ${path}`);
  };
  return {
    a,
    b,
    calls,
    fetcher,
    tokens,
    scope: (station: typeof a): CredentialScope => ({
      baseUrl: station.baseUrl,
      instanceId: station.info.instanceId,
      keyId: station.info.identity.keyId,
      publicKey: station.info.identity.publicKey,
    }),
    intercept: (handler: typeof intercept) => {
      intercept = handler;
    },
  };
}
const controllers: SessionController[] = [];
function track(controller: SessionController) {
  controllers.push(controller);
  return controller;
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.restoreAllMocks();
});

describe('isolated instance sessions', () => {
  it('restores colliding usernames from their own URL, instance and identity scope', async () => {
    const f = fixture();
    const credentials = createMemoryCredentialStore();
    const cleanup = vi.fn();
    const controller = track(
      new SessionController({
        fetcher: f.fetcher,
        credentials,
        onContextChanging: cleanup,
      }),
    );
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'a-password');
    const aRefresh = (await credentials.get(f.scope(f.a)))!.refreshToken;
    await controller.selectServer(f.b.baseUrl, f.b.info);
    expect(controller.getSnapshot().session).toBeUndefined();
    await controller.signIn('same-user', 'b-password');
    const bRefresh = (await credentials.get(f.scope(f.b)))!.refreshToken;
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.restore();
    expect(controller.getSnapshot().session?.instanceId).toBe(
      f.a.info.instanceId,
    );
    const refresh = f.calls.find((call) => call.path === 'auth/refresh')!;
    expect(refresh.station).toBe(f.a);
    expect(refresh.body).toEqual({ refreshToken: aRefresh });
    expect(refresh.init?.credentials).toBe('omit');
    expect((await credentials.get(f.scope(f.b)))?.refreshToken).toBe(bRefresh);
    expect(cleanup).toHaveBeenCalledTimes(5);
  });
  it('discards a late login response after switching servers', async () => {
    const f = fixture();
    const pending = deferred<Response>();
    const entered = deferred<void>();
    const credentials = createMemoryCredentialStore();
    f.intercept((call) => {
      if (call.path === 'auth/login' && call.station === f.a) {
        entered.resolve();
        return pending.promise;
      }
      return undefined;
    });
    const controller = track(
      new SessionController({ fetcher: f.fetcher, credentials }),
    );
    await controller.selectServer(f.a.baseUrl, f.a.info);
    const old = controller.signIn('same-user', 'old-password');
    await entered.promise;
    await controller.selectServer(f.b.baseUrl, f.b.info);
    await controller.signIn('same-user', 'new-password');
    pending.resolve(Response.json(f.tokens(f.a)));
    await old;
    expect(controller.getSnapshot().session?.instanceId).toBe(
      f.b.info.instanceId,
    );
    expect(await credentials.get(f.scope(f.a))).toBeNull();
    expect(await credentials.get(f.scope(f.b))).not.toBeNull();
  });
  it('does not let an obsolete request invalidate a rotated access token', async () => {
    const f = fixture();
    const controller = track(new SessionController({ fetcher: f.fetcher }));
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    const old = controller.getSnapshot().session!;
    await controller.refresh();
    const current = controller.getSnapshot().session!;
    expect(current.accessToken).not.toBe(old.accessToken);
    old.onUnauthorized?.();
    expect(controller.getSnapshot().session).toBe(current);
    current.onUnauthorized?.();
    expect(controller.getSnapshot().status).toBe('signed_out');
  });
  it('rotates a refresh credential once for simultaneous consumers', async () => {
    const f = fixture();
    const controller = track(new SessionController({ fetcher: f.fetcher }));
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    const entered = deferred<void>();
    const pending = deferred<Response>();
    f.intercept((call) => {
      if (call.path === 'auth/refresh') {
        entered.resolve();
        return pending.promise;
      }
      return undefined;
    });
    const first = controller.refresh();
    const second = controller.refresh();
    await entered.promise;
    pending.resolve(Response.json(f.tokens(f.a)));
    await Promise.all([first, second]);
    expect(f.calls.filter((call) => call.path === 'auth/refresh')).toHaveLength(
      1,
    );
    expect(controller.getSnapshot().status).toBe('signed_in');
  });
  it('checks pinned identity before sending login or bootstrap secrets', async () => {
    const f = fixture();
    const controller = track(new SessionController({ fetcher: f.fetcher }));
    await controller.selectServer(f.a.baseUrl, f.a.info);
    f.intercept((call) =>
      call.path === 'server-info'
        ? Response.json({ ...f.a.info, instanceId: crypto.randomUUID() })
        : undefined,
    );
    await expect(
      controller.signIn('same-user', 'password'),
    ).rejects.toMatchObject({ code: 'INSTANCE_IDENTITY_CHANGED' });
    await expect(
      controller.bootstrap(
        'long-enough-setup-token-value',
        'same-user',
        'long-password-value',
      ),
    ).rejects.toMatchObject({ code: 'INSTANCE_IDENTITY_CHANGED' });
    expect(
      f.calls.filter(
        (call) =>
          call.path === 'auth/login' ||
          (call.path === 'auth/bootstrap' && call.init?.method === 'POST'),
      ),
    ).toHaveLength(0);
  });
  it('rejects refresh responses for another account without deleting another instance credential', async () => {
    const f = fixture();
    const credentials = createMemoryCredentialStore();
    const controller = track(
      new SessionController({ fetcher: f.fetcher, credentials }),
    );
    await controller.selectServer(f.b.baseUrl, f.b.info);
    await controller.signIn('same-user', 'password');
    const b = await credentials.get(f.scope(f.b));
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    f.intercept((call) => {
      if (call.path !== 'auth/refresh') return undefined;
      const response = f.tokens(f.a);
      response.user.id = crypto.randomUUID();
      return Response.json(response);
    });
    await expect(controller.refresh()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(controller.getSnapshot().status).toBe('signed_out');
    expect(await credentials.get(f.scope(f.a))).toBeNull();
    expect(await credentials.get(f.scope(f.b))).toEqual(b);
  });
  it('sends same-origin cookie refresh with a CSRF proof and keeps refresh tokens out of storage', async () => {
    const f = fixture();
    const credentials = createMemoryCredentialStore();
    const controller = track(
      new SessionController({
        fetcher: f.fetcher,
        credentials,
        modeForServer: () => 'cookie',
        readCsrfToken: () => `${f.a.info.instanceId}.csrf`,
      }),
    );
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    await controller.refresh();
    const refresh = f.calls.find((call) => call.path === 'auth/refresh')!;
    expect(refresh.body).toEqual({});
    expect(refresh.init?.credentials).toBe('same-origin');
    expect(new Headers(refresh.init?.headers).get('X-CSRF-Token')).toBe(
      `${f.a.info.instanceId}.csrf`,
    );
    expect(await credentials.get(f.scope(f.a))).toBeNull();
  });
  it('clears local state on offline logout without touching another server', async () => {
    const f = fixture();
    const credentials = createMemoryCredentialStore();
    const controller = track(
      new SessionController({ fetcher: f.fetcher, credentials }),
    );
    await controller.selectServer(f.b.baseUrl, f.b.info);
    await controller.signIn('same-user', 'password');
    const b = await credentials.get(f.scope(f.b));
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    f.intercept((call) => {
      if (call.path === 'auth/logout') throw new Error('offline');
      return undefined;
    });
    await expect(controller.signOut()).rejects.toThrow('offline');
    expect(controller.getSnapshot().session).toBeUndefined();
    expect(controller.getSnapshot().error).toContain('could not confirm');
    expect(await credentials.get(f.scope(f.a))).toBeNull();
    expect(await credentials.get(f.scope(f.b))).toEqual(b);
  });
  it('forgets an inactive instance while preserving the active account', async () => {
    const f = fixture();
    const credentials = createMemoryCredentialStore();
    const controller = track(
      new SessionController({ fetcher: f.fetcher, credentials }),
    );
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    const a = (await credentials.get(f.scope(f.a)))!;
    await controller.selectServer(f.b.baseUrl, f.b.info);
    await controller.signIn('same-user', 'password');
    const active = controller.getSnapshot().session;
    await controller.forgetServer({ baseUrl: f.a.baseUrl, ...f.a.info });
    expect(controller.getSnapshot().session).toBe(active);
    expect(await credentials.get(f.scope(f.a))).toBeNull();
    const logout = f.calls.find((call) => call.path === 'auth/logout')!;
    expect(logout.station).toBe(f.a);
    expect(logout.body).toEqual({ refreshToken: a.refreshToken });
  });
  it('does not disclose a forgotten refresh token after the URL changes identity', async () => {
    const f = fixture();
    const credentials = createMemoryCredentialStore();
    const controller = track(
      new SessionController({ fetcher: f.fetcher, credentials }),
    );
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    f.intercept((call) =>
      call.path === 'server-info'
        ? Response.json({ ...f.a.info, instanceId: crypto.randomUUID() })
        : undefined,
    );
    await expect(
      controller.forgetServer({ baseUrl: f.a.baseUrl, ...f.a.info }),
    ).rejects.toMatchObject({ code: 'INSTANCE_IDENTITY_CHANGED' });
    expect(await credentials.get(f.scope(f.a))).toBeNull();
    expect(f.calls.filter((call) => call.path === 'auth/logout')).toHaveLength(
      0,
    );
  });
  it('does not let a delayed logout delete a newly signed-in account', async () => {
    const f = fixture();
    const store = createMemoryCredentialStore();
    let delay = false;
    const entered = deferred<void>();
    const pending = deferred<void>();
    const credentials = {
      ...store,
      get: async (scope: CredentialScope) => {
        if (delay) {
          delay = false;
          entered.resolve();
          await pending.promise;
        }
        return store.get(scope);
      },
    };
    const controller = track(
      new SessionController({ fetcher: f.fetcher, credentials }),
    );
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    delay = true;
    const oldLogout = controller.signOut();
    await entered.promise;
    await controller.signIn('same-user', 'new-password');
    const current = controller.getSnapshot().session;
    const saved = await store.get(f.scope(f.a));
    pending.resolve();
    await oldLogout;
    expect(controller.getSnapshot().session).toBe(current);
    expect(await store.get(f.scope(f.a))).toEqual(saved);
    expect(f.calls.filter((call) => call.path === 'auth/logout')).toHaveLength(
      0,
    );
  });
  it('does not restore a refresh credential under a different pinned key', async () => {
    const f = fixture();
    const credentials = createMemoryCredentialStore();
    const controller = track(
      new SessionController({ fetcher: f.fetcher, credentials }),
    );
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.signIn('same-user', 'password');
    const oldScope = f.scope(f.a);
    f.a.info = {
      ...f.a.info,
      identity: {
        ...f.a.info.identity,
        publicKey: 'replacement-public-key',
        keyId: `sha256:${'c'.repeat(64)}`,
      },
    };
    await controller.selectServer(f.a.baseUrl, f.a.info);
    await controller.restore();
    expect(controller.getSnapshot().session).toBeUndefined();
    expect(f.calls.filter((call) => call.path === 'auth/refresh')).toHaveLength(
      0,
    );
    expect(await credentials.get(oldScope)).not.toBeNull();
  });
  it('conditional deletion preserves a newer credential for the same instance', async () => {
    const f = fixture();
    const credentials = createMemoryCredentialStore();
    const scope = f.scope(f.a);
    await credentials.set({ scope, userId: 'user', refreshToken: 'old' });
    await credentials.set({ scope, userId: 'user', refreshToken: 'new' });
    await credentials.delete(scope, 'old');
    expect((await credentials.get(scope))?.refreshToken).toBe('new');
  });
});
