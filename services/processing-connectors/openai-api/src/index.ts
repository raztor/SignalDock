import {
  SignalDockError,
  type ProcessingConnection,
  type ProcessingProfile,
  type ProcessingRequest,
} from '@signaldock/contracts';
import type { ProcessingExecutionContext } from '@signaldock/processing-sdk';
import { OpenAICompatibleConnector } from '../../openai-compatible/src/index.js';

export class OpenAIApiConnector extends OpenAICompatibleConnector {
  constructor() {
    super('openai-api');
  }
  override async execute(
    input: ProcessingRequest,
    connection: ProcessingConnection,
    profile: ProcessingProfile,
    signal: AbortSignal,
    context?: ProcessingExecutionContext,
  ) {
    if (
      context &&
      new URL(context.endpoint).href.replace(/\/$/, '') !==
        'https://api.openai.com/v1'
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'The official API connector uses the public OpenAI API endpoint.',
      );
    return super.execute(input, connection, profile, signal, context);
  }
}
