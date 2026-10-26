import { z } from 'zod';
import {
  IdSchema,
  type JobHandler,
  type JobExecutionContext,
} from '@signaldock/contracts';

export interface RuleAnalysisHandlerPort {
  analyzeRules(
    reference: {
      instanceId: string;
      communicationId: string;
      transcriptRevisionId: string;
    },
    signal: AbortSignal,
    analysisId: string,
    execution: JobExecutionContext,
  ): Promise<unknown>;
}
export interface TranscriptAnalysisHandlerPort {
  analyzeLocalTranscript(
    reference: {
      instanceId: string;
      communicationId: string;
      transcriptRevisionId: string;
    },
    signal: AbortSignal,
    jobId: string,
    execution: JobExecutionContext,
  ): Promise<unknown>;
}
const payloadSchema = z.strictObject({
  communicationId: IdSchema,
  transcriptRevisionId: IdSchema,
});

/** Embedded jobs and workers inject the same structural service port. */
export function createRuleAnalysisHandler(
  service: RuleAnalysisHandlerPort,
): JobHandler {
  return async (job, signal, execution) => {
    signal.throwIfAborted();
    const source = payloadSchema.parse(job.payload);
    if (!job.source || job.source.communicationId !== source.communicationId)
      throw new Error('Analysis requires a matching versioned job source.');
    return service.analyzeRules(
      { instanceId: job.instanceId, ...source },
      signal,
      job.jobId,
      execution,
    );
  };
}

export function createLocalTranscriptAnalysisHandler(
  service: TranscriptAnalysisHandlerPort,
): JobHandler {
  return async (job, signal, execution) => {
    signal.throwIfAborted();
    const source = payloadSchema.parse(job.payload);
    if (!job.source || job.source.communicationId !== source.communicationId)
      throw new Error('Analysis requires a matching versioned job source.');
    return service.analyzeLocalTranscript(
      { instanceId: job.instanceId, ...source },
      signal,
      job.jobId,
      execution,
    );
  };
}
