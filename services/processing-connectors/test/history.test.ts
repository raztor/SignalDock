import { describe, expect, it, vi } from 'vitest';
import type {
  Communication,
  DatabasePort,
  Principal,
  ProcessingRequest,
} from '@signaldock/contracts';
import {
  createHistoryProcessingHooks,
  type ProcessingHistoryPort,
} from '../src/history.js';

function fixture() {
  const instanceId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const actor = {
    instanceId,
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
  } as Principal;
  const transcriptRevisionId = crypto.randomUUID();
  const communication = {
    id,
    instanceId,
    radioId: crypto.randomUUID(),
    revision: 3,
    recording: { artifactId, state: 'available' },
    transcripts: [{ id: transcriptRevisionId, text: 'Current source text' }],
  } as Communication;
  const history = {
    get: vi.fn(async () => communication),
    validateJobSource: vi.fn(async () => true),
    appendTranscript: vi.fn(async () => ({})),
  } as unknown as ProcessingHistoryPort;
  const authorize = vi.fn(async () => undefined);
  const hooks = createHistoryProcessingHooks(history, authorize);
  const request: ProcessingRequest = {
    instanceId,
    jobId: crypto.randomUUID(),
    profileId: crypto.randomUUID(),
    profileRevision: 1,
    task: 'speech.transcribe',
    taskVersion: 1,
    deadline: new Date(Date.now() + 60000).toISOString(),
    input: { kind: 'audio', artifactId, communicationIds: [id] },
  };
  const source = {
    communicationId: id,
    communicationRevision: 3,
    artifactId,
    transcriptRevisionId,
  };
  return { actor, communication, history, authorize, hooks, request, source };
}
describe('history processing source and provenance hooks', () => {
  it('authorizes the actual source radio and rejects unrelated artifacts or changed revisions', async () => {
    const f = fixture();
    await f.hooks.validateInputs(f.actor, f.request, f.source);
    expect(f.authorize).toHaveBeenCalledWith(
      f.actor,
      'history.read',
      f.communication.radioId,
      undefined,
    );
    await expect(
      f.hooks.validateInputs(f.actor, f.request, {
        ...f.source,
        communicationRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      f.hooks.validateInputs(
        f.actor,
        f.request,
        f.source,
        undefined,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      f.hooks.validateInputs(
        f.actor,
        {
          ...f.request,
          input: {
            ...f.request.input,
            kind: 'audio',
            artifactId: crypto.randomUUID(),
          },
        },
        f.source,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('requires current source text for structured tasks and disallows evidence on prepared speech', async () => {
    const f = fixture();
    const request = {
      ...f.request,
      task: 'conversation.summarize',
      input: {
        kind: 'text' as const,
        text: 'Forged source text',
        communicationIds: [f.communication.id],
      },
    };
    await expect(
      f.hooks.validateInputs(f.actor, request, f.source),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      f.hooks.validateInputs(
        f.actor,
        {
          ...request,
          input: { ...request.input, text: 'Current source text' },
        },
        f.source,
      ),
    ).resolves.toBeUndefined();
    await expect(
      f.hooks.validateInputs(
        f.actor,
        {
          ...request,
          input: { ...request.input, text: 'Current source text' },
        },
        { ...f.source, transcriptRevisionId: crypto.randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      f.hooks.validateInputs(
        f.actor,
        { ...request, task: 'speech.synthesize' },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('persists transcript provenance in the exact terminal transaction, including valid silence', async () => {
    const f = fixture();
    const tx = {} as DatabasePort;
    await f.hooks.onCompleted!(tx, f.actor, f.request, {
      jobId: f.request.jobId,
      connectorId: 'fixture.stt',
      profileRevision: 1,
      simulated: true,
      output: { kind: 'transcript', artifactId: f.source.artifactId, text: '' },
    });
    expect(f.history.appendTranscript).toHaveBeenCalledWith(
      f.actor.instanceId,
      f.communication.id,
      expect.objectContaining({
        text: '',
        source: 'provider',
        expectedRevision: 3,
        provenance: expect.objectContaining({
          task: 'speech.transcribe',
          jobId: f.request.jobId,
          simulated: true,
        }),
      }),
      tx,
    );
    f.communication.deletedAt = new Date().toISOString();
    await expect(
      f.hooks.onCompleted!(tx, f.actor, f.request, {
        jobId: f.request.jobId,
        connectorId: 'fixture.stt',
        profileRevision: 1,
        simulated: true,
        output: {
          kind: 'transcript',
          artifactId: f.source.artifactId,
          text: 'Late',
        },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.history.appendTranscript).toHaveBeenCalledOnce();
  });
  it('enqueues follow-up work in the same transaction against the new transcript revision', async () => {
    const f = fixture();
    const tx = {} as DatabasePort;
    const transcript = {
      id: crypto.randomUUID(),
      communicationId: f.communication.id,
      revision: 1,
      text: 'New transcript',
      source: 'provider' as const,
      provenance: {},
      createdAt: new Date().toISOString(),
    };
    vi.mocked(f.history.appendTranscript).mockImplementationOnce(async () => {
      f.communication.revision = 4;
      f.communication.transcripts = [transcript];
      return transcript;
    });
    const onTranscriptCommitted = vi.fn(async () => undefined);
    const hooks = createHistoryProcessingHooks(f.history, f.authorize, {
      onTranscriptCommitted,
    });
    await hooks.onCompleted!(tx, f.actor, f.request, {
      jobId: f.request.jobId,
      connectorId: 'fixture.stt',
      profileRevision: 1,
      simulated: true,
      output: {
        kind: 'transcript',
        artifactId: f.source.artifactId,
        text: 'New transcript',
      },
    });
    expect(onTranscriptCommitted).toHaveBeenCalledWith(
      tx,
      f.actor,
      expect.objectContaining({ revision: 4 }),
      transcript,
    );
  });
  it('forwards the terminal transaction into both source and completion authorization', async () => {
    const f = fixture();
    const tx = {} as DatabasePort;
    await f.hooks.validateInputs(f.actor, f.request, f.source, tx);
    expect(f.history.validateJobSource).toHaveBeenCalledWith(
      expect.objectContaining({
        source: f.source,
        instanceId: f.actor.instanceId,
        jobId: f.request.jobId,
      }),
      tx,
    );
    expect(f.authorize).toHaveBeenLastCalledWith(
      f.actor,
      'history.read',
      f.communication.radioId,
      tx,
    );
    await f.hooks.onCompleted!(tx, f.actor, f.request, {
      jobId: f.request.jobId,
      connectorId: 'fixture.stt',
      profileRevision: 1,
      simulated: true,
      output: {
        kind: 'transcript',
        artifactId: f.source.artifactId,
        text: 'Verified result',
      },
    });
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(f.authorize).toHaveBeenLastCalledWith(
      f.actor,
      'history.read',
      f.communication.radioId,
      tx,
    );
  });
  it('rejects deleted sources under the source lock before authorizing or reading payloads', async () => {
    const f = fixture();
    const tx = {} as DatabasePort;
    vi.mocked(f.history.validateJobSource!).mockResolvedValueOnce(false);
    await expect(
      f.hooks.validateInputs(f.actor, f.request, f.source, tx),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(f.history.get).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('authorizes output against the real source radio while allowing older immutable results', async () => {
    const f = fixture();
    f.communication.revision = 10;
    await expect(
      f.hooks.authorizeSourceRead!(f.actor, f.source),
    ).resolves.toBeUndefined();
    expect(f.authorize).toHaveBeenCalledWith(
      f.actor,
      'history.read',
      f.communication.radioId,
      undefined,
    );
    f.communication.deletedAt = new Date().toISOString();
    await expect(
      f.hooks.authorizeSourceRead!(f.actor, f.source),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
