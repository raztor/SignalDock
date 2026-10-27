import { describe, expect, it } from 'vitest';
import type { JobExecutionContext, JobInput } from '@signaldock/contracts';
import {
  createLocalTranscriptAnalysisHandler,
  createRuleAnalysisHandler,
} from '../src/index.js';

function job(): JobInput {
  const communicationId = crypto.randomUUID();
  return {
    instanceId: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    kind: 'analysis.transcript',
    idempotencyKey: crypto.randomUUID(),
    deadline: new Date(Date.now() + 10000).toISOString(),
    source: { communicationId, communicationRevision: 3 },
    payload: { communicationId, transcriptRevisionId: crypto.randomUUID() },
  };
}

describe('shared analysis handler composition', () => {
  it.each(['rules', 'transcript'] as const)(
    'forwards the trusted scope and terminal commit context for %s',
    async (kind) => {
      const input = job();
      const signal = new AbortController().signal;
      const terminal: JobExecutionContext = {
        commit: async () => {
          throw new Error('The service owns its terminal write.');
        },
      };
      const analyze = async (...args: unknown[]) => {
        expect(args).toEqual([
          { instanceId: input.instanceId, ...input.payload },
          signal,
          input.jobId,
          terminal,
        ]);
        return { queuedAnalysis: true };
      };
      const handler =
        kind === 'rules'
          ? createRuleAnalysisHandler({ analyzeRules: analyze })
          : createLocalTranscriptAnalysisHandler({
              analyzeLocalTranscript: analyze,
            });
      expect(await handler(input, signal, terminal)).toEqual({
        queuedAnalysis: true,
      });
    },
  );
  it.each(['rules', 'transcript'] as const)(
    'rejects absent, mismatched and aborted source inputs before %s execution',
    async (kind) => {
      let calls = 0;
      const analyze = async () => {
        calls++;
        return null;
      };
      const handler =
        kind === 'rules'
          ? createRuleAnalysisHandler({ analyzeRules: analyze })
          : createLocalTranscriptAnalysisHandler({
              analyzeLocalTranscript: analyze,
            });
      const terminal: JobExecutionContext = {
        commit: async () => {
          throw new Error('No writes expected.');
        },
      };
      const input = job();
      const { source: _source, ...unversioned } = input;
      await expect(
        handler(unversioned, new AbortController().signal, terminal),
      ).rejects.toThrow('versioned');
      await expect(
        handler(
          {
            ...input,
            source: {
              communicationId: crypto.randomUUID(),
              communicationRevision: 3,
            },
          },
          new AbortController().signal,
          terminal,
        ),
      ).rejects.toThrow('versioned');
      const aborted = new AbortController();
      aborted.abort(new Error('Cancelled.'));
      await expect(handler(input, aborted.signal, terminal)).rejects.toThrow(
        'Cancelled',
      );
      expect(calls).toBe(0);
    },
  );
});
