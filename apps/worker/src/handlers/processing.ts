import type { JobQueuePort } from '@signaldock/contracts';
import type { ProcessingRuntime } from '@signaldock/processing-connectors';

export function registerProcessingHandlers(
  queue: JobQueuePort,
  processing: ProcessingRuntime,
): void {
  queue.register('processing.execute', (job, signal, execution) =>
    processing.execute(job, signal, execution),
  );
}
