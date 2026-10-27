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
  RevocationIntent,
} from '../src/modules/notifications/repository.js';
import { defaultNotificationPreference } from '../src/modules/notifications/validation.js';

export class FixtureNotificationRepository implements NotificationRepository {
  readonly notifications: StoredNotification[] = [];
  readonly outbox: string[] = [];
  readonly devices: DeviceSubscription[] = [];
  readonly attempts: DeliveryAttempt[] = [];
  readonly admissions = new Map<
    string,
    { alert: string; foreground?: string }
  >();
  readonly preference = new Map<string, NotificationPreference>();
  listening = false;
  originSessionActive = true;
  readonly revocations = new Map<
    string,
    RevocationIntent & {
      status: 'pending' | 'confirmed' | 'expired';
      nextAttemptAt: string;
    }
  >();
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
        (this.admissions.get(item.record.id)?.alert ?? '') > since &&
        item.record.id !== excludingId &&
        this.admissions.has(item.record.id),
    ).length;
  }
  async admit(
    stored: StoredNotification,
    channel: 'foreground' | 'relay',
    time: string,
    cooldownSeconds: number,
  ): Promise<boolean> {
    const n = this.notifications.find(
      (item) =>
        item.record.instanceId === stored.record.instanceId &&
        item.record.userId === stored.record.userId &&
        item.record.id === stored.record.id,
    );
    if (
      !n ||
      n.record.readAt ||
      n.record.deliveryState === 'expired' ||
      Date.parse(n.expiresAt) <= Date.parse(time)
    )
      return false;
    const prior = this.admissions.get(n.record.id);
    if (channel === 'foreground' && prior?.foreground) return false;
    if (!prior) {
      const since = new Date(
        Date.parse(time) - cooldownSeconds * 1000,
      ).toISOString();
      if (
        this.notifications.some(
          (item) =>
            item.record.instanceId === n.record.instanceId &&
            item.record.userId === n.record.userId &&
            item.record.category === n.record.category &&
            item.record.radioId === n.record.radioId &&
            item.record.id !== n.record.id &&
            (this.admissions.get(item.record.id)?.alert ?? '') > since,
        )
      )
        return false;
    }
    this.admissions.set(n.record.id, {
      alert: prior?.alert ?? time,
      ...(prior?.foreground ? { foreground: prior.foreground } : {}),
      ...(channel === 'foreground' ? { foreground: time } : {}),
    });
    return true;
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
    if (index >= 0) {
      const prior = this.devices[index]!;
      if (prior.grantRef !== value.grantRef) this.queueRevocation(prior);
      this.devices[index] = { ...value, id: this.devices[index]!.id };
    } else this.devices.push(structuredClone(value));
  }
  async isSubscriptionActive(_value: DeviceSubscription): Promise<boolean> {
    return this.originSessionActive;
  }
  async revokeSubscription(
    i: string,
    u: string,
    id: string,
    time: string,
    expectedSessionId?: string,
  ) {
    const item = this.devices.find(
      (item) => item.instanceId === i && item.userId === u && item.id === id,
    );
    if (item && (!expectedSessionId || item.sessionId === expectedSessionId)) {
      item.revokedAt = time;
      this.queueRevocation(item);
    }
  }
  private queueRevocation(value: DeviceSubscription) {
    const key = `${value.instanceId}:${value.grantRef}`;
    if (!this.revocations.has(key))
      this.revocations.set(key, {
        instanceId: value.instanceId,
        grantRef: value.grantRef,
        expiresAt: value.expiresAt,
        attempts: 0,
        status: 'pending',
        nextAttemptAt: '1970-01-01T00:00:00.000Z',
      });
  }
  async claimRevocations(
    instanceId: string,
    time: string,
    limit: number,
    grantRef?: string,
  ): Promise<RevocationIntent[]> {
    const result: RevocationIntent[] = [];
    if (!this.originSessionActive)
      for (const device of this.devices)
        if (device.instanceId === instanceId && !device.revokedAt) {
          device.revokedAt = time;
          this.queueRevocation(device);
        }
    for (const value of this.revocations.values()) {
      if (value.instanceId !== instanceId || value.status !== 'pending')
        continue;
      if (value.expiresAt <= time) {
        value.status = 'expired';
        continue;
      }
      if (
        value.nextAttemptAt > time ||
        (grantRef && value.grantRef !== grantRef) ||
        result.length >= limit
      )
        continue;
      value.attempts++;
      value.nextAttemptAt = new Date(Date.parse(time) + 60000).toISOString();
      result.push(structuredClone(value));
    }
    return result;
  }
  async completeRevocation(
    intent: RevocationIntent,
    confirmed: boolean,
    time: string,
  ): Promise<void> {
    const value = this.revocations.get(
      `${intent.instanceId}:${intent.grantRef}`,
    );
    if (
      !value ||
      value.attempts !== intent.attempts ||
      value.status !== 'pending'
    )
      return;
    value.status = confirmed ? 'confirmed' : 'pending';
    value.nextAttemptAt = new Date(
      Math.min(
        Date.parse(intent.expiresAt),
        Date.parse(time) +
          Math.min(3600000, 15000 * 2 ** Math.min(intent.attempts - 1, 8)),
      ),
    ).toISOString();
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
