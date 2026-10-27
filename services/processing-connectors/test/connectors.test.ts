import { describe, expect, it } from 'vitest';
import type {
  ProcessingConnection,
  ProcessingProfile,
  ProcessingRequest,
} from '@signaldock/contracts';
import {
  builtinProcessingTasks,
  ProcessingRegistry,
  type ProcessingExecutionContext,
} from '@signaldock/processing-sdk';
import {
  AzureSpeechConnector,
  completedText,
  OllamaConnector,
  OpenAIApiConnector,
  OpenAICompatibleConnector,
  OpenAISubscriptionConnector,
} from '../src/index.js';
import { endpoint } from '../src/http.js';

function setup(
  capability: ProcessingProfile['capability'] = 'text.structured',
) {
  const instanceId = crypto.randomUUID();
  const connection: ProcessingConnection = {
    connectionId: crypto.randomUUID(),
    instanceId,
    connectorId: 'openai-api',
    owner: { kind: 'instance' },
  };
  const profile: ProcessingProfile = {
    profileId: crypto.randomUUID(),
    revision: 1,
    connectionId: connection.connectionId,
    capability,
    model: 'configured-model',
    allowCloud: true,
  };
  const request: ProcessingRequest = {
    jobId: crypto.randomUUID(),
    instanceId,
    task: 'conversation.summarize',
    taskVersion: 1,
    profileId: profile.profileId,
    profileRevision: 1,
    deadline: new Date(Date.now() + 5000).toISOString(),
    input: {
      kind: 'text',
      text: 'Received a clear transmission.',
      communicationIds: [crypto.randomUUID()],
    },
  };
  const task = builtinProcessingTasks()[0]!;
  const context: ProcessingExecutionContext = {
    authentication: { kind: 'api-key', secret: 'private-key' },
    endpoint: 'https://api.openai.com/v1',
    capabilities: ['text.structured', 'stt.batch', 'tts.synthesize'],
    configuration: {},
    settings: {},
    task: {
      ...task.describePrompt!(request),
      normalizeOutput: task.normalizeOutput!,
    },
  };
  return {
    request,
    profile,
    connection,
    context,
    signal: new AbortController().signal,
  };
}
function responses(text: string) {
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  });
}

describe('real protocol connectors with controlled HTTP', () => {
  it('uses configured Responses schema without exposing tokens to another origin', async () => {
    const c = setup();
    let destination = '';
    let posted: Record<string, unknown> = {};
    c.context.configuration = { supportsJsonSchema: true };
    c.context.fetch = async (url, init) => {
      destination = String(url);
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer private-key',
      });
      return responses('{"summary":"Clear reception."}');
    };
    const result = await new OpenAIApiConnector().execute(
      c.request,
      c.connection,
      c.profile,
      c.signal,
      c.context,
    );
    expect(destination).toBe('https://api.openai.com/v1/responses');
    expect(posted['store']).toBe(false);
    expect(posted['tools']).toBeUndefined();
    expect(result).toMatchObject({
      simulated: false,
      output: { kind: 'summary', text: 'Clear reception.' },
    });
    await expect(
      new OpenAIApiConnector().execute(
        c.request,
        c.connection,
        c.profile,
        c.signal,
        { ...c.context, endpoint: 'https://other.example/v1' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('supports an explicitly selected compatible Chat Completions endpoint', async () => {
    const c = setup();
    c.context.endpoint = 'https://compatible.example/api/v1';
    c.context.configuration = { protocol: 'chat-completions' };
    c.context.fetch = async (url) => {
      expect(String(url)).toBe(
        'https://compatible.example/api/v1/chat/completions',
      );
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '{"summary":"Compatible output."}' },
          },
        ],
      });
    };
    const output = await new OpenAICompatibleConnector().execute(
      c.request,
      c.connection,
      c.profile,
      c.signal,
      c.context,
    );
    expect(output.output).toMatchObject({ text: 'Compatible output.' });
  });
  it('rejects incomplete, malformed and unavailable output without fallback', async () => {
    const c = setup();
    c.context.fetch = async () =>
      Response.json({ status: 'incomplete', output: [] });
    await expect(
      new OpenAIApiConnector().execute(
        c.request,
        c.connection,
        c.profile,
        c.signal,
        c.context,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    c.context.fetch = async () => responses('not JSON');
    await expect(
      new OpenAIApiConnector().execute(
        c.request,
        c.connection,
        c.profile,
        c.signal,
        c.context,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    c.context.fetch = async () =>
      new Response('private error body', {
        status: 429,
        headers: { 'x-request-id': 'test-id' },
      });
    await expect(
      new OpenAIApiConnector().execute(
        c.request,
        c.connection,
        c.profile,
        c.signal,
        c.context,
      ),
    ).rejects.toMatchObject({ status: 429, requestId: 'test-id' });
  });
  it('uploads only the authorized audio artifact as multipart transcription input', async () => {
    const c = setup('stt.batch');
    const artifactId = crypto.randomUUID();
    c.request.task = 'speech.transcribe';
    c.request.input = {
      kind: 'audio',
      artifactId,
      communicationIds: c.request.input.communicationIds,
    };
    c.context.readArtifact = async (id) => {
      expect(id).toBe(artifactId);
      return {
        artifactId,
        contentType: 'audio/wav',
        bytes: new Uint8Array([1, 2, 3]),
      };
    };
    c.context.fetch = async (_url, init) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get('model')).toBe('configured-model');
      return Response.json({ text: 'Received voice.' });
    };
    expect(
      (
        await new OpenAIApiConnector().execute(
          c.request,
          c.connection,
          c.profile,
          c.signal,
          c.context,
        )
      ).output,
    ).toEqual({ kind: 'transcript', text: 'Received voice.', artifactId });
  });
  it('stores TTS as an artifact and never starts transmission', async () => {
    const c = setup('tts.synthesize');
    c.context.settings = { voice: 'configured-voice' };
    c.request.task = 'speech.synthesize';
    const stored = crypto.randomUUID();
    let writes = 0;
    c.context.fetch = async () =>
      new Response(new Uint8Array([1, 2]), {
        headers: { 'Content-Type': 'audio/wav' },
      });
    c.context.writeArtifact = async ({ bytes, contentType }) => {
      writes++;
      expect(contentType).toBe('audio/wav');
      expect(bytes).toEqual(new Uint8Array([1, 2]));
      return { artifactId: stored };
    };
    const result = await new OpenAIApiConnector().execute(
      c.request,
      c.connection,
      c.profile,
      c.signal,
      c.context,
    );
    expect(writes).toBe(1);
    expect(result.output).toMatchObject({ kind: 'audio', artifactId: stored });
  });
  it('uses local Ollama without claiming audio support', async () => {
    const c = setup();
    c.context.endpoint = 'http://127.0.0.1:11434';
    c.context.authentication = { kind: 'none' };
    c.context.configuration = { allowPrivateNetwork: true };
    c.context.fetch = async (_url, init) => {
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      return Response.json({
        done: true,
        done_reason: 'stop',
        message: { content: '{"summary":"Local output."}' },
      });
    };
    const result = await new OllamaConnector().execute(
      c.request,
      c.connection,
      c.profile,
      c.signal,
      c.context,
    );
    expect(result.output).toMatchObject({ text: 'Local output.' });
    expect(new OllamaConnector().describe().capabilities).toEqual([
      'text.structured',
    ]);
    await expect(
      new OllamaConnector().execute(
        c.request,
        c.connection,
        c.profile,
        c.signal,
        { ...c.context, endpoint: 'https://remote.example' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('normalizes Azure fast transcription and escapes SSML synthesis input', async () => {
    const c = setup('stt.batch');
    const artifactId = crypto.randomUUID();
    c.request.task = 'speech.transcribe';
    c.request.input = {
      kind: 'audio',
      artifactId,
      communicationIds: c.request.input.communicationIds,
    };
    c.context.endpoint = 'https://resource.cognitiveservices.azure.com';
    c.context.settings = { language: 'es-CL', voice: 'es-CL-CatalinaNeural' };
    c.context.readArtifact = async () => ({
      artifactId,
      contentType: 'audio/wav',
      bytes: new Uint8Array([1]),
    });
    c.context.fetch = async (url) => {
      expect(String(url)).toContain('api-version=2025-10-15');
      return Response.json({ combinedPhrases: [{ text: 'Voice.' }] });
    };
    expect(
      (
        await new AzureSpeechConnector().execute(
          c.request,
          c.connection,
          c.profile,
          c.signal,
          c.context,
        )
      ).output,
    ).toMatchObject({ text: 'Voice.' });
    c.request.input = {
      kind: 'text',
      text: '<voice>untrusted & text</voice>',
      communicationIds: c.request.input.communicationIds,
    };
    c.profile.capability = 'tts.synthesize';
    c.context.configuration = {
      ttsEndpoint: 'https://westus.tts.speech.microsoft.com',
    };
    c.context.fetch = async (_url, init) => {
      expect(String(init?.body)).toContain(
        '&lt;voice&gt;untrusted &amp; text&lt;/voice&gt;',
      );
      return new Response(new Uint8Array([2]), {
        headers: { 'Content-Type': 'audio/wav' },
      });
    };
    c.context.writeArtifact = async () => ({ artifactId });
    expect(
      (
        await new AzureSpeechConnector().execute(
          c.request,
          c.connection,
          c.profile,
          c.signal,
          c.context,
        )
      ).output,
    ).toMatchObject({ kind: 'audio' });
  });
  it('enforces per-connection capability and OAuth ownership in the registry', async () => {
    const c = setup();
    const registry = new ProcessingRegistry();
    registry.register(new OpenAIApiConnector());
    await expect(
      registry.execute(
        c.request,
        c.connection,
        c.profile,
        { instanceId: c.request.instanceId },
        c.signal,
        { ...c.context, capabilities: [] },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(
      registry.execute(
        c.request,
        c.connection,
        c.profile,
        { instanceId: c.request.instanceId, userId: crypto.randomUUID() },
        c.signal,
        {
          ...c.context,
          authentication: {
            kind: 'oauth',
            accessToken: 'not-shared',
            userId: crypto.randomUUID(),
            accountId: 'account',
            workspaceId: 'workspace',
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('subscription completion and outbound policy', () => {
  const event = (type: string, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ type, ...extra })}\n\n`;
  it('requires terminal completed after partial streaming output', async () => {
    const signal = new AbortController().signal;
    await expect(
      completedText(
        new Response(event('response.output_text.delta', { delta: 'partial' })),
        signal,
      ),
    ).rejects.toThrow('before terminal completion');
    await expect(
      completedText(
        new Response(
          event('response.output_text.delta', { delta: 'partial' }) +
            event('response.failed'),
        ),
        signal,
      ),
    ).rejects.toThrow('failed or was incomplete');
    expect(
      await completedText(
        new Response(
          event('response.output_text.delta', { delta: 'valid' }) +
            event('response.completed', { response: { status: 'completed' } }),
        ),
        signal,
      ),
    ).toBe('valid');
  });
  it('never enables speech endpoints through subscription credentials', async () => {
    const c = setup('stt.batch');
    await expect(
      new OpenAISubscriptionConnector().execute(
        c.request,
        c.connection,
        c.profile,
        c.signal,
        c.context,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(new OpenAISubscriptionConnector().describe().capabilities).toEqual([
      'text.structured',
    ]);
  });
  it.each([
    'https://user:key@provider.example',
    'https://provider.example?secret=1',
    'http://public.example',
    'http://169.254.169.254',
  ])('rejects untrusted provider URL %s', (url) => {
    expect(() =>
      endpoint(url, 'responses', { allowPrivateNetwork: true }),
    ).toThrow();
  });
});
