import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  SignalDockError,
  type AuthenticationPort,
  type NotificationAudience,
  type NotificationAudiencePort,
  type NotificationEvent,
  type Principal,
} from '@signaldock/contracts';
import type {
  RelayDeliveryPort,
  RelayGrantInspection,
} from '@signaldock/notification-sdk/server';
import type { RelaySend } from '@signaldock/notification-sdk';
import { NotificationService } from '../src/modules/notifications/service.js';
import { registerNotificationRoutes } from '../src/modules/notifications/routes.js';
import { configureHttp } from '../src/shared/http/configure-http.js';
import {
  defaultNotificationPreference,
  withinQuietHours,
} from '../src/modules/notifications/validation.js';
import { FixtureNotificationRepository } from './notification-fixtures.js';

function context(withRelay = true) {
  const instanceId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    radioId = crypto.randomUUID();
  const principal: Principal = {
    instanceId,
    userId,
    sessionId: crypto.randomUUID(),
    username: 'listener',
    role: 'listener',
    radioPermissions: [{ radioId, permissions: ['radio.listen'] }],
  };
  const { sessionId: _sessionId, ...audiencePrincipal } = principal;
  let current: NotificationAudience | null = audiencePrincipal;
  let now = Date.parse('2026-10-26T12:00:00Z');
  const authorize = async (
    subject: NotificationAudience,
    permission: string,
    radio?: string,
  ) => {
    if (
      permission === 'notifications.manage' &&
      subject.role !== 'administrator'
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'Instance notification administration is restricted.',
      );
    if (
      permission === 'radio.listen' &&
      !subject.radioPermissions.some(
        (grant) =>
          grant.radioId === radio && grant.permissions.includes('radio.listen'),
      )
    )
      throw new SignalDockError('FORBIDDEN', 'Radio access was revoked.');
  };
  const audience: NotificationAudiencePort = {
    resolveUser: async (id) =>
      current?.userId === id ? structuredClone(current) : null,
    authorizeUser: async (id, permission, radio) => {
      if (!current || current.userId !== id)
        throw new SignalDockError('FORBIDDEN', 'User is disabled.');
      await authorize(current, permission, radio);
    },
  };
  const auth: AuthenticationPort = {
    authenticate: async (token) => {
      if (token !== 'valid')
        throw new SignalDockError('UNAUTHORIZED', 'Invalid session.');
      return principal;
    },
    authorize,
  };
  const repository = new FixtureNotificationRepository();
  const sent: RelaySend[] = [];
  const inspection: RelayGrantInspection = {
    grantId: crypto.randomUUID(),
    installationId: crypto.randomUUID(),
    instanceId,
    instancePublicKey: 'fixture',
    subscriptionRef: userId,
    categories: ['communication', 'incident'],
    radioIds: [radioId],
    expiresAt: new Date(now + 3600000).toISOString(),
    revokedAt: null,
  };
  const relay: RelayDeliveryPort = {
    inspect: async () => structuredClone(inspection),
    send: async (payload) => {
      sent.push(payload);
      return { requestId: payload.requestId, state: 'provider_accepted' };
    },
  };
  const service = new NotificationService(
    repository,
    auth,
    audience,
    withRelay ? relay : undefined,
    () => now,
  );
  const event = (): NotificationEvent => ({
    instanceId,
    radioId,
    eventId: crypto.randomUUID(),
    category: 'communication',
    occurredAt: new Date(now).toISOString(),
  });
  return {
    instanceId,
    userId,
    radioId,
    principal,
    auth,
    repository,
    service,
    relay,
    inspection,
    sent,
    event,
    setUser: (user: NotificationAudience | null) => {
      current = user;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('durable station notifications', () => {
  it.each(['listener', 'operator'] as const)(
    'allows %s users to manage only their own notification preferences and subscriptions',
    async (role) => {
      const c = context();
      c.principal.role = role;
      await expect(
        c.service.updatePreferences(
          c.principal,
          defaultNotificationPreference(),
        ),
      ).resolves.toMatchObject({ enabled: true });
      const subscription = await c.service.subscribe(c.principal, {
        deviceRef: c.inspection.installationId,
        grantRef: c.inspection.grantId,
      });
      await c.service.unsubscribe(c.principal, subscription.id);
      expect(c.repository.devices[0]?.revokedAt).toBeTruthy();
    },
  );
  it('creates one user-scoped notification/outbox request per finalized event without a relay', async () => {
    const c = context(false);
    const event = c.event();
    const a = await c.service.publishForUser(c.userId, event);
    const b = await c.service.publishForUser(c.userId, event);
    expect(a?.id).toBe(b?.id);
    expect(c.repository.outbox).toHaveLength(1);
    expect((await c.service.list(c.principal)).items).toHaveLength(1);
    await c.service.deliver(c.instanceId, a!.id);
    expect(c.sent).toHaveLength(0);
    expect(c.service.configuration()).toMatchObject({
      relayConfigured: false,
      browserDelivery: 'foreground',
    });
  });
  it('isolates users/instances and filters an unassigned radio before creating metadata', async () => {
    const c = context();
    const record = await c.service.publishForUser(c.userId, c.event());
    expect(
      await c.service.publishForUser(c.userId, {
        ...c.event(),
        instanceId: crypto.randomUUID(),
      }),
    ).toBeNull();
    expect(
      await c.service.publishForUser(c.userId, {
        ...c.event(),
        radioId: crypto.randomUUID(),
      }),
    ).toBeNull();
    const other = { ...c.principal, userId: crypto.randomUUID() };
    expect((await c.service.list(other)).items).toHaveLength(0);
    await expect(c.service.markRead(other, record!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('rechecks enabled-user/current-radio permission before asynchronous delivery', async () => {
    const c = context();
    const record = await c.service.publishForUser(c.userId, c.event());
    c.setUser(null);
    await c.service.deliver(c.instanceId, record!.id);
    expect(c.sent).toHaveLength(0);
    expect(c.repository.notifications[0]!.record.deliveryState).toBe('expired');
  });
  it('does not send when an origin session was revoked after the subscription was loaded', async () => {
    const c = context();
    await c.service.subscribe(c.principal, {
      deviceRef: c.inspection.installationId,
      grantRef: c.inspection.grantId,
    });
    const item = await c.service.publishForUser(c.userId, c.event());
    c.repository.originSessionActive = false;
    await c.service.deliver(c.instanceId, item!.id);
    expect(c.sent).toHaveLength(0);
    expect(c.repository.attempts[0]?.state).toBe('expired');
  });
  it('binds subscriptions to the current instance, user and installation', async () => {
    const c = context();
    const input = {
      deviceRef: c.inspection.installationId,
      grantRef: c.inspection.grantId,
    };
    c.inspection.subscriptionRef = crypto.randomUUID();
    await expect(c.service.subscribe(c.principal, input)).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    c.inspection.subscriptionRef = c.userId;
    c.inspection.instanceId = crypto.randomUUID();
    await expect(c.service.subscribe(c.principal, input)).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    c.inspection.instanceId = c.instanceId;
    const subscription = await c.service.subscribe(c.principal, input);
    expect(subscription.sessionId).toBe(c.principal.sessionId);
    await c.service.revokeForUser(
      c.instanceId,
      c.userId,
      c.principal.sessionId,
    );
    expect(c.repository.devices[0]!.revokedAt).not.toBeNull();
  });
  it('filters frequencies, suppresses ordinary pushes while listening, and retains the history entry', async () => {
    const c = context();
    await c.service.updatePreferences(c.principal, {
      ...defaultNotificationPreference(),
      frequencyHz: 145500000,
      cooldownSeconds: 0,
    });
    expect(await c.service.publishForUser(c.userId, c.event())).toBeNull();
    await c.service.subscribe(c.principal, {
      deviceRef: c.inspection.installationId,
      grantRef: c.inspection.grantId,
    });
    await c.service.setPresence(c.principal, c.radioId, true);
    const record = await c.service.publishForUser(c.userId, c.event(), {
      frequencyHz: 145500000,
    });
    await c.service.deliver(c.instanceId, record!.id);
    expect(c.sent).toHaveLength(0);
    expect((await c.service.list(c.principal)).items).toHaveLength(1);
    const incident = await c.service.publishForUser(
      c.userId,
      { ...c.event(), category: 'incident' },
      { frequencyHz: 145500000 },
    );
    await c.service.deliver(c.instanceId, incident!.id);
    expect(c.sent).toHaveLength(1);
  });
  it('keeps stable wire identifiers for relay retry and respects cooldown without losing events', async () => {
    const c = context();
    await c.service.subscribe(c.principal, {
      deviceRef: c.inspection.installationId,
      grantRef: c.inspection.grantId,
    });
    let fail = true;
    c.relay.send = async (payload) => {
      c.sent.push(payload);
      if (fail) {
        fail = false;
        throw new Error('Offline');
      }
      return { requestId: payload.requestId, state: 'provider_accepted' };
    };
    const record = await c.service.publishForUser(c.userId, c.event());
    await expect(
      c.service.deliver(c.instanceId, record!.id),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    c.advance(1000);
    await c.service.deliver(c.instanceId, record!.id);
    expect(c.sent[0]).toEqual(c.sent[1]);
    const second = await c.service.publishForUser(c.userId, c.event());
    await c.service.deliver(c.instanceId, second!.id);
    expect(c.sent).toHaveLength(2);
    expect(c.repository.notifications).toHaveLength(2);
  });
  it('records application-opened separately and validates cross-midnight quiet hours', async () => {
    const c = context();
    const record = await c.service.publishForUser(c.userId, c.event());
    const read = await c.service.markRead(c.principal, record!.id);
    expect(read.deliveryState).toBe('application_opened');
    const preference = {
      ...defaultNotificationPreference(),
      quietHours: { start: '22:00', end: '07:00', timeZone: 'UTC' },
    };
    expect(withinQuietHours(preference, new Date('2026-10-26T23:00:00Z'))).toBe(
      true,
    );
    expect(withinQuietHours(preference, new Date('2026-10-26T12:00:00Z'))).toBe(
      false,
    );
    await expect(
      c.service.updatePreferences(c.principal, {
        ...preference,
        quietHours: { ...preference.quietHours, timeZone: 'Not/AZone' },
      }),
    ).rejects.toThrow();
  });
  it('protects routes and accepts pagination/preferences only through the instance session', async () => {
    const c = context();
    const app = Fastify();
    configureHttp(app);
    registerNotificationRoutes(app, {
      prefix: '/station/api/v1',
      auth: c.auth,
      service: c.service,
    });
    try {
      expect(
        (await app.inject('/station/api/v1/notifications')).statusCode,
      ).toBe(401);
      const headers = { authorization: 'Bearer valid' };
      const updated = await app.inject({
        method: 'PUT',
        url: '/station/api/v1/notification-preferences',
        headers,
        payload: defaultNotificationPreference(),
      });
      expect(updated.statusCode).toBe(200);
      const subscription = await app.inject({
        method: 'POST',
        url: '/station/api/v1/push/subscriptions',
        headers,
        payload: {
          deviceRef: c.inspection.installationId,
          grantRef: c.inspection.grantId,
        },
      });
      expect(subscription.statusCode).toBe(201);
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/station/api/v1/push/subscriptions/${subscription.json().id}`,
        headers,
      });
      expect(revoked.statusCode).toBe(204);
      const list = await app.inject({
        url: '/station/api/v1/notifications',
        headers,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({ items: [], nextCursor: null });
      const invalid = await app.inject({
        method: 'PUT',
        url: '/station/api/v1/notification-preferences',
        headers,
        payload: { enabled: true },
      });
      expect(invalid.statusCode).toBe(400);
      expect(
        (
          await app.inject({
            url: '/station/api/v1/notifications?limit=10000',
            headers,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
