import type { DatabasePort, Permission, Role } from '@signaldock/contracts';

export type IdentityRole = Role;
export interface IdentityRadioGrant {
  radioId: string;
  permissions: Permission[];
}
export interface IdentityUserRecord {
  id: string;
  instanceId: string;
  username: string;
  passwordHash: string;
  role: IdentityRole;
  enabled: boolean;
  authVersion: number;
  createdAt: string;
  updatedAt: string;
  radioPermissions: IdentityRadioGrant[];
}
export interface IdentitySessionRecord {
  id: string;
  instanceId: string;
  userId: string;
  accessTokenHash: string;
  csrfTokenHash: string;
  mode: 'cookie' | 'token';
  accessExpiresAt: string;
  refreshExpiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
  label: string;
}
export interface IdentityRefreshRecord {
  session: IdentitySessionRecord;
  usedAt: string | null;
  expiresAt: string;
}

export interface IdentityRepository {
  transaction<T>(
    action: (repository: IdentityRepository) => Promise<T>,
  ): Promise<T>;
  lockBootstrap(): Promise<void>;
  hasUsers(): Promise<boolean>;
  findUserByName(username: string): Promise<IdentityUserRecord | null>;
  findUser(id: string): Promise<IdentityUserRecord | null>;
  listUsers(): Promise<IdentityUserRecord[]>;
  createUser(user: IdentityUserRecord): Promise<void>;
  updateUser(user: IdentityUserRecord): Promise<void>;
  replaceRadioPermissions(
    userId: string,
    grants: IdentityRadioGrant[],
  ): Promise<void>;
  lockAdministrators(): Promise<IdentityUserRecord[]>;
  createSession(
    session: IdentitySessionRecord,
    refreshHash: string,
  ): Promise<void>;
  findAccess(accessHash: string): Promise<IdentitySessionRecord | null>;
  findSession(id: string): Promise<IdentitySessionRecord | null>;
  lockRefresh(refreshHash: string): Promise<IdentityRefreshRecord | null>;
  rotateSession(
    session: IdentitySessionRecord,
    previousRefreshHash: string,
    nextRefreshHash: string,
    usedAt: string,
  ): Promise<void>;
  revokeSession(id: string, now: string): Promise<boolean>;
  revokeUserSessions(userId: string, now: string): Promise<string[]>;
  listSessions(userId: string): Promise<IdentitySessionRecord[]>;
}

type Row = Record<string, unknown>;
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value);
const nullableIso = (value: unknown) => (value == null ? null : iso(value));

export class SqlIdentityRepository implements IdentityRepository {
  constructor(
    private readonly database: DatabasePort,
    private readonly instanceId: string,
  ) {}
  transaction<T>(
    action: (repository: IdentityRepository) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction((database) =>
      action(new SqlIdentityRepository(database, this.instanceId)),
    );
  }
  async lockBootstrap(): Promise<void> {
    await this.database.query('SELECT pg_advisory_xact_lock(hashtext($1),14)', [
      this.instanceId,
    ]);
  }
  async hasUsers(): Promise<boolean> {
    return (
      (
        await this.database.query(
          'SELECT id FROM sd_users WHERE instance_id=$1 LIMIT 1',
          [this.instanceId],
        )
      ).rows.length > 0
    );
  }
  async findUserByName(username: string): Promise<IdentityUserRecord | null> {
    const row = (
      await this.database.query(
        'SELECT * FROM sd_users WHERE instance_id=$1 AND username=$2',
        [this.instanceId, username],
      )
    ).rows[0];
    return row ? this.user(row) : null;
  }
  async findUser(id: string): Promise<IdentityUserRecord | null> {
    const row = (
      await this.database.query(
        'SELECT * FROM sd_users WHERE instance_id=$1 AND id=$2',
        [this.instanceId, id],
      )
    ).rows[0];
    return row ? this.user(row) : null;
  }
  async listUsers(): Promise<IdentityUserRecord[]> {
    const rows = (
      await this.database.query(
        'SELECT * FROM sd_users WHERE instance_id=$1 ORDER BY username,id',
        [this.instanceId],
      )
    ).rows;
    return Promise.all(rows.map((row) => this.user(row)));
  }
  async createUser(user: IdentityUserRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO sd_users(instance_id,id,username,password_hash,role,enabled,auth_version,created_at,updated_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        this.instanceId,
        user.id,
        user.username,
        user.passwordHash,
        user.role,
        user.enabled,
        user.authVersion,
        user.createdAt,
        user.updatedAt,
      ],
    );
    await this.replaceRadioPermissions(user.id, user.radioPermissions);
  }
  async updateUser(user: IdentityUserRecord): Promise<void> {
    await this.database.query(
      `UPDATE sd_users SET username=$3,password_hash=$4,role=$5,enabled=$6,auth_version=$7,updated_at=$8
WHERE instance_id=$1 AND id=$2`,
      [
        this.instanceId,
        user.id,
        user.username,
        user.passwordHash,
        user.role,
        user.enabled,
        user.authVersion,
        user.updatedAt,
      ],
    );
    await this.replaceRadioPermissions(user.id, user.radioPermissions);
  }
  async replaceRadioPermissions(
    userId: string,
    grants: IdentityRadioGrant[],
  ): Promise<void> {
    await this.database.query(
      'DELETE FROM sd_radio_permissions WHERE instance_id=$1 AND user_id=$2',
      [this.instanceId, userId],
    );
    for (const grant of grants) {
      await this.database.query(
        'INSERT INTO sd_radio_permissions(instance_id,user_id,radio_id,permissions) VALUES($1,$2,$3,$4)',
        [this.instanceId, userId, grant.radioId, grant.permissions],
      );
    }
  }
  async lockAdministrators(): Promise<IdentityUserRecord[]> {
    const rows = (
      await this.database.query(
        `SELECT * FROM sd_users WHERE instance_id=$1 AND role='administrator' AND enabled=true ORDER BY id FOR UPDATE`,
        [this.instanceId],
      )
    ).rows;
    return Promise.all(rows.map((row) => this.user(row)));
  }
  async createSession(
    session: IdentitySessionRecord,
    refreshHash: string,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO sd_sessions(instance_id,id,user_id,access_token_hash,csrf_token_hash,mode,access_expires_at,refresh_expires_at,revoked_at,created_at,last_seen_at,label)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        this.instanceId,
        session.id,
        session.userId,
        session.accessTokenHash,
        session.csrfTokenHash,
        session.mode,
        session.accessExpiresAt,
        session.refreshExpiresAt,
        session.revokedAt,
        session.createdAt,
        session.lastSeenAt,
        session.label,
      ],
    );
    await this.database.query(
      'INSERT INTO sd_refresh_tokens(instance_id,token_hash,session_id,expires_at) VALUES($1,$2,$3,$4)',
      [this.instanceId, refreshHash, session.id, session.refreshExpiresAt],
    );
  }
  async findAccess(accessHash: string): Promise<IdentitySessionRecord | null> {
    const row = (
      await this.database.query(
        'SELECT * FROM sd_sessions WHERE instance_id=$1 AND access_token_hash=$2',
        [this.instanceId, accessHash],
      )
    ).rows[0];
    return row ? this.session(row) : null;
  }
  async findSession(id: string): Promise<IdentitySessionRecord | null> {
    const row = (
      await this.database.query(
        'SELECT * FROM sd_sessions WHERE instance_id=$1 AND id=$2',
        [this.instanceId, id],
      )
    ).rows[0];
    return row ? this.session(row) : null;
  }
  async lockRefresh(
    refreshHash: string,
  ): Promise<IdentityRefreshRecord | null> {
    const row = (
      await this.database.query(
        `SELECT s.*,t.used_at AS token_used_at,t.expires_at AS token_expires_at FROM sd_refresh_tokens t
JOIN sd_sessions s ON s.instance_id=t.instance_id AND s.id=t.session_id
WHERE t.instance_id=$1 AND t.token_hash=$2 FOR UPDATE OF t,s`,
        [this.instanceId, refreshHash],
      )
    ).rows[0];
    return row
      ? {
          session: this.session(row),
          usedAt: nullableIso(row['token_used_at']),
          expiresAt: iso(row['token_expires_at']),
        }
      : null;
  }
  async rotateSession(
    session: IdentitySessionRecord,
    previousRefreshHash: string,
    nextRefreshHash: string,
    usedAt: string,
  ): Promise<void> {
    await this.database.query(
      'UPDATE sd_refresh_tokens SET used_at=$3 WHERE instance_id=$1 AND token_hash=$2',
      [this.instanceId, previousRefreshHash, usedAt],
    );
    await this.database.query(
      `UPDATE sd_sessions SET access_token_hash=$3,csrf_token_hash=$4,access_expires_at=$5,last_seen_at=$6
WHERE instance_id=$1 AND id=$2`,
      [
        this.instanceId,
        session.id,
        session.accessTokenHash,
        session.csrfTokenHash,
        session.accessExpiresAt,
        usedAt,
      ],
    );
    await this.database.query(
      'INSERT INTO sd_refresh_tokens(instance_id,token_hash,session_id,expires_at) VALUES($1,$2,$3,$4)',
      [this.instanceId, nextRefreshHash, session.id, session.refreshExpiresAt],
    );
  }
  async revokeSession(id: string, now: string): Promise<boolean> {
    return (
      (
        await this.database.query(
          'UPDATE sd_sessions SET revoked_at=$3 WHERE instance_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',
          [this.instanceId, id, now],
        )
      ).rows.length > 0
    );
  }
  async revokeUserSessions(userId: string, now: string): Promise<string[]> {
    return (
      await this.database.query(
        'UPDATE sd_sessions SET revoked_at=$3 WHERE instance_id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id',
        [this.instanceId, userId, now],
      )
    ).rows.map((row) => String(row['id']));
  }
  async listSessions(userId: string): Promise<IdentitySessionRecord[]> {
    return (
      await this.database.query(
        'SELECT * FROM sd_sessions WHERE instance_id=$1 AND user_id=$2 ORDER BY created_at DESC,id',
        [this.instanceId, userId],
      )
    ).rows.map((row) => this.session(row));
  }
  private async user(row: Row): Promise<IdentityUserRecord> {
    const id = String(row['id']);
    const grants = (
      await this.database.query(
        'SELECT radio_id,permissions FROM sd_radio_permissions WHERE instance_id=$1 AND user_id=$2 ORDER BY radio_id',
        [this.instanceId, id],
      )
    ).rows;
    return {
      id,
      instanceId: this.instanceId,
      username: String(row['username']),
      passwordHash: String(row['password_hash']),
      role: row['role'] as IdentityRole,
      enabled: Boolean(row['enabled']),
      authVersion: Number(row['auth_version']),
      createdAt: iso(row['created_at']),
      updatedAt: iso(row['updated_at']),
      radioPermissions: grants.map((grant) => ({
        radioId: String(grant['radio_id']),
        permissions: grant['permissions'] as Permission[],
      })),
    };
  }
  private session(row: Row): IdentitySessionRecord {
    return {
      id: String(row['id']),
      instanceId: this.instanceId,
      userId: String(row['user_id']),
      accessTokenHash: String(row['access_token_hash']),
      csrfTokenHash: String(row['csrf_token_hash']),
      mode: row['mode'] as 'cookie' | 'token',
      accessExpiresAt: iso(row['access_expires_at']),
      refreshExpiresAt: iso(row['refresh_expires_at']),
      revokedAt: nullableIso(row['revoked_at']),
      createdAt: iso(row['created_at']),
      lastSeenAt: iso(row['last_seen_at']),
      label: String(row['label']),
    };
  }
}
