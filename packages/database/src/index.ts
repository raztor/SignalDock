import { createHash } from 'node:crypto';
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';
import type { DatabasePort, MigrationDefinition } from '@signaldock/contracts';
export type { MigrationDefinition } from '@signaldock/contracts';

class TransactionDatabase implements DatabasePort {
  private active = true;
  private savepoint = 0;
  constructor(private readonly client: PoolClient) {}
  async query<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    if (!this.active) throw new Error('Transaction is no longer active.');
    const result = await this.client.query<T & QueryResultRow>(text, [
      ...values,
    ]);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  async transaction<T>(
    run: (database: DatabasePort) => Promise<T>,
  ): Promise<T> {
    const name = `sd_savepoint_${++this.savepoint}`;
    await this.query(`SAVEPOINT ${name}`);
    try {
      const result = await run(this);
      await this.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await this.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }
  close(): void {
    this.active = false;
  }
}

export class PostgresDatabase implements DatabasePort {
  private readonly pool: Pool;
  constructor(config: PoolConfig) {
    this.pool = new Pool({
      max: 10,
      connectionTimeoutMillis: 10000,
      ...config,
    });
    this.pool.on('error', () => {
      /* An unavailable idle connection is replaced by the pool; requests report their own failure. */
    });
  }
  async query<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    const result = await this.pool.query<T & QueryResultRow>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  async transaction<T>(
    run: (database: DatabasePort) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const tx = new TransactionDatabase(client);
    try {
      await client.query('BEGIN');
      const result = await run(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      tx.close();
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  async health(): Promise<{ available: boolean }> {
    try {
      await this.query('SELECT 1');
      return { available: true };
    } catch {
      return { available: false };
    }
  }
}

/** Serializes migrations and rejects edited history instead of replaying changed SQL. */
export async function migrate(
  database: DatabasePort,
  definitions: readonly MigrationDefinition[],
): Promise<void> {
  const migrations = [...definitions].sort((a, b) => a.id.localeCompare(b.id));
  const identifiers = new Set<string>();
  for (const migration of migrations) {
    if (
      !/^\d{3}_[a-z0-9_]+$/.test(migration.id) ||
      identifiers.has(migration.id)
    )
      throw new Error(
        'Migration IDs must be unique and ordered numeric names.',
      );
    identifiers.add(migration.id);
  }
  await database.transaction(async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('signaldock:migrations'))",
    );
    await tx.query(
      'CREATE TABLE IF NOT EXISTS sd_schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const existing = await tx.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM sd_schema_migrations ORDER BY id',
    );
    const known = new Map(existing.rows.map((row) => [row.id, row.checksum]));
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      if (known.has(migration.id)) {
        if (known.get(migration.id) !== checksum)
          throw new Error(`Applied migration was modified: ${migration.id}`);
        continue;
      }
      const latest = existing.rows.at(-1)?.id;
      if (latest && migration.id < latest)
        throw new Error(`Migration precedes applied history: ${migration.id}`);
      await tx.query(migration.sql);
      await tx.query(
        'INSERT INTO sd_schema_migrations (id, checksum) VALUES ($1,$2)',
        [migration.id, checksum],
      );
    }
  });
}

export const foundationMigrations: readonly MigrationDefinition[] = [
  {
    id: '001_foundation',
    sql: `
CREATE TABLE sd_event_outbox (
  instance_id uuid NOT NULL, id uuid NOT NULL, type text NOT NULL, radio_id uuid,
  payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id,id)
);
CREATE INDEX sd_event_outbox_pending ON sd_event_outbox (occurred_at,id) WHERE delivered_at IS NULL;
CREATE TABLE sd_jobs (
  instance_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL, payload jsonb NOT NULL,
  idempotency_key text NOT NULL, state text NOT NULL CHECK (state IN ('queued','running','retry_wait','completed','failed','cancelled','requires_configuration')),
  deadline timestamptz NOT NULL, max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  attempt integer NOT NULL DEFAULT 0, result jsonb, error text, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id,id), UNIQUE(instance_id,kind,idempotency_key)
);
CREATE TABLE sd_job_attempts (
  instance_id uuid NOT NULL, id uuid NOT NULL, job_id uuid NOT NULL, attempt integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, error text,
  PRIMARY KEY (instance_id,id), UNIQUE(instance_id,job_id,attempt),
  FOREIGN KEY(instance_id,job_id) REFERENCES sd_jobs(instance_id,id)
);
`,
  },
];

export async function appendOutbox(
  database: DatabasePort,
  event: {
    instanceId: string;
    id: string;
    type: string;
    radioId?: string;
    payload: unknown;
  },
): Promise<void> {
  await database.query(
    'INSERT INTO sd_event_outbox(instance_id,id,type,radio_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(instance_id,id) DO NOTHING',
    [
      event.instanceId,
      event.id,
      event.type,
      event.radioId ?? null,
      JSON.stringify(event.payload),
    ],
  );
}

/** Handler must be idempotent: a crash after delivery can cause an event to repeat. */
export async function dispatchOutbox(
  database: DatabasePort,
  deliver: (event: {
    instanceId: string;
    id: string;
    type: string;
    radioId?: string;
    payload: unknown;
  }) => Promise<void>,
  limit = 50,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('Invalid outbox batch limit.');
  return database.transaction(async (tx) => {
    const batch = await tx.query<{
      instance_id: string;
      id: string;
      type: string;
      radio_id: string | null;
      payload: unknown;
    }>(
      'SELECT instance_id,id,type,radio_id,payload FROM sd_event_outbox WHERE delivered_at IS NULL ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT $1',
      [limit],
    );
    for (const row of batch.rows) {
      await deliver({
        instanceId: row.instance_id,
        id: row.id,
        type: row.type,
        ...(row.radio_id ? { radioId: row.radio_id } : {}),
        payload: row.payload,
      });
      await tx.query(
        'UPDATE sd_event_outbox SET delivered_at=now(),attempts=attempts+1 WHERE instance_id=$1 AND id=$2',
        [row.instance_id, row.id],
      );
    }
    return batch.rows.length;
  });
}
