import { createHash, randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { appendOutbox } from '@signaldock/database';
import {
  IdSchema,
  SignalDockError,
  type DatabasePort,
  type JobExecutionContext,
  type JobHandler,
  type JobInput,
  type JobQueuePort,
  type JobSnapshot,
  type JobState,
} from '@signaldock/contracts';

type JobRow = {
  instance_id: string;
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  source: JobInput['source'] | null;
  idempotency_key: string;
  state: JobState;
  deadline: Date;
  max_attempts: number;
  attempt: number;
  error: string | null;
};

export interface PostgresJobQueueOptions {
  connectionString: string;
  instanceId?: string;
  schema?: string;
  concurrency?: number;
  maxPendingPerInstance?: number;
  validateSource?: (job: JobInput, database: DatabasePort) => Promise<boolean>;
  onError?: (error: Error) => void;
}

const queueName = 'signaldock_jobs';
function schedulerId(instanceId: string, jobId: string): string {
  const bytes = createHash('sha256')
    .update(`${instanceId}:${jobId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function json(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (
      typeof entry === 'function' ||
      typeof entry === 'bigint' ||
      typeof entry === 'undefined' ||
      (typeof entry === 'number' && !Number.isFinite(entry))
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Job payload must contain JSON values.',
      );
    return entry;
  });
}

export class PostgresJobQueue implements JobQueuePort {
  private readonly boss: PgBoss;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly active = new Map<string, AbortController>();
  private publisher: ReturnType<typeof setInterval> | undefined;
  private publishing = false;
  private started = false;
  constructor(
    private readonly database: DatabasePort,
    private readonly options: PostgresJobQueueOptions,
  ) {
    if (options.instanceId !== undefined) IdSchema.parse(options.instanceId);
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema:
        options.schema ??
        (options.instanceId
          ? `sd_queue_${options.instanceId.replaceAll('-', '').toLowerCase()}`
          : 'sd_queue'),
      max: 4,
    });
    this.boss.on('error', (error: Error) => options.onError?.(error));
    const concurrency = options.concurrency ?? 2;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error('Worker concurrency must be from 1 to 8.');
  }
  register(kind: string, handler: JobHandler): void {
    if (
      this.started ||
      this.handlers.has(kind) ||
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(kind)
    )
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'Register a unique valid handler before starting the worker.',
      );
    this.handlers.set(kind, handler);
  }
  async enqueue(
    input: JobInput,
    transaction?: DatabasePort,
  ): Promise<{ jobId: string; duplicate: boolean }> {
    IdSchema.parse(input.instanceId);
    this.assertInstance(input.instanceId);
    IdSchema.parse(input.jobId);
    if (
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(input.kind) ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 256 ||
      !Number.isFinite(Date.parse(input.deadline)) ||
      Date.parse(input.deadline) <= Date.now()
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Invalid or expired background job.',
      );
    const maximum = input.maxAttempts ?? 3;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 20)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Invalid maximum attempts.',
      );
    const payload = json(input.payload);
    if (Buffer.byteLength(payload) > 65536)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Job payload exceeds the limit.',
      );
    if (input.source) {
      IdSchema.parse(input.source.communicationId);
      if (
        !Number.isSafeInteger(input.source.communicationRevision) ||
        input.source.communicationRevision < 0
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Invalid source revision.',
        );
      if (input.source.artifactId) IdSchema.parse(input.source.artifactId);
      if (input.source.transcriptRevisionId)
        IdSchema.parse(input.source.transcriptRevisionId);
    }
    const source = input.source ? json(input.source) : null;
    const persist = async (tx: DatabasePort) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('sd_jobs:' || $1))",
        [input.instanceId],
      );
      const existing = await tx.query<{ id: string; matches: boolean }>(
        'SELECT id,(payload=$4::jsonb AND source IS NOT DISTINCT FROM $5::jsonb) AS matches FROM sd_jobs WHERE instance_id=$1 AND kind=$2 AND idempotency_key=$3',
        [input.instanceId, input.kind, input.idempotencyKey, payload, source],
      );
      if (existing.rows[0]) {
        if (!existing.rows[0].matches)
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'The job idempotency key was reused with different content.',
          );
        return { jobId: existing.rows[0].id, duplicate: true };
      }
      const count = await tx.query<{ count: string }>(
        "SELECT count(*) AS count FROM sd_jobs WHERE instance_id=$1 AND state IN ('queued','running','retry_wait')",
        [input.instanceId],
      );
      if (
        Number(count.rows[0]!.count) >=
        (this.options.maxPendingPerInstance ?? 1000)
      )
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'The instance background queue is full.',
        );
      await tx.query(
        "INSERT INTO sd_jobs(instance_id,id,kind,payload,source,idempotency_key,state,deadline,max_attempts) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8)",
        [
          input.instanceId,
          input.jobId,
          input.kind,
          payload,
          source,
          input.idempotencyKey,
          input.deadline,
          maximum,
        ],
      );
      await appendOutbox(tx, {
        instanceId: input.instanceId,
        id: randomUUID(),
        type: 'job.enqueue',
        payload: { instanceId: input.instanceId, jobId: input.jobId },
      });
      return { jobId: input.jobId, duplicate: false };
    };
    return transaction
      ? persist(transaction)
      : this.database.transaction(persist);
  }
  async get(instanceId: string, jobId: string): Promise<JobSnapshot | null> {
    if (!this.includesInstance(instanceId)) return null;
    const result = await this.database.query<JobRow>(
      'SELECT * FROM sd_jobs WHERE instance_id=$1 AND id=$2',
      [instanceId, jobId],
    );
    const row = result.rows[0];
    return row
      ? {
          instanceId,
          jobId,
          state: row.state,
          attempts: row.attempt,
          ...(row.error ? { error: row.error } : {}),
        }
      : null;
  }
  async cancel(instanceId: string, jobId: string): Promise<void> {
    this.assertInstance(instanceId);
    await this.database.query(
      "UPDATE sd_jobs SET state='cancelled',cancelled_at=now(),updated_at=now() WHERE instance_id=$1 AND id=$2 AND state IN ('queued','running','retry_wait','requires_configuration')",
      [instanceId, jobId],
    );
    this.active
      .get(`${instanceId}:${jobId}`)
      ?.abort(new Error('Job cancelled.'));
    if (this.started)
      await this.boss.cancel(queueName, schedulerId(instanceId, jobId));
  }
  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    await this.boss.createQueue(queueName, {
      retryLimit: 2,
      retryDelay: 1,
      retryBackoff: true,
      expireInSeconds: 300,
    });
    this.started = true;
    await this.boss.work<{ instanceId: string; jobId: string }>(
      queueName,
      {
        batchSize: 1,
        localConcurrency: this.options.concurrency ?? 2,
        pollingIntervalSeconds: 0.5,
      },
      async (jobs) => {
        for (const job of jobs)
          await this.execute(job.data.instanceId, job.data.jobId);
      },
    );
    await this.publishPending();
    this.publisher = setInterval(() => {
      void this.publishPending().catch((error) =>
        this.options.onError?.(error as Error),
      );
    }, 500);
    this.publisher.unref();
  }
  async stop(): Promise<void> {
    if (this.publisher) clearInterval(this.publisher);
    for (const controller of this.active.values())
      controller.abort(new Error('Worker is stopping.'));
    await this.boss.stop({ graceful: true, timeout: 5000 });
    this.started = false;
  }
  async publishPending(): Promise<number> {
    if (this.publishing || !this.started) return 0;
    this.publishing = true;
    try {
      return await this.database.transaction(async (tx) => {
        const events = await tx.query<{
          instance_id: string;
          id: string;
          payload: { instanceId: string; jobId: string };
        }>(
          `SELECT instance_id,id,payload FROM sd_event_outbox WHERE type='job.enqueue' AND delivered_at IS NULL${this.options.instanceId === undefined ? '' : ' AND instance_id=$1::uuid'} ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT 50`,
          this.options.instanceId === undefined
            ? []
            : [this.options.instanceId],
        );
        for (const event of events.rows) {
          const records = await tx.query<JobRow>(
            'SELECT * FROM sd_jobs WHERE instance_id=$1 AND id=$2',
            [event.instance_id, event.payload.jobId],
          );
          const row = records.rows[0];
          if (row && ['queued', 'retry_wait', 'running'].includes(row.state))
            await this.boss.send(
              queueName,
              { instanceId: row.instance_id, jobId: row.id },
              {
                id: schedulerId(row.instance_id, row.id),
                retryLimit: row.max_attempts - 1,
                expireInSeconds: Math.max(
                  1,
                  Math.ceil((row.deadline.getTime() - Date.now()) / 1000),
                ),
              },
            );
          await tx.query(
            'UPDATE sd_event_outbox SET delivered_at=now(),attempts=attempts+1 WHERE instance_id=$1 AND id=$2',
            [event.instance_id, event.id],
          );
        }
        return events.rows.length;
      });
    } finally {
      this.publishing = false;
    }
  }
  private input(row: JobRow): JobInput {
    return {
      jobId: row.id,
      instanceId: row.instance_id,
      kind: row.kind,
      payload: row.payload,
      idempotencyKey: row.idempotency_key,
      deadline: row.deadline.toISOString(),
      maxAttempts: row.max_attempts,
      ...(row.source ? { source: row.source } : {}),
    };
  }
  private async currentSource(
    input: JobInput,
    tx: DatabasePort,
  ): Promise<boolean> {
    if (!('source' in input) || !input.source) return true;
    return this.options.validateSource
      ? this.options.validateSource(input, tx)
      : false;
  }
  private async execute(instanceId: string, jobId: string): Promise<void> {
    if (!this.includesInstance(instanceId)) return;
    const claimed = await this.database.transaction(async (tx) => {
      const preview = await tx.query<JobRow>(
        'SELECT * FROM sd_jobs WHERE instance_id=$1 AND id=$2',
        [instanceId, jobId],
      );
      const sourceCurrent = preview.rows[0]
        ? await this.currentSource(this.input(preview.rows[0]), tx)
        : false;
      const found = await tx.query<JobRow>(
        'SELECT * FROM sd_jobs WHERE instance_id=$1 AND id=$2 FOR UPDATE',
        [instanceId, jobId],
      );
      const row = found.rows[0];
      if (
        !row ||
        ['completed', 'cancelled', 'failed', 'requires_configuration'].includes(
          row.state,
        )
      )
        return null;
      const input = this.input(row);
      if (row.deadline.getTime() <= Date.now() || !sourceCurrent) {
        await tx.query(
          "UPDATE sd_jobs SET state='cancelled',cancelled_at=now(),updated_at=now() WHERE instance_id=$1 AND id=$2",
          [instanceId, jobId],
        );
        return null;
      }
      const handler = this.handlers.get(row.kind);
      if (!handler) {
        await tx.query(
          "UPDATE sd_jobs SET state='requires_configuration',error='No task handler is installed.',updated_at=now() WHERE instance_id=$1 AND id=$2",
          [instanceId, jobId],
        );
        return null;
      }
      await tx.query(
        "UPDATE sd_jobs SET state='running',attempt=attempt+1,error=NULL,updated_at=now() WHERE instance_id=$1 AND id=$2",
        [instanceId, jobId],
      );
      row.attempt++;
      await tx.query(
        'INSERT INTO sd_job_attempts(instance_id,id,job_id,attempt) VALUES($1,$2,$3,$4)',
        [instanceId, randomUUID(), jobId, row.attempt],
      );
      return { row, input, handler };
    });
    if (!claimed) return;
    const { row, input, handler } = claimed;
    const controller = new AbortController();
    const key = `${instanceId}:${jobId}`;
    this.active.set(key, controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('Job deadline exceeded.')),
      Math.max(1, Math.min(2147483647, row.deadline.getTime() - Date.now())),
    );
    const cancellation = setInterval(() => {
      void this.database
        .query<{ state: string; attempt: number }>(
          'SELECT state,attempt FROM sd_jobs WHERE instance_id=$1 AND id=$2',
          [instanceId, jobId],
        )
        .then((result) => {
          if (
            result.rows[0]?.state !== 'running' ||
            result.rows[0]?.attempt !== row.attempt
          )
            controller.abort(new Error('Job is no longer current.'));
        })
        .catch(() => controller.abort(new Error('Job supervision failed.')));
    }, 250);
    let committed = false;
    let sourceInvalid = false;
    const execution: JobExecutionContext = {
      commit: async <T>(
        write: (tx: DatabasePort) => Promise<T>,
      ): Promise<T> => {
        controller.signal.throwIfAborted();
        if (committed)
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'A job result can only be committed once.',
          );
        const result = await this.database.transaction(async (tx) => {
          if (!(await this.currentSource(input, tx))) {
            sourceInvalid = true;
            throw new SignalDockError(
              'STALE_REVISION',
              'The job source is no longer current.',
            );
          }
          const current = await tx.query<JobRow>(
            'SELECT * FROM sd_jobs WHERE instance_id=$1 AND id=$2 FOR UPDATE',
            [instanceId, jobId],
          );
          const latest = current.rows[0];
          if (
            !latest ||
            latest.state !== 'running' ||
            latest.attempt !== row.attempt ||
            latest.deadline.getTime() <= Date.now()
          )
            throw new SignalDockError(
              'OPERATION_CONFLICT',
              'The job attempt is no longer active.',
            );
          controller.signal.throwIfAborted();
          const value = await write(tx);
          controller.signal.throwIfAborted();
          if (latest.deadline.getTime() <= Date.now())
            throw new SignalDockError(
              'DEADLINE_EXCEEDED',
              'The job deadline expired during result commit.',
            );
          await tx.query(
            "UPDATE sd_jobs SET state='completed',result=$4,updated_at=now() WHERE instance_id=$1 AND id=$2 AND attempt=$3",
            [instanceId, jobId, row.attempt, json(value ?? null)],
          );
          return value;
        });
        committed = true;
        return result;
      },
    };
    try {
      const result = await abortable(
        handler(input, controller.signal, execution),
        controller.signal,
      );
      if (!committed) await execution.commit(async () => result);
    } catch (error) {
      const message =
        error instanceof SignalDockError
          ? `Background task failed (${error.code}).`
          : 'Background task failed.';
      const configurationMissing =
        error instanceof SignalDockError &&
        error.code === 'REQUIRES_CONFIGURATION';
      await this.database.query(
        "UPDATE sd_jobs SET state=CASE WHEN cancelled_at IS NOT NULL OR deadline<=now() OR $5 THEN 'cancelled' WHEN $6 THEN 'requires_configuration' WHEN attempt>=max_attempts THEN 'failed' ELSE 'retry_wait' END,error=$4,updated_at=now() WHERE instance_id=$1 AND id=$2 AND attempt=$3 AND state='running'",
        [
          instanceId,
          jobId,
          row.attempt,
          message,
          sourceInvalid,
          configurationMissing,
        ],
      );
      if ((await this.get(instanceId, jobId))?.state === 'retry_wait')
        throw new Error(message);
    } finally {
      clearTimeout(timeout);
      clearInterval(cancellation);
      this.active.delete(key);
      await this.database.query(
        'UPDATE sd_job_attempts SET completed_at=now() WHERE instance_id=$1 AND job_id=$2 AND attempt=$3',
        [instanceId, jobId, row.attempt],
      );
    }
  }
  private includesInstance(instanceId: string): boolean {
    return (
      this.options.instanceId === undefined ||
      this.options.instanceId.toLowerCase() === instanceId.toLowerCase()
    );
  }
  private assertInstance(instanceId: string): void {
    if (!this.includesInstance(instanceId))
      throw new SignalDockError(
        'FORBIDDEN',
        'This worker belongs to another instance.',
      );
  }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
