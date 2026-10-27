import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStation } from '../src/app/station.js';
import { loadInstanceIdentity } from '../src/modules/instance/identity-store.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)(
  'administrator history lists with real identity authorization',
  () => {
    const schema = `sd_history_acl_${randomUUID().replaceAll('-', '')}`;
    const maintenance = new Client({ connectionString: url });
    let station: Awaited<ReturnType<typeof createStation>>;
    let directory: string;
    beforeAll(async () => {
      await maintenance.connect();
      await maintenance.query(`CREATE SCHEMA ${schema}`);
      directory = await mkdtemp(join(tmpdir(), 'sd-history-acl-'));
      const connection = new URL(url!);
      connection.searchParams.set('options', `-c search_path=${schema}`);
      station = await createStation({
        identity: await loadInstanceIdentity(directory),
        dataDirectory: directory,
        connectionString: connection.href,
        startJobs: false,
      });
    });
    afterAll(async () => {
      await station?.server.close();
      await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await maintenance.end();
      await rm(directory, { recursive: true, force: true });
    });
    it('requires explicit radio grants for lists, conversations and details, including administrators', async () => {
      const password = randomUUID() + randomUUID();
      const user = await station.auth.bootstrap({
        setupToken: station.secrets.setupToken,
        username: 'history-admin',
        password,
      });
      const login = () =>
        station.auth.login({
          username: user.username,
          password,
          sessionMode: 'token',
        });
      let tokens = await login();
      const [allowed, hidden] = [randomUUID(), randomUUID()];
      const communications = [];
      for (const radioId of [allowed, hidden])
        communications.push(
          await station.history.ingest({
            id: randomUUID(),
            instanceId: station.auth.instanceId,
            radioId,
            kind: 'note',
            direction: 'internal',
            frequencyHz: 147540000,
            frequencyAttribution: 'confirmed',
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            context: {},
          }),
        );
      const get = (path: string) =>
        station.server.inject({
          method: 'GET',
          url: '/api/v1/' + path,
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        });
      for (const path of ['communications', 'conversations']) {
        const response = await get(path);
        expect(response.statusCode).toBe(200);
        expect(response.json().items).toEqual([]);
      }
      expect(
        (await get('communications/' + communications[0]!.id)).statusCode,
      ).toBe(403);
      await station.auth.updateUser(
        await station.auth.authenticate(tokens.accessToken),
        user.id,
        {
          radioPermissions: [
            { radioId: allowed, permissions: ['history.read'] },
          ],
        },
      );
      tokens = await login();
      for (const path of ['communications', 'conversations']) {
        const response = await get(path);
        expect(response.statusCode).toBe(200);
        expect(
          response
            .json<{ items: { radioId: string }[] }>()
            .items.map((item) => item.radioId),
        ).toEqual([allowed]);
      }
      expect(
        (await get('communications/' + communications[0]!.id)).statusCode,
      ).toBe(200);
      expect(
        (await get('communications/' + communications[1]!.id)).statusCode,
      ).toBe(403);
      expect((await get('communications?radioId=' + hidden)).statusCode).toBe(
        403,
      );
    });
  },
);
