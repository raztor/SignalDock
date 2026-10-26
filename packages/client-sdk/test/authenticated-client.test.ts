import { afterEach, expect, it, vi } from 'vitest';
import type { ClientSession } from '@signaldock/contracts';
import { apiFetch, apiRequest } from '../src/index.js';

const session: ClientSession = {
  baseUrl: 'https://station.example/prefix/',
  instanceId: crypto.randomUUID(),
  accessToken: 'only-this-instance',
  user: {
    id: crypto.randomUUID(),
    username: 'operator',
    role: 'operator',
    enabled: true,
    radioPermissions: [],
  },
};
afterEach(() => vi.unstubAllGlobals());
it('keeps bearer credentials on the selected prefixed API and disables redirect forwarding', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.href).toBe('https://station.example/prefix/api/v1/radios');
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer only-this-instance',
      );
      expect(init.redirect).toBe('error');
      expect(init.credentials).toBe('omit');
      return Response.json({ items: [] });
    }),
  );
  expect(await apiRequest(session, 'radios')).toEqual({ items: [] });
});
it.each([
  '../auth',
  'https://other.example/api',
  '/api/v1/radios',
  'radios/%2e%2e/auth',
])('rejects escaping route %s before fetching', async (path) => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(apiRequest(session, path)).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('supports authorized binary reads and scoped unauthorized callbacks', async () => {
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));
  expect(
    new Uint8Array(
      await (await apiFetch(session, 'recordings/fixture')).arrayBuffer(),
    ),
  ).toEqual(new Uint8Array([1, 2, 3]));
  const unauthorized = vi.fn();
  vi.stubGlobal('fetch', async () =>
    Response.json(
      {
        code: 'UNAUTHORIZED',
        message: 'Expired.',
        correlationId: 'fixture',
        retryable: false,
      },
      { status: 401 },
    ),
  );
  await expect(
    apiRequest({ ...session, onUnauthorized: unauthorized }, 'me'),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(unauthorized).toHaveBeenCalledOnce();
});
