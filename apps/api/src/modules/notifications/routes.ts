import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthenticationPort } from '@signaldock/contracts';
import { requirePrincipal } from '../../shared/http/auth.js';
import type { NotificationService } from './service.js';

export function registerNotificationRoutes(
  app: FastifyInstance,
  options: {
    prefix: string;
    auth: AuthenticationPort;
    service: NotificationService;
  },
): void {
  const { prefix, auth, service } = options;
  app.get(`${prefix}/notifications`, async (request) => {
    const principal = await requirePrincipal(
      request,
      auth,
      'notifications.read',
    );
    const query = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().max(1024).optional(),
      })
      .parse(request.query);
    return service.list(principal, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  });
  app.get(`${prefix}/notification-preferences`, async (request) =>
    service.preferences(
      await requirePrincipal(request, auth, 'notifications.read'),
    ),
  );
  app.put(`${prefix}/notification-preferences`, async (request) =>
    service.updatePreferences(
      await requirePrincipal(request, auth, 'notifications.manage'),
      request.body,
    ),
  );
  app.post(`${prefix}/notifications/:id/read`, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return service.markRead(
      await requirePrincipal(request, auth, 'notifications.read'),
      id,
    );
  });
  app.get(`${prefix}/push/configuration`, async (request) => {
    await requirePrincipal(request, auth, 'notifications.read');
    return service.configuration();
  });
  app.get(`${prefix}/push/subscriptions`, async (request) =>
    service.subscriptions(
      await requirePrincipal(request, auth, 'notifications.read'),
    ),
  );
  app.post(`${prefix}/push/subscriptions`, async (request, reply) =>
    reply
      .code(201)
      .send(
        await service.subscribe(
          await requirePrincipal(request, auth, 'notifications.manage'),
          request.body,
        ),
      ),
  );
  app.delete(`${prefix}/push/subscriptions/:id`, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await service.unsubscribe(
      await requirePrincipal(request, auth, 'notifications.manage'),
      id,
    );
    return reply.code(204).send();
  });
  app.post(`${prefix}/notifications/presence`, async (request, reply) => {
    const input = z
      .strictObject({ radioId: z.uuid(), listening: z.boolean() })
      .parse(request.body);
    await service.setPresence(
      await requirePrincipal(request, auth),
      input.radioId,
      input.listening,
    );
    return reply.code(204).send();
  });
}
