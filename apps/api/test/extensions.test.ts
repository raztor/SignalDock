import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStation } from '../src/app/station.js';
import { PostgresDigitalRepository } from '../src/modules/aprs/repository.js';
import { loadInstanceIdentity } from '../src/modules/instance/identity-store.js';

function recordingFixture() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(4, 40);
  return bytes;
}

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
    const bytes = recordingFixture();
    const communication = await station.history.ingest(
      {
        id: crypto.randomUUID(),
        instanceId,
        radioId,
        kind: 'received_voice',
        direction: 'rx',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        frequencyHz: 147540000,
        frequencyAttribution: 'confirmed',
        context: {},
      },
      { bytes, contentType: 'audio/wav' },
    );
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
    await station.extensions.notifications.updatePreferences(actor, {
      ...(await station.extensions.notifications.preferences(actor)),
      categories: ['incident'],
      frequencyHz: 147540000,
      cooldownSeconds: 0,
    });
    await station.extensions.incidents.saveRule(actor, {
      id: crypto.randomUUID(),
      name: 'Emergency fixture',
      enabled: true,
      phrases: ['MAYDAY'],
      priority: 'critical',
      radioIds: [radioId],
    });
    const emergency = await station.history.ingest({
      id: crypto.randomUUID(),
      instanceId,
      radioId,
      kind: 'note',
      direction: 'internal',
      frequencyHz: 147540000,
      frequencyAttribution: 'confirmed',
      context: {},
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    await station.history.appendTranscript(instanceId, emergency.id, {
      text: 'MAYDAY from N0CALL',
      source: 'human',
      provenance: { fixture: true },
      expectedRevision: emergency.revision,
    });
    await until(async () =>
      (await station.extensions.notifications.list(actor)).items.some(
        (record) =>
          record.category === 'incident' && record.radioId === radioId,
      ),
    );
    const digital = new PostgresDigitalRepository(station.database);
    const packetId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    await digital.ingest(
      {
        instanceId,
        radioId,
        packetId,
        receivedAt,
        source: 'recording',
        attribution: 'confirmed',
        parserVersion: 'fixture-v1',
        path: [],
        kind: 'position',
        callsign: 'N0CALL',
        parsed: {
          recording: { artifactId: communication.recording!.artifactId },
        },
        position: {
          positionId: crypto.randomUUID(),
          packetId,
          instanceId,
          radioId,
          receivedAt,
          source: 'recording',
          callsign: 'N0CALL',
          lat: 0,
          lon: 0,
        },
      },
      'retention-fixture',
    );
    await station.history.applyRetention(instanceId, {
      transcriptsBefore: new Date(Date.now() + 1000).toISOString(),
    });
    expect(
      (await station.history.get(instanceId, communication.id))?.transcripts,
    ).toEqual([]);
    expect(
      (
        await station.history.readRecording(
          instanceId,
          communication.recording!.id,
        )
      ).bytes,
    ).toEqual(bytes);
    expect(await digital.packet(instanceId, packetId)).not.toBeNull();
    expect(
      (
        await digital.positions({ instanceId, radioIds: [radioId], limit: 10 })
      ).some((position) => position.packetId === packetId),
    ).toBe(true);
    expect(await station.extensions.processing.jobs(actor)).toEqual([]);
    await station.history.delete(instanceId, communication.id, actor.userId);
    expect(await digital.packet(instanceId, packetId)).toBeNull();
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
  it('does not re-upload an RX source advanced by completion before outbox acknowledgement', async () => {
    const replay = await createStation({
      identity: await loadInstanceIdentity(join(directory, 'replay')),
      dataDirectory: join(directory, 'replay'),
      connectionString: (() => {
        const url = new URL(process.env['TEST_DATABASE_URL']!);
        url.searchParams.set('options', `-c search_path=${schema}`);
        return url.href;
      })(),
      startJobs: false,
      startRadios: false,
    });
    try {
      await replay.auth.bootstrap({
        setupToken: replay.secrets.setupToken,
        username: 'replay-admin',
        password: crypto.randomUUID() + crypto.randomUUID(),
      });
      const source = await replay.history.ingest(
        {
          id: crypto.randomUUID(),
          instanceId: replay.auth.instanceId,
          radioId: crypto.randomUUID(),
          kind: 'received_voice',
          direction: 'rx',
          frequencyAttribution: 'unknown',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          context: {},
        },
        { bytes: recordingFixture(), contentType: 'audio/wav' },
      );
      const auto = vi
        .spyOn(replay.extensions.processing, 'enqueueFinalizedCommunication')
        .mockImplementation(async (communication) => {
          await replay.history.appendTranscript(
            replay.auth.instanceId,
            communication.id,
            {
              text: 'Fixture completed speech',
              source: 'provider',
              provenance: { fixture: true },
              expectedRevision: communication.revision,
            },
          );
          return { status: 'queued', jobId: crypto.randomUUID() };
        });
      vi.spyOn(
        replay.extensions.notifications,
        'publishForUser',
      ).mockRejectedValueOnce(
        new Error('Simulated failure before outbox acknowledgement'),
      );
      await expect(replay.extensions.drain()).rejects.toThrow(
        'before outbox acknowledgement',
      );
      expect(
        (await replay.history.get(replay.auth.instanceId, source.id))?.revision,
      ).toBe(2);
      await replay.extensions.drain();
      expect(auto).toHaveBeenCalledOnce();
      expect(
        Number(
          (
            await replay.database.query<{ count: string }>(
              "SELECT count(*) FROM sd_event_outbox WHERE instance_id=$1 AND type='communication.created' AND delivered_at IS NULL",
              [replay.auth.instanceId],
            )
          ).rows[0]!.count,
        ),
      ).toBe(0);
    } finally {
      await replay.server.close();
    }
  });
});
