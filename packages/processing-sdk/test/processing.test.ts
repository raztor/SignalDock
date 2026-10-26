import { describe, expect, it } from 'vitest';
import type {
  ProcessingConnection,
  ProcessingProfile,
  ProcessingRequest,
} from '@signaldock/contracts';
import {
  FixtureTextConnector,
  FixtureTranscriptionConnector,
  ProcessingRegistry,
  type ProcessingConnector,
} from '../src/index.js';

function context() {
  const instanceId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const connection: ProcessingConnection = {
    instanceId,
    connectionId: crypto.randomUUID(),
    connectorId: 'fixture.text',
    owner: { kind: 'instance' },
  };
  const profile: ProcessingProfile = {
    profileId,
    revision: 1,
    connectionId: connection.connectionId,
    capability: 'text.structured',
    model: 'fixture',
    allowCloud: false,
  };
  const request: ProcessingRequest = {
    instanceId,
    profileId,
    profileRevision: 1,
    jobId: crypto.randomUUID(),
    taskVersion: 1,
    deadline: new Date(Date.now() + 10000).toISOString(),
    task: 'conversation.summarize',
    input: {
      kind: 'text',
      text: 'Station one reports clear reception.',
      communicationIds: [crypto.randomUUID()],
    },
  };
  const registry = new ProcessingRegistry();
  registry.register(new FixtureTextConnector());
  return {
    instanceId,
    request,
    profile,
    connection,
    registry,
    signal: new AbortController().signal,
  };
}

describe('processing registry boundaries', () => {
  it('adds a versioned task and connector without changing registry dispatch', async () => {
    const c = context();
    c.registry.registerTask({
      taskId: 'fixture.custom',
      version: 1,
      capability: 'text.structured',
      validateInput(request) {
        if (request.input.kind !== 'text') throw new Error('Text is required.');
      },
      validateOutput(_request, result) {
        if (
          result.output.kind !== 'extension' ||
          result.output.schemaId !== 'fixture.custom' ||
          result.output.schemaVersion !== 1 ||
          typeof result.output.data['label'] !== 'string'
        )
          throw new Error('Invalid task output.');
      },
    });
    c.registry.register({
      describe: () => ({
        ...new FixtureTextConnector().describe(),
        connectorId: 'fixture.custom-provider',
      }),
      execute: async (request) => ({
        jobId: request.jobId,
        connectorId: 'fixture.custom-provider',
        profileRevision: request.profileRevision,
        simulated: true,
        output: {
          kind: 'extension',
          schemaId: 'fixture.custom',
          schemaVersion: 1,
          data: { label: 'Known fixture' },
          evidenceIds: request.input.communicationIds,
        },
      }),
    });
    const result = await c.registry.execute(
      { ...c.request, task: 'fixture.custom' },
      { ...c.connection, connectorId: 'fixture.custom-provider' },
      c.profile,
      { instanceId: c.instanceId },
      c.signal,
    );
    expect(result.output).toMatchObject({
      kind: 'extension',
      data: { label: 'Known fixture' },
    });
    await expect(
      c.registry.execute(
        { ...c.request, task: 'fixture.custom', taskVersion: 2 },
        c.connection,
        c.profile,
        { instanceId: c.instanceId },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });
  it('executes fixture connectors with different capabilities through the same registry', async () => {
    const c = context();
    const artifactId = crypto.randomUUID();
    const summary = await c.registry.execute(
      c.request,
      c.connection,
      c.profile,
      { instanceId: c.instanceId },
      c.signal,
    );
    expect(summary).toMatchObject({
      simulated: true,
      output: {
        kind: 'summary',
        evidenceIds: c.request.input.communicationIds,
      },
    });
    c.registry.register(
      new FixtureTranscriptionConnector(
        new Map([[artifactId, 'A known fixture transcript.']]),
      ),
    );
    const transcript = await c.registry.execute(
      {
        ...c.request,
        task: 'speech.transcribe',
        input: {
          kind: 'audio',
          artifactId,
          communicationIds: c.request.input.communicationIds,
        },
      },
      { ...c.connection, connectorId: 'fixture.stt' },
      { ...c.profile, capability: 'stt.batch' },
      { instanceId: c.instanceId },
      c.signal,
    );
    expect(transcript.output).toEqual({
      kind: 'transcript',
      text: 'A known fixture transcript.',
      artifactId,
    });
    expect('cost' in transcript).toBe(false);
  });
  it('rejects connections from another instance or user', async () => {
    const c = context();
    await expect(
      c.registry.execute(
        c.request,
        c.connection,
        c.profile,
        { instanceId: crypto.randomUUID() },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      c.registry.execute(
        c.request,
        {
          ...c.connection,
          owner: { kind: 'user', userId: crypto.randomUUID() },
        },
        c.profile,
        { instanceId: c.instanceId, userId: crypto.randomUUID() },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects a missing capability and changed profile revision', async () => {
    const c = context();
    await expect(
      c.registry.execute(
        c.request,
        c.connection,
        { ...c.profile, capability: 'tts.synthesize' },
        { instanceId: c.instanceId },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(
      c.registry.execute(
        c.request,
        c.connection,
        { ...c.profile, revision: 2 },
        { instanceId: c.instanceId },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });
  it('never switches a missing connector to another installed provider', async () => {
    const c = context();
    await expect(
      c.registry.execute(
        c.request,
        { ...c.connection, connectorId: 'missing.provider' },
        c.profile,
        { instanceId: c.instanceId },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
  it('blocks cloud transfer when the selected profile is local-only', async () => {
    const c = context();
    let called = false;
    const cloud: ProcessingConnector = {
      describe: () => ({
        ...new FixtureTextConnector().describe(),
        connectorId: 'fixture.cloud',
        execution: 'cloud',
      }),
      execute: async () => {
        called = true;
        throw new Error('Must not execute.');
      },
    };
    c.registry.register(cloud);
    await expect(
      c.registry.execute(
        c.request,
        { ...c.connection, connectorId: 'fixture.cloud' },
        c.profile,
        { instanceId: c.instanceId },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(called).toBe(false);
  });
  it('does not accept a result for another job or unrelated evidence', async () => {
    const c = context();
    const fixture = new FixtureTextConnector();
    const bad: ProcessingConnector = {
      describe: () => ({ ...fixture.describe(), connectorId: 'fixture.bad' }),
      execute: async (request, connection, profile, signal) => ({
        ...(await fixture.execute(request, connection, profile, signal)),
        connectorId: 'fixture.bad',
        output: {
          kind: 'summary',
          text: 'Unsupported claim.',
          evidenceIds: [crypto.randomUUID()],
        },
      }),
    };
    c.registry.register(bad);
    await expect(
      c.registry.execute(
        c.request,
        { ...c.connection, connectorId: 'fixture.bad' },
        c.profile,
        { instanceId: c.instanceId },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
  it('cancels a connector that has not completed instead of accepting partial work', async () => {
    const c = context();
    const controller = new AbortController();
    const stuck: ProcessingConnector = {
      describe: () => ({
        ...new FixtureTextConnector().describe(),
        connectorId: 'fixture.stuck',
      }),
      execute: async () => new Promise(() => undefined),
    };
    c.registry.register(stuck);
    const pending = c.registry.execute(
      c.request,
      { ...c.connection, connectorId: 'fixture.stuck' },
      c.profile,
      { instanceId: c.instanceId },
      controller.signal,
    );
    controller.abort(new Error('Cancelled by owner.'));
    await expect(pending).rejects.toThrow('Cancelled by owner.');
  });
  it('rejects a job that expired before dispatch', async () => {
    const c = context();
    await expect(
      c.registry.execute(
        { ...c.request, deadline: '2000-01-01T00:00:00Z' },
        c.connection,
        c.profile,
        { instanceId: c.instanceId },
        c.signal,
      ),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });
});
