import { z } from 'zod';
import { HistoryService } from '@signaldock/history';
import { SignalDockError, type JobHandler } from '@signaldock/contracts';

const policySchema = z.strictObject({
  audioBefore: z.iso.datetime().optional(),
  transcriptsBefore: z.iso.datetime().optional(),
  communicationsBefore: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
/** Register as history.maintenance only from trusted instance administration. */
export function createHistoryMaintenanceHandler(
  history: HistoryService,
): JobHandler {
  return async (job, signal) => {
    if (signal.aborted)
      throw new SignalDockError(
        'DEADLINE_EXCEEDED',
        'Maintenance was cancelled.',
      );
    const policy = policySchema.parse(job.payload);
    const cleanup = await history.cleanupDeletedArtifacts(job.instanceId);
    if (signal.aborted)
      throw new SignalDockError(
        'DEADLINE_EXCEEDED',
        'Maintenance was cancelled.',
      );
    const retained = await history.applyRetention(job.instanceId, {
      ...(policy.audioBefore ? { audioBefore: policy.audioBefore } : {}),
      ...(policy.transcriptsBefore
        ? { transcriptsBefore: policy.transcriptsBefore }
        : {}),
      ...(policy.communicationsBefore
        ? { communicationsBefore: policy.communicationsBefore }
        : {}),
      ...(policy.limit ? { limit: policy.limit } : {}),
    });
    return { cleanup, ...retained };
  };
}
