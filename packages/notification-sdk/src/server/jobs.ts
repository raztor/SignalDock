import { z } from 'zod';
import type { JobHandler } from '@signaldock/contracts';

export interface NotificationDeliveryService {
  deliver(instanceId: string, notificationId: string): Promise<void>;
  revokeExternalGrant(grantId: string): Promise<void>;
}
export function notificationDeliveryHandler(
  service: NotificationDeliveryService,
): JobHandler {
  return async (job, signal) => {
    signal.throwIfAborted();
    const payload = z
      .strictObject({ notificationId: z.uuid() })
      .parse(job.payload);
    await service.deliver(job.instanceId, payload.notificationId);
    signal.throwIfAborted();
    return { notificationId: payload.notificationId };
  };
}
export function notificationRevocationHandler(
  service: NotificationDeliveryService,
): JobHandler {
  return async (job, signal) => {
    signal.throwIfAborted();
    const payload = z.strictObject({ grantId: z.uuid() }).parse(job.payload);
    await service.revokeExternalGrant(payload.grantId);
    signal.throwIfAborted();
    return { revoked: true };
  };
}
