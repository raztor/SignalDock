import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresDatabase } from '@signaldock/database';
import {
  SessionTokensSchema,
  type ControlLease,
  type RadioView,
  type RadioPermissionGrant,
} from '@signaldock/contracts';
import { createStation } from '../src/app/station.js';
import { loadInstanceIdentity } from '../src/modules/instance/identity-store.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('composed operational station on PostgreSQL', () => {
  const schema = `sd_station_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: url });
  let directory: string;
  let database: PostgresDatabase;
  const stations: Awaited<ReturnType<typeof createStation>>[] = [];
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    directory = await mkdtemp(join(tmpdir(), 'signaldock-station-'));
    database = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
  });
  afterAll(async () => {
    await Promise.all(stations.map((station) => station.server.close()));
    await database?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  it('isolates instances, composes permissions/control/capture/playback, and preserves identity after restart', async () => {
    async function open(name: string) {
      const dataDirectory = join(directory, name);
      const identity = await loadInstanceIdentity(dataDirectory);
      const station = await createStation({
        identity,
        dataDirectory,
        database,
        connectionString: url!,
        basePath: '/station',
        startJobs: false,
      });
      stations.push(station);
      return station;
    }
    const first = await open('first');
    const second = await open('second');
    const prefix = '/station/api/v1';
    for (const station of [first, second]) {
      const discovery = await station.server.inject(`${prefix}/server-info`);
      expect(discovery.json().features).toMatchObject({
        authentication: 'local',
        multiRadio: true,
        liveAudio: false,
      });
      expect(
        (await station.server.inject('/api/v1/server-info')).statusCode,
      ).toBe(404);
      const setup = await station.server.inject({
        method: 'POST',
        url: `${prefix}/auth/bootstrap`,
        payload: {
          setupToken: station.secrets.setupToken,
          username: 'admin',
          password: 'Station-test-password-2026!',
        },
      });
      expect(setup.statusCode).toBe(201);
    }
    async function login(station: typeof first, username = 'admin') {
      const response = await station.server.inject({
        method: 'POST',
        url: `${prefix}/auth/login`,
        payload: {
          username,
          password: 'Station-test-password-2026!',
          sessionMode: 'token',
        },
      });
      expect(response.statusCode).toBe(200);
      return SessionTokensSchema.parse(response.json());
    }
    const tokens = await login(first);
    const other = await login(second);
    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    expect(
      (await second.server.inject({ url: `${prefix}/me`, headers })).statusCode,
    ).toBe(401);
    expect(tokens.user.id).not.toBe(other.user.id);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, radioId] of ids.entries()) {
      const response = await first.server.inject({
        method: 'POST',
        url: `${prefix}/radios`,
        headers,
        payload: {
          radioId,
          displayName: `Independent radio ${index + 1}`,
          driverId: 'simulator.tunable',
          resourceGroupIds: [],
          enabled: true,
          config: {},
        },
      });
      expect(response.statusCode).toBe(201);
    }
    expect(
      (await first.server.inject({ url: `${prefix}/radios`, headers })).json(),
    ).toEqual([]);
    // Configuration privileges deliberately confer no operating grant, including for administrators.
    expect(
      (
        await first.server.inject({
          method: 'POST',
          url: `${prefix}/radios/${ids[0]}/control`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    const permissions: RadioPermissionGrant[] = ids.map((radioId) => ({
      radioId,
      permissions: [
        'radio.listen',
        'radio.control',
        'history.read',
        'history.write',
        'recording.export',
      ],
    }));
    const principal = await first.auth.authenticate(tokens.accessToken);
    await first.auth.createUser(principal, {
      username: 'operator',
      password: 'Station-test-password-2026!',
      role: 'operator',
      radioPermissions: permissions,
    });
    await first.auth.createUser(principal, {
      username: 'competing',
      password: 'Station-test-password-2026!',
      role: 'operator',
      radioPermissions: permissions,
    });
    const operator = await login(first, 'operator');
    const competitor = await login(first, 'competing');
    const operationHeaders = {
      authorization: `Bearer ${operator.accessToken}`,
    };
    const views = (
      await first.server.inject({
        url: `${prefix}/radios`,
        headers: operationHeaders,
      })
    ).json() as RadioView[];
    expect(views).toHaveLength(2);
    const grantResponse = await first.server.inject({
      method: 'POST',
      url: `${prefix}/radios/${ids[0]}/control`,
      headers: operationHeaders,
    });
    expect(grantResponse.statusCode).toBe(201);
    const grant = grantResponse.json() as ControlLease;
    expect(
      (
        await first.server.inject({
          method: 'POST',
          url: `${prefix}/radios/${ids[0]}/control`,
          headers: { authorization: `Bearer ${competitor.accessToken}` },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await first.server.inject({
          method: 'POST',
          url: `${prefix}/radios/${ids[1]}/control`,
          headers: { authorization: `Bearer ${competitor.accessToken}` },
        })
      ).statusCode,
    ).toBe(201);
    const before = first.radios.runtime.snapshot(ids[0]!);
    const operation = {
      context: {
        operationId: crypto.randomUUID(),
        radioId: ids[0],
        generation: before.generation,
        expectedRevision: before.revision,
        controlGrant: grant.grantId,
        deadline: new Date(Date.now() + 10000).toISOString(),
      },
      tuning: { rxHz: 147540000, mode: 'FM' },
    };
    const tunedResponse = await first.server.inject({
      method: 'POST',
      url: `${prefix}/radios/${ids[0]}/operations`,
      headers: operationHeaders,
      payload: operation,
    });
    expect(tunedResponse.statusCode).toBe(200);
    const tuned = first.radios.runtime.snapshot(ids[0]!);
    expect(tuned.observedTuning?.rxHz).toBe(147540000);
    expect(
      first.radios.runtime.snapshot(ids[1]!).observedTuning?.rxHz,
    ).not.toBe(147540000);
    expect(
      (
        await first.server.inject({
          method: 'POST',
          url: `${prefix}/radios/${ids[0]}/operations`,
          headers: operationHeaders,
          payload: {
            ...operation,
            context: { ...operation.context, operationId: crypto.randomUUID() },
          },
        })
      ).statusCode,
    ).toBe(409);
    const data = Buffer.alloc(3200);
    for (let i = 0; i < data.length; i += 2)
      data.writeInt16LE(Math.round(Math.sin(i / 20) * 5000), i);
    first.recorder.push(
      {
        streamId: crypto.randomUUID(),
        sequence: 0,
        mediaTimeUs: 0,
        format: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
        data,
        tuningRevision: tuned.revision,
        attributionConfidence: 'confirmed',
        discontinuity: false,
        endOfBurst: true,
      },
      {
        instanceId: principal.instanceId,
        radioId: ids[0]!,
        generation: tuned.generation,
        direction: 'rx',
        tuningRevision: tuned.revision,
        frequencyHz: 147540000,
        attributionConfidence: 'confirmed',
      },
    );
    await first.recorder.flush();
    const communication = (
      await first.history.list(principal.instanceId, { radioId: ids[0]! })
    ).items.at(0)!;
    expect(communication.frequencyHz).toBe(147540000);
    expect(communication.context['generation']).toBe(tuned.generation);
    expect(communication.recording?.state).toBe('available');
    const audio = await first.server.inject({
      url: `${prefix}/recordings/${communication.recording!.id}`,
      headers: { ...operationHeaders, range: 'bytes=0-43' },
    });
    expect(audio.statusCode).toBe(206);
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect(
      (
        await second.server.inject({
          url: `${prefix}/communications/${communication.id}`,
          headers: { authorization: `Bearer ${other.accessToken}` },
        })
      ).statusCode,
    ).toBe(404);
    const loggedOut = await first.server.inject({
      method: 'POST',
      url: `${prefix}/auth/logout`,
      headers: operationHeaders,
    });
    expect(loggedOut.statusCode).toBe(204);
    expect(first.radios.runtime.currentControl(ids[0]!)).toBeNull();
    expect(
      (
        await first.server.inject({
          url: `${prefix}/radios`,
          headers: operationHeaders,
        })
      ).statusCode,
    ).toBe(401);
    const oldInstanceId = principal.instanceId;
    const oldSetupToken = first.secrets.setupToken;
    await first.server.close();
    stations.splice(stations.indexOf(first), 1);
    const restarted = await open('first');
    expect(restarted.secrets.setupToken).toBe(oldSetupToken);
    expect(
      (await restarted.server.inject(`${prefix}/server-info`)).json()
        .instanceId,
    ).toBe(oldInstanceId);
    expect(restarted.radios.runtime.currentControl(ids[0]!)).toBeNull();
    expect(
      (await restarted.history.get(oldInstanceId, communication.id))?.recording
        ?.state,
    ).toBe('available');
  }, 20000);
});
