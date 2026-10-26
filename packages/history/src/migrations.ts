import type { MigrationDefinition } from '@signaldock/contracts';

export const historyMigrations: readonly MigrationDefinition[] = [
  {
    id: '020_history',
    sql: `
CREATE TABLE sd_frequency_conversations (
  instance_id uuid NOT NULL, id uuid NOT NULL, radio_id uuid NOT NULL, rx_hz bigint,
  attribution text NOT NULL CHECK(attribution IN ('confirmed','inferred','unknown')),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(instance_id,id),
  UNIQUE NULLS NOT DISTINCT(instance_id,radio_id,rx_hz), CHECK(rx_hz IS NULL OR rx_hz BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE sd_communications (
  instance_id uuid NOT NULL, id uuid NOT NULL, radio_id uuid NOT NULL, conversation_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('received_voice','transmitted_voice','transmitted_tts','digital','note')),
  direction text NOT NULL CHECK(direction IN ('rx','tx','internal')),
  started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL, rx_hz bigint,
  frequency_attribution text NOT NULL CHECK(frequency_attribution IN ('confirmed','inferred','unknown')),
  context jsonb NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  notes jsonb NOT NULL DEFAULT '[]', tags text[] NOT NULL DEFAULT '{}', retention_hold boolean NOT NULL DEFAULT false,
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(instance_id,id),
  FOREIGN KEY(instance_id,conversation_id) REFERENCES sd_frequency_conversations(instance_id,id),
  CHECK(ended_at>=started_at), CHECK(rx_hz IS NULL OR rx_hz BETWEEN 1 AND 9007199254740991)
);
CREATE INDEX sd_communications_history ON sd_communications(instance_id,radio_id,started_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE TABLE sd_recordings (
  instance_id uuid NOT NULL, id uuid NOT NULL, communication_id uuid NOT NULL, artifact_id uuid NOT NULL,
  content_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>=0), sha256 text NOT NULL,
  state text NOT NULL CHECK(state IN ('available','deleted','gap')), gap_reason text, physical_deleted_at timestamptz,
  PRIMARY KEY(instance_id,id), UNIQUE(instance_id,communication_id), UNIQUE(instance_id,artifact_id),
  FOREIGN KEY(instance_id,communication_id) REFERENCES sd_communications(instance_id,id)
);
CREATE TABLE sd_transcript_revisions (
  instance_id uuid NOT NULL, id uuid NOT NULL, communication_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0), text text NOT NULL, language text,
  source text NOT NULL CHECK(source IN ('provider','human')), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(instance_id,id),
  UNIQUE(instance_id,communication_id,revision),
  FOREIGN KEY(instance_id,communication_id) REFERENCES sd_communications(instance_id,id)
);
CREATE INDEX sd_transcript_revision_history ON sd_transcript_revisions(instance_id,communication_id,revision DESC);
CREATE TABLE sd_history_audit (
  instance_id uuid NOT NULL, id uuid NOT NULL, communication_id uuid NOT NULL,
  actor_user_id uuid, action text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id,id), FOREIGN KEY(instance_id,communication_id) REFERENCES sd_communications(instance_id,id)
);
CREATE TABLE sd_coverage_intervals (
  instance_id uuid NOT NULL, id uuid NOT NULL, radio_id uuid NOT NULL, generation uuid NOT NULL,
  rx_hz bigint, attribution text NOT NULL CHECK(attribution IN ('confirmed','inferred','unknown')),
  started_at timestamptz NOT NULL, ended_at timestamptz, reason text,
  PRIMARY KEY(instance_id,id), CHECK(ended_at IS NULL OR ended_at>=started_at)
);
`,
  },
];
