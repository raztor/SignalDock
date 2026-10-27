import type { DatabasePort, MigrationDefinition } from '@signaldock/contracts';
import type {
  DeliveryResult,
  RelayChallenge,
  RelayGrant,
  RelayInstallation,
} from '@signaldock/notification-sdk';
import { RelayError } from '@signaldock/notification-sdk';

export interface StoredDelivery extends DeliveryResult {
  grantId: string;
  installationId: string;
  /** Null means a pre-generation delivery whose receiving registration is unknown. */
  registrationId: string | null;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  receiptChecked: boolean;
  receiptAttempts: number;
  receiptNextCheckAt: string;
  receiptRetryUntil: string;
  receiptLastCheckedAt: string | null;
}
export interface RelayTransaction {
  getChallenge(id: string): Promise<RelayChallenge | null>;
  saveChallenge(challenge: RelayChallenge): Promise<void>;
  deleteChallenge(id: string): Promise<void>;
  getInstallation(id: string): Promise<RelayInstallation | null>;
  saveInstallation(installation: RelayInstallation): Promise<void>;
  getGrant(id: string): Promise<RelayGrant | null>;
  saveGrant(grant: RelayGrant): Promise<void>;
  revokeGrants(
    installationId: string,
    revokedAt: string,
    grantId?: string,
  ): Promise<void>;
  consumeNonce(
    scope: string,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean>;
  getDelivery(requestId: string): Promise<StoredDelivery | null>;
  countDeliveries(
    installationId: string,
    grantId: string,
    since: string,
  ): Promise<{ installation: number; grant: number }>;
  saveDelivery(delivery: StoredDelivery): Promise<void>;
  pendingReceipts(time: string): Promise<StoredDelivery[]>;
}
export interface RelayStore {
  transaction<T>(action: (tx: RelayTransaction) => Promise<T>): Promise<T>;
  cleanup(expiredBefore: string, deliveryBefore?: string): Promise<void>;
}

/** An independent relay schema; it must not share the instance credential store. */
export const relaySchemaSql = `
CREATE SCHEMA IF NOT EXISTS sd_relay;
CREATE TABLE IF NOT EXISTS sd_relay.installations (
  id uuid PRIMARY KEY, document jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS sd_relay.challenges (
  id uuid PRIMARY KEY, expires_at timestamptz NOT NULL, document jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS sd_relay.grants (
  id uuid PRIMARY KEY, installation_id uuid NOT NULL REFERENCES sd_relay.installations(id), document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_grants_installation ON sd_relay.grants(installation_id);
CREATE TABLE IF NOT EXISTS sd_relay.nonces (
  scope text NOT NULL, nonce uuid NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(scope,nonce)
);
CREATE TABLE IF NOT EXISTS sd_relay.deliveries (
  id uuid PRIMARY KEY, installation_id uuid NOT NULL, grant_id uuid NOT NULL,
  created_at timestamptz NOT NULL, document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_delivery_quota ON sd_relay.deliveries(installation_id,created_at);
`;

/** Keep 001 unchanged: previously accepted receipts cannot safely be attributed to today's token. */
export const relayMigrations: readonly MigrationDefinition[] = [
  { id: '001_private_relay', sql: relaySchemaSql },
  {
    id: '002_registration_generation',
    sql: `
UPDATE sd_relay.installations
SET document=jsonb_set(document,'{registrationId}',to_jsonb(gen_random_uuid()::text))
WHERE NOT (document ? 'registrationId');
UPDATE sd_relay.deliveries
SET document=jsonb_set(document,'{registrationId}','null'::jsonb)
WHERE NOT (document ? 'registrationId');
`,
  },
  {
    id: '003_receipt_schedule',
    sql: `
UPDATE sd_relay.deliveries SET document=document || jsonb_build_object(
 'receiptAttempts',0,'receiptNextCheckAt',created_at,'receiptRetryUntil',created_at+interval '24 hours','receiptLastCheckedAt',NULL
) WHERE NOT (document ? 'receiptRetryUntil');
CREATE INDEX IF NOT EXISTS relay_receipts_due ON sd_relay.deliveries((document->>'receiptNextCheckAt')) WHERE document->>'receiptChecked'='false' AND document->>'state'='provider_accepted';
`,
  },
];

export class PostgresRelayStore implements RelayStore {
  private readonly database: DatabasePort;
  constructor(database: DatabasePort, schema = 'sd_relay') {
    this.database = withRelaySchema(database, schema);
  }
  transaction<T>(action: (tx: RelayTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction((database) =>
      action(new PostgresRelayTransaction(database)),
    );
  }
  async cleanup(before: string, deliveryBefore = before): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query('DELETE FROM sd_relay.nonces WHERE expires_at < $1', [
        before,
      ]);
      await tx.query('DELETE FROM sd_relay.challenges WHERE expires_at < $1', [
        before,
      ]);
      await tx.query('DELETE FROM sd_relay.deliveries WHERE created_at < $1', [
        deliveryBefore,
      ]);
      await tx.query(
        "DELETE FROM sd_relay.grants WHERE (document->>'expiresAt')::timestamptz<$1 OR (document->>'revokedAt')::timestamptz<$1",
        [deliveryBefore],
      );
      await tx.query(
        "DELETE FROM sd_relay.installations i WHERE (document->>'revokedAt')::timestamptz<$1 AND NOT EXISTS(SELECT 1 FROM sd_relay.grants g WHERE g.installation_id=i.id)",
        [deliveryBefore],
      );
    });
  }
}
export function relaySchemaFor(schema: string): string {
  if (!/^sd_relay(?:_[a-z0-9_]+)?$/.test(schema))
    throw new Error('The relay schema name is invalid.');
  return relayMigrations
    .map((migration) => migration.sql.replaceAll('sd_relay', schema))
    .join('\n');
}
function withRelaySchema(database: DatabasePort, schema: string): DatabasePort {
  relaySchemaFor(schema);
  return {
    query: (text, values) =>
      database.query(text.replaceAll('sd_relay.', `${schema}.`), values),
    transaction: (action) =>
      database.transaction((tx) => action(withRelaySchema(tx, schema))),
  };
}
class PostgresRelayTransaction implements RelayTransaction {
  constructor(private readonly db: DatabasePort) {}
  private async find<T>(
    table: string,
    id: string,
    lock = false,
  ): Promise<T | null> {
    const result = await this.db.query<{ document: T }>(
      `SELECT document FROM sd_relay.${table} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return result.rows[0]?.document ?? null;
  }
  getChallenge(id: string) {
    return this.find<RelayChallenge>('challenges', id, true);
  }
  async saveChallenge(record: RelayChallenge): Promise<void> {
    await this.db.query(
      'INSERT INTO sd_relay.challenges(id,expires_at,document) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET document=$3,expires_at=$2',
      [record.challengeId, record.expiresAt, record],
    );
  }
  async deleteChallenge(id: string): Promise<void> {
    await this.db.query('DELETE FROM sd_relay.challenges WHERE id=$1', [id]);
  }
  getInstallation(id: string) {
    return this.find<RelayInstallation>('installations', id, true);
  }
  async saveInstallation(record: RelayInstallation): Promise<void> {
    const result = await this.db.query(
      "INSERT INTO sd_relay.installations(id,document) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET document=$2 WHERE installations.document->>'publicKey'=$3",
      [record.installationId, record, record.publicKey],
    );
    if (result.rowCount !== 1)
      throw new RelayError(
        'FORBIDDEN',
        'An installation identifier cannot replace an existing key.',
      );
  }
  getGrant(id: string) {
    return this.find<RelayGrant>('grants', id);
  }
  async saveGrant(record: RelayGrant): Promise<void> {
    const result = await this.db.query(
      'INSERT INTO sd_relay.grants(id,installation_id,document) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
      [record.grantId, record.installationId, record],
    );
    if (result.rowCount !== 1)
      throw new RelayError(
        'REPLAY',
        'The grant identifier has already been used.',
      );
  }
  async revokeGrants(
    installationId: string,
    revokedAt: string,
    grantId?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE sd_relay.grants SET document=jsonb_set(document,'{revokedAt}',to_jsonb($2::text)) WHERE installation_id=$1${grantId ? ' AND id=$3' : ''}`,
      [installationId, revokedAt, ...(grantId ? [grantId] : [])],
    );
  }
  async consumeNonce(
    scope: string,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean> {
    return (
      (
        await this.db.query(
          'INSERT INTO sd_relay.nonces(scope,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [scope, nonce, expiresAt],
        )
      ).rowCount === 1
    );
  }
  getDelivery(requestId: string) {
    return this.find<StoredDelivery>('deliveries', requestId);
  }
  async countDeliveries(
    installationId: string,
    grantId: string,
    since: string,
  ): Promise<{ installation: number; grant: number }> {
    const result = await this.db.query<{ installation: string; grant: string }>(
      'SELECT count(*)::text AS installation,count(*) FILTER(WHERE grant_id=$2)::text AS grant FROM sd_relay.deliveries WHERE installation_id=$1 AND created_at>=$3',
      [installationId, grantId, since],
    );
    return {
      installation: Number(result.rows[0]?.installation ?? 0),
      grant: Number(result.rows[0]?.grant ?? 0),
    };
  }
  async saveDelivery(record: StoredDelivery): Promise<void> {
    const result = await this.db.query(
      "INSERT INTO sd_relay.deliveries(id,installation_id,grant_id,created_at,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET document=$5 WHERE deliveries.installation_id=$2 AND deliveries.grant_id=$3 AND deliveries.document->>'fingerprint'=$6 AND deliveries.document->'registrationId' IS NOT DISTINCT FROM $7::jsonb",
      [
        record.requestId,
        record.installationId,
        record.grantId,
        record.createdAt,
        record,
        record.fingerprint,
        JSON.stringify(record.registrationId),
      ],
    );
    if (result.rowCount !== 1)
      throw new RelayError(
        'REPLAY',
        'An idempotency identifier cannot be replaced.',
      );
  }
  async pendingReceipts(time: string): Promise<StoredDelivery[]> {
    const rows = (
      await this.db.query<{ document: StoredDelivery }>(
        "SELECT document FROM sd_relay.deliveries WHERE document->>'receiptChecked'='false' AND document->>'state'='provider_accepted' AND (document->>'receiptNextCheckAt')::timestamptz<=$1 ORDER BY (document->>'receiptNextCheckAt')::timestamptz,created_at,id FOR UPDATE SKIP LOCKED LIMIT 100",
        [time],
      )
    ).rows.map((row) => row.document);
    for (const row of rows) {
      row.receiptAttempts++;
      row.receiptNextCheckAt = new Date(Date.parse(time) + 60000).toISOString();
      await this.saveDelivery(row);
    }
    return rows;
  }
}
