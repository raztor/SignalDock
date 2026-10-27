import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SignalDockError,
  type AuthenticationPort,
  type NotificationAudiencePort,
  type NotificationEvent,
  type NotificationPreference,
  type NotificationRecord,
  type Principal,
} from '@signaldock/contracts';
import type { RelayDeliveryPort } from '@signaldock/notification-sdk/server';
import { RelayCategorySchema } from '@signaldock/notification-sdk';
import type {
  DeviceSubscription,
  NotificationRepository,
  StoredNotification,
} from './repository.js';
import {
  NotificationCursorSchema,
  parseNotificationPreference,
  SubscriptionInputSchema,
  withinQuietHours,
} from './validation.js';

const eventSchema = z.strictObject({
  instanceId: z.uuid(),
  radioId: z.uuid().optional(),
  eventId: z.uuid(),
  category: RelayCategorySchema,
  occurredAt: z.iso.datetime(),
});

export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly auth: AuthenticationPort,
    private readonly audience: NotificationAudiencePort,
    private readonly relay: RelayDeliveryPort | undefined,
    private readonly now = Date.now,
  ) {}

  async list(
    principal: Principal,
    input: { limit?: number; cursor?: string } = {},
  ) {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 30);
    await this.auth.authorize(principal, 'notifications.read');
    let before: { createdAt: string; id: string } | undefined;
    if (input.cursor) {
      try {
        before = NotificationCursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'The notification cursor is invalid.',
        );
      }
    }
    const records = await this.repository.list(
      principal.instanceId,
      principal.userId,
      limit,
      before,
    );
    const items: NotificationRecord[] = [];
    for (const stored of records) {
      if (await this.canRead(principal, stored.record.radioId))
        items.push(stored.record);
    }
    const tail = records.at(-1);
    return {
      items,
      nextCursor:
        records.length === limit && tail
          ? Buffer.from(
              JSON.stringify({
                createdAt: tail.record.createdAt,
                id: tail.record.id,
              }),
            ).toString('base64url')
          : null,
    };
  }
  async preferences(principal: Principal): Promise<NotificationPreference> {
    await this.auth.authorize(principal, 'notifications.read');
    return parseNotificationPreference(
      await this.repository.preferences(principal.instanceId, principal.userId),
    );
  }
  async updatePreferences(
    principal: Principal,
    input: unknown,
  ): Promise<NotificationPreference> {
    await this.auth.authorize(principal, 'notifications.read');
    const value = parseNotificationPreference(input);
    for (const radioId of value.radioIds)
      await this.auth.authorize(principal, 'radio.listen', radioId);
    await this.repository.savePreferences(
      principal.instanceId,
      principal.userId,
      value,
    );
    return value;
  }
  async markRead(
    principal: Principal,
    id: string,
  ): Promise<NotificationRecord> {
    z.uuid().parse(id);
    await this.auth.authorize(principal, 'notifications.read');
    const stored = await this.repository.find(
      principal.instanceId,
      principal.userId,
      id,
    );
    if (!stored || !(await this.canRead(principal, stored.record.radioId)))
      throw new SignalDockError('NOT_FOUND', 'The notification was not found.');
    const time = new Date(this.now()).toISOString();
    await this.repository.markRead(
      principal.instanceId,
      principal.userId,
      id,
      time,
    );
    return {
      ...stored.record,
      readAt: stored.record.readAt ?? time,
      deliveryState: 'application_opened',
    };
  }

  /** Called for finalized domain events, never partial speech or individual audio frames. */
  async publishForUser(
    userId: string,
    input: NotificationEvent,
    context: { frequencyHz?: number } = {},
  ): Promise<NotificationRecord | null> {
    const event = eventSchema.parse(input);
    z.uuid().parse(userId);
    const current = await this.audience.resolveUser(userId);
    if (
      !current ||
      current.instanceId !== event.instanceId ||
      !(await this.canRead(current, event.radioId))
    )
      return null;
    const preference = parseNotificationPreference(
      await this.repository.preferences(event.instanceId, userId),
    );
    if (
      !preference.enabled ||
      !preference.categories.includes(event.category) ||
      (preference.radioIds.length &&
        (!event.radioId || !preference.radioIds.includes(event.radioId))) ||
      (preference.frequencyHz !== undefined &&
        preference.frequencyHz !== context.frequencyHz)
    )
      return null;
    const notification: StoredNotification = {
      record: {
        id: randomUUID(),
        instanceId: event.instanceId,
        userId,
        ...(event.radioId ? { radioId: event.radioId } : {}),
        eventId: event.eventId,
        category: event.category,
        createdAt: new Date(this.now()).toISOString(),
        deliveryState: 'queued',
      },
      ...(context.frequencyHz !== undefined
        ? { frequencyHz: context.frequencyHz }
        : {}),
      expiresAt: new Date(Date.parse(event.occurredAt) + 300000).toISOString(),
    };
    return (await this.repository.create(notification)).notification.record;
  }

  async deliver(instanceId: string, notificationId: string): Promise<void> {
    const stored = await this.repository.findById(instanceId, notificationId);
    if (!stored) return;
    const n = stored.record;
    const current = await this.audience.resolveUser(n.userId);
    if (
      !current ||
      current.instanceId !== instanceId ||
      !(await this.canRead(current, n.radioId))
    ) {
      await this.repository.updateState(instanceId, n.id, 'expired');
      return;
    }
    if (!this.relay) return; // In-app history works without a relay.
    const preference = parseNotificationPreference(
      await this.repository.preferences(instanceId, n.userId),
    );
    const suppressed = await this.suppressed(stored, preference);
    if (suppressed) {
      await this.repository.updateState(instanceId, n.id, 'expired');
      return;
    }
    for (const subscription of await this.repository.subscriptions(
      instanceId,
      n.userId,
    )) {
      if (
        subscription.revokedAt ||
        Date.parse(subscription.expiresAt) <= this.now() ||
        !subscription.categories.includes(n.category) ||
        (n.radioId && !subscription.radioIds.includes(n.radioId))
      )
        continue;
      const attempt = await this.repository.prepareAttempt(
        instanceId,
        n.id,
        subscription.id,
        {
          grantId: subscription.grantRef,
          instanceId,
          requestId: randomUUID(),
          nonce: randomUUID(),
          notificationId: n.id,
          eventId: n.eventId,
          category: n.category,
          ...(n.radioId ? { radioId: n.radioId } : {}),
          sentAt: new Date(this.now()).toISOString(),
          expiresAt: stored.expiresAt,
        },
      );
      if (attempt.state !== 'queued') continue;
      if (
        Date.parse(attempt.payload.expiresAt) <= this.now() ||
        this.now() - Date.parse(attempt.payload.sentAt) > 60000
      ) {
        await this.repository.completeAttempt(
          instanceId,
          attempt,
          'expired',
          'Expired',
        );
        continue;
      }
      try {
        if (
          !(await this.repository.isSubscriptionActive(subscription)) ||
          !(await this.repository.admit(
            stored,
            'relay',
            new Date(this.now()).toISOString(),
            preference.cooldownSeconds,
          ))
        ) {
          await this.repository.completeAttempt(
            instanceId,
            attempt,
            'expired',
            'AdmissionDenied',
          );
          continue;
        }
        const result = await this.relay.send(attempt.payload);
        await this.repository.completeAttempt(
          instanceId,
          attempt,
          result.state,
          result.errorCode,
        );
        if (result.errorCode === 'DeviceNotRegistered')
          await this.repository.revokeSubscription(
            instanceId,
            n.userId,
            subscription.id,
            new Date(this.now()).toISOString(),
          );
      } catch {
        throw new SignalDockError(
          'PROVIDER_UNAVAILABLE',
          'The notification relay is unavailable; the durable notification remains on this station.',
        );
      }
    }
  }
  async foreground(
    principal: Principal,
    id: string,
  ): Promise<NotificationRecord | null> {
    z.uuid().parse(id);
    await this.auth.authorize(principal, 'notifications.read');
    const stored = await this.repository.find(
      principal.instanceId,
      principal.userId,
      id,
    );
    if (!stored || !(await this.canRead(principal, stored.record.radioId)))
      return null;
    const preference = parseNotificationPreference(
      await this.repository.preferences(principal.instanceId, principal.userId),
    );
    if (await this.suppressed(stored, preference)) return null;
    if (
      !(await this.repository.admit(
        stored,
        'foreground',
        new Date(this.now()).toISOString(),
        preference.cooldownSeconds,
      ))
    )
      return null;
    return stored.record;
  }
  private async suppressed(
    stored: StoredNotification,
    preference: NotificationPreference,
  ): Promise<boolean> {
    const n = stored.record;
    return !!(
      !preference.enabled ||
      n.readAt ||
      n.deliveryState === 'expired' ||
      !preference.categories.includes(n.category) ||
      (preference.radioIds.length > 0 &&
        (!n.radioId || !preference.radioIds.includes(n.radioId))) ||
      (preference.frequencyHz !== undefined &&
        preference.frequencyHz !== stored.frequencyHz) ||
      Date.parse(stored.expiresAt) <= this.now() ||
      withinQuietHours(preference, new Date(this.now())) ||
      (preference.suppressWhileListening &&
        n.category !== 'incident' &&
        !!n.radioId &&
        (await this.repository.isListening(
          n.instanceId,
          n.userId,
          n.radioId,
          new Date(this.now()).toISOString(),
        )))
    );
  }
  async subscriptions(principal: Principal): Promise<DeviceSubscription[]> {
    await this.auth.authorize(principal, 'notifications.read');
    return this.repository.subscriptions(
      principal.instanceId,
      principal.userId,
    );
  }
  async subscribe(
    principal: Principal,
    input: unknown,
  ): Promise<DeviceSubscription> {
    await this.auth.authorize(principal, 'notifications.read');
    const request = SubscriptionInputSchema.parse(input);
    if (!this.relay)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'This instance has no configured notification relay.',
      );
    const grant = await this.relay.inspect(request.grantRef);
    if (
      grant.instanceId !== principal.instanceId ||
      grant.subscriptionRef !== principal.userId ||
      grant.installationId !== request.deviceRef ||
      grant.revokedAt ||
      Date.parse(grant.expiresAt) <= this.now()
    ) {
      throw new SignalDockError(
        'FORBIDDEN',
        'The relay grant does not belong to this user, instance, and installation.',
      );
    }
    for (const radioId of grant.radioIds)
      await this.auth.authorize(principal, 'radio.listen', radioId);
    const subscription: DeviceSubscription = {
      id: randomUUID(),
      instanceId: principal.instanceId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      deviceRef: request.deviceRef,
      grantRef: grant.grantId,
      categories: grant.categories,
      radioIds: grant.radioIds,
      expiresAt: grant.expiresAt,
      revokedAt: null,
    };
    await this.repository.saveSubscription(subscription);
    return (
      await this.repository.subscriptions(
        principal.instanceId,
        principal.userId,
      )
    ).find((value) => value.deviceRef === request.deviceRef)!;
  }
  async unsubscribe(principal: Principal, id: string): Promise<void> {
    await this.auth.authorize(principal, 'notifications.read');
    z.uuid().parse(id);
    await this.repository.revokeSubscription(
      principal.instanceId,
      principal.userId,
      id,
      new Date(this.now()).toISOString(),
    );
  }
  async revokeForUser(
    instanceId: string,
    userId: string,
    sessionId?: string,
  ): Promise<void> {
    for (const subscription of await this.repository.subscriptions(
      instanceId,
      userId,
    )) {
      if (!sessionId || subscription.sessionId === sessionId)
        await this.repository.revokeSubscription(
          instanceId,
          userId,
          subscription.id,
          new Date(this.now()).toISOString(),
        );
    }
  }
  async revokeExternalGrant(grantId: string): Promise<void> {
    z.uuid().parse(grantId);
    if (this.relay?.revoke) await this.relay.revoke(grantId);
  }
  async setPresence(
    principal: Principal,
    radioId: string,
    listening: boolean,
  ): Promise<void> {
    z.uuid().parse(radioId);
    await this.auth.authorize(principal, 'radio.listen', radioId);
    await this.repository.setPresence(
      principal.instanceId,
      principal.userId,
      principal.sessionId,
      radioId,
      listening ? new Date(this.now() + 45000).toISOString() : null,
    );
  }
  configuration() {
    return {
      relayConfigured: !!this.relay,
      relayUrl: this.relay?.publicUrl ?? null,
      nativeEnrollment: 'private-test-only',
      browserDelivery: 'foreground',
    } as const;
  }
  private async canRead(
    principal: Omit<Principal, 'sessionId'>,
    radioId?: string,
  ): Promise<boolean> {
    try {
      if ('sessionId' in principal) {
        await this.auth.authorize(principal as Principal, 'notifications.read');
        if (radioId)
          await this.auth.authorize(
            principal as Principal,
            'radio.listen',
            radioId,
          );
      } else {
        await this.audience.authorizeUser(
          principal.userId,
          'notifications.read',
        );
        if (radioId)
          await this.audience.authorizeUser(
            principal.userId,
            'radio.listen',
            radioId,
          );
      }
      return true;
    } catch (error) {
      if (
        error instanceof SignalDockError &&
        ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'].includes(error.code)
      )
        return false;
      throw error;
    }
  }
}
