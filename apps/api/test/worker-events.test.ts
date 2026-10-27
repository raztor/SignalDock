import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@signaldock/contracts';
import { createStation } from '../src/app/station.js';
import { loadInstanceIdentity } from '../src/modules/instance/identity-store.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
describe.skipIf(!databaseUrl)('API and standalone-worker event fanout', () => {
  const schema = `sd_worker_events_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: databaseUrl });
  let station: Awaited<ReturnType<typeof createStation>>;
  let directory: string;
  let connectionString: string;
  let baseUrl: string;
  let worker: ChildProcess | undefined;
  let workerExit: Promise<void> | undefined;
  let workerOutput = '';
  let workerFailure: Error | undefined;
  const stream = new AbortController();

  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 12000;
    while (!(await check())) {
      if (workerFailure) throw workerFailure;
      if (Date.now() > deadline)
        throw new Error('Cross-process event acceptance timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    directory = await mkdtemp(join(tmpdir(), 'sd-worker-events-'));
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    connectionString = url.href;
    station = await createStation({
      identity: await loadInstanceIdentity(directory),
      dataDirectory: directory,
      connectionString,
      startJobs: false,
      startRadios: false,
    });
    baseUrl = await station.server.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    stream.abort();
    if (worker && worker.exitCode === null) worker.kill('SIGTERM');
    const timeout = setTimeout(() => worker?.kill('SIGKILL'), 10000);
    await workerExit;
    clearTimeout(timeout);
    await station?.server.close();
    if (station)
      await admin.query(
        `DROP SCHEMA IF EXISTS sd_queue_${station.auth.instanceId.replaceAll('-', '')} CASCADE`,
      );
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('delivers worker-committed refresh events to API clients with current radio scopes', async () => {
    const password = randomUUID() + randomUUID();
    const user = await station.auth.bootstrap({
      setupToken: station.secrets.setupToken,
      username: 'event-admin',
      password,
    });
    let login = await station.auth.login({
      username: user.username,
      password,
      sessionMode: 'token',
    });
    const allowedRadio = randomUUID(),
      hiddenRadio = randomUUID();
    await station.auth.updateUser(
      await station.auth.authenticate(login.accessToken),
      user.id,
      {
        radioPermissions: [
          {
            radioId: allowedRadio,
            permissions: [
              'history.read',
              'history.write',
              'radio.listen',
              'notifications.read',
            ],
          },
        ],
      },
    );
    login = await station.auth.login({
      username: user.username,
      password,
      sessionMode: 'token',
    });
    const response = await fetch(baseUrl + '/api/v1/events', {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        Accept: 'text/event-stream',
      },
      signal: stream.signal,
    });
    expect(response.status).toBe(200);
    const seen: DomainEvent[] = [];
    let expectedId: string | undefined;
    const reader = response.body!.getReader();
    const received = (async () => {
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error('API event stream ended before worker publication.');
        pending += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = frame
            .split('\n')
            .find((line) => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)) as DomainEvent;
          seen.push(event);
        }
      }
    })();
    void received.catch(() => undefined);
    worker = spawn(process.execPath, ['apps/api/dist/worker.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SIGNALDOCK_RELAY_URL: '',
        LIVEKIT_URL: '',
        DATABASE_URL: connectionString,
        SIGNALDOCK_DATA_DIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout!.on('data', (data) => {
      workerOutput += String(data);
    });
    worker.stderr!.on('data', (data) => {
      workerOutput += String(data);
    });
    worker.on('error', (error) => {
      workerFailure = error;
    });
    workerExit = new Promise((resolve) =>
      worker!.once('exit', () => resolve()),
    );
    await until(async () => workerOutput.includes('background worker started'));
    const hidden = await station.history.ingest({
      id: randomUUID(),
      instanceId: station.auth.instanceId,
      radioId: hiddenRadio,
      kind: 'note',
      direction: 'internal',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      context: {},
    });
    await until(
      async () =>
        Number(
          (
            await station.database.query<{ count: string }>(
              "SELECT count(*) FROM sd_event_outbox WHERE instance_id=$1 AND type='communication.created' AND payload->>'communicationId'=$2 AND delivered_at IS NOT NULL",
              [station.auth.instanceId, hidden.id],
            )
          ).rows[0]!.count,
        ) === 1,
    );
    // The permitted event uses the authenticated API; the worker owns all outbox draining.
    const note = await station.server.inject({
      method: 'POST',
      url: '/api/v1/communications/notes',
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: {
        radioId: allowedRadio,
        text: 'Standalone worker event fixture.',
      },
    });
    expect(note.statusCode).toBe(201);
    expectedId = note.json<{ id: string }>().id;
    let event: DomainEvent;
    try {
      await until(async () =>
        seen.some(
          (item) =>
            item.type === 'communication.created' &&
            item.payload &&
            typeof item.payload === 'object' &&
            'communicationId' in item.payload &&
            item.payload.communicationId === expectedId,
        ),
      );
      event = seen.find(
        (item) =>
          item.type === 'communication.created' &&
          item.payload &&
          typeof item.payload === 'object' &&
          'communicationId' in item.payload &&
          item.payload.communicationId === expectedId,
      )!;
    } finally {
      await reader.cancel();
      await received.catch(() => undefined);
      reader.releaseLock();
    }
    expect(event.instanceId).toBe(station.auth.instanceId);
    expect(event.radioId).toBe(allowedRadio);
    expect(seen.some((item) => item.radioId === hiddenRadio)).toBe(false);
  }, 25000);
});
