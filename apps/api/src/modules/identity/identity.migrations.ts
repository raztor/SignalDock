/** Domain migrations are registered by the shared database composition root. */
export const identityMigrations = [
  {
    id: '010_identity',
    sql: `
CREATE TABLE IF NOT EXISTS sd_users (
  instance_id uuid NOT NULL, id uuid NOT NULL,
  username text NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('listener','operator','administrator')),
  enabled boolean NOT NULL DEFAULT true, auth_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id,id), UNIQUE (instance_id,username)
);
CREATE TABLE IF NOT EXISTS sd_radio_permissions (
  instance_id uuid NOT NULL, user_id uuid NOT NULL, radio_id uuid NOT NULL,
  permissions text[] NOT NULL,
  PRIMARY KEY (instance_id,user_id,radio_id),
  FOREIGN KEY (instance_id,user_id) REFERENCES sd_users(instance_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sd_sessions (
  instance_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL,
  access_token_hash text NOT NULL, csrf_token_hash text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cookie','token')),
  access_expires_at timestamptz NOT NULL, refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
  label text NOT NULL DEFAULT '',
  PRIMARY KEY (instance_id,id), UNIQUE (instance_id,access_token_hash),
  FOREIGN KEY (instance_id,user_id) REFERENCES sd_users(instance_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sd_sessions_user_idx ON sd_sessions(instance_id,user_id);
CREATE TABLE IF NOT EXISTS sd_refresh_tokens (
  instance_id uuid NOT NULL, token_hash text NOT NULL, session_id uuid NOT NULL,
  used_at timestamptz, expires_at timestamptz NOT NULL,
  PRIMARY KEY (instance_id,token_hash),
  FOREIGN KEY (instance_id,session_id) REFERENCES sd_sessions(instance_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sd_refresh_tokens_session_idx ON sd_refresh_tokens(instance_id,session_id);
`,
  },
] as const;
