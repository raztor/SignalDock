import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SignalDockError, type RadioSnapshot } from '@signaldock/contracts';
import {
  PostgresDatabase,
  foundationMigrations,
  migrate,
} from '@signaldock/database';
import { FileArtifactStorage } from '@signaldock/artifact-storage';
import { PostgresJobQueue } from '@signaldock/job-queue';
import {
  HistoryService,
  historyMigrations,
  HistoryCaptureRecorder,
  createHistoryMaintenanceHandler,
} from '@signaldock/history';
import { GrpcRadioDriver } from '@signaldock/radio-driver-sdk';
import { TxSupervisor, type TxDriverPort } from '@signaldock/radio-runtime/tx';
import {
  LiveKitCredentials,
  MediaService,
  createGrpcTxDriver,
  grpcRxFrames,
  type LiveKitConfiguration,
} from '@signaldock/media-gateway';
import {
  IdentityService,
  SqlIdentityRepository,
  createArgon2idHasher,
  identityMigrations,
  registerIdentityRoutes,
} from '../modules/identity/index.js';
import {
  RadioApplicationService,
  radioMigrations,
  registerRadioRoutes,
} from '../modules/radios/index.js';
import {
  createSimulatorRegistry,
  createGrpcDriverFactory,
} from '../modules/radios/driver-factory.js';
import { registerMediaRoutes } from '../modules/media/media.routes.js';
import { registerHistoryRoutes } from '../modules/history/index.js';
import type { InstanceIdentity } from '../modules/instance/identity-store.js';
import { buildServer } from './create-server.js';
import { loadStationSecrets } from './secrets.js';
import { CoverageTracker, TuningHistory } from './radio-context.js';
import { createExtensions } from './extensions.js';
import { processingMigrations } from '../modules/processing/migrations.js';
import { incidentMigrations } from '../modules/incidents/migrations.js';
import { digitalMigrations } from '../modules/aprs/index.js';
import { notificationMigrations } from '../modules/notifications/index.js';
import { StationEvents } from './events.js';

export interface StationOptions {
  identity: InstanceIdentity;
  dataDirectory: string;
  connectionString: string;
  database?: PostgresDatabase;
  displayName?: string;
  basePath?: string;
  allowedOrigins?: string[];
  cookieOrigin?: string;
  secureCookies?: boolean;
  logger?: boolean;
  livekit?: LiveKitConfiguration;
  driverCredentials?: ReadonlyMap<string, string>;
  startJobs?: boolean;
  queueSchema?: string;
  relayUrl?: string;
  startRadios?: boolean;
}

/** One process owns the radio runtime. Restart never restores control or TX grants. */
export async function createStation(options: StationOptions) {
  const database =
    options.database ??
    new PostgresDatabase({ connectionString: options.connectionString });
  const instanceId = options.identity.instanceId;
  let media: MediaService | undefined;
  let radios: RadioApplicationService | undefined;
  let supervisor: TxSupervisor | undefined;
  let recorder: HistoryCaptureRecorder | undefined;
  let queue: PostgresJobQueue | undefined;
  let unsubscribe: (() => void) | undefined;
  let uninvalidate: (() => void) | undefined;
  let coverage: CoverageTracker | undefined;
  let extensions: Awaited<ReturnType<typeof createExtensions>> | undefined;
  let events: StationEvents | undefined;
  const logFailure = (message: string, error: unknown) => {
    if (options.logger)
      console.error(
        message,
        error instanceof SignalDockError ? error.code : 'INTERNAL_ERROR',
      );
  };
  try {
    await migrate(database, [
      ...foundationMigrations,
      ...identityMigrations,
      ...radioMigrations,
      ...historyMigrations,
      ...processingMigrations,
      ...incidentMigrations,
      ...digitalMigrations,
      ...notificationMigrations,
    ]);
    const secrets = await loadStationSecrets(options.dataDirectory);
    const auth = new IdentityService({
      instanceId,
      repository: new SqlIdentityRepository(database, instanceId),
      passwords: createArgon2idHasher(),
      setupToken: secrets.setupToken,
      onAccessRevoked: async (event) => {
        events?.revoke(event.sessionIds);
        if (
          event.reason === 'access_changed' ||
          event.reason === 'password_reset'
        )
          radios?.runtime.revokeUser(event.userId);
        for (const sessionId of event.sessionIds)
          radios?.runtime.revokeSession(sessionId);
        await Promise.all(
          event.sessionIds.map((sessionId) => media?.revokeSession(sessionId)),
        );
        await extensions?.onAccessRevoked(event);
      },
    });
    events = new StationEvents(auth, instanceId);
    const registry = createSimulatorRegistry();
    registry.register(
      'vgc-benlink',
      createGrpcDriverFactory({
        resolveCredential: async (reference) => {
          const value = options.driverCredentials?.get(reference);
          if (!value)
            throw new SignalDockError(
              'REQUIRES_CONFIGURATION',
              'The driver credential is not configured.',
            );
          return value;
        },
      }),
    );
    radios = new RadioApplicationService({
      instanceId,
      database,
      auth,
      driverFactory: registry.create,
      events,
    });
    const runtime = radios.runtime;
    const artifacts = new FileArtifactStorage(
      join(options.dataDirectory, 'artifacts'),
    );
    const history = new HistoryService(database, artifacts, {
      maxRecordingBytesPerRadio: 1024 ** 3,
      onDeleteSource: async (tx, source) =>
        extensions?.onDeleteSource(tx, source),
    });
    recorder = new HistoryCaptureRecorder(history, {
      onError: (error) => logFailure('Recording capture failed', error),
    });
    const capture = recorder;
    const snapshots = new TuningHistory();
    coverage = new CoverageTracker(history, (error) =>
      logFailure('Coverage update failed', error),
    );
    const txDrivers = new Map<
      string,
      { driver: GrpcRadioDriver; port: TxDriverPort }
    >();
    const audioDriver = (radioId: string) => {
      const driver = runtime.getDriver(radioId);
      if (!(driver instanceof GrpcRadioDriver))
        throw new SignalDockError(
          'CAPABILITY_UNSUPPORTED',
          'This installed connector has no live PCM transport.',
        );
      return driver;
    };
    if (options.livekit) {
      supervisor = new TxSupervisor({
        runtime,
        onState: (status) => {
          if (status.state === 'idle' || status.state === 'stop_unconfirmed')
            return;
          const state =
            status.state === 'transmitting' ||
            status.state === 'stopping' ||
            status.state === 'tx_unconfirmed'
              ? status.state
              : 'preparing';
          try {
            runtime.setTransmissionState(
              status.grant.radioId,
              status.grant.txGrantId,
              state,
            );
          } catch (error) {
            logFailure('Transmission state changed during supervision', error);
          }
        },
        driver: (radioId) => {
          const driver = audioDriver(radioId);
          let cached = txDrivers.get(radioId);
          if (!cached || cached.driver !== driver) {
            cached = { driver, port: createGrpcTxDriver(driver) };
            txDrivers.set(radioId, cached);
          }
          return cached.port;
        },
        onFrame: (frame, grant, source) => {
          const snapshot = snapshots.get(
            grant.radioId,
            grant.generation,
            frame.tuningRevision,
          );
          const frequencyHz =
            snapshot?.observedTuning?.txHz ?? snapshot?.observedTuning?.rxHz;
          capture.push(frame, {
            instanceId,
            radioId: grant.radioId,
            generation: grant.generation,
            direction: 'tx',
            tuningRevision: frame.tuningRevision,
            txGrantId: grant.txGrantId,
            source,
            attributionConfidence: snapshot?.tuningConfidence ?? 'unknown',
            ...(frequencyHz === undefined ? {} : { frequencyHz }),
          });
        },
        onCaptureError: (error) => logFailure('TX recording failed', error),
      });
      const tx = supervisor;
      media = new MediaService({
        instanceId,
        auth,
        credentials: new LiveKitCredentials(options.livekit),
        supervisor: tx,
        rxSource: (radioId) => {
          const driver = audioDriver(radioId);
          const generation = runtime.snapshot(radioId).generation;
          return {
            generation,
            format: { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
            frames: (signal) => grpcRxFrames(driver, generation, signal),
          };
        },
        resolveTuning: (radioId, generation, revision) => {
          const snapshot = snapshots.get(radioId, generation, revision);
          if (!snapshot) return undefined;
          return {
            attributionConfidence: snapshot.tuningConfidence,
            ...(snapshot.observedTuning
              ? { frequencyHz: snapshot.observedTuning.rxHz }
              : {}),
          };
        },
        onFrame: (frame, context) => {
          const input = { instanceId, ...context };
          capture.push(frame, input);
          coverage?.push(input);
        },
        onError: (_radioId, error) =>
          logFailure('Radio media unavailable', error),
      });
      uninvalidate = runtime.onControlInvalidated(({ radioId, reason }) => {
        void tx.invalidateControl(radioId, reason);
      });
    }
    // An interval left open by a crashed process is evidence of an unknown end, not continuous reception.
    if (options.startRadios !== false)
      await database.query(
        "UPDATE sd_coverage_intervals SET ended_at=started_at,reason='process_restart_end_unknown' WHERE instance_id=$1 AND ended_at IS NULL",
        [instanceId],
      );
    const observe = (snapshot: RadioSnapshot) => {
      snapshots.observe(snapshot);
      coverage?.observe(snapshot);
      const audioCapable = runtime
        .list()
        .find((driver) => driver.radioId === snapshot.radioId)
        ?.capabilities.rxAudio;
      if (media && snapshot.connection === 'ready' && audioCapable)
        void media
          .attachRadio(snapshot.radioId)
          .catch((error: unknown) =>
            logFailure('Radio bridge unavailable', error),
          );
    };
    unsubscribe = runtime.subscribe(observe);
    if (options.startRadios !== false) await radios.start();
    for (const descriptor of runtime.list())
      observe(runtime.snapshot(descriptor.radioId));
    queue = new PostgresJobQueue(database, {
      instanceId,
      connectionString: options.connectionString,
      ...(options.queueSchema ? { schema: options.queueSchema } : {}),
      validateSource: history.validateJobSource.bind(history),
      onError: (error) => logFailure('Job worker failed', error),
    });
    queue.register(
      'history.maintenance',
      createHistoryMaintenanceHandler(history),
    );
    extensions = await createExtensions({
      instanceId,
      database,
      auth,
      history,
      artifacts,
      queue,
      secrets,
      dataDirectory: options.dataDirectory,
      events,
      ...(media ? { media } : {}),
      ...(options.relayUrl ? { relayUrl: options.relayUrl } : {}),
      onError: (error) => logFailure('Background workflow failed', error),
    });
    if (options.startJobs !== false) {
      await queue.start();
      extensions.start();
    }
    const stationRadios = radios;
    const stationMedia = media;
    const server = await buildServer({
      identity: options.identity,
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.basePath ? { basePath: options.basePath } : {}),
      ...(options.allowedOrigins
        ? { allowedOrigins: options.allowedOrigins }
        : {}),
      ...(options.cookieOrigin ? { cookieOrigin: options.cookieOrigin } : {}),
      logger: options.logger ?? false,
      features: {
        authentication: 'local',
        multiRadio: true,
        radioControl: true,
        liveAudio: Boolean(media),
        pushRelay: options.relayUrl ? 'optional' : 'unavailable',
      },
      register: async (app, prefix) => {
        registerIdentityRoutes(app, {
          prefix,
          service: auth,
          ...(options.cookieOrigin
            ? { cookieOrigin: options.cookieOrigin }
            : {}),
          secureCookies: options.secureCookies ?? true,
        });
        registerRadioRoutes(app, { prefix, auth, service: stationRadios });
        if (stationMedia)
          registerMediaRoutes(app, prefix, { auth, media: stationMedia });
        await app.register(
          async (scope) => registerHistoryRoutes(scope, { auth, history }),
          { prefix },
        );
        await extensions!.register(app, prefix);
        events!.register(app, prefix);
      },
    });
    const closeResources = async () => {
      unsubscribe?.();
      uninvalidate?.();
      const failures: unknown[] = [];
      for (const stop of [
        () => media?.close(),
        () => supervisor?.close(),
        () => radios?.close(),
        () => capture.stop(),
        () => coverage?.close(),
        () => extensions?.close(),
        () => queue?.stop(),
        () => (options.database ? undefined : database.close()),
      ]) {
        try {
          await stop();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'Station shutdown could not confirm every resource cleanup.',
        );
    };
    server.addHook('preClose', async () => {
      events?.close();
    });
    server.addHook('onClose', closeResources);
    return {
      server,
      auth,
      radios: stationRadios,
      media,
      supervisor,
      history,
      recorder: capture,
      database,
      queue,
      secrets,
      extensions,
      events,
    };
  } catch (error) {
    events?.close();
    unsubscribe?.();
    uninvalidate?.();
    await media?.close().catch(() => undefined);
    await supervisor?.close().catch(() => undefined);
    await radios?.close().catch(() => undefined);
    await recorder?.stop().catch(() => undefined);
    await coverage?.close().catch(() => undefined);
    await extensions?.close().catch(() => undefined);
    await queue?.stop().catch(() => undefined);
    if (!options.database) await database.close();
    throw error;
  }
}

/** Deployment explicitly maps opaque credential names to private token files. */
export async function loadDriverCredentials(
  path?: string,
): Promise<ReadonlyMap<string, string>> {
  if (!path) return new Map();
  const entries = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  const result = new Map<string, string>();
  for (const [reference, file] of Object.entries(entries)) {
    if (typeof file !== 'string' || !file.startsWith('/'))
      throw new Error(
        'Driver credentials must reference absolute private files.',
      );
    const value = (await readFile(file, 'utf8')).trim();
    if (!value) throw new Error('A configured driver token file is empty.');
    result.set(reference, value);
  }
  return result;
}
