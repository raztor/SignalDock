import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresDatabase } from '@signaldock/database';
import {
  InstalledDriverSchema,
  SessionTokensSchema,
} from '@signaldock/contracts';
import { createStation } from '../src/app/station.js';
import { loadInstanceIdentity } from '../src/modules/instance/identity-store.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('composed station installed drivers', () => {
  const schema = `sd_drivers_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: url });
  let directory: string;
  let database: PostgresDatabase;
  let station: Awaited<ReturnType<typeof createStation>> | undefined;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    directory = await mkdtemp(join(tmpdir(), 'signaldock-drivers-'));
    database = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
  });
  afterAll(async () => {
    await station?.server.close();
    await database?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  it('lists the simulators and the registered gRPC driver to administrators only', async () => {
    const dataDirectory = join(directory, 'station');
    station = await createStation({
      identity: await loadInstanceIdentity(dataDirectory),
      dataDirectory,
      database,
      connectionString: url!,
      startJobs: false,
      startRadios: false,
      listenForEvents: false,
      driverCredentials: new Map([['bench', 'never-exposed-token']]),
    });
    const prefix = '/api/v1';
    const password = 'Station-test-password-2026!';
    expect(
      (
        await station.server.inject({
          method: 'POST',
          url: `${prefix}/auth/bootstrap`,
          payload: {
            setupToken: station.secrets.setupToken,
            username: 'admin',
            password,
          },
        })
      ).statusCode,
    ).toBe(201);
    const login = async (username: string) => {
      const response = await station!.server.inject({
        method: 'POST',
        url: `${prefix}/auth/login`,
        payload: { username, password, sessionMode: 'token' },
      });
      expect(response.statusCode).toBe(200);
      return {
        authorization: `Bearer ${SessionTokensSchema.parse(response.json()).accessToken}`,
      };
    };
    const headers = await login('admin');
    expect(
      (await station.server.inject({ url: `${prefix}/radios/drivers` }))
        .statusCode,
    ).toBe(401);
    const response = await station.server.inject({
      url: `${prefix}/radios/drivers`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('never-exposed-token');
    const drivers = (response.json() as unknown[]).map((entry) =>
      InstalledDriverSchema.parse(entry),
    );
    expect(drivers.map((driver) => driver.driverId)).toEqual([
      'simulator.tunable',
      'simulator.receiver',
      'vgc-benlink',
    ]);
    expect(drivers[2]).toMatchObject({
      transport: 'grpc',
      requiresEndpoint: true,
      verification: 'experimental',
      configSchema: {
        type: 'object',
        properties: {
          credentialRef: { 'x-credential-ref': true },
          connectTimeoutMs: { type: 'integer' },
        },
      },
    });

    const created = await station.server.inject({
      method: 'POST',
      url: `${prefix}/admin/users`,
      headers,
      payload: {
        username: 'operator',
        password,
        role: 'operator',
        radioPermissions: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const operator = await login('operator');
    expect(
      (
        await station.server.inject({
          url: `${prefix}/radios/drivers`,
          headers: operator,
        })
      ).statusCode,
    ).toBe(403);
  });
});
