import {
  SignalDockError,
  type ProcessingCapability,
  type ProcessingRequest,
  type ProcessingResult,
} from '@signaldock/contracts';

export interface ProcessingTaskDefinition {
  taskId: string;
  version: number;
  capability: ProcessingCapability;
  validateInput(request: ProcessingRequest): void;
  validateOutput(request: ProcessingRequest, result: ProcessingResult): void;
}

export function builtinProcessingTasks(): ProcessingTaskDefinition[] {
  return [
    {
      taskId: 'conversation.summarize',
      version: 1,
      capability: 'text.structured',
      validateInput(request) {
        if (request.input.kind !== 'text')
          throw new SignalDockError(
            'INVALID_ARGUMENT',
            'Summary input must be text.',
          );
      },
      validateOutput(_request, result) {
        if (result.output.kind !== 'summary')
          throw new SignalDockError(
            'PROVIDER_UNAVAILABLE',
            'The summary task requires a summary result.',
          );
      },
    },
    {
      taskId: 'speech.transcribe',
      version: 1,
      capability: 'stt.batch',
      validateInput(request) {
        if (request.input.kind !== 'audio')
          throw new SignalDockError(
            'INVALID_ARGUMENT',
            'Transcription input must reference audio.',
          );
      },
      validateOutput(request, result) {
        if (
          result.output.kind !== 'transcript' ||
          request.input.kind !== 'audio' ||
          result.output.artifactId !== request.input.artifactId
        ) {
          throw new SignalDockError(
            'PROVIDER_UNAVAILABLE',
            'Transcription returned an invalid result or another artifact.',
          );
        }
      },
    },
  ];
}
