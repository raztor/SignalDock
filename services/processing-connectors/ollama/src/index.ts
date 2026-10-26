import { SignalDockError, type ConnectorManifest, type ProcessingConnection, type ProcessingProfile, type ProcessingRequest } from '@signaldock/contracts';
import type { ProcessingConnector, ProcessingExecutionContext } from '@signaldock/processing-sdk';
import { endpoint, isLocalHost, jsonBody, object, request, requireContext, result, stringValue, textOutput } from '../../src/http.js';

export class OllamaConnector implements ProcessingConnector {
  describe(): ConnectorManifest { return { connectorId: 'ollama', version: '0.1.0', sdkVersion: 1, capabilities: ['text.structured'], simulated: false, execution: 'local' }; }
  async execute(input: ProcessingRequest, _connection: ProcessingConnection, profile: ProcessingProfile, signal: AbortSignal, resolved?: ProcessingExecutionContext) {
    const context = requireContext(resolved, 'text.structured');
    if (profile.capability !== 'text.structured' || input.input.kind !== 'text' || !context.task) throw new SignalDockError('CAPABILITY_UNSUPPORTED', 'This adapter supports registered text tasks only.');
    if (!isLocalHost(new URL(context.endpoint).hostname)) throw new SignalDockError('FORBIDDEN', 'The local Ollama adapter requires an explicitly local/private endpoint.');
    const response = await request(context, endpoint(context.endpoint, 'api/chat', context.configuration), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: profile.model, stream: false, format: context.task.outputSchema ?? 'json', messages: [
        { role: 'system', content: context.task.instruction }, { role: 'user', content: input.input.text }],
    }) }, signal);
    const body = await jsonBody(response);
    if (body['done'] !== true || (body['done_reason'] !== undefined && body['done_reason'] !== 'stop')) throw new SignalDockError('PROVIDER_UNAVAILABLE', 'Ollama did not complete the requested output.');
    return result(input, 'ollama', textOutput(context, input, stringValue(object(body['message'])['content'], 'text')));
  }
}
