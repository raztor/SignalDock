import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStation } from '../src/app/station.js';
import { loadInstanceIdentity } from '../src/modules/instance/identity-store.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('composed local processing, outbox and retention', () => {
  const schema = `sd_extensions_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: url });
  let directory: string;
  let station: Awaited<ReturnType<typeof createStation>>;
  let instanceId: string;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    directory = await mkdtemp(join(tmpdir(), 'signaldock-extensions-'));
    const connection = new URL(url!);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    const identity = await loadInstanceIdentity(directory);
    instanceId = identity.instanceId;
    station = await createStation({
      identity,
      dataDirectory: directory,
      connectionString: connection.href,
      startRadios: false,
    });
  });
  afterAll(async () => {
    await station?.server.close();
    await admin.query(
      `DROP SCHEMA IF EXISTS sd_queue_${instanceId?.replaceAll('-', '')} CASCADE`,
    );
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 12000;
    while (!(await check())) {
      if (Date.now() > deadline)
        throw new Error('Composed background workflow did not settle.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  it('executes a local provider through real jobs, persists analysis and removes copied source data', async () => {
    const password = crypto.randomUUID() + crypto.randomUUID();
    const user = await station.auth.bootstrap({
      setupToken: station.secrets.setupToken,
      username: 'operator-admin',
      password,
    });
    const first = await station.auth.login({
      username: user.username,
      password,
      sessionMode: 'token',
    });
    let actor = await station.auth.authenticate(first.accessToken);
    const radioId = crypto.randomUUID();
    await station.auth.updateUser(actor, actor.userId, {
      radioPermissions: [
        {
          radioId,
          permissions: [
            'radio.listen',
            'history.read',
            'history.write',
            'incident.read',
            'incident.manage',
            'aprs.read',
          ],
        },
      ],
    });
    actor = await station.auth.authenticate(
      (
        await station.auth.login({
          username: user.username,
          password,
          sessionMode: 'token',
        })
      ).accessToken,
    );
    const communication = await station.history.ingest({
      id: crypto.randomUUID(),
      instanceId,
      radioId,
      kind: 'note',
      direction: 'internal',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      frequencyHz: 147540000,
      frequencyAttribution: 'confirmed',
      context: {},
    });
    const text = 'Test station N0CALL reports a clear local connection.';
    const transcript = await station.history.appendTranscript(
      instanceId,
      communication.id,
      {
        text,
        source: 'human',
        provenance: { fixture: true },
        expectedRevision: communication.revision,
      },
    );
    await station.extensions.drain();
    await until(
      async () =>
        Number(
          (
            await station.database.query<{ count: string }>(
              'SELECT count(*) AS count FROM sd_analysis_results WHERE instance_id=$1 AND communication_id=$2',
              [instanceId, communication.id],
            )
          ).rows[0]!.count,
        ) >= 3,
    );
    const connection = await station.extensions.processing.createConnection(
      actor,
      {
        connectorId: 'local.analysis',
        displayName: 'Local analysis fixture',
        endpoint: 'https://local.invalid',
        capabilities: ['text.structured'],
      },
    );
    const profileId = crypto.randomUUID();
    await station.extensions.processing.saveProfile(actor, {
      profileId,
      revision: 1,
      connectionId: connection.connection.connectionId,
      capability: 'text.structured',
      model: 'local-rules',
      allowCloud: false,
      task: 'conversation.summarize',
    });
    const source = (await station.history.get(instanceId, communication.id))!;
    const jobId = crypto.randomUUID();
    await station.extensions.processing.enqueue(
      actor,
      {
        instanceId,
        jobId,
        profileId,
        profileRevision: 1,
        task: 'conversation.summarize',
        taskVersion: 1,
        deadline: new Date(Date.now() + 60000).toISOString(),
        input: { kind: 'text', text, communicationIds: [communication.id] },
      },
      'local-provider-composition',
      radioId,
      {
        communicationId: communication.id,
        communicationRevision: source.revision,
        transcriptRevisionId: transcript.id,
      },
    );
    await until(
      async () =>
        (await station.queue.get(instanceId, jobId))?.state === 'completed',
    );
    const result = (await station.extensions.processing.jobs(actor)).find(
      (job) => job.jobId === jobId,
    );
    expect(result?.result?.connectorId).toBe('local.analysis');
    const persisted = await station.database.query<{
      id: string;
      connector_id: string;
    }>(
      'SELECT id,connector_id FROM sd_analysis_results WHERE instance_id=$1 AND id=$2',
      [instanceId, jobId],
    );
    expect(persisted.rows).toEqual([
      { id: jobId, connector_id: 'local.analysis' },
    ]);
    const notifications = await station.extensions.notifications.list(actor);
    expect(
      notifications.items.some((record) => record.category === 'communication'),
    ).toBe(true);
    await station.history.delete(instanceId, communication.id, actor.userId);
    expect(await station.extensions.processing.jobs(actor)).toEqual([]);
    expect(
      (
        await station.database.query(
          'SELECT id FROM sd_analysis_results WHERE instance_id=$1 AND communication_id=$2',
          [instanceId, communication.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await station.database.query<{ result: unknown }>(
          'SELECT result FROM sd_jobs WHERE instance_id=$1 AND id=$2',
          [instanceId, jobId],
        )
      ).rows[0]?.result,
    ).toBeNull();
  }, 20000);
});
