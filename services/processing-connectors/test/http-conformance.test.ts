import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ProcessingConnection, ProcessingProfile, ProcessingRequest } from '@signaldock/contracts';
import { builtinProcessingTasks, ProcessingRegistry } from '@signaldock/processing-sdk';
import { OpenAICompatibleConnector } from '../openai-compatible/src/index.js';

describe('real loopback HTTP conformance', () => {
  it('uses the configured endpoint prefix and cancels an in-flight provider request', async () => {
    let hanging = false; let requestStarted: (() => void) | undefined;
    const server = createServer(async (request, response) => {
      expect(request.url).toBe('/prefix/v1/chat/completions'); expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe('Bearer protected-test-key');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      expect(body['model']).toBe('configured-test-model'); expect(body['stream']).toBe(false);
      if (hanging) { requestStarted?.(); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"Loopback conformance"}' } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback listener.');
      const instanceId = crypto.randomUUID();
      const connection: ProcessingConnection = { connectionId: crypto.randomUUID(), instanceId, connectorId: 'openai-compatible', owner: { kind: 'instance' } };
      const profile: ProcessingProfile = { profileId: crypto.randomUUID(), revision: 1, connectionId: connection.connectionId, model: 'configured-test-model', capability: 'text.structured', allowCloud: true };
      const request: ProcessingRequest = { instanceId, jobId: crypto.randomUUID(), profileId: profile.profileId, profileRevision: 1, deadline: new Date(Date.now() + 5000).toISOString(), task: 'conversation.summarize', taskVersion: 1, input: { kind: 'text', text: 'Recorded transmission', communicationIds: [crypto.randomUUID()] } };
      const task = builtinProcessingTasks()[0]!; const connector = new OpenAICompatibleConnector();
      const context = { endpoint: `http://127.0.0.1:${address.port}/prefix/v1`, configuration: { protocol: 'chat-completions', allowPrivateNetwork: true }, capabilities: ['text.structured' as const], settings: {}, authentication: { kind: 'api-key' as const, secret: 'protected-test-key' }, task: { ...task.describePrompt!(request), normalizeOutput: task.normalizeOutput! } };
      const registry = new ProcessingRegistry(); registry.register(connector);
      expect((await registry.execute(request, connection, { ...profile, allowCloud: false }, { instanceId }, new AbortController().signal, context)).output).toMatchObject({ kind: 'summary', text: 'Loopback conformance' });
      hanging = true; const controller = new AbortController();
      const started = new Promise<void>((resolve) => { requestStarted = resolve; });
      const pending = connector.execute(request, connection, profile, controller.signal, context);
      const assertion = expect(pending).rejects.toThrow(); await started;
      controller.abort(new Error('Cancelled by operator.')); await assertion;
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
