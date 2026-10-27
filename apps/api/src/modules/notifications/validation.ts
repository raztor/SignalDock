import { z } from 'zod';
import type {
  NotificationCategory,
  NotificationPreference,
} from '@signaldock/contracts';

export const notificationCategories = [
  'communication',
  'transcript',
  'incident',
  'control',
  'radio',
  'storage',
  'processing',
] as const satisfies readonly NotificationCategory[];
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const NotificationPreferenceSchema = z.strictObject({
  categories: z.array(z.enum(notificationCategories)).max(7),
  radioIds: z.array(z.uuid()).max(100),
  frequencyHz: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  quietHours: z
    .strictObject({
      start: clock,
      end: clock,
      timeZone: z
        .string()
        .min(1)
        .max(100)
        .refine((zone) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: zone }).format();
            return true;
          } catch {
            return false;
          }
        }, 'Unknown time zone.'),
    })
    .optional(),
  cooldownSeconds: z.number().int().min(0).max(3600),
  suppressWhileListening: z.boolean(),
  enabled: z.boolean(),
});
export function parseNotificationPreference(
  input: unknown,
): NotificationPreference {
  const { frequencyHz, quietHours, ...rest } =
    NotificationPreferenceSchema.parse(input);
  return {
    ...rest,
    ...(frequencyHz === undefined ? {} : { frequencyHz }),
    ...(quietHours ? { quietHours } : {}),
  };
}
export const SubscriptionInputSchema = z.strictObject({
  deviceRef: z.uuid(),
  grantRef: z.uuid(),
});
export const NotificationCursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});
export function defaultNotificationPreference(): NotificationPreference {
  return {
    categories: [...notificationCategories],
    radioIds: [],
    cooldownSeconds: 30,
    suppressWhileListening: true,
    enabled: true,
  };
}
export function withinQuietHours(
  preference: NotificationPreference,
  date: Date,
): boolean {
  const quiet = preference.quietHours;
  if (!quiet || quiet.start === quiet.end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: quiet.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const current = `${parts.find((part) => part.type === 'hour')?.value}:${parts.find((part) => part.type === 'minute')?.value}`;
  return quiet.start < quiet.end
    ? current >= quiet.start && current < quiet.end
    : current >= quiet.start || current < quiet.end;
}
