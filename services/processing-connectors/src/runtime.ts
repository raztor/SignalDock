import { createHash, randomUUID } from 'node:crypto';
import {
  ProcessingConnectionSchema,
  ProcessingProfileSchema,
  ProcessingRequestSchema,
  SignalDockError,
  type ArtifactStoragePort,
  type AuthPort,
  type DatabasePort,
  type JobInput,
  type JobQueuePort,
  type Principal,
  type ProcessingCapability,
  type ProcessingConnection,
  type ProcessingProfile,
  type ProcessingRequest,
  type ProcessingResult,
  type ProcessingConnectionView,
  type ProcessingJobView,
  type JobExecutionContext,
  type NotificationAudience,
  type Permission,
  type Communication,
  type ProcessingBackgroundConsentView,
} from '@signaldock/contracts';
import {
  ProcessingRegistry,
  type ProviderAuthentication,
} from '@signaldock/processing-sdk';
import { endpoint } from './http.js';
import { CredentialVault, type CredentialEnvelope } from './vault.js';
import {
  OpenAISubscriptionOAuth,
  type SubscriptionRegistration,
} from '../openai-subscription-oauth/src/oauth.js';

interface ConnectionRow extends Record<string, unknown> {
  id: string;
  instance_id: string;
  owner_user_id: string | null;
  connector_id: string;
  display_name: string;
  endpoint: string;
  configuration: Record<string, unknown>;
  capabilities: ProcessingCapability[];
  status: ProcessingConnectionView['status'];
  credential_id: string | null;
}
interface JobRow extends Record<string, unknown> {
  id: string;
  instance_id: string;
  owner_user_id: string;
  radio_id: string | null;
  request: ProcessingRequest;
  actor: ProcessingActor;
  source: JobInput['source'] | null;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result: ProcessingResult | null;
  error: string | null;
  fingerprint: string;
  created_at: Date | string;
}
type StoredCredential =
  | { kind: 'api-key'; secret: string }
  | { kind: 'subscription'; registration: SubscriptionRegistration };
export type ProcessingActor =
  | Principal
  | { kind: 'service'; instanceId: string; userId: string; consentId: string };
interface BackgroundConsent extends Record<string, unknown> {
  id: string;
  radio_id: string;
  profile_id: string;
  profile_revision: number;
  connection_id: string;
  service_owner_user_id: string;
  endpoint: string;
  connection_fingerprint: string;
  enabled: boolean;
  consented_at: string | Date;
}
export interface ProcessingRuntimeOptions {
  db: DatabasePort;
  auth: AuthPort;
  artifacts: ArtifactStoragePort;
  queue: JobQueuePort;
  registry: ProcessingRegistry;
  vault: CredentialVault;
  subscriptionOAuth: OpenAISubscriptionOAuth;
  /** Must authorize every referenced communication/artifact and compare the original revision. */
  validateInputs(
    principal: ProcessingActor,
    request: ProcessingRequest,
    source: JobInput['source'] | undefined,
    db?: DatabasePort,
    claimedRadioId?: string,
  ): Promise<void>;
  /** Reauthorize the persisted source's current radio; viewing an old result does not require its old revision to remain latest. */
  authorizeSourceRead?(
    principal: ProcessingActor,
    source: NonNullable<JobInput['source']>,
    db?: DatabasePort,
  ): Promise<void>;
  /** Runs inside the queue's guarded final transaction, for example to append a transcript revision. */
  onCompleted?(
    transaction: DatabasePort,
    principal: ProcessingActor,
    request: ProcessingRequest,
    result: ProcessingResult,
    source?: JobInput['source'],
  ): Promise<void>;
  authorizeBackgroundUser?(
    instanceId: string,
    userId: string,
    permission: Permission,
    radioId?: string,
  ): Promise<NotificationAudience>;
}
export interface CreateProcessingConnection {
  connectorId: string;
  displayName: string;
  endpoint: string;
  capabilities: ProcessingCapability[];
  configuration?: Record<string, unknown> | undefined;
  apiKey?: string | undefined;
}
/** Domain orchestration; no vendor HTTP or radio transmission logic belongs here. */
export class ProcessingRuntime {
  constructor(private readonly options: ProcessingRuntimeOptions) {}
  manifests() {
    return this.options.registry.manifests();
  }
  tasks() {
    return this.options.registry.taskDefinitions();
  }
  private async authorize(
    actor: ProcessingActor,
    permission: Permission,
    radioId?: string,
    db = this.options.db,
  ) {
    if ('kind' in actor && actor.kind === 'service') {
      await this.validateConsent(actor, db);
      if (!this.options.authorizeBackgroundUser)
        throw new SignalDockError(
          'REQUIRES_CONFIGURATION',
          'A background-user authorization policy is required.',
        );
      const current = await this.options.authorizeBackgroundUser(
        actor.instanceId,
        actor.userId,
        permission,
        radioId,
      );
      if (
        current.instanceId !== actor.instanceId ||
        current.userId !== actor.userId
      )
        throw new SignalDockError(
          'FORBIDDEN',
          'The background user belongs to another identity.',
        );
    } else
      await this.options.auth.authorize(
        actor as Principal,
        permission,
        radioId,
      );
  }
  private async manage(actor: ProcessingActor, db = this.options.db) {
    await this.authorize(actor, 'processing.manage', undefined, db);
  }
  async connections(actor: Principal) {
    await this.manage(actor);
    const rows = await this.options.db.query<ConnectionRow>(
      'SELECT * FROM sd_processing_connections WHERE instance_id=$1 AND (owner_user_id IS NULL OR owner_user_id=$2) ORDER BY created_at',
      [actor.instanceId, actor.userId],
    );
    return rows.rows.map(connectionView);
  }
  async profiles(actor: Principal) {
    await this.manage(actor);
    const rows = await this.options.db.query<{ profile: ProcessingProfile }>(
      'SELECT p.profile FROM sd_processing_profiles p JOIN sd_processing_connections c ON (p.instance_id=c.instance_id AND p.connection_id=c.id) WHERE p.instance_id=$1 AND (c.owner_user_id IS NULL OR c.owner_user_id=$2) ORDER BY p.created_at',
      [actor.instanceId, actor.userId],
    );
    return rows.rows.map((row) => ProcessingProfileSchema.parse(row.profile));
  }
  async createConnection(actor: Principal, input: CreateProcessingConnection) {
    await this.manage(actor);
    await this.options.auth.authorize(actor, 'instance.admin');
    if (input.connectorId === 'openai-subscription-oauth')
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Link a subscription to the current user through verified subscription import.',
      );
    const manifest = this.options.registry
      .manifests()
      .find((item) => item.connectorId === input.connectorId);
    if (
      !manifest ||
      manifest.simulated ||
      !input.capabilities.length ||
      input.capabilities.some(
        (capability) => !manifest.capabilities.includes(capability),
      )
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'The installed connector does not declare these capabilities.',
      );
    const configuration = input.configuration ?? {};
    assertSafeConfiguration(configuration);
    endpoint(input.endpoint, '', configuration);
    const connectionId = randomUUID();
    const credentialId = input.apiKey ? randomUUID() : null;
    if (input.apiKey && (input.apiKey.length > 64000 || !input.apiKey.trim()))
      throw new SignalDockError('INVALID_ARGUMENT', 'The API key is invalid.');
    await this.options.db.transaction(async (tx) => {
      if (credentialId)
        await this.saveCredential(tx, actor.instanceId, credentialId, null, {
          kind: 'api-key',
          secret: input.apiKey!,
        });
      await tx.query(
        'INSERT INTO sd_processing_connections(instance_id,id,connector_id,display_name,endpoint,configuration,capabilities,credential_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',
        [
          actor.instanceId,
          connectionId,
          input.connectorId,
          input.displayName,
          input.endpoint,
          JSON.stringify(configuration),
          JSON.stringify(input.capabilities),
          credentialId,
        ],
      );
    });
    return connectionView(await this.connection(actor, connectionId));
  }
  async importSubscription(
    actor: Principal,
    input: SubscriptionRegistration,
    signal: AbortSignal,
  ) {
    await this.manage(actor);
    const registration =
      await this.options.subscriptionOAuth.importRegistration(input, signal);
    const connectionId = randomUUID();
    const credentialId = randomUUID();
    await this.options.db.transaction(async (tx) => {
      await this.saveCredential(
        tx,
        actor.instanceId,
        credentialId,
        actor.userId,
        { kind: 'subscription', registration },
      );
      await tx.query(
        'INSERT INTO sd_processing_connections(instance_id,id,owner_user_id,connector_id,display_name,endpoint,configuration,capabilities,credential_id,status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)',
        [
          actor.instanceId,
          connectionId,
          actor.userId,
          'openai-subscription-oauth',
          'OpenAI subscription',
          'https://api.openai.com/v1',
          '{}',
          '["text.structured"]',
          credentialId,
          'connected',
        ],
      );
    });
    return connectionView(await this.connection(actor, connectionId));
  }
  async revokeConnection(
    actor: Principal,
    connectionId: string,
    signal: AbortSignal,
  ) {
    await this.manage(actor);
    const connection = await this.connection(actor, connectionId);
    if (connection.owner_user_id === null)
      await this.options.auth.authorize(actor, 'instance.admin');
    // Disable admission first. A failed provider revocation leaves the connection disabled for retry.
    await this.options.db.query(
      "UPDATE sd_processing_connections SET status='revoked',updated_at=now() WHERE instance_id=$1 AND id=$2",
      [actor.instanceId, connectionId],
    );
    if (connection.credential_id)
      await this.options.db.transaction(async (tx) => {
        const credential = await this.credential(tx, connection);
        if (credential.kind === 'subscription')
          await this.options.subscriptionOAuth.revoke(
            credential.registration,
            signal,
          );
        await tx.query(
          'UPDATE sd_provider_credentials SET envelope=$3::jsonb,revision=revision+1,updated_at=now() WHERE instance_id=$1 AND id=$2',
          [
            actor.instanceId,
            connection.credential_id,
            JSON.stringify(
              this.options.vault.seal(scope(connection), { kind: 'revoked' }),
            ),
          ],
        );
      });
  }
  async saveProfile(
    actor: Principal,
    value: ProcessingProfile,
    expectedRevision?: number,
  ) {
    await this.manage(actor);
    const profile = ProcessingProfileSchema.parse(value);
    const connection = await this.connection(actor, profile.connectionId);
    if (
      !connection.capabilities.includes(profile.capability) ||
      connection.status === 'revoked'
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'The connection cannot run this profile.',
      );
    assertSafeConfiguration(profile.settings ?? {});
    if (
      profile.task &&
      !this.options.registry
        .taskDefinitions()
        .some(
          (task) =>
            task.taskId === profile.task &&
            task.capability === profile.capability,
        )
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'The profile task is not installed for this capability.',
      );
    await this.options.db.transaction(async (tx) => {
      const existing = await tx.query<{ profile: ProcessingProfile }>(
        'SELECT profile FROM sd_processing_profiles WHERE instance_id=$1 AND id=$2 FOR UPDATE',
        [actor.instanceId, profile.profileId],
      );
      if (existing.rows[0]) {
        await this.connection(actor, existing.rows[0].profile.connectionId, tx);
        if (
          expectedRevision !== existing.rows[0].profile.revision ||
          profile.revision !== expectedRevision + 1
        )
          throw new SignalDockError(
            'STALE_REVISION',
            'Reload the current processing profile before changing it.',
          );
        await tx.query(
          'UPDATE sd_processing_profiles SET connection_id=$3,revision=$4,profile=$5::jsonb,updated_at=now() WHERE instance_id=$1 AND id=$2',
          [
            actor.instanceId,
            profile.profileId,
            profile.connectionId,
            profile.revision,
            JSON.stringify(profile),
          ],
        );
      } else {
        if (expectedRevision !== undefined || profile.revision !== 1)
          throw new SignalDockError(
            'STALE_REVISION',
            'A new processing profile starts at revision one.',
          );
        await tx.query(
          'INSERT INTO sd_processing_profiles(instance_id,id,connection_id,revision,profile) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            actor.instanceId,
            profile.profileId,
            profile.connectionId,
            profile.revision,
            JSON.stringify(profile),
          ],
        );
      }
    });
    return profile;
  }
  async enqueue(
    actor: Principal,
    input: ProcessingRequest,
    idempotencyKey: string,
    radioId?: string,
    source?: JobInput['source'],
  ) {
    return this.enqueueAuthorized(
      actor,
      input,
      idempotencyKey,
      radioId,
      source,
    );
  }
  private async enqueueAuthorized(
    actor: ProcessingActor,
    input: ProcessingRequest,
    idempotencyKey: string,
    radioId?: string,
    source?: JobInput['source'],
  ) {
    await this.manage(actor);
    if (radioId) await this.authorize(actor, 'history.read', radioId);
    const request = ProcessingRequestSchema.parse(input);
    if (
      request.instanceId !== actor.instanceId ||
      Date.parse(request.deadline) <= Date.now() ||
      Date.parse(request.deadline) > Date.now() + 10 * 60_000 ||
      !idempotencyKey ||
      idempotencyKey.length > 200
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'The processing instance, deadline, or idempotency key is invalid.',
      );
    const profile = await this.profile(actor, request.profileId);
    const connection = await this.connection(actor, profile.connectionId);
    if (
      profile.revision !== request.profileRevision ||
      (profile.task && profile.task !== request.task)
    )
      throw new SignalDockError(
        'STALE_REVISION',
        'The processing request does not match the current profile.',
      );
    if (
      !connection.capabilities.includes(profile.capability) ||
      connection.status === 'revoked'
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'The configured connection is unavailable for this task.',
      );
    if (
      profile.capability !== 'tts.synthesize' &&
      (!source ||
        request.input.communicationIds.length !== 1 ||
        request.input.communicationIds[0] !== source.communicationId ||
        (request.input.kind === 'audio' &&
          source.artifactId !== request.input.artifactId))
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Processing requires one versioned communication source and its matching recording.',
      );
    await this.options.validateInputs(
      actor,
      request,
      source,
      undefined,
      radioId,
    );
    const fingerprint = semanticFingerprint(request, radioId, source);
    return this.options.db.transaction(async (tx) => {
      // Lock/revalidate the source before any domain or queue row, so deletion cannot race a late enqueue.
      await this.options.validateInputs(actor, request, source, tx, radioId);
      const inserted = await tx.query(
        'INSERT INTO sd_processing_jobs(instance_id,id,owner_user_id,radio_id,profile_id,request,actor,source,state,fingerprint,idempotency_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11) ON CONFLICT(instance_id,owner_user_id,idempotency_key) DO NOTHING',
        [
          actor.instanceId,
          request.jobId,
          actor.userId,
          radioId ?? null,
          request.profileId,
          JSON.stringify(request),
          JSON.stringify(actor),
          source ? JSON.stringify(source) : null,
          'queued',
          fingerprint,
          idempotencyKey,
        ],
      );
      if (inserted.rowCount === 0) {
        const duplicate = (
          await tx.query<JobRow>(
            'SELECT * FROM sd_processing_jobs WHERE instance_id=$1 AND owner_user_id=$2 AND idempotency_key=$3',
            [actor.instanceId, actor.userId, idempotencyKey],
          )
        ).rows[0]!;
        // Compare persisted semantics too: older fingerprints included delivery deadlines.
        if (
          semanticFingerprint(
            duplicate.request,
            duplicate.radio_id ?? undefined,
            duplicate.source ?? undefined,
          ) !== fingerprint
        )
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'The idempotency key belongs to a different request.',
          );
        return jobView(duplicate);
      }
      await this.options.queue.enqueue(
        {
          jobId: request.jobId,
          instanceId: actor.instanceId,
          kind: 'processing.execute',
          payload: { processingJobId: request.jobId },
          idempotencyKey: `processing:${request.jobId}`,
          deadline: request.deadline,
          maxAttempts: 1,
          ...(source ? { source } : {}),
        },
        tx,
      );
      return jobView(
        (
          await tx.query<JobRow>(
            'SELECT * FROM sd_processing_jobs WHERE instance_id=$1 AND id=$2',
            [actor.instanceId, request.jobId],
          )
        ).rows[0]!,
      );
    });
  }
  /** No connection/profile creation enables automation. Each consent binds an explicit destination snapshot. */
  async consentToAutomaticRx(
    actor: Principal,
    input: {
      radioId: string;
      profileId: string;
      profileRevision: number;
      endpoint: string;
      serviceOwnerUserId: string;
      allowAutomaticUpload: true;
    },
  ) {
    await this.manage(actor);
    await this.options.auth.authorize(actor, 'instance.admin');
    if (
      input.allowAutomaticUpload !== true ||
      !this.options.authorizeBackgroundUser
    )
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'Explicit automatic-upload consent and a background-user policy are required.',
      );
    const user = await this.options.authorizeBackgroundUser(
      actor.instanceId,
      input.serviceOwnerUserId,
      'processing.manage',
    );
    if (
      user.instanceId !== actor.instanceId ||
      user.userId !== input.serviceOwnerUserId
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'The service owner belongs to another instance.',
      );
    await this.options.authorizeBackgroundUser(
      actor.instanceId,
      user.userId,
      'history.read',
      input.radioId,
    );
    const profile = await this.profile(actor, input.profileId);
    const connection = await this.connection(actor, profile.connectionId);
    if (
      profile.revision !== input.profileRevision ||
      connection.endpoint !== input.endpoint
    )
      throw new SignalDockError(
        'STALE_REVISION',
        'Confirm the current endpoint and immutable profile revision before enabling automatic uploads.',
      );
    if (
      connection.owner_user_id !== null ||
      profile.capability !== 'stt.batch' ||
      profile.task !== 'speech.transcribe' ||
      connection.status === 'revoked'
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'Automatic RX requires an instance-owned transcription profile.',
      );
    if (
      !connection.credential_id &&
      connection.connector_id !== 'openai-compatible'
    )
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'Configure provider credentials before consenting to automatic transcription.',
      );
    const consentId = randomUUID();
    await this.options.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `processing-consent:${actor.instanceId}:${input.radioId}`,
      ]);
      await tx.query(
        'UPDATE sd_processing_background_consents SET enabled=false,disabled_at=now() WHERE instance_id=$1 AND radio_id=$2 AND enabled=true',
        [actor.instanceId, input.radioId],
      );
      await tx.query(
        'INSERT INTO sd_processing_background_consents(instance_id,id,radio_id,profile_id,profile_revision,connection_id,service_owner_user_id,endpoint,connection_fingerprint,consented_by,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)',
        [
          actor.instanceId,
          consentId,
          input.radioId,
          profile.profileId,
          profile.revision,
          profile.connectionId,
          user.userId,
          connection.endpoint,
          connectionFingerprint(connection),
          actor.userId,
        ],
      );
    });
    return { consentId, ...input };
  }
  async disableAutomaticRx(actor: Principal, radioId: string) {
    await this.manage(actor);
    await this.options.auth.authorize(actor, 'instance.admin');
    await this.options.db.query(
      'UPDATE sd_processing_background_consents SET enabled=false,disabled_at=now() WHERE instance_id=$1 AND radio_id=$2 AND enabled=true',
      [actor.instanceId, radioId],
    );
  }
  async backgroundConsents(
    actor: Principal,
  ): Promise<ProcessingBackgroundConsentView[]> {
    await this.manage(actor);
    await this.options.auth.authorize(actor, 'instance.admin');
    const rows = await this.options.db.query<BackgroundConsent>(
      'SELECT * FROM sd_processing_background_consents WHERE instance_id=$1 AND enabled=true ORDER BY consented_at DESC',
      [actor.instanceId],
    );
    return rows.rows.map((row) => ({
      consentId: row.id,
      radioId: row.radio_id,
      profileId: row.profile_id,
      profileRevision: row.profile_revision,
      endpoint: row.endpoint,
      serviceOwnerUserId: row.service_owner_user_id,
      enabled: row.enabled,
      consentedAt: new Date(row.consented_at).toISOString(),
    }));
  }
  async enqueueFinalizedCommunication(communication: Communication): Promise<{
    status: 'queued' | 'disabled' | 'requires_configuration';
    jobId?: string;
  }> {
    if (
      communication.deletedAt ||
      communication.direction !== 'rx' ||
      communication.kind !== 'received_voice' ||
      communication.recording?.state !== 'available'
    )
      return { status: 'disabled' };
    const consent = (
      await this.options.db.query<BackgroundConsent>(
        'SELECT * FROM sd_processing_background_consents WHERE instance_id=$1 AND radio_id=$2 AND enabled=true',
        [communication.instanceId, communication.radioId],
      )
    ).rows[0];
    if (!consent) return { status: 'disabled' };
    try {
      const actor: ProcessingActor = {
        kind: 'service',
        instanceId: communication.instanceId,
        userId: consent.service_owner_user_id,
        consentId: consent.id,
      };
      await this.manage(actor);
      const job = await this.enqueueAuthorized(
        actor,
        {
          instanceId: communication.instanceId,
          jobId: randomUUID(),
          task: 'speech.transcribe',
          taskVersion: 1,
          profileId: consent.profile_id,
          profileRevision: consent.profile_revision,
          deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
          input: {
            kind: 'audio',
            artifactId: communication.recording.artifactId,
            communicationIds: [communication.id],
          },
        },
        `rx-stt:${communication.id}:${communication.revision}:${consent.id}`,
        communication.radioId,
        {
          communicationId: communication.id,
          communicationRevision: communication.revision,
          artifactId: communication.recording.artifactId,
        },
      );
      return { status: 'queued', jobId: job.jobId };
    } catch (error) {
      if (
        error instanceof SignalDockError &&
        [
          'REQUIRES_CONFIGURATION',
          'FORBIDDEN',
          'UNAUTHORIZED',
          'NOT_FOUND',
          'CAPABILITY_UNSUPPORTED',
          'STALE_REVISION',
        ].includes(error.code)
      )
        return { status: 'requires_configuration' };
      throw error;
    }
  }
  async jobs(actor: Principal) {
    await this.manage(actor);
    const selected = (
      await this.options.db.query<JobRow>(
        'SELECT * FROM sd_processing_jobs WHERE instance_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC LIMIT 100',
        [actor.instanceId, actor.userId],
      )
    ).rows;
    const rows: JobRow[] = [];
    for (const row of selected) {
      try {
        await this.authorizeOutput(actor, row);
        rows.push(row);
      } catch (error) {
        if (
          !(error instanceof SignalDockError) ||
          !['FORBIDDEN', 'NOT_FOUND'].includes(error.code)
        )
          throw error;
      }
    }
    await Promise.all(
      rows
        .filter((row) => row.state === 'queued' || row.state === 'running')
        .map(async (row) => {
          const state = await this.options.queue.get(actor.instanceId, row.id);
          if (
            state?.state === 'failed' ||
            state?.state === 'cancelled' ||
            state?.state === 'requires_configuration'
          ) {
            row.state = state.state === 'cancelled' ? 'cancelled' : 'failed';
            // Queue errors can contain arbitrary worker diagnostics; expose a stable code only.
            row.error =
              state.state === 'requires_configuration'
                ? 'REQUIRES_CONFIGURATION'
                : 'JOB_TERMINATED';
            await this.options.db.query(
              "UPDATE sd_processing_jobs SET state=$3,error=$4,updated_at=now() WHERE instance_id=$1 AND id=$2 AND state IN ('queued','running')",
              [actor.instanceId, row.id, row.state, row.error],
            );
          }
        }),
    );
    return rows.map(jobView);
  }
  async cancel(actor: Principal, jobId: string) {
    await this.manage(actor);
    const updated = await this.options.db.query(
      "UPDATE sd_processing_jobs SET state='cancelled',updated_at=now() WHERE instance_id=$1 AND id=$2 AND owner_user_id=$3 AND state IN ('queued','running')",
      [actor.instanceId, jobId, actor.userId],
    );
    if (!updated.rowCount)
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'The processing job is unavailable or already finished.',
      );
    await this.options.queue.cancel(actor.instanceId, jobId);
  }
  async preview(actor: Principal, jobId: string) {
    await this.manage(actor);
    const job = (
      await this.options.db.query<JobRow>(
        'SELECT * FROM sd_processing_jobs WHERE instance_id=$1 AND id=$2 AND owner_user_id=$3',
        [actor.instanceId, jobId, actor.userId],
      )
    ).rows[0];
    if (
      !job ||
      job.state !== 'completed' ||
      job.result?.output.kind !== 'audio'
    )
      throw new SignalDockError(
        'NOT_FOUND',
        'A completed audio preview is unavailable.',
      );
    await this.authorizeOutput(actor, job);
    return this.options.artifacts.read(
      actor.instanceId,
      job.result.output.artifactId,
    );
  }
  async prepareTransmission(actor: Principal, jobId: string, radioId: string) {
    const artifactId = await this.validatePreparedTransmission(
      actor,
      jobId,
      radioId,
    );
    return this.options.artifacts.read(actor.instanceId, artifactId);
  }
  async validatePreparedTransmission(
    actor: Principal,
    jobId: string,
    radioId: string,
  ): Promise<string> {
    await this.manage(actor);
    await this.options.auth.authorize(actor, 'radio.transmit', radioId);
    const job = (
      await this.options.db.query<JobRow>(
        'SELECT * FROM sd_processing_jobs WHERE instance_id=$1 AND id=$2 AND owner_user_id=$3',
        [actor.instanceId, jobId, actor.userId],
      )
    ).rows[0];
    if (
      !job ||
      job.state !== 'completed' ||
      job.result?.output.kind !== 'audio' ||
      job.request.task !== 'speech.synthesize'
    )
      throw new SignalDockError(
        'NOT_FOUND',
        'A completed speech preview belonging to this user is required.',
      );
    await this.authorizeOutput(actor, job);
    const profile = await this.profile(actor, job.request.profileId);
    const connection = await this.connection(actor, profile.connectionId);
    if (
      profile.revision !== job.request.profileRevision ||
      connection.status === 'revoked'
    )
      throw new SignalDockError(
        'STALE_REVISION',
        'Regenerate the preview after changing its profile or connection.',
      );
    if (job.radio_id && job.radio_id !== radioId)
      throw new SignalDockError(
        'FORBIDDEN',
        'The preview was prepared for another radio.',
      );
    return job.result.output.artifactId;
  }
  async rewrapCredentials(actor: Principal) {
    await this.manage(actor);
    await this.options.auth.authorize(actor, 'instance.admin');
    return this.options.db.transaction(async (tx) => {
      const rows = await tx.query<{
        id: string;
        owner_user_id: string | null;
        envelope: CredentialEnvelope;
      }>(
        'SELECT id,owner_user_id,envelope FROM sd_provider_credentials WHERE instance_id=$1 FOR UPDATE',
        [actor.instanceId],
      );
      for (const row of rows.rows) {
        const binding = {
          instanceId: actor.instanceId,
          credentialId: row.id,
          ownerUserId: row.owner_user_id,
        };
        const value = this.options.vault.open<unknown>(binding, row.envelope);
        await tx.query(
          'UPDATE sd_provider_credentials SET envelope=$3::jsonb,revision=revision+1,updated_at=now() WHERE instance_id=$1 AND id=$2',
          [
            actor.instanceId,
            row.id,
            JSON.stringify(this.options.vault.seal(binding, value)),
          ],
        );
      }
      return { rewrapped: rows.rows.length };
    });
  }
  async execute(
    job: JobInput,
    signal: AbortSignal,
    execution: JobExecutionContext,
  ) {
    const row = (
      await this.options.db.query<JobRow>(
        'SELECT * FROM sd_processing_jobs WHERE instance_id=$1 AND id=$2',
        [job.instanceId, job.jobId],
      )
    ).rows[0];
    if (!row || row.state !== 'queued')
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'The processing job cannot be replayed.',
      );
    const actor = row.actor;
    const generated: string[] = [];
    let committed = false;
    try {
      await this.manage(actor);
      if (row.radio_id)
        await this.authorize(actor, 'history.read', row.radio_id);
      await this.options.validateInputs(
        actor,
        row.request,
        row.source ?? undefined,
        undefined,
        row.radio_id ?? undefined,
      );
      const profile = await this.profile(actor, row.request.profileId);
      const connection = await this.connection(actor, profile.connectionId);
      const profileSnapshot = canonicalJson(profile);
      const connectionSnapshot = connectionFingerprint(connection);
      if (connection.status === 'revoked')
        throw new SignalDockError(
          'FORBIDDEN',
          'The processing connection was revoked.',
        );
      const claimed = await this.options.db.query(
        "UPDATE sd_processing_jobs SET state='running',updated_at=now() WHERE instance_id=$1 AND id=$2 AND state='queued'",
        [job.instanceId, job.jobId],
      );
      if (claimed.rowCount !== 1)
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'The processing job is already claimed.',
        );
      const authentication = await this.authentication(
        connection,
        actor,
        signal,
      );
      // Credential locks and refresh can outlast a source, permission or configuration change.
      signal.throwIfAborted();
      await this.manage(actor);
      if (row.radio_id)
        await this.authorize(actor, 'history.read', row.radio_id);
      await this.options.validateInputs(
        actor,
        row.request,
        row.source ?? undefined,
      );
      const activeProfile = await this.profile(actor, row.request.profileId);
      const activeConnection = await this.connection(
        actor,
        activeProfile.connectionId,
      );
      if (activeConnection.status === 'revoked')
        throw new SignalDockError(
          'FORBIDDEN',
          'The processing connection was revoked while credentials resolved.',
        );
      if (
        activeProfile.revision !== row.request.profileRevision ||
        canonicalJson(activeProfile) !== profileSnapshot ||
        activeProfile.connectionId !== profile.connectionId ||
        connectionFingerprint(activeConnection) !== connectionSnapshot
      )
        throw new SignalDockError(
          'STALE_REVISION',
          'The processing profile or connection changed while credentials resolved.',
        );
      signal.throwIfAborted();
      const result = await this.options.registry.execute(
        row.request,
        toConnection(activeConnection),
        activeProfile,
        actor,
        signal,
        {
          authentication,
          endpoint: activeConnection.endpoint,
          capabilities: activeConnection.capabilities,
          configuration: activeConnection.configuration,
          settings: activeProfile.settings ?? {},
          readArtifact: async (artifactId, cancellation) => {
            cancellation.throwIfAborted();
            await this.options.validateInputs(
              actor,
              row.request,
              row.source ?? undefined,
              undefined,
              row.radio_id ?? undefined,
            );
            const stored = await this.options.artifacts.read(
              actor.instanceId,
              artifactId,
            );
            cancellation.throwIfAborted();
            return {
              artifactId,
              bytes: stored.bytes,
              contentType: stored.metadata.contentType,
            };
          },
          writeArtifact: async (value, cancellation) => {
            cancellation.throwIfAborted();
            const artifactId = randomUUID();
            generated.push(artifactId);
            await this.options.artifacts.put({
              instanceId: actor.instanceId,
              artifactId,
              bytes: value.bytes,
              contentType: value.contentType,
            });
            cancellation.throwIfAborted();
            return { artifactId };
          },
        },
      );
      signal.throwIfAborted();
      await execution.commit(async (tx) => {
        await this.manage(actor, tx);
        if (row.radio_id)
          await this.authorize(actor, 'history.read', row.radio_id, tx);
        await this.options.validateInputs(
          actor,
          row.request,
          row.source ?? undefined,
          tx,
          row.radio_id ?? undefined,
        );
        const current = await this.profile(actor, row.request.profileId, tx);
        const latestConnection = await this.connection(
          actor,
          current.connectionId,
          tx,
        );
        if (
          current.revision !== row.request.profileRevision ||
          latestConnection.status === 'revoked'
        )
          throw new SignalDockError(
            'STALE_REVISION',
            'The processing profile or connection changed.',
          );
        const updated = await tx.query(
          "UPDATE sd_processing_jobs SET state='completed',result=$3::jsonb,updated_at=now() WHERE instance_id=$1 AND id=$2 AND state='running'",
          [job.instanceId, job.jobId, JSON.stringify(result)],
        );
        if (updated.rowCount !== 1)
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'The processing result was cancelled or superseded.',
          );
        await this.options.onCompleted?.(
          tx,
          actor,
          row.request,
          result,
          row.source ?? undefined,
        );
      });
      committed = true;
      // Health metadata must not turn an already committed result into a retried inference.
      await this.options.db
        .query(
          "UPDATE sd_processing_connections SET status='connected',updated_at=now() WHERE instance_id=$1 AND id=$2 AND status<>'revoked'",
          [actor.instanceId, profile.connectionId],
        )
        .catch(() => undefined);
      return result;
    } catch (error) {
      const code =
        error instanceof SignalDockError
          ? error.code
          : signal.aborted
            ? 'CANCELLED'
            : 'PROVIDER_UNAVAILABLE';
      await this.options.db.query(
        "UPDATE sd_processing_jobs SET state=$3,error=$4,updated_at=now() WHERE instance_id=$1 AND id=$2 AND state IN ('queued','running')",
        [
          job.instanceId,
          job.jobId,
          signal.aborted ? 'cancelled' : 'failed',
          code,
        ],
      );
      throw error;
    } finally {
      if (!committed)
        await Promise.allSettled(
          generated.map((artifactId) =>
            this.options.artifacts.delete(job.instanceId, artifactId),
          ),
        );
    }
  }
  private async profile(
    actor: ProcessingActor,
    id: string,
    db = this.options.db,
  ) {
    const row = (
      await db.query<{ profile: ProcessingProfile }>(
        'SELECT profile FROM sd_processing_profiles WHERE instance_id=$1 AND id=$2 FOR SHARE',
        [actor.instanceId, id],
      )
    ).rows[0];
    if (!row)
      throw new SignalDockError(
        'NOT_FOUND',
        'The processing profile was not found.',
      );
    const profile = ProcessingProfileSchema.parse(row.profile);
    await this.connection(actor, profile.connectionId, db);
    return profile;
  }
  private async authorizeOutput(actor: Principal, job: JobRow) {
    if (job.source) {
      if (!this.options.authorizeSourceRead)
        throw new SignalDockError(
          'REQUIRES_CONFIGURATION',
          'Processing source-read authorization is required.',
        );
      await this.options.authorizeSourceRead(actor, job.source);
    } else if (job.radio_id)
      await this.options.auth.authorize(actor, 'history.read', job.radio_id);
  }
  private async connection(
    actor: ProcessingActor,
    id: string,
    db = this.options.db,
  ) {
    const row = (
      await db.query<ConnectionRow>(
        'SELECT * FROM sd_processing_connections WHERE instance_id=$1 AND id=$2 AND (owner_user_id IS NULL OR owner_user_id=$3) FOR SHARE',
        [actor.instanceId, id, actor.userId],
      )
    ).rows[0];
    if (!row)
      throw new SignalDockError(
        'NOT_FOUND',
        'The processing connection was not found.',
      );
    return row;
  }
  private async saveCredential(
    db: DatabasePort,
    instanceId: string,
    credentialId: string,
    ownerUserId: string | null,
    value: StoredCredential,
  ) {
    const envelope = this.options.vault.seal(
      { instanceId, credentialId, ownerUserId },
      value,
    );
    await db.query(
      'INSERT INTO sd_provider_credentials(instance_id,id,owner_user_id,envelope) VALUES($1,$2,$3,$4::jsonb)',
      [instanceId, credentialId, ownerUserId, JSON.stringify(envelope)],
    );
  }
  private async credential(
    db: DatabasePort,
    connection: ConnectionRow,
  ): Promise<StoredCredential> {
    const row = (
      await db.query<{
        envelope: CredentialEnvelope;
        owner_user_id: string | null;
      }>(
        'SELECT envelope,owner_user_id FROM sd_provider_credentials WHERE instance_id=$1 AND id=$2 FOR UPDATE',
        [connection.instance_id, connection.credential_id],
      )
    ).rows[0];
    if (!row || row.owner_user_id !== connection.owner_user_id)
      throw new SignalDockError(
        'UNAUTHORIZED',
        'The linked credential is unavailable.',
      );
    const value = this.options.vault.open<StoredCredential>(
      scope(connection),
      row.envelope,
    );
    if (value.kind !== 'api-key' && value.kind !== 'subscription')
      throw new SignalDockError(
        'UNAUTHORIZED',
        'The linked credential was revoked.',
      );
    return value;
  }
  private async authentication(
    connection: ConnectionRow,
    actor: ProcessingActor,
    signal: AbortSignal,
  ): Promise<ProviderAuthentication> {
    if (!connection.credential_id) return { kind: 'none' };
    return this.options.db
      .transaction(async (tx) => {
        const value = await this.credential(tx, connection);
        if (value.kind === 'api-key')
          return { kind: 'api-key' as const, secret: value.secret };
        if (
          connection.owner_user_id !== actor.userId ||
          ('kind' in actor && actor.kind === 'service')
        )
          throw new SignalDockError(
            'FORBIDDEN',
            'Subscription credentials require their linked interactive user.',
          );
        let registration = value.registration;
        if (registration.expiresAt <= Date.now() + 60_000) {
          registration = await this.options.subscriptionOAuth.refresh(
            registration,
            signal,
          );
          await tx.query(
            'UPDATE sd_provider_credentials SET envelope=$3::jsonb,revision=revision+1,updated_at=now() WHERE instance_id=$1 AND id=$2',
            [
              actor.instanceId,
              connection.credential_id,
              JSON.stringify(
                this.options.vault.seal(scope(connection), {
                  kind: 'subscription',
                  registration,
                }),
              ),
            ],
          );
        }
        return {
          kind: 'oauth' as const,
          accessToken: registration.accessToken,
          userId: actor.userId,
          accountId: registration.subject,
          workspaceId: registration.clientId,
        };
      })
      .catch(async (error: unknown) => {
        if (
          error instanceof SignalDockError &&
          ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)
        )
          await this.options.db
            .query(
              "UPDATE sd_processing_connections SET status='expired',updated_at=now() WHERE instance_id=$1 AND id=$2 AND status<>'revoked'",
              [actor.instanceId, connection.id],
            )
            .catch(() => undefined);
        throw error;
      });
  }
  private async validateConsent(
    actor: { instanceId: string; userId: string; consentId: string },
    db: DatabasePort,
  ) {
    const consent = (
      await db.query<BackgroundConsent>(
        'SELECT * FROM sd_processing_background_consents WHERE instance_id=$1 AND id=$2 AND enabled=true FOR SHARE',
        [actor.instanceId, actor.consentId],
      )
    ).rows[0];
    if (!consent || consent.service_owner_user_id !== actor.userId)
      throw new SignalDockError(
        'FORBIDDEN',
        'Automatic processing consent is disabled or belongs to another service owner.',
      );
    const profile = await this.profile(
      actor as ProcessingActor,
      consent.profile_id,
      db,
    );
    const connection = await this.connection(
      actor as ProcessingActor,
      profile.connectionId,
      db,
    );
    if (
      profile.revision !== consent.profile_revision ||
      profile.connectionId !== consent.connection_id ||
      connection.endpoint !== consent.endpoint ||
      connectionFingerprint(connection) !== consent.connection_fingerprint ||
      connection.owner_user_id !== null ||
      !['configured', 'connected'].includes(connection.status)
    )
      throw new SignalDockError(
        'STALE_REVISION',
        'Automatic processing requires renewed consent for the changed provider, endpoint, or profile.',
      );
    return consent;
  }
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child && typeof child === 'object' && !Array.isArray(child))
      return Object.fromEntries(
        Object.entries(child).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    return child;
  });
}
function semanticFingerprint(
  request: ProcessingRequest,
  radioId: string | undefined,
  source: JobInput['source'] | undefined,
) {
  // Delivery IDs/deadlines change on replay; the first accepted job keeps its original deadline.
  return createHash('sha256')
    .update(
      canonicalJson({
        request: { ...request, jobId: undefined, deadline: undefined },
        radioId,
        source,
      }),
    )
    .digest('hex');
}
function connectionFingerprint(connection: ConnectionRow) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        connection.connector_id,
        connection.endpoint,
        connection.configuration,
        connection.capabilities,
        connection.owner_user_id,
        connection.credential_id,
      ]),
    )
    .digest('hex');
}
function scope(connection: ConnectionRow) {
  return {
    instanceId: connection.instance_id,
    credentialId: connection.credential_id!,
    ownerUserId: connection.owner_user_id,
  };
}
function toConnection(row: ConnectionRow): ProcessingConnection {
  return ProcessingConnectionSchema.parse({
    connectionId: row.id,
    instanceId: row.instance_id,
    connectorId: row.connector_id,
    owner: row.owner_user_id
      ? { kind: 'user', userId: row.owner_user_id }
      : { kind: 'instance' },
  });
}
function connectionView(row: ConnectionRow): ProcessingConnectionView {
  return {
    connection: toConnection(row),
    displayName: row.display_name,
    endpoint: row.endpoint,
    capabilities: row.capabilities,
    configuration: row.configuration,
    status: row.status,
    hasCredentials: row.credential_id !== null,
  };
}
function jobView(row: JobRow): ProcessingJobView {
  return {
    jobId: row.id,
    instanceId: row.instance_id,
    profileId: row.request.profileId,
    ...(row.radio_id ? { radioId: row.radio_id } : {}),
    task: row.request.task,
    state: row.state,
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}
function assertSafeConfiguration(value: Record<string, unknown>) {
  const inspect = (input: unknown): boolean =>
    Array.isArray(input)
      ? input.some(inspect)
      : input !== null && typeof input === 'object'
        ? Object.entries(input).some(
            ([key, child]) =>
              /token|secret|password|key|authorization/i.test(key) ||
              inspect(child),
          )
        : false;
  if (JSON.stringify(value).length > 16000 || inspect(value))
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Credentials must use the encrypted credential field, never configuration or profile settings.',
    );
}
