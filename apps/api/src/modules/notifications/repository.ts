import { randomUUID } from 'node:crypto';
import type {
  DatabasePort,
  NotificationPreference,
  NotificationRecord,
} from '@signaldock/contracts';
import type { RelaySend } from '@signaldock/notification-sdk';
import { defaultNotificationPreference } from './validation.js';

export interface StoredNotification {
  record: NotificationRecord;
  frequencyHz?: number;
  expiresAt: string;
}
export interface DeviceSubscription {
  id: string;
  instanceId: string;
  userId: string;
  sessionId: string;
  deviceRef: string;
  grantRef: string;
  categories: string[];
  radioIds: string[];
  expiresAt: string;
  revokedAt: string | null;
}
export interface DeliveryAttempt {
  id: string;
  notificationId: string;
  subscriptionId: string;
  payload: RelaySend;
  state: string;
  errorCode?: string;
}
export interface NotificationRepository {
  preferences(
    instanceId: string,
    userId: string,
  ): Promise<NotificationPreference>;
  savePreferences(
    instanceId: string,
    userId: string,
    value: NotificationPreference,
  ): Promise<void>;
  create(
    notification: StoredNotification,
  ): Promise<{ notification: StoredNotification; duplicate: boolean }>;
  list(
    instanceId: string,
    userId: string,
    limit: number,
    before?: { createdAt: string; id: string },
  ): Promise<StoredNotification[]>;
  find(
    instanceId: string,
    userId: string,
    id: string,
  ): Promise<StoredNotification | null>;
  findById(instanceId: string, id: string): Promise<StoredNotification | null>;
  markRead(
    instanceId: string,
    userId: string,
    id: string,
    time: string,
  ): Promise<void>;
  recentCount(
    instanceId: string,
    userId: string,
    category: string,
    radioId: string | undefined,
    since: string,
    excludingId: string,
  ): Promise<number>;
  subscriptions(
    instanceId: string,
    userId: string,
  ): Promise<DeviceSubscription[]>;
  saveSubscription(value: DeviceSubscription): Promise<void>;
  revokeSubscription(
    instanceId: string,
    userId: string,
    id: string,
    time: string,
  ): Promise<void>;
  prepareAttempt(
    instanceId: string,
    notificationId: string,
    subscriptionId: string,
    payload: RelaySend,
  ): Promise<DeliveryAttempt>;
  completeAttempt(
    instanceId: string,
    attempt: DeliveryAttempt,
    state: string,
    errorCode?: string,
  ): Promise<void>;
  updateState(
    instanceId: string,
    id: string,
    state: NotificationRecord['deliveryState'],
  ): Promise<void>;
  setPresence(
    instanceId: string,
    userId: string,
    sessionId: string,
    radioId: string,
    until: string | null,
  ): Promise<void>;
  isListening(
    instanceId: string,
    userId: string,
    radioId: string,
    now: string,
  ): Promise<boolean>;
}

type NotificationRow = {
  id: string;
  instance_id: string;
  user_id: string;
  radio_id: string | null;
  event_id: string;
  category: NotificationRecord['category'];
  created_at: Date | string;
  read_at: Date | string | null;
  delivery_state: NotificationRecord['deliveryState'];
  frequency_hz: string | null;
  expires_at: Date | string;
};
const notificationColumns =
  'id,instance_id,user_id,radio_id,event_id,category,created_at,read_at,delivery_state,frequency_hz,expires_at';
const iso = (date: Date | string) => new Date(date).toISOString();
function notification(row: NotificationRow): StoredNotification {
  return {
    record: {
      id: row.id,
      instanceId: row.instance_id,
      userId: row.user_id,
      ...(row.radio_id ? { radioId: row.radio_id } : {}),
      eventId: row.event_id,
      category: row.category,
      createdAt: iso(row.created_at),
      ...(row.read_at ? { readAt: iso(row.read_at) } : {}),
      deliveryState: row.delivery_state,
    },
    ...(row.frequency_hz ? { frequencyHz: Number(row.frequency_hz) } : {}),
    expiresAt: iso(row.expires_at),
  };
}

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly database: DatabasePort) {}
  async preferences(
    instanceId: string,
    userId: string,
  ): Promise<NotificationPreference> {
    const result = await this.database.query<{
      preference: NotificationPreference;
    }>(
      'SELECT preference FROM sd_notification_preferences WHERE instance_id=$1 AND user_id=$2',
      [instanceId, userId],
    );
    return result.rows[0]?.preference ?? defaultNotificationPreference();
  }
  async savePreferences(
    instanceId: string,
    userId: string,
    value: NotificationPreference,
  ): Promise<void> {
    await this.database.query(
      'INSERT INTO sd_notification_preferences(instance_id,user_id,preference) VALUES($1,$2,$3) ON CONFLICT(instance_id,user_id) DO UPDATE SET preference=$3',
      [instanceId, userId, value],
    );
  }
  async create(
    input: StoredNotification,
  ): Promise<{ notification: StoredNotification; duplicate: boolean }> {
    return this.database.transaction(async (tx) => {
      const n = input.record;
      const created = await tx.query<NotificationRow>(
        `INSERT INTO sd_notifications(instance_id,id,user_id,radio_id,event_id,category,created_at,delivery_state,frequency_hz,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(instance_id,user_id,event_id,category) DO NOTHING RETURNING ${notificationColumns}`,
        [
          n.instanceId,
          n.id,
          n.userId,
          n.radioId ?? null,
          n.eventId,
          n.category,
          n.createdAt,
          n.deliveryState,
          input.frequencyHz ?? null,
          input.expiresAt,
        ],
      );
      if (!created.rows[0]) {
        const existing = await tx.query<NotificationRow>(
          `SELECT ${notificationColumns} FROM sd_notifications WHERE instance_id=$1 AND user_id=$2 AND event_id=$3 AND category=$4`,
          [n.instanceId, n.userId, n.eventId, n.category],
        );
        return {
          notification: notification(existing.rows[0]!),
          duplicate: true,
        };
      }
      // Canonical foundation outbox: visible state and its delivery request commit together.
      await tx.query(
        'INSERT INTO sd_event_outbox(instance_id,id,type,radio_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(instance_id,id) DO NOTHING',
        [
          n.instanceId,
          n.id,
          'notification.delivery_requested',
          n.radioId ?? null,
          { notificationId: n.id },
        ],
      );
      return { notification: notification(created.rows[0]), duplicate: false };
    });
  }
  async list(
    instanceId: string,
    userId: string,
    limit: number,
    before?: { createdAt: string; id: string },
  ): Promise<StoredNotification[]> {
    return (
      await this.database.query<NotificationRow>(
        `SELECT ${notificationColumns} FROM sd_notifications WHERE instance_id=$1 AND user_id=$2${before ? ' AND (created_at,id)<($4::timestamptz,$5::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT $3`,
        [
          instanceId,
          userId,
          limit,
          ...(before ? [before.createdAt, before.id] : []),
        ],
      )
    ).rows.map(notification);
  }
  async find(
    instanceId: string,
    userId: string,
    id: string,
  ): Promise<StoredNotification | null> {
    const rows = await this.database.query<NotificationRow>(
      `SELECT ${notificationColumns} FROM sd_notifications WHERE instance_id=$1 AND user_id=$2 AND id=$3`,
      [instanceId, userId, id],
    );
    return rows.rows[0] ? notification(rows.rows[0]) : null;
  }
  async findById(
    instanceId: string,
    id: string,
  ): Promise<StoredNotification | null> {
    const rows = await this.database.query<NotificationRow>(
      `SELECT ${notificationColumns} FROM sd_notifications WHERE instance_id=$1 AND id=$2`,
      [instanceId, id],
    );
    return rows.rows[0] ? notification(rows.rows[0]) : null;
  }
  async markRead(
    instanceId: string,
    userId: string,
    id: string,
    time: string,
  ): Promise<void> {
    await this.database.query(
      "UPDATE sd_notifications SET read_at=COALESCE(read_at,$4),delivery_state='application_opened' WHERE instance_id=$1 AND user_id=$2 AND id=$3",
      [instanceId, userId, id, time],
    );
  }
  async recentCount(
    instanceId: string,
    userId: string,
    category: string,
    radioId: string | undefined,
    since: string,
    excludingId: string,
  ): Promise<number> {
    const rows = await this.database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sd_notifications WHERE instance_id=$1 AND user_id=$2 AND category=$3 AND radio_id IS NOT DISTINCT FROM $4 AND created_at>=$5 AND id<>$6 AND delivery_state IN('relay_accepted','provider_accepted','application_opened')",
      [instanceId, userId, category, radioId ?? null, since, excludingId],
    );
    return Number(rows.rows[0]?.count ?? 0);
  }
  async subscriptions(
    instanceId: string,
    userId: string,
  ): Promise<DeviceSubscription[]> {
    const rows = await this.database.query<{ document: DeviceSubscription }>(
      `SELECT jsonb_build_object('id',id,'instanceId',instance_id,'userId',user_id,'sessionId',session_id,'deviceRef',device_ref,'grantRef',grant_ref,'categories',categories,'radioIds',radio_ids,'expiresAt',expires_at,'revokedAt',revoked_at) AS document FROM sd_notification_subscriptions WHERE instance_id=$1 AND user_id=$2`,
      [instanceId, userId],
    );
    return rows.rows.map((row) => row.document);
  }
  async saveSubscription(value: DeviceSubscription): Promise<void> {
    await this.database.transaction(async (tx) => {
      // Serialize first-time enrollment and replacement for the same user/device.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${value.instanceId}:${value.userId}:${value.deviceRef}`,
      ]);
      const old = await tx.query<{ grant_ref: string }>(
        'SELECT grant_ref FROM sd_notification_subscriptions WHERE instance_id=$1 AND user_id=$2 AND device_ref=$3',
        [value.instanceId, value.userId, value.deviceRef],
      );
      await tx.query(
        'INSERT INTO sd_notification_subscriptions(instance_id,id,user_id,session_id,device_ref,grant_ref,categories,radio_ids,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL) ON CONFLICT(instance_id,user_id,device_ref) DO UPDATE SET grant_ref=$6,session_id=$4,categories=$7,radio_ids=$8,expires_at=$9,revoked_at=NULL',
        [
          value.instanceId,
          value.id,
          value.userId,
          value.sessionId,
          value.deviceRef,
          value.grantRef,
          JSON.stringify(value.categories),
          JSON.stringify(value.radioIds),
          value.expiresAt,
        ],
      );
      if (old.rows[0] && old.rows[0].grant_ref !== value.grantRef)
        await tx.query(
          'INSERT INTO sd_event_outbox(instance_id,id,type,payload) VALUES($1,$2,$3,$4)',
          [
            value.instanceId,
            randomUUID(),
            'notification.subscription_revoked',
            { grantId: old.rows[0].grant_ref },
          ],
        );
    });
  }
  async revokeSubscription(
    instanceId: string,
    userId: string,
    id: string,
    time: string,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      const result = await tx.query<{ grant_ref: string }>(
        'UPDATE sd_notification_subscriptions SET revoked_at=$4 WHERE instance_id=$1 AND user_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING grant_ref',
        [instanceId, userId, id, time],
      );
      if (result.rows[0])
        await tx.query(
          'INSERT INTO sd_event_outbox(instance_id,id,type,payload) VALUES($1,$2,$3,$4)',
          [
            instanceId,
            randomUUID(),
            'notification.subscription_revoked',
            { grantId: result.rows[0].grant_ref },
          ],
        );
    });
  }
  async prepareAttempt(
    instanceId: string,
    notificationId: string,
    subscriptionId: string,
    payload: RelaySend,
  ): Promise<DeliveryAttempt> {
    const id = randomUUID();
    await this.database.query(
      "INSERT INTO sd_notification_delivery_attempts(instance_id,id,notification_id,subscription_id,request_id,wire_payload,state) VALUES($1,$2,$3,$4,$5,$6,'queued') ON CONFLICT(instance_id,notification_id,subscription_id) DO NOTHING",
      [
        instanceId,
        id,
        notificationId,
        subscriptionId,
        payload.requestId,
        payload,
      ],
    );
    const rows = await this.database.query<{
      id: string;
      notification_id: string;
      subscription_id: string;
      wire_payload: RelaySend;
      state: string;
      error_code: string | null;
    }>(
      'SELECT id,notification_id,subscription_id,wire_payload,state,error_code FROM sd_notification_delivery_attempts WHERE instance_id=$1 AND notification_id=$2 AND subscription_id=$3',
      [instanceId, notificationId, subscriptionId],
    );
    const row = rows.rows[0]!;
    return {
      id: row.id,
      notificationId: row.notification_id,
      subscriptionId: row.subscription_id,
      payload: row.wire_payload,
      state: row.state,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    };
  }
  async completeAttempt(
    instanceId: string,
    attempt: DeliveryAttempt,
    state: string,
    errorCode?: string,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        'UPDATE sd_notification_delivery_attempts SET state=$3,error_code=$4 WHERE instance_id=$1 AND id=$2',
        [instanceId, attempt.id, state, errorCode ?? null],
      );
      const aggregate = await tx.query<{
        state: NotificationRecord['deliveryState'];
      }>(
        "SELECT CASE WHEN bool_or(state='provider_accepted') THEN 'provider_accepted' WHEN bool_or(state='relay_accepted') THEN 'relay_accepted' WHEN bool_or(state='queued') THEN 'queued' WHEN bool_or(state='failed') THEN 'failed' ELSE 'expired' END AS state FROM sd_notification_delivery_attempts WHERE instance_id=$1 AND notification_id=$2",
        [instanceId, attempt.notificationId],
      );
      await tx.query(
        "UPDATE sd_notifications SET delivery_state=$3 WHERE instance_id=$1 AND id=$2 AND delivery_state<>'application_opened'",
        [
          instanceId,
          attempt.notificationId,
          aggregate.rows[0]?.state ?? 'failed',
        ],
      );
    });
  }
  async updateState(
    instanceId: string,
    id: string,
    state: NotificationRecord['deliveryState'],
  ): Promise<void> {
    await this.database.query(
      "UPDATE sd_notifications SET delivery_state=$3 WHERE instance_id=$1 AND id=$2 AND delivery_state<>'application_opened'",
      [instanceId, id, state],
    );
  }
  async setPresence(
    instanceId: string,
    userId: string,
    sessionId: string,
    radioId: string,
    until: string | null,
  ): Promise<void> {
    if (!until) {
      await this.database.query(
        'DELETE FROM sd_notification_presence WHERE instance_id=$1 AND user_id=$2 AND session_id=$3',
        [instanceId, userId, sessionId],
      );
      return;
    }
    await this.database.query(
      'INSERT INTO sd_notification_presence(instance_id,user_id,session_id,radio_id,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(instance_id,session_id) DO UPDATE SET radio_id=$4,expires_at=$5',
      [instanceId, userId, sessionId, radioId, until],
    );
  }
  async isListening(
    instanceId: string,
    userId: string,
    radioId: string,
    now: string,
  ): Promise<boolean> {
    return !!(
      await this.database.query(
        'SELECT 1 FROM sd_notification_presence WHERE instance_id=$1 AND user_id=$2 AND radio_id=$3 AND expires_at>$4 LIMIT 1',
        [instanceId, userId, radioId, now],
      )
    ).rows.length;
  }
}
