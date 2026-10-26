import { createHash } from 'node:crypto';
import {
  IdSchema,
  TimestampSchema,
  SignalDockError,
  type ArtifactStoragePort,
  type AuthenticationPort,
  type DatabasePort,
  type JobHandler,
  type JobQueuePort,
  type JobState,
  type Principal,
} from '@signaldock/contracts';
import {
  decodeRecording,
  type AudioDecodeMode,
  type AudioDecodeResult,
} from '@signaldock/digital-decoders';
import { normalizeReceivedPacket } from './service.js';
import { PostgresDigitalRepository } from './repository.js';

export interface RecordingDecodeContext {
  communicationId: string;
  communicationRevision: number;
  radioId: string;
  startedAt: string;
  frequencyHz?: number;
  attribution: 'confirmed' | 'inferred' | 'unknown';
}
export type RecordingContextResolver = (
  instanceId: string,
  artifactId: string,
) => Promise<RecordingDecodeContext | null>;
export interface DecoderRun {
  runId: string;
  instanceId: string;
  radioId: string;
  artifactId: string;
  mode: AudioDecodeMode;
  state: JobState;
  requestedBy: string;
  createdAt: string;
  completedAt?: string;
  result?: AudioDecodeResult;
  error?: string;
}

function parseMode(value: unknown): AudioDecodeMode {
  if (value !== 'AFSK1200' && value !== 'DTMF')
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'Only AFSK1200 and DTMF are implemented.',
    );
  return value;
}

export class DigitalDecodingService {
  constructor(
    private readonly deps: {
      database: DatabasePort;
      auth: AuthenticationPort;
      queue: JobQueuePort;
      resolveRecording: RecordingContextResolver;
    },
  ) {}
  async create(
    principal: Principal,
    input: { operationId: string; artifactId: string; mode: AudioDecodeMode },
  ): Promise<{ runId: string; duplicate: boolean }> {
    const runId = IdSchema.parse(input.operationId);
    const artifactId = IdSchema.parse(input.artifactId);
    const mode = parseMode(input.mode);
    const source = await this.deps.resolveRecording(
      principal.instanceId,
      artifactId,
    );
    if (!source)
      throw new SignalDockError('NOT_FOUND', 'Available recording not found.');
    await this.deps.auth.authorize(principal, 'history.read', source.radioId);
    await this.deps.auth.authorize(principal, 'aprs.read', source.radioId);
    return this.deps.database.transaction(async (transaction) => {
      const inserted = await transaction.query(
        `INSERT INTO sd_digital_decoder_runs
        (instance_id,run_id,radio_id,artifact_id,mode,state,requested_by,created_at)
        VALUES($1,$2,$3,$4,$5,'queued',$6,$7) ON CONFLICT(instance_id,run_id) DO NOTHING RETURNING run_id`,
        [
          principal.instanceId,
          runId,
          source.radioId,
          artifactId,
          mode,
          principal.userId,
          new Date().toISOString(),
        ],
      );
      if (!inserted.rowCount) {
        const previous = await transaction.query(
          'SELECT artifact_id,mode,requested_by FROM sd_digital_decoder_runs WHERE instance_id=$1 AND run_id=$2',
          [principal.instanceId, runId],
        );
        const existing = previous.rows[0];
        if (
          !existing ||
          existing['artifact_id'] !== artifactId ||
          existing['mode'] !== mode ||
          existing['requested_by'] !== principal.userId
        )
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'Decoder operation ID was reused with different input.',
          );
        return { runId, duplicate: true };
      }
      await this.deps.queue.enqueue(
        {
          jobId: runId,
          instanceId: principal.instanceId,
          kind: 'digital.decode',
          payload: { artifactId, mode, radioId: source.radioId },
          idempotencyKey: `digital:${runId}`,
          deadline: new Date(Date.now() + 60000).toISOString(),
          maxAttempts: 1,
          source: {
            communicationId: source.communicationId,
            communicationRevision: source.communicationRevision,
            artifactId,
          },
        },
        transaction,
      );
      return { runId, duplicate: false };
    });
  }

  async get(principal: Principal, runId: string): Promise<DecoderRun> {
    IdSchema.parse(runId);
    const result = await this.deps.database.query(
      'SELECT * FROM sd_digital_decoder_runs WHERE instance_id=$1 AND run_id=$2',
      [principal.instanceId, runId],
    );
    const row = result.rows[0];
    if (!row) throw new SignalDockError('NOT_FOUND', 'Decoder run not found.');
    const radioId = String(row['radio_id']);
    await this.deps.auth.authorize(principal, 'history.read', radioId);
    await this.deps.auth.authorize(principal, 'aprs.read', radioId);
    const job = await this.deps.queue.get(principal.instanceId, runId);
    return {
      runId,
      instanceId: principal.instanceId,
      radioId,
      artifactId: String(row['artifact_id']),
      mode: parseMode(row['mode']),
      state: job?.state ?? (row['state'] as JobState),
      requestedBy: String(row['requested_by']),
      createdAt: iso(row['created_at']),
      ...(row['completed_at'] ? { completedAt: iso(row['completed_at']) } : {}),
      ...(row['result'] ? { result: row['result'] as AudioDecodeResult } : {}),
      ...((row['error'] ?? job?.error)
        ? { error: String(row['error'] ?? job?.error) }
        : {}),
    };
  }
  async cancel(principal: Principal, runId: string): Promise<void> {
    const run = await this.get(principal, runId);
    if (run.requestedBy !== principal.userId)
      await this.deps.auth.authorize(
        principal,
        'processing.manage',
        run.radioId,
      );
    await this.deps.queue.cancel(principal.instanceId, runId);
    await this.deps.database.query(
      "UPDATE sd_digital_decoder_runs SET state='cancelled' WHERE instance_id=$1 AND run_id=$2 AND state NOT IN ('completed','failed')",
      [principal.instanceId, runId],
    );
  }
}

export function createDigitalDecodeHandler(deps: {
  database: DatabasePort;
  storage: ArtifactStoragePort;
  resolveRecording: RecordingContextResolver;
}): JobHandler {
  return async (job, signal, execution) => {
    IdSchema.parse(job.instanceId);
    IdSchema.parse(job.jobId);
    const artifactId = IdSchema.parse(job.payload['artifactId']);
    const mode = parseMode(job.payload['mode']);
    signal.throwIfAborted();
    TimestampSchema.parse(job.deadline);
    if (Date.parse(job.deadline) <= Date.now())
      throw new SignalDockError('DEADLINE_EXCEEDED', 'Decoder job expired.');
    const source = await deps.resolveRecording(job.instanceId, artifactId);
    if (
      !source ||
      !job.source ||
      job.source.communicationId !== source.communicationId ||
      job.source.communicationRevision !== source.communicationRevision ||
      job.source.artifactId !== artifactId ||
      job.payload['radioId'] !== source.radioId
    ) {
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'The source recording was deleted, revised, or replaced.',
      );
    }
    const previous = await deps.database.query(
      "SELECT result FROM sd_digital_decoder_runs WHERE instance_id=$1 AND run_id=$2 AND state='completed'",
      [job.instanceId, job.jobId],
    );
    if (previous.rows[0]?.['result']) return previous.rows[0]['result'];
    const artifact = await deps.storage.read(job.instanceId, artifactId, {
      start: 0,
      end: 16 * 1024 * 1024,
    });
    if (
      artifact.metadata.instanceId !== job.instanceId ||
      artifact.metadata.artifactId !== artifactId ||
      artifact.metadata.sizeBytes > 16 * 1024 * 1024 ||
      artifact.bytes.byteLength !== artifact.metadata.sizeBytes
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Decoder artifact metadata is invalid.',
      );
    const started = await deps.database.query(
      "UPDATE sd_digital_decoder_runs SET state='running' WHERE instance_id=$1 AND run_id=$2 AND state IN ('queued','running') RETURNING run_id",
      [job.instanceId, job.jobId],
    );
    if (started.rowCount !== 1)
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'Decoder run is no longer active.',
      );
    const result = await decodeRecording(mode, artifact.bytes, {
      signal,
      timeoutMs: Math.min(
        10000,
        Math.max(1, Date.parse(job.deadline) - Date.now()),
      ),
    });
    signal.throwIfAborted();
    return execution.commit(async (transaction) => {
      const run = await transaction.query(
        'SELECT state FROM sd_digital_decoder_runs WHERE instance_id=$1 AND run_id=$2 FOR UPDATE',
        [job.instanceId, job.jobId],
      );
      if (!run.rows[0] || run.rows[0]['state'] === 'cancelled')
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'Decoder run was cancelled or removed.',
        );
      signal.throwIfAborted();
      if (Date.parse(job.deadline) <= Date.now())
        throw new SignalDockError(
          'DEADLINE_EXCEEDED',
          'Decoder job expired before commit.',
        );
      // Nested repository transactions reuse this locked transaction instead of opening a new connection.
      const scoped: DatabasePort = {
        query: (text, values) => transaction.query(text, values),
        transaction: (action) => action(transaction),
      };
      const repository = new PostgresDigitalRepository(scoped);
      for (const [index, decoded] of result.packets.entries()) {
        signal.throwIfAborted();
        const packet = normalizeReceivedPacket({
          packetId: derivedId(`${job.instanceId}:${job.jobId}:${index}`),
          instanceId: job.instanceId,
          radioId: source.radioId,
          receivedAt: new Date(
            Date.parse(source.startedAt) + decoded.offsetMs,
          ).toISOString(),
          source: 'recording',
          rawFrame: Buffer.from(decoded.frameBase64, 'base64'),
          includesFcs: true,
          ...(source.frequencyHz === undefined
            ? {}
            : { frequencyHz: source.frequencyHz }),
          attribution: source.attribution,
        });
        packet.parsed = {
          ...packet.parsed,
          recording: {
            artifactId,
            communicationId: source.communicationId,
            communicationRevision: source.communicationRevision,
            decoderRunId: job.jobId,
            offsetMs: decoded.offsetMs,
            decoderId: result.decoderId,
            decoderVersion: result.decoderVersion,
          },
        };
        await repository.ingest(
          packet,
          createHash('sha256').update(decoded.text).digest('hex'),
        );
      }
      signal.throwIfAborted();
      const updated = await transaction.query(
        "UPDATE sd_digital_decoder_runs SET state='completed',result=$3::jsonb,completed_at=$4 WHERE instance_id=$1 AND run_id=$2 AND state <> 'cancelled'",
        [
          job.instanceId,
          job.jobId,
          JSON.stringify(result),
          new Date().toISOString(),
        ],
      );
      if (updated.rowCount !== 1)
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'Decoder run changed before commit.',
        );
      return result;
    });
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function derivedId(value: string): string {
  const hash = createHash('sha256').update(value).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
