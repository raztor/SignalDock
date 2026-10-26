import { SignalDockError, type ConnectorManifest, type ProcessingConnection, type ProcessingProfile, type ProcessingRequest, type ProcessingResult } from '@signaldock/contracts';
import type { ProcessingConnector, ProcessingExecutionContext } from '@signaldock/processing-sdk';
import { apiKey, audioInput, endpoint, isLocalHost, jsonBody, object, request, requireContext, result, saveAudio, setting, stringValue, taskInstruction, textOutput } from '../../src/http.js';

export class OpenAICompatibleConnector implements ProcessingConnector {
  constructor(private readonly connectorId = 'openai-compatible') {}
  describe(): ConnectorManifest { return { connectorId: this.connectorId, version: '0.1.0', sdkVersion: 1,
    capabilities: ['text.structured', 'stt.batch', 'tts.synthesize'], simulated: false, execution: 'cloud' }; }
  executionScope(context: ProcessingExecutionContext | undefined): 'local' | 'cloud' {
    if (this.connectorId !== 'openai-compatible' || !context) return 'cloud';
    const configured = endpoint(context.endpoint, '', context.configuration);
    return isLocalHost(configured.hostname) && context.configuration['allowPrivateNetwork'] === true ? 'local' : 'cloud';
  }
  async execute(input: ProcessingRequest, _connection: ProcessingConnection, profile: ProcessingProfile, signal: AbortSignal, resolved?: ProcessingExecutionContext): Promise<ProcessingResult> {
    const context = requireContext(resolved, profile.capability);
    const authorization = context.authentication.kind === 'none' && this.connectorId === 'openai-compatible' ? {} : { Authorization: `Bearer ${apiKey(context)}` };
    if (profile.capability === 'text.structured') {
      if (input.input.kind !== 'text' || !context.task) throw new SignalDockError('INVALID_ARGUMENT', 'A registered text task is required.');
      const protocol = context.configuration['protocol'] ?? 'responses';
      if (protocol !== 'responses' && protocol !== 'chat-completions') throw new SignalDockError('INVALID_ARGUMENT', 'Select Responses or Chat Completions explicitly.');
      const format = context.configuration['supportsJsonSchema'] === true && context.task.outputSchema ?
        { type: 'json_schema', name: 'signaldock_result', strict: true, schema: context.task.outputSchema } : undefined;
      const body = protocol === 'responses' ? { model: profile.model, instructions: taskInstruction(context),
        input: [{ role: 'user', content: input.input.text }], store: false, stream: false,
        ...(format ? { text: { format } } : {}) } : { model: profile.model, messages: [
          { role: 'system', content: taskInstruction(context) }, { role: 'user', content: input.input.text }], stream: false,
          ...(format ? { response_format: { type: 'json_schema', json_schema: { name: format.name, strict: true, schema: format.schema } } } : {}) };
      const response = await request(context, endpoint(context.endpoint, protocol === 'responses' ? 'responses' : 'chat/completions', context.configuration),
        { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
      const payload = await jsonBody(response); let text: string;
      if (protocol === 'responses') {
        if (payload['status'] !== 'completed') throw new SignalDockError('PROVIDER_UNAVAILABLE', 'The Responses request did not complete.');
        const output = payload['output'];
        if (!Array.isArray(output)) throw new SignalDockError('PROVIDER_UNAVAILABLE', 'The Responses output is invalid.');
        text = output.flatMap((part) => { const content = object(part)['content']; return Array.isArray(content) ? content.filter((item) => object(item)['type'] === 'output_text').map((item) => stringValue(object(item)['text'], 'text')) : []; }).join('');
      } else {
        const choices = payload['choices']; if (!Array.isArray(choices) || choices.length !== 1) throw new SignalDockError('PROVIDER_UNAVAILABLE', 'The Chat Completions output is invalid.');
        const choice = object(choices[0]);
        if (choice['finish_reason'] !== 'stop') throw new SignalDockError('PROVIDER_UNAVAILABLE', 'The Chat Completions request did not finish normally.');
        text = stringValue(object(choice['message'])['content'], 'text');
      }
      return result(input, this.connectorId, textOutput(context, input, text));
    }
    if (profile.capability === 'stt.batch') {
      const audio = await audioInput(context, input, signal); const form = new FormData();
      form.set('model', profile.model); form.set('file', new Blob([new Uint8Array(audio.bytes)], { type: audio.contentType }), 'communication.wav');
      const language = setting(context, 'language'); if (language) form.set('language', language);
      const response = await request(context, endpoint(context.endpoint, 'audio/transcriptions', context.configuration), { method: 'POST', headers: authorization, body: form }, signal);
      const payload = await jsonBody(response);
      return result(input, this.connectorId, { kind: 'transcript', text: stringValue(payload['text'], 'transcript'), artifactId: audio.artifactId });
    }
    if (profile.capability === 'tts.synthesize') {
      if (input.input.kind !== 'text') throw new SignalDockError('INVALID_ARGUMENT', 'Synthesis requires text.');
      const response = await request(context, endpoint(context.endpoint, 'audio/speech', context.configuration), { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: profile.model, input: input.input.text, voice: setting(context, 'voice', true), response_format: 'wav' }) }, signal);
      return result(input, this.connectorId, await saveAudio(context, input, response, signal));
    }
    throw new SignalDockError('CAPABILITY_UNSUPPORTED', 'This connection does not support the requested capability.');
  }
}
