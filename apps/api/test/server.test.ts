import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerInfoSchema } from '@signaldock/contracts';
import { SignalDockClient } from '@signaldock/client-sdk';
import { loadInstanceIdentity } from '../src/modules/instance/identity-store.js';
import { buildServer } from '../src/app/create-server.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'signaldock-identity-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('persistent instance identity', () => {
  it('preserves keys across concurrent initialization and restart', async () => {
    const path = await directory();
    const identities = await Promise.all(
      Array.from({ length: 4 }, () => loadInstanceIdentity(path)),
    );
    for (const identity of identities) expect(identity).toEqual(identities[0]);
    expect(await loadInstanceIdentity(path)).toEqual(identities[0]);
    expect((await stat(join(path, 'identity.json'))).mode & 0o777).toBe(0o600);
  });
  it('does not silently replace corrupted identity material', async () => {
    const path = await directory();
    await writeFile(join(path, 'identity.json'), '{corrupt');
    await expect(loadInstanceIdentity(path)).rejects.toThrow();
    expect(await readFile(join(path, 'identity.json'), 'utf8')).toBe(
      '{corrupt',
    );
  });
  it('rejects mismatched private/public keys', async () => {
    const a = await directory();
    const b = await directory();
    await loadInstanceIdentity(a);
    await loadInstanceIdentity(b);
    const storedA = JSON.parse(
      await readFile(join(a, 'identity.json'), 'utf8'),
    ) as Record<string, unknown>;
    const storedB = JSON.parse(
      await readFile(join(b, 'identity.json'), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      join(a, 'identity.json'),
      JSON.stringify({ ...storedA, privateKey: storedB['privateKey'] }),
    );
    await expect(loadInstanceIdentity(a)).rejects.toThrow('keys do not match');
  });
});

describe('discovery-only API', () => {
  it('supports prefixes end to end with the shared client and omits private keys', async () => {
    const identity = await loadInstanceIdentity(await directory());
    const app = await buildServer({ identity, basePath: '/station/north' });
    try {
      const fetcher: typeof fetch = async (input) => {
        const response = await app.inject({
          method: 'GET',
          url: new URL(String(input)).pathname,
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const info = await new SignalDockClient(
        'https://station.example/station/north',
        fetcher,
      ).discover();
      expect(ServerInfoSchema.parse(info).instanceId).toBe(identity.instanceId);
      expect(JSON.stringify(info)).not.toContain('PRIVATE KEY');
      expect(info.features).toMatchObject({
        radioControl: false,
        liveAudio: false,
        authentication: 'unavailable',
      });
      expect((await app.inject('/api/v1/server-info')).statusCode).toBe(404);
      expect(
        (await app.inject('/station/north/api/v1/health')).json(),
      ).toMatchObject({ status: 'ok' });
      expect(
        (await app.inject('/station/north/api/v1/radios')).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('allows only configured web origins and returns structured errors', async () => {
    const app = await buildServer({
      identity: await loadInstanceIdentity(await directory()),
      allowedOrigins: ['https://client.example'],
    });
    try {
      const allowed = await app.inject({
        url: '/api/v1/server-info',
        headers: { origin: 'https://client.example' },
      });
      const denied = await app.inject({
        url: '/api/v1/server-info',
        headers: { origin: 'https://other.example' },
      });
      expect(allowed.headers['access-control-allow-origin']).toBe(
        'https://client.example',
      );
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      expect(allowed.headers['cache-control']).toBe('no-store');
      const missing = await app.inject('/missing');
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        code: 'NOT_FOUND',
        correlationId: expect.any(String),
        retryable: false,
      });
    } finally {
      await app.close();
    }
  });
});
