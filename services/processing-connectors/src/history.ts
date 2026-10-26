import {
  SignalDockError,
  type Communication,
  type DatabasePort,
  type Permission,
  type TranscriptRevision,
} from '@signaldock/contracts';
import type { ProcessingActor, ProcessingRuntimeOptions } from './runtime.js';

/** Structural adapter for the shared history service, avoiding a concrete provider/history dependency. */
export interface ProcessingHistoryPort {
  get(
    instanceId: string,
    communicationId: string,
    transaction?: DatabasePort,
  ): Promise<Communication | null>;
  appendTranscript(
    instanceId: string,
    communicationId: string,
    input: {
      text: string;
      source: 'provider' | 'human';
      provenance: Record<string, unknown>;
      expectedRevision: number;
    },
    transaction?: DatabasePort,
  ): Promise<TranscriptRevision>;
}
export function createHistoryProcessingHooks(
  history: ProcessingHistoryPort,
  authorizeActor: (
    actor: ProcessingActor,
    permission: Permission,
    radioId: string,
  ) => Promise<void>,
  options: {
    onTranscriptCommitted?: (
      transaction: DatabasePort,
      actor: ProcessingActor,
      communication: Communication,
      transcript: TranscriptRevision,
    ) => Promise<void>;
  } = {},
): Pick<ProcessingRuntimeOptions, 'validateInputs' | 'onCompleted'> {
  return {
    async validateInputs(actor, request, source, transaction) {
      if (request.instanceId !== actor.instanceId)
        throw new SignalDockError(
          'FORBIDDEN',
          'The processing input belongs to another instance.',
        );
      if (request.task === 'speech.synthesize') {
        if (
          request.input.kind !== 'text' ||
          request.input.communicationIds.length ||
          source
        )
          throw new SignalDockError(
            'INVALID_ARGUMENT',
            'Prepared speech must not claim unrelated communication evidence.',
          );
        return;
      }
      if (
        !source ||
        request.input.communicationIds.length !== 1 ||
        request.input.communicationIds[0] !== source.communicationId
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'The processing job requires one versioned communication.',
        );
      const communication = await history.get(
        actor.instanceId,
        source.communicationId,
        transaction,
      );
      if (
        !communication ||
        communication.instanceId !== actor.instanceId ||
        communication.deletedAt
      )
        throw new SignalDockError(
          'NOT_FOUND',
          'The source communication is unavailable.',
        );
      await authorizeActor(actor, 'history.read', communication.radioId);
      if (communication.revision !== source.communicationRevision)
        throw new SignalDockError(
          'STALE_REVISION',
          'The source communication changed.',
        );
      if (request.input.kind === 'audio') {
        if (
          communication.recording?.state !== 'available' ||
          communication.recording.artifactId !== request.input.artifactId ||
          source.artifactId !== request.input.artifactId
        )
          throw new SignalDockError(
            'FORBIDDEN',
            'The artifact is not the available recording for this communication.',
          );
      } else {
        const transcript = communication.transcripts.at(-1);
        if (!transcript || transcript.text !== request.input.text)
          throw new SignalDockError(
            'STALE_REVISION',
            'Structured processing must use the current authorized transcript.',
          );
      }
    },
    async onCompleted(transaction, actor, request, result) {
      if (result.output.kind !== 'transcript') return;
      if (
        request.input.kind !== 'audio' ||
        request.input.communicationIds.length !== 1 ||
        result.output.artifactId !== request.input.artifactId
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'The transcription result does not match its input.',
        );
      const communicationId = request.input.communicationIds[0]!;
      const communication = await history.get(
        actor.instanceId,
        communicationId,
        transaction,
      );
      if (
        !communication ||
        communication.deletedAt ||
        communication.recording?.state !== 'available' ||
        communication.recording.artifactId !== result.output.artifactId
      )
        throw new SignalDockError(
          'NOT_FOUND',
          'The recording was removed before transcription completed.',
        );
      await authorizeActor(actor, 'history.read', communication.radioId);
      const transcript = await history.appendTranscript(
        actor.instanceId,
        communicationId,
        {
          text: result.output.text,
          source: 'provider',
          expectedRevision: communication.revision,
          provenance: {
            jobId: request.jobId,
            connectorId: result.connectorId,
            profileId: request.profileId,
            profileRevision: request.profileRevision,
            task: request.task,
            taskVersion: request.taskVersion,
            simulated: result.simulated,
          },
        },
        transaction,
      );
      if (options.onTranscriptCommitted) {
        const current = await history.get(
          actor.instanceId,
          communicationId,
          transaction,
        );
        if (!current || current.deletedAt)
          throw new SignalDockError(
            'NOT_FOUND',
            'The transcript source disappeared during commit.',
          );
        // Enqueue/outbox writes only: transcript and follow-up jobs become visible in this same commit.
        await options.onTranscriptCommitted(
          transaction,
          actor,
          current,
          transcript,
        );
      }
    },
  };
}
