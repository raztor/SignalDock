import {
  SignalDockError,
  type ConnectorManifest,
  type ProcessingConnection,
  type ProcessingProfile,
  type ProcessingRequest,
} from '@signaldock/contracts';
import type {
  ProcessingConnector,
  ProcessingExecutionContext,
} from '@signaldock/processing-sdk';
import {
  jsonBody,
  object,
  request,
  requireContext,
  result,
  stringValue,
  taskInstruction,
  textOutput,
} from '../../src/http.js';

/** Subscription-backed inference is intentionally separate from API-key audio. */
export class OpenAISubscriptionConnector implements ProcessingConnector {
  describe(): ConnectorManifest {
    return {
      connectorId: 'openai-subscription-oauth',
      version: '0.1.0',
      sdkVersion: 1,
      capabilities: ['text.structured'],
      simulated: false,
      execution: 'cloud',
    };
  }
  async listModels(
    context: ProcessingExecutionContext,
    signal: AbortSignal,
  ): Promise<{ id: string; displayName: string }[]> {
    if (context.authentication.kind !== 'oauth')
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'Link a supported subscription account first.',
      );
    const payload = await jsonBody(
      await request(
        context,
        new URL('https://api.openai.com/v1/models'),
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${context.authentication.accessToken}`,
          },
        },
        signal,
      ),
    );
    if (!Array.isArray(payload['models']))
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'The subscription model catalog is invalid.',
      );
    return payload['models']
      .map(object)
      .filter((model) => model['visibility'] === 'list')
      .map((model) => ({
        id: stringValue(model['slug'], 'model identifier', 200),
        displayName: stringValue(
          model['display_name'],
          'model display name',
          200,
        ),
      }));
  }
  async execute(
    input: ProcessingRequest,
    connection: ProcessingConnection,
    profile: ProcessingProfile,
    signal: AbortSignal,
    resolved?: ProcessingExecutionContext,
  ) {
    const context = requireContext(resolved, 'text.structured');
    if (
      profile.capability !== 'text.structured' ||
      input.input.kind !== 'text' ||
      !context.task
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Subscription inference supports registered text tasks only.',
      );
    if (
      context.authentication.kind !== 'oauth' ||
      connection.owner.kind !== 'user' ||
      connection.owner.userId !== context.authentication.userId
    ) {
      throw new SignalDockError(
        'FORBIDDEN',
        'Subscription credentials must belong to the selected connection owner.',
      );
    }
    if (context.endpoint.replace(/\/$/, '') !== 'https://api.openai.com/v1')
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Subscription requests use the public Responses API.',
      );
    const response = await request(
      context,
      new URL('https://api.openai.com/v1/responses'),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${context.authentication.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: profile.model,
          instructions: taskInstruction(context),
          input: [{ role: 'user', content: input.input.text }],
          store: false,
          stream: true,
        }),
      },
      signal,
    );
    if (!response.headers.get('content-type')?.includes('text/event-stream'))
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'The subscription endpoint did not return its required event stream.',
      );
    return result(
      input,
      'openai-subscription-oauth',
      textOutput(context, input, await completedText(response, signal)),
    );
  }
}

export async function completedText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new SignalDockError(
      'PROVIDER_UNAVAILABLE',
      'The response stream is missing.',
    );
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let completed = false;
  let totalBytes = 0;
  const accept = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let event: Record<string, unknown>;
    try {
      event = object(JSON.parse(data));
    } catch {
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'The response stream contains malformed events.',
      );
    }
    if (event['type'] === 'response.output_text.delta')
      output += stringValue(event['delta'], 'text delta');
    if (
      event['type'] === 'response.failed' ||
      event['type'] === 'response.incomplete' ||
      event['type'] === 'error'
    )
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'Subscription inference failed or was incomplete.',
      );
    if (event['type'] === 'response.completed') {
      const payload = object(event['response']);
      if (payload['status'] !== 'completed')
        throw new SignalDockError(
          'PROVIDER_UNAVAILABLE',
          'Subscription inference did not complete successfully.',
        );
      completed = true;
    }
    if (output.length > 1024 * 1024)
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'The response exceeds the text limit.',
      );
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.length;
      if (totalBytes > 4 * 1024 * 1024)
        throw new SignalDockError(
          'PROVIDER_UNAVAILABLE',
          'The response event stream exceeds its limit.',
        );
      buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(
        /\r\n/g,
        '\n',
      );
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        accept(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) accept(buffer);
    if (!completed)
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'The response stream ended before terminal completion.',
      );
    return output;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}
