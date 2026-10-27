import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  SignalDockError,
  type ArtifactStoragePort,
  type DatabasePort,
  type JobQueuePort,
  type Permission,
  type EventPublisherPort,
} from '@signaldock/contracts';
import {
  appendOutbox,
  dispatchOutbox,
  type OutboxEvent,
} from '@signaldock/database';
import type { HistoryService } from '@signaldock/history';
import type { MediaService } from '@signaldock/media-gateway';
import {
  CredentialVault,
  OpenAISubscriptionOAuth,
  ProcessingRuntime,
  createHistoryProcessingHooks,
  createProcessingRegistry,
  type ProcessingActor,
  removeProcessingSourceDerivatives,
} from '@signaldock/processing-connectors';
import {
  LocalAnalysisConnector,
  registerAnalysisTasks,
  createLocalTranscriptAnalysisHandler,
} from '@signaldock/processing-tasks';
import {
  SignedRelayClient,
  notificationDeliveryHandler,
  notificationRevocationHandler,
} from '@signaldock/notification-sdk/server';
import {
  IdentityService,
  SqlIdentityRepository,
  createArgon2idHasher,
  type AccessRevocation,
} from '../modules/identity/index.js';
import { registerProcessingRoutes } from '../modules/processing/processing.routes.js';
import {
  registerIncidentRoutes,
  IncidentService,
  SqlIncidentRepository,
} from '../modules/incidents/incidents.routes.js';
import {
  registerAprsRoutes,
  AprsService,
  PostgresDigitalRepository,
  DigitalDecodingService,
  createDigitalDecodeHandler,
  removeDigitalRecordingDerivatives,
} from '../modules/aprs/index.js';
import {
  NotificationService,
  PostgresNotificationRepository,
  registerNotificationRoutes,
} from '../modules/notifications/index.js';

export interface ExtensionOptions {
  instanceId: string;
  database: DatabasePort;
  auth: IdentityService;
  history: HistoryService;
  artifacts: ArtifactStoragePort;
  queue: JobQueuePort;
  secrets: { activeKeyId: string; keys: ReadonlyMap<string, Uint8Array> };
  dataDirectory: string;
  media?: MediaService;
  relayUrl?: string;
  onError?: (error: unknown) => void;
  events?: EventPublisherPort;
  publishOutboxEvent?: (
    event: OutboxEvent,
    transaction: DatabasePort,
  ) => Promise<void>;
}

export function authorizeStoredActor(
  instanceId: string,
  userId: string,
  permission: Permission,
  radioId: string | undefined,
  database: DatabasePort,
) {
  return database.transaction(async (tx) => {
    await tx.query(
      'SELECT id FROM sd_users WHERE instance_id=$1 AND id=$2 FOR SHARE',
      [instanceId, userId],
    );
    if (radioId)
      await tx.query(
        'SELECT user_id FROM sd_radio_permissions WHERE instance_id=$1 AND user_id=$2 AND radio_id=$3 FOR SHARE',
        [instanceId, userId, radioId],
      );
    const identity = new IdentityService({
      instanceId,
      repository: new SqlIdentityRepository(tx, instanceId),
      passwords: createArgon2idHasher(),
      passwordHashWarmup: false,
    });
    await identity.authorizeUser(userId, permission, radioId);
    const audience = await identity.resolveUser(userId);
    if (!audience)
      throw new SignalDockError('FORBIDDEN', 'This user is no longer active.');
    return audience;
  });
}

/** Optional domain workflows share the same authorized history, queue and transmission path. */
export async function createExtensions(options: ExtensionOptions) {
  const { instanceId, database, auth, history, artifacts, queue } = options;
  const incidents = new IncidentService(
    new SqlIncidentRepository(database, appendOutbox),
    auth,
  );
  const registry = createProcessingRegistry();
  registerAnalysisTasks(registry);
  registry.register(new LocalAnalysisConnector());
  const authorizeActor = async (
    actor: ProcessingActor,
    permission: Permission,
    radioId: string,
    tx: DatabasePort = database,
  ) => {
    if (actor.instanceId !== instanceId)
      throw new SignalDockError(
        'FORBIDDEN',
        'This actor belongs to another instance.',
      );
    if ('kind' in actor) {
      const consent = await tx.query<{ enabled: boolean }>(
        'SELECT enabled FROM sd_processing_background_consents WHERE instance_id=$1 AND id=$2 FOR SHARE',
        [instanceId, actor.consentId],
      );
      if (!consent.rows[0]?.enabled)
        throw new SignalDockError(
          'FORBIDDEN',
          'Background processing consent is no longer active.',
        );
      await authorizeStoredActor(
        instanceId,
        actor.userId,
        permission,
        radioId,
        tx,
      );
      return;
    }
    await tx.transaction(async (locked) => {
      await locked.query(
        'SELECT id FROM sd_users WHERE instance_id=$1 AND id=$2 FOR SHARE',
        [instanceId, actor.userId],
      );
      await locked.query(
        'SELECT id FROM sd_sessions WHERE instance_id=$1 AND id=$2 FOR SHARE',
        [instanceId, actor.sessionId],
      );
      const identity = new IdentityService({
        instanceId,
        repository: new SqlIdentityRepository(locked, instanceId),
        passwords: createArgon2idHasher(),
        passwordHashWarmup: false,
      });
      await identity.authorize(actor, permission, radioId);
    });
  };
  const hooks = createHistoryProcessingHooks(history, authorizeActor);
  const processing = new ProcessingRuntime({
    db: database,
    auth,
    artifacts,
    queue,
    registry,
    vault: new CredentialVault(
      options.secrets.activeKeyId,
      options.secrets.keys,
    ),
    subscriptionOAuth: new OpenAISubscriptionOAuth(`urn:uuid:${instanceId}`),
    ...hooks,
    onCompleted: async (tx, actor, request, result, source) => {
      await hooks.onCompleted?.(tx, actor, request, result, source);
      await incidents.acceptProcessingResult(
        tx,
        request,
        result,
        AbortSignal.timeout(10000),
        source,
      );
    },
    authorizeBackgroundUser: async (id, userId, permission, radioId) => {
      if (id !== instanceId)
        throw new SignalDockError(
          'FORBIDDEN',
          'This actor belongs to another instance.',
        );
      return authorizeStoredActor(id, userId, permission, radioId, database);
    },
  });
  const aprs = new AprsService(new PostgresDigitalRepository(database), auth);
  const resolveRecording = history.getRecordingContext.bind(history);
  const decoding = new DigitalDecodingService({
    database,
    auth,
    queue,
    resolveRecording,
  });
  let relay: SignedRelayClient | undefined;
  if (options.relayUrl) {
    const stored = JSON.parse(
      await readFile(join(options.dataDirectory, 'identity.json'), 'utf8'),
    ) as { privateKey: string };
    relay = new SignedRelayClient(
      options.relayUrl,
      instanceId,
      stored.privateKey,
    );
  }
  const notifications = new NotificationService(
    new PostgresNotificationRepository(database),
    auth,
    auth,
    relay,
  );
  queue.register('processing.execute', (job, signal, execution) =>
    processing.execute(job, signal, execution),
  );
  queue.register(
    'analysis.transcript',
    createLocalTranscriptAnalysisHandler(incidents),
  );
  queue.register(
    'digital.decode',
    createDigitalDecodeHandler({
      database,
      storage: artifacts,
      resolveRecording,
      authorizeActor: async (id, userId, radioId, tx) => {
        if (id !== instanceId)
          throw new SignalDockError(
            'FORBIDDEN',
            'This actor belongs to another instance.',
          );
        await authorizeStoredActor(id, userId, 'history.read', radioId, tx);
        await authorizeStoredActor(id, userId, 'aprs.read', radioId, tx);
      },
    }),
  );
  queue.register(
    'notifications.deliver',
    notificationDeliveryHandler(notifications),
  );
  queue.register(
    'notifications.revoke',
    notificationRevocationHandler(notifications),
  );
  let draining = false;
  let sequence = 0;
  const streamGeneration = randomUUID();
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciliationTimer: ReturnType<typeof setInterval> | undefined;
  let revoking: Promise<unknown> | undefined;
  const reconcileRevocations = () => {
    if (!revoking)
      revoking = notifications
        .reconcileRevocations(instanceId, 2)
        .catch(options.onError ?? (() => undefined))
        .finally(() => {
          revoking = undefined;
        });
    return revoking;
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      await dispatchOutbox(
        database,
        async (event, eventTransaction) => {
          if (event.instanceId !== instanceId)
            throw new Error('An outbox worker cannot consume another station.');
          const payload = event.payload as Record<string, unknown>;
          if (
            event.type === 'notification.delivery_requested' ||
            event.type === 'notification.subscription_revoked'
          ) {
            const revocation =
              event.type === 'notification.subscription_revoked';
            await queue.enqueue({
              instanceId,
              jobId: randomUUID(),
              kind: revocation
                ? 'notifications.revoke'
                : 'notifications.deliver',
              payload: revocation
                ? { grantId: payload['grantId'] }
                : { notificationId: payload['notificationId'] },
              idempotencyKey: `outbox:${event.id}`,
              deadline: new Date(Date.now() + 300000).toISOString(),
            });
            return;
          }
          let frequencyHz: number | undefined;
          if (
            event.type === 'communication.created' ||
            event.type === 'incident.created'
          ) {
            const source = await history.get(
              instanceId,
              String(payload['communicationId']),
            );
            if (!source || source.deletedAt) return;
            frequencyHz = source.frequencyHz;
            if (event.type === 'communication.created')
              await processing.enqueueFinalizedCommunication(source);
          }
          if (event.type === 'transcript.created') {
            const source = await history.get(
              instanceId,
              String(payload['communicationId']),
            );
            if (
              !source ||
              source.deletedAt ||
              source.revision !== payload['communicationRevision'] ||
              source.transcripts.at(-1)?.id !== payload['transcriptRevisionId']
            )
              return;
            frequencyHz = source.frequencyHz;
            await queue.enqueue({
              instanceId,
              jobId: randomUUID(),
              kind: 'analysis.transcript',
              payload: {
                communicationId: source.id,
                transcriptRevisionId: payload['transcriptRevisionId'],
              },
              source: {
                communicationId: source.id,
                communicationRevision: source.revision,
                transcriptRevisionId: String(payload['transcriptRevisionId']),
              },
              idempotencyKey: `analysis:${source.id}:${String(payload['transcriptRevisionId'])}`,
              deadline: new Date(Date.now() + 300000).toISOString(),
            });
          }
          const category =
            event.type === 'communication.created'
              ? 'communication'
              : event.type === 'transcript.created'
                ? 'transcript'
                : event.type === 'incident.created'
                  ? 'incident'
                  : undefined;
          if (category) {
            const users = await database.query<{ id: string }>(
              'SELECT id FROM sd_users WHERE instance_id=$1 AND enabled=true',
              [instanceId],
            );
            for (const user of users.rows)
              await notifications.publishForUser(
                user.id,
                {
                  instanceId,
                  eventId: event.id,
                  category,
                  occurredAt: event.occurredAt,
                  ...(event.radioId ? { radioId: event.radioId } : {}),
                },
                frequencyHz === undefined ? {} : { frequencyHz },
              );
          }
          if (options.publishOutboxEvent) {
            await options.publishOutboxEvent(event, eventTransaction);
          } else
            await options.events?.publish({
              protocolVersion: 1,
              eventId: event.id,
              instanceId,
              ...(event.radioId ? { radioId: event.radioId } : {}),
              streamGeneration,
              sequence: ++sequence,
              occurredAt: event.occurredAt,
              type: event.type,
              payloadVersion: 1,
              payload: event.payload,
            });
        },
        50,
        instanceId,
      );
    } finally {
      draining = false;
    }
  };
  return {
    processing,
    incidents,
    notifications,
    aprs,
    decoding,
    start() {
      timer = setInterval(() => {
        void drain().catch(options.onError ?? (() => undefined));
      }, 500);
      timer.unref();
      reconciliationTimer = setInterval(() => {
        void reconcileRevocations();
      }, 5000);
      reconciliationTimer.unref();
      void reconcileRevocations();
    },
    drain,
    async close() {
      if (timer) clearInterval(timer);
      if (reconciliationTimer) clearInterval(reconciliationTimer);
      await revoking;
      while (draining) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    async onAccessRevoked(event: AccessRevocation) {
      if (
        event.reason === 'access_changed' ||
        event.reason === 'password_reset'
      )
        await notifications.revokeForUser(instanceId, event.userId);
      else
        for (const sessionId of event.sessionIds)
          await notifications.revokeForUser(
            instanceId,
            event.userId,
            sessionId,
          );
    },
    async onDeleteTranscripts(
      tx: DatabasePort,
      source: { instanceId: string; communicationId: string },
    ) {
      await removeProcessingSourceDerivatives(
        tx,
        source.instanceId,
        source.communicationId,
      );
    },
    async onDeleteSource(
      tx: DatabasePort,
      source: {
        instanceId: string;
        communicationId: string;
        artifactIds: string[];
      },
    ) {
      await removeProcessingSourceDerivatives(
        tx,
        source.instanceId,
        source.communicationId,
      );
      for (const artifactId of source.artifactIds)
        await removeDigitalRecordingDerivatives(
          tx,
          source.instanceId,
          artifactId,
        );
    },
    async register(app: FastifyInstance, prefix: string) {
      registerProcessingRoutes(app, {
        prefix,
        auth,
        processing,
        ...(options.media
          ? {
              transmitPreparedSpeech: (...args) =>
                options.media!.transmitEncodedAudio(...args),
            }
          : {}),
      });
      registerIncidentRoutes(app, { prefix, auth, service: incidents });
      registerAprsRoutes(app, { prefix, auth, service: aprs, decoding });
      registerNotificationRoutes(app, { prefix, auth, service: notifications });
    },
  };
}
