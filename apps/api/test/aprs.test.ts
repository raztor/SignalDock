import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { configureHttp } from '../src/shared/http/configure-http.js';
import { registerAprsRoutes } from '../src/modules/aprs/aprs.routes.js';
import { PostgresDatabase, migrate } from '@signaldock/database';
import {
  SignalDockError,
  type AuthenticationPort,
  type Principal,
  type JobInput,
  type JobQueuePort,
  type ArtifactStoragePort,
} from '@signaldock/contracts';
import { AprsService } from '../src/modules/aprs/service.js';
import {
  PostgresDigitalRepository,
  digitalMigrations,
  removeDigitalRecordingDerivatives,
} from '../src/modules/aprs/repository.js';
import {
  DigitalDecodingService,
  createDigitalDecodeHandler,
  type RecordingDecodeContext,
} from '../src/modules/aprs/decoding.js';
import { afskFixture } from '../../../services/digital-decoders/test/fixtures.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
describe.skipIf(!databaseUrl)(
  'PostgreSQL packet isolation and recording jobs',
  () => {
    const schema = `sd_digital_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const admin = new PostgresDatabase({ connectionString: databaseUrl });
    let database: PostgresDatabase;
    let repository: PostgresDigitalRepository;
    let service: AprsService;
    const instanceId = crypto.randomUUID();
    const radioId = crypto.randomUUID();
    const otherRadioId = crypto.randomUUID();
    const principal: Principal = {
      instanceId,
      userId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      username: 'fixture',
      role: 'listener',
      radioPermissions: [
        { radioId, permissions: ['aprs.read', 'history.read'] },
      ],
    };
    const auth: AuthenticationPort = {
      authenticate: async () => principal,
      authorize: async (actor, permission, radio) => {
        if (
          !actor.radioPermissions.some(
            (grant) =>
              grant.radioId === radio && grant.permissions.includes(permission),
          )
        )
          throw new SignalDockError('FORBIDDEN', 'Radio access denied.');
      },
    };
    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA ${schema}`);
      database = new PostgresDatabase({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await migrate(database, digitalMigrations);
      // A fixture identity boundary: actual identity schema and sessionless grant logic belong to its own module.
      await database.query(
        `CREATE TABLE sd_decoder_test_grants(instance_id uuid,user_id uuid,radio_id uuid,enabled boolean,history_read boolean,aprs_read boolean,PRIMARY KEY(instance_id,user_id,radio_id))`,
      );
      repository = new PostgresDigitalRepository(database);
      service = new AprsService(repository, auth, () =>
        Date.parse('2026-10-26T13:00:00Z'),
      );
    });
    beforeEach(async () => {
      await database.query(
        'TRUNCATE sd_decoder_test_grants,sd_digital_decoder_runs,sd_aprs_positions,sd_digital_packets CASCADE',
      );
    });
    async function authorizeActor(
      actorInstance: string,
      actorId: string,
      actorRadio: string,
      db: import('@signaldock/contracts').DatabasePort,
    ) {
      const result = await db.query(
        'SELECT enabled,history_read,aprs_read FROM sd_decoder_test_grants WHERE instance_id=$1 AND user_id=$2 AND radio_id=$3 FOR SHARE',
        [actorInstance, actorId, actorRadio],
      );
      const grant = result.rows[0];
      if (!grant?.['enabled'] || !grant['history_read'] || !grant['aprs_read'])
        throw new SignalDockError(
          'FORBIDDEN',
          'Current decoder access was revoked.',
        );
    }
    afterAll(async () => {
      await database?.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    });
    const receive = (
      overrides: Partial<Parameters<AprsService['ingest']>[0]> = {},
    ) =>
      service.ingest({
        instanceId,
        radioId,
        source: 'native',
        receivedAt: '2026-10-26T12:00:00Z',
        attribution: 'unknown',
        rawText: 'N0CALL>APRS:!4903.50N/07201.75W-Synthetic fixture',
        ...overrides,
      });

    it('retains separate receptions and suppresses only repeated event IDs', async () => {
      const packetId = crypto.randomUUID();
      await receive({ packetId });
      expect((await receive({ packetId })).duplicate).toBe(true);
      await receive();
      expect((await service.listPackets(principal)).items).toHaveLength(2);
      await expect(
        receive({ packetId, rawText: 'N0CALL>APRS:>Different evidence' }),
      ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    });
    it('scopes packets, positions and filters to the current instance and assigned radios', async () => {
      await receive();
      await receive({ radioId: otherRadioId });
      await receive({ instanceId: crypto.randomUUID() });
      const packets = await service.listPackets(principal);
      expect(packets.items).toHaveLength(1);
      expect(packets.items[0]?.radioId).toBe(radioId);
      const positions = await service.listPositions(principal);
      expect(positions.items).toHaveLength(1);
      expect(positions.generatedAt).toBe('2026-10-26T13:00:00.000Z');
      await expect(
        service.listPackets(principal, { radioId: otherRadioId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(
        (await service.listPackets(principal, { source: 'recording' })).items,
      ).toEqual([]);
      await expect(
        service.listPackets(principal, { callsign: "' OR true --" }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });
    it('enforces authentication and bounded requests through prefixed HTTP routes', async () => {
      const app = Fastify();
      configureHttp(app);
      registerAprsRoutes(app, { prefix: '/station/api/v1', auth, service });
      try {
        await receive();
        expect(
          (await app.inject({ url: '/station/api/v1/packets' })).statusCode,
        ).toBe(401);
        expect(
          (
            await app.inject({
              url: '/station/api/v1/packets?limit=501',
              headers: { authorization: 'Bearer fixture' },
            })
          ).statusCode,
        ).toBe(400);
        const response = await app.inject({
          url: `/station/api/v1/packets?radioId=${radioId}`,
          headers: { authorization: 'Bearer fixture' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().items).toHaveLength(1);
        expect(response.headers['cache-control']).toBe('no-store');
        const unavailable = await app.inject({
          method: 'POST',
          url: '/station/api/v1/decodings',
          headers: { authorization: 'Bearer fixture' },
          payload: {
            operationId: crypto.randomUUID(),
            artifactId: crypto.randomUUID(),
            mode: 'AFSK1200',
          },
        });
        expect(unavailable.statusCode).toBe(503);
        expect(unavailable.json().code).toBe('REQUIRES_CONFIGURATION');
      } finally {
        await app.close();
      }
    });
    it('preserves malformed and ambiguous evidence without manufacturing positions', async () => {
      await receive({ rawText: 'Malformed' });
      await receive({ rawText: 'N0CALL>APRS:!4903.  N/07201.  W-Test' });
      expect((await service.listPositions(principal)).items).toEqual([]);
      const packets = (await service.listPackets(principal)).items;
      expect(packets.map((packet) => packet.kind).sort()).toEqual([
        'malformed',
        'position_ambiguous',
      ]);
      expect(packets.some((packet) => packet.rawText === 'Malformed')).toBe(
        true,
      );
    });
    it('paginates equal-time packets without leaking another radio', async () => {
      await receive();
      await receive();
      await receive({ radioId: otherRadioId });
      const page = await service.listPackets(principal, { limit: 1 });
      expect(page.nextCursor).toBeTruthy();
      const next = await service.listPackets(principal, {
        limit: 1,
        cursor: page.nextCursor!,
      });
      expect(next.items).toHaveLength(1);
      expect(next.items[0]?.packetId).not.toBe(page.items[0]?.packetId);
    });

    async function decoderFixture() {
      await database.query(
        'INSERT INTO sd_decoder_test_grants VALUES($1,$2,$3,true,true,true) ON CONFLICT DO NOTHING',
        [instanceId, principal.userId, radioId],
      );
      const artifactId = crypto.randomUUID();
      const bytes = afskFixture().wav;
      const source: RecordingDecodeContext = {
        communicationId: crypto.randomUUID(),
        communicationRevision: 1,
        radioId,
        startedAt: '2026-10-26T12:00:00Z',
        attribution: 'unknown',
      };
      const jobs: JobInput[] = [];
      let enqueueTransaction = false;
      const queue: JobQueuePort = {
        enqueue: async (job, transaction) => {
          jobs.push(job);
          enqueueTransaction = !!transaction;
          return { jobId: job.jobId, duplicate: false };
        },
        get: async () => null,
        cancel: async () => undefined,
        register: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
      };
      const decoding = new DigitalDecodingService({
        database,
        auth,
        queue,
        resolveRecording: async () => source,
      });
      const storage: ArtifactStoragePort = {
        put: async () => {
          throw Error('Unused');
        },
        delete: async () => undefined,
        read: async () => ({
          metadata: {
            artifactId,
            instanceId,
            sizeBytes: bytes.length,
            sha256: 'fixture',
            contentType: 'audio/wav',
          },
          bytes,
          totalBytes: bytes.length,
          start: 0,
          end: bytes.length - 1,
        }),
      };
      return {
        artifactId,
        source,
        jobs,
        queue,
        decoding,
        storage,
        transactionUsed: () => enqueueTransaction,
      };
    }
    it('atomically schedules a recording decoder and commits real packets with source provenance', async () => {
      const fixture = await decoderFixture();
      const runId = crypto.randomUUID();
      await fixture.decoding.create(principal, {
        operationId: runId,
        artifactId: fixture.artifactId,
        mode: 'AFSK1200',
      });
      expect(fixture.transactionUsed()).toBe(true);
      expect(
        (
          await fixture.decoding.create(principal, {
            operationId: runId,
            artifactId: fixture.artifactId,
            mode: 'AFSK1200',
          })
        ).duplicate,
      ).toBe(true);
      const handler = createDigitalDecodeHandler({
        database,
        storage: fixture.storage,
        resolveRecording: async () => fixture.source,
        authorizeActor,
      });
      await handler(fixture.jobs[0]!, new AbortController().signal, {
        commit: (write) => database.transaction(write),
      });
      const result = await fixture.decoding.get(principal, runId);
      expect(result.state).toBe('completed');
      expect(result.result?.packets).toHaveLength(1);
      const packet = (await service.listPackets(principal)).items[0]!;
      expect(packet.source).toBe('recording');
      expect(packet.attribution).toBe('unknown');
      expect(packet.parsed?.['recording']).toMatchObject({
        artifactId: fixture.artifactId,
        communicationId: fixture.source.communicationId,
        decoderRunId: runId,
      });
      await handler(fixture.jobs[0]!, new AbortController().signal, {
        commit: (write) => database.transaction(write),
      });
      expect((await service.listPackets(principal)).items).toHaveLength(1);
    });
    it('removes recording derivatives inside the source deletion transaction while retaining independent evidence', async () => {
      const fixture = await decoderFixture();
      const runId = crypto.randomUUID();
      await fixture.decoding.create(principal, {
        operationId: runId,
        artifactId: fixture.artifactId,
        mode: 'AFSK1200',
      });
      const handler = createDigitalDecodeHandler({
        database,
        storage: fixture.storage,
        resolveRecording: async () => fixture.source,
        authorizeActor,
      });
      await handler(fixture.jobs[0]!, new AbortController().signal, {
        commit: (write) => database.transaction(write),
      });
      await receive();
      await database.transaction((tx) =>
        removeDigitalRecordingDerivatives(tx, instanceId, fixture.artifactId),
      );
      const packets = await service.listPackets(principal);
      expect(packets.items).toHaveLength(1);
      expect(packets.items[0]?.source).toBe('native');
      expect((await service.listPositions(principal)).items).toHaveLength(1);
      await expect(
        fixture.decoding.get(principal, runId),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    it('rejects a queued job after its originating user access is revoked before reading audio', async () => {
      const fixture = await decoderFixture();
      const runId = crypto.randomUUID();
      await fixture.decoding.create(principal, {
        operationId: runId,
        artifactId: fixture.artifactId,
        mode: 'AFSK1200',
      });
      await database.query(
        'UPDATE sd_decoder_test_grants SET enabled=false WHERE instance_id=$1 AND user_id=$2',
        [instanceId, principal.userId],
      );
      let reads = 0;
      const handler = createDigitalDecodeHandler({
        database,
        authorizeActor,
        resolveRecording: async () => fixture.source,
        storage: {
          ...fixture.storage,
          read: async (...args) => {
            reads++;
            return fixture.storage.read(...args);
          },
        },
      });
      await expect(
        handler(fixture.jobs[0]!, new AbortController().signal, {
          commit: (write) => database.transaction(write),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(reads).toBe(0);
      expect((await service.listPackets(principal)).items).toEqual([]);
    });
    it('rechecks current grants inside the terminal transaction after decoding', async () => {
      const fixture = await decoderFixture();
      const runId = crypto.randomUUID();
      await fixture.decoding.create(principal, {
        operationId: runId,
        artifactId: fixture.artifactId,
        mode: 'AFSK1200',
      });
      let checks = 0;
      let terminalDatabase:
        import('@signaldock/contracts').DatabasePort | undefined;
      const handler = createDigitalDecodeHandler({
        database,
        storage: fixture.storage,
        resolveRecording: async () => fixture.source,
        authorizeActor: async (...args) => {
          checks++;
          if (checks === 2) terminalDatabase = args[3];
          await authorizeActor(...args);
        },
      });
      await expect(
        handler(fixture.jobs[0]!, new AbortController().signal, {
          commit: async (write) => {
            await database.query(
              'UPDATE sd_decoder_test_grants SET aprs_read=false WHERE instance_id=$1 AND user_id=$2',
              [instanceId, principal.userId],
            );
            return database.transaction(write);
          },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(checks).toBe(2);
      expect(terminalDatabase).toBeDefined();
      expect(terminalDatabase).not.toBe(database);
      expect((await service.listPackets(principal)).items).toEqual([]);
      expect(
        (
          await database.query(
            'SELECT result FROM sd_digital_decoder_runs WHERE instance_id=$1 AND run_id=$2',
            [instanceId, runId],
          )
        ).rows[0]?.['result'],
      ).toBeNull();
    });
    it('does not reopen a cancelled decoder run', async () => {
      const fixture = await decoderFixture();
      const runId = crypto.randomUUID();
      await fixture.decoding.create(principal, {
        operationId: runId,
        artifactId: fixture.artifactId,
        mode: 'AFSK1200',
      });
      await fixture.decoding.cancel(principal, runId);
      const handler = createDigitalDecodeHandler({
        database,
        storage: fixture.storage,
        resolveRecording: async () => fixture.source,
        authorizeActor,
      });
      await expect(
        handler(fixture.jobs[0]!, new AbortController().signal, {
          commit: (write) => database.transaction(write),
        }),
      ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
      expect((await fixture.decoding.get(principal, runId)).state).toBe(
        'cancelled',
      );
      expect((await service.listPackets(principal)).items).toEqual([]);
    });
    it('does not publish packets when the terminal source/cancellation guard refuses the commit', async () => {
      const fixture = await decoderFixture();
      const runId = crypto.randomUUID();
      await fixture.decoding.create(principal, {
        operationId: runId,
        artifactId: fixture.artifactId,
        mode: 'AFSK1200',
      });
      const handler = createDigitalDecodeHandler({
        database,
        storage: fixture.storage,
        resolveRecording: async () => fixture.source,
        authorizeActor,
      });
      await expect(
        handler(fixture.jobs[0]!, new AbortController().signal, {
          commit: async () => {
            throw new SignalDockError(
              'OPERATION_CONFLICT',
              'Source was deleted.',
            );
          },
        }),
      ).rejects.toThrow('Source was deleted.');
      expect((await service.listPackets(principal)).items).toEqual([]);
    });
  },
);
