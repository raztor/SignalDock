import { HistoryService } from '@signaldock/history';
import {
  SignalDockError,
  TimestampSchema,
  type JobHandler,
} from '@signaldock/contracts';
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
    const policy: {
      audioBefore?: string;
      transcriptsBefore?: string;
      communicationsBefore?: string;
      limit?: number;
    } = {};
    if (
      Object.keys(job.payload).some(
        (key) =>
          ![
            'audioBefore',
            'transcriptsBefore',
            'communicationsBefore',
            'limit',
          ].includes(key),
      )
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Unsupported maintenance policy field.',
      );
    for (const key of [
      'audioBefore',
      'transcriptsBefore',
      'communicationsBefore',
    ] as const) {
      const value = job.payload[key];
      if (value !== undefined) policy[key] = TimestampSchema.parse(value);
    }
    const limit = job.payload['limit'];
    if (limit !== undefined) {
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Invalid retention batch limit.',
        );
      policy.limit = limit;
    }
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
