import { z } from 'zod';

export const NotificationReferenceSchema = z.strictObject({
  instanceId: z.uuid(),
  radioId: z.uuid().optional(),
  eventId: z.uuid(),
  notificationId: z.uuid(),
});
export type NotificationReference = z.infer<typeof NotificationReferenceSchema>;

/** A push may select only a previously saved instance, never introduce a URL. */
export function resolveNotificationReference(
  payload: unknown,
  saved: readonly { instanceId: string; baseUrl: string }[],
): { reference: NotificationReference; baseUrl: string } | null {
  const parsed = NotificationReferenceSchema.safeParse(payload);
  if (!parsed.success) return null;
  const match = saved.find(
    (server) => server.instanceId === parsed.data.instanceId,
  );
  if (!match) return null;
  return { reference: parsed.data, baseUrl: match.baseUrl };
}
