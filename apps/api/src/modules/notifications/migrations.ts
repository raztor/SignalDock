import type { MigrationDefinition } from '@signaldock/contracts';

export const notificationMigrations: readonly MigrationDefinition[] = [
  {
    id: '050_notifications',
    sql: `
CREATE TABLE sd_notifications (
  instance_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL, radio_id uuid,
  event_id uuid NOT NULL, category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
  delivery_state text NOT NULL, frequency_hz bigint,
  expires_at timestamptz NOT NULL, PRIMARY KEY(instance_id,id),
  UNIQUE(instance_id,user_id,event_id,category),
  CHECK(category IN('communication','transcript','incident','control','radio','storage','processing')),
  CHECK(delivery_state IN('queued','relay_accepted','provider_accepted','failed','expired','application_opened'))
);
CREATE INDEX sd_notifications_user_cursor ON sd_notifications(instance_id,user_id,created_at DESC,id DESC);
CREATE TABLE sd_notification_preferences (
  instance_id uuid NOT NULL,user_id uuid NOT NULL,preference jsonb NOT NULL,PRIMARY KEY(instance_id,user_id)
);
CREATE TABLE sd_notification_subscriptions (
  instance_id uuid NOT NULL,id uuid NOT NULL,user_id uuid NOT NULL,device_ref uuid NOT NULL,
  grant_ref uuid NOT NULL,session_id uuid NOT NULL,categories jsonb NOT NULL,radio_ids jsonb NOT NULL,
  expires_at timestamptz NOT NULL,revoked_at timestamptz,
  PRIMARY KEY(instance_id,id),UNIQUE(instance_id,user_id,device_ref)
);
CREATE TABLE sd_notification_delivery_attempts (
  instance_id uuid NOT NULL,id uuid NOT NULL,notification_id uuid NOT NULL,subscription_id uuid NOT NULL,
  request_id uuid NOT NULL,wire_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),state text NOT NULL,error_code text,
  PRIMARY KEY(instance_id,id),UNIQUE(instance_id,notification_id,subscription_id),
  FOREIGN KEY(instance_id,notification_id) REFERENCES sd_notifications(instance_id,id)
);
CREATE TABLE sd_notification_presence (
  instance_id uuid NOT NULL,user_id uuid NOT NULL,session_id uuid NOT NULL,radio_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,PRIMARY KEY(instance_id,session_id)
);
`,
  },
  {
    id: '051_notifications_foreground',
    sql: `
ALTER TABLE sd_notifications ADD COLUMN alert_admitted_at timestamptz;
ALTER TABLE sd_notifications ADD COLUMN foreground_admitted_at timestamptz;
UPDATE sd_notifications SET alert_admitted_at=created_at WHERE delivery_state IN('relay_accepted','provider_accepted');
CREATE INDEX sd_notifications_alert_cooldown ON sd_notifications(instance_id,user_id,category,radio_id,alert_admitted_at) WHERE alert_admitted_at IS NOT NULL;
`,
  },
  {
    id: '052_notifications_revocation',
    sql: `
CREATE TABLE sd_notification_revocations (
 instance_id uuid NOT NULL,grant_ref uuid NOT NULL,expires_at timestamptz NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(),next_attempt_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','confirmed','expired')),
 confirmed_at timestamptz,last_error text,PRIMARY KEY(instance_id,grant_ref)
);
CREATE INDEX sd_notification_revocations_due ON sd_notification_revocations(instance_id,next_attempt_at) WHERE status='pending';
INSERT INTO sd_notification_revocations(instance_id,grant_ref,expires_at,requested_at,next_attempt_at)
 SELECT instance_id,grant_ref,expires_at,revoked_at,now() FROM sd_notification_subscriptions WHERE revoked_at IS NOT NULL
 ON CONFLICT DO NOTHING;
INSERT INTO sd_notification_revocations(instance_id,grant_ref,expires_at,requested_at,next_attempt_at)
 SELECT DISTINCT ON(instance_id,payload->>'grantId') instance_id,(payload->>'grantId')::uuid,occurred_at+interval '30 days',occurred_at,now()
 FROM sd_event_outbox WHERE type='notification.subscription_revoked' AND payload->>'grantId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 ORDER BY instance_id,payload->>'grantId',occurred_at DESC ON CONFLICT DO NOTHING;
`,
  },
];
