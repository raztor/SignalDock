import type { MigrationDefinition } from '@signaldock/contracts';

export const processingMigrations: readonly MigrationDefinition[] = [
  {
    id: '030_processing',
    sql: `
CREATE TABLE sd_provider_credentials (
  instance_id uuid NOT NULL, id uuid NOT NULL, owner_user_id uuid,
  envelope jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id,id)
);
CREATE TABLE sd_processing_connections (
  instance_id uuid NOT NULL, id uuid NOT NULL, owner_user_id uuid, connector_id text NOT NULL,
  display_name text NOT NULL, endpoint text NOT NULL, configuration jsonb NOT NULL DEFAULT '{}',
  capabilities jsonb NOT NULL, status text NOT NULL DEFAULT 'configured', credential_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id,id),
  FOREIGN KEY (instance_id,credential_id) REFERENCES sd_provider_credentials(instance_id,id)
);
CREATE TABLE sd_processing_profiles (
  instance_id uuid NOT NULL, id uuid NOT NULL, connection_id uuid NOT NULL,
  revision integer NOT NULL, profile jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id,id),
  FOREIGN KEY (instance_id,connection_id) REFERENCES sd_processing_connections(instance_id,id)
);
CREATE TABLE sd_processing_jobs (
  instance_id uuid NOT NULL, id uuid NOT NULL, owner_user_id uuid NOT NULL, radio_id uuid,
  profile_id uuid NOT NULL, request jsonb NOT NULL, actor jsonb NOT NULL, source jsonb,
  state text NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled')),
  result jsonb, error text, fingerprint text NOT NULL, idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id,id), UNIQUE (instance_id,owner_user_id,idempotency_key),
  FOREIGN KEY (instance_id,profile_id) REFERENCES sd_processing_profiles(instance_id,id)
);
CREATE INDEX sd_processing_jobs_owner_created ON sd_processing_jobs(instance_id,owner_user_id,created_at DESC);
CREATE TABLE sd_processing_background_consents (
  instance_id uuid NOT NULL, id uuid NOT NULL, radio_id uuid NOT NULL,
  profile_id uuid NOT NULL, profile_revision integer NOT NULL, connection_id uuid NOT NULL,
  service_owner_user_id uuid NOT NULL, endpoint text NOT NULL, connection_fingerprint text NOT NULL,
  consented_by uuid NOT NULL, consented_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT false, disabled_at timestamptz,
  PRIMARY KEY(instance_id,id), FOREIGN KEY(instance_id,profile_id) REFERENCES sd_processing_profiles(instance_id,id)
);
CREATE UNIQUE INDEX sd_processing_one_active_consent ON sd_processing_background_consents(instance_id,radio_id) WHERE enabled=true;
`,
  },
];
