import type {
  NotificationPreference,
  NotificationRecord,
} from '@signaldock/contracts';
import type { RelaySend } from '@signaldock/notification-sdk';
import type {
  DeliveryAttempt,
  DeviceSubscription,
  NotificationRepository,
  StoredNotification,
} from '../src/modules/notifications/repository.js';
import { defaultNotificationPreference } from '../src/modules/notifications/validation.js';

export class FixtureNotificationRepository implements NotificationRepository {
  readonly notifications: StoredNotification[] = [];
  readonly outbox: string[] = [];
  readonly devices: DeviceSubscription[] = [];
  readonly attempts: DeliveryAttempt[] = [];
  readonly preference = new Map<string, NotificationPreference>();
  listening = false;
  private key(instanceId: string, userId: string) {
    return `${instanceId}:${userId}`;
  }
  async preferences(i: string, u: string) {
    return structuredClone(
      this.preference.get(this.key(i, u)) ?? defaultNotificationPreference(),
    );
  }
  async savePreferences(i: string, u: string, p: NotificationPreference) {
    this.preference.set(this.key(i, u), structuredClone(p));
  }
  async create(value: StoredNotification) {
    const prior = this.notifications.find(
      (item) =>
        item.record.instanceId === value.record.instanceId &&
        item.record.userId === value.record.userId &&
        item.record.eventId === value.record.eventId &&
        item.record.category === value.record.category,
    );
    if (prior) return { notification: structuredClone(prior), duplicate: true };
    this.notifications.push(structuredClone(value));
    this.outbox.push(value.record.id);
    return { notification: structuredClone(value), duplicate: false };
  }
  async list(
    i: string,
    u: string,
    limit: number,
    before?: { createdAt: string; id: string },
  ) {
    return structuredClone(
      this.notifications
        .filter(
          (item) =>
            item.record.instanceId === i &&
            item.record.userId === u &&
            (!before ||
              item.record.createdAt < before.createdAt ||
              (item.record.createdAt === before.createdAt &&
                item.record.id < before.id)),
        )
        .sort(
          (a, b) =>
            b.record.createdAt.localeCompare(a.record.createdAt) ||
            b.record.id.localeCompare(a.record.id),
        )
        .slice(0, limit),
    );
  }
  async find(i: string, u: string, id: string) {
    return structuredClone(
      this.notifications.find(
        (item) =>
          item.record.instanceId === i &&
          item.record.userId === u &&
          item.record.id === id,
      ) ?? null,
    );
  }
  async findById(i: string, id: string) {
    return structuredClone(
      this.notifications.find(
        (item) => item.record.instanceId === i && item.record.id === id,
      ) ?? null,
    );
  }
  async markRead(i: string, u: string, id: string, time: string) {
    const item = this.notifications.find(
      (item) =>
        item.record.instanceId === i &&
        item.record.userId === u &&
        item.record.id === id,
    );
    if (item) {
      item.record.readAt ??= time;
      item.record.deliveryState = 'application_opened';
    }
  }
  async recentCount(
    i: string,
    u: string,
    c: string,
    r: string | undefined,
    since: string,
    excludingId: string,
  ) {
    return this.notifications.filter(
      (item) =>
        item.record.instanceId === i &&
        item.record.userId === u &&
        item.record.category === c &&
        item.record.radioId === r &&
        item.record.createdAt >= since &&
        item.record.id !== excludingId &&
        ['relay_accepted', 'provider_accepted', 'application_opened'].includes(
          item.record.deliveryState,
        ),
    ).length;
  }
  async subscriptions(i: string, u: string) {
    return structuredClone(
      this.devices.filter((item) => item.instanceId === i && item.userId === u),
    );
  }
  async saveSubscription(value: DeviceSubscription) {
    const index = this.devices.findIndex(
      (item) =>
        item.instanceId === value.instanceId &&
        item.userId === value.userId &&
        item.deviceRef === value.deviceRef,
    );
    if (index >= 0)
      this.devices[index] = { ...value, id: this.devices[index]!.id };
    else this.devices.push(structuredClone(value));
  }
  async revokeSubscription(i: string, u: string, id: string, time: string) {
    const item = this.devices.find(
      (item) => item.instanceId === i && item.userId === u && item.id === id,
    );
    if (item) item.revokedAt = time;
  }
  async prepareAttempt(_i: string, n: string, s: string, payload: RelaySend) {
    const old = this.attempts.find(
      (item) => item.notificationId === n && item.subscriptionId === s,
    );
    if (old) return structuredClone(old);
    const item = {
      id: crypto.randomUUID(),
      notificationId: n,
      subscriptionId: s,
      payload,
      state: 'queued',
    };
    this.attempts.push(structuredClone(item));
    return item;
  }
  async completeAttempt(
    i: string,
    a: DeliveryAttempt,
    state: string,
    errorCode?: string,
  ) {
    const item = this.attempts.find((item) => item.id === a.id)!;
    item.state = state;
    if (errorCode) item.errorCode = errorCode;
    const next = this.attempts.some(
      (value) =>
        value.notificationId === a.notificationId &&
        value.state === 'provider_accepted',
    )
      ? 'provider_accepted'
      : state === 'relay_accepted'
        ? 'relay_accepted'
        : 'failed';
    await this.updateState(i, a.notificationId, next);
  }
  async updateState(
    i: string,
    id: string,
    state: NotificationRecord['deliveryState'],
  ) {
    const item = this.notifications.find(
      (item) => item.record.instanceId === i && item.record.id === id,
    );
    if (item && item.record.deliveryState !== 'application_opened')
      item.record.deliveryState = state;
  }
  async setPresence(
    _i: string,
    _u: string,
    _s: string,
    _r: string,
    until: string | null,
  ) {
    this.listening = !!until;
  }
  async isListening() {
    return this.listening;
  }
}
