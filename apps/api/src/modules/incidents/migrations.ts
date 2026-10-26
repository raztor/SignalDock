import type { MigrationDefinition } from '@signaldock/contracts';

export const incidentMigrations: readonly MigrationDefinition[] = [
  {
    id: '040_incidents',
    sql: `
CREATE TABLE sd_incident_rules (
  instance_id uuid NOT NULL, id uuid NOT NULL, definition jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (instance_id, id)
);
CREATE TABLE sd_incident_rule_actions (
  instance_id uuid NOT NULL, id uuid NOT NULL, rule_id uuid NOT NULL, actor_user_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('saved','removed')), definition jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(instance_id,id)
);
CREATE TABLE sd_analysis_results (
  instance_id uuid NOT NULL, id uuid NOT NULL, communication_id uuid NOT NULL,
  transcript_revision_id uuid NOT NULL, task_id text NOT NULL, task_version integer NOT NULL,
  connector_id text NOT NULL, profile_revision integer NOT NULL, input_sha256 text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, id),
  FOREIGN KEY (instance_id, communication_id) REFERENCES sd_communications(instance_id,id) ON DELETE CASCADE,
  FOREIGN KEY (instance_id, transcript_revision_id) REFERENCES sd_transcript_revisions(instance_id,id) ON DELETE CASCADE
);
CREATE INDEX sd_analysis_source_idx ON sd_analysis_results(instance_id,communication_id,created_at DESC);
CREATE TABLE sd_incidents (
  instance_id uuid NOT NULL, id uuid NOT NULL, radio_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('new','acknowledged','in_progress','resolved','dismissed')),
  priority text NOT NULL CHECK(priority IN ('low','medium','high','critical')),
  title text NOT NULL, owner_user_id uuid, retention_hold boolean NOT NULL DEFAULT true,
  frequency_hz bigint, source_started_at timestamptz NOT NULL DEFAULT now(),
  last_source_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id,id)
);
CREATE INDEX sd_incident_radio_idx ON sd_incidents(instance_id,radio_id,updated_at DESC,id);
CREATE TABLE sd_incident_evidence (
  instance_id uuid NOT NULL, incident_id uuid NOT NULL, communication_id uuid NOT NULL,
  transcript_revision_id uuid NOT NULL, quote text NOT NULL,
  PRIMARY KEY(instance_id,incident_id,communication_id,transcript_revision_id,quote),
  FOREIGN KEY(instance_id,incident_id) REFERENCES sd_incidents(instance_id,id) ON DELETE CASCADE,
  FOREIGN KEY(instance_id,communication_id) REFERENCES sd_communications(instance_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(instance_id,transcript_revision_id) REFERENCES sd_transcript_revisions(instance_id,id) ON DELETE RESTRICT
);
CREATE TABLE sd_incident_actions (
  instance_id uuid NOT NULL, id uuid NOT NULL, incident_id uuid NOT NULL,
  actor_user_id uuid, kind text NOT NULL, previous_state text, next_state text,
  note text NOT NULL DEFAULT '', revision integer NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(instance_id,id),
  FOREIGN KEY(instance_id,incident_id) REFERENCES sd_incidents(instance_id,id) ON DELETE CASCADE
);
`,
  },
];
