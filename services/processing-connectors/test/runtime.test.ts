import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SignalDockError,
  type ArtifactStoragePort,
  type AuthPort,
  type Communication,
  type DatabasePort,
  type JobQueuePort,
  type Principal,
  type ProcessingProfile,
  type ProcessingRequest,
} from '@signaldock/contracts';
import {
  ProcessingRegistry,
  type ProcessingConnector,
} from '@signaldock/processing-sdk';
import { CredentialVault } from '../src/vault.js';
import {
  ProcessingRuntime,
  type ProcessingRuntimeOptions,
} from '../src/runtime.js';
import { OpenAISubscriptionOAuth } from '../openai-subscription-oauth/src/oauth.js';

const instanceId = randomUUID();
const userId = randomUUID();
const actor: Principal = {
  instanceId,
  userId,
  sessionId: randomUUID(),
  username: 'operator',
  role: 'administrator',
  radioPermissions: [],
};
function fixture(overrides: Partial<ProcessingRuntimeOptions> = {}) {
  const profile: ProcessingProfile = {
    profileId: randomUUID(),
    revision: 1,
    connectionId: randomUUID(),
    capability: 'tts.synthesize',
    task: 'speech.synthesize',
    model: 'fixture',
    allowCloud: false,
  };
  const request: ProcessingRequest = {
    instanceId,
    jobId: randomUUID(),
    profileId: profile.profileId,
    profileRevision: 1,
    task: 'speech.synthesize',
    taskVersion: 1,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    input: { kind: 'text', text: 'Test speech', communicationIds: [] },
  };
  const connection = {
    instance_id: instanceId,
    id: profile.connectionId,
    owner_user_id: null,
    connector_id: 'fixture.speech',
    display_name: 'Fixture',
    endpoint: 'http://localhost:1234',
    configuration: { allowPrivateNetwork: true },
    capabilities: ['tts.synthesize'],
    status: 'configured',
    credential_id: null,
  };
  const row = {
    id: request.jobId,
    instance_id: instanceId,
    owner_user_id: userId,
    radio_id: null,
    request,
    actor,
    source: null,
    state: 'queued',
    result: null,
    error: null,
    fingerprint: '',
    created_at: new Date(),
  };
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes('SELECT * FROM sd_processing_jobs'))
      return { rows: [row], rowCount: 1 };
    if (text.includes('SELECT profile FROM sd_processing_profiles'))
      return { rows: [{ profile }], rowCount: 1 };
    if (text.includes('SELECT * FROM sd_processing_connections'))
      return { rows: [connection], rowCount: 1 };
    if (text.includes('INSERT INTO sd_processing_jobs')) {
      row.fingerprint = values[9] as string;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const db: DatabasePort = {
    query: query as DatabasePort['query'],
    transaction: async (action) => action(db),
  };
  const auth: AuthPort = {
    authenticate: async () => actor,
    authorize: vi.fn(async () => undefined),
  };
  const artifacts = {
    put: vi.fn(async () => ({})),
    read: vi.fn(),
    delete: vi.fn(async () => undefined),
  } as unknown as ArtifactStoragePort;
  const queue = {
    enqueue: vi.fn(async () => ({ jobId: request.jobId, duplicate: false })),
    cancel: vi.fn(),
    get: vi.fn(),
    register: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as JobQueuePort;
  const connector: ProcessingConnector = {
    describe: () => ({
      connectorId: 'fixture.speech',
      version: '1',
      sdkVersion: 1,
      capabilities: ['tts.synthesize'],
      simulated: true,
      execution: 'local',
    }),
    execute: vi.fn(async (input, _connection, _profile, signal, context) => {
      const output = await context!.writeArtifact!(
        {
          bytes: new Uint8Array([1, 2]),
          contentType: 'audio/wav',
          jobId: input.jobId,
        },
        signal,
      );
      return {
        jobId: input.jobId,
        profileRevision: 1,
        connectorId: 'fixture.speech',
        simulated: true,
        output: {
          kind: 'audio',
          artifactId: output.artifactId,
          contentType: 'audio/wav',
          byteLength: 2,
        },
      };
    }),
  };
  const registry = new ProcessingRegistry();
  registry.register(connector);
  const validateInputs = vi.fn(async () => undefined);
  const onCompleted = vi.fn(async () => undefined);
  const runtime = new ProcessingRuntime({
    db,
    auth,
    artifacts,
    queue,
    registry,
    vault: new CredentialVault('key1', new Map([['key1', randomBytes(32)]])),
    subscriptionOAuth: new OpenAISubscriptionOAuth(`urn:uuid:${randomUUID()}`),
    validateInputs,
    onCompleted,
    ...overrides,
  });
  const job = {
    jobId: request.jobId,
    instanceId,
    kind: 'processing.execute',
    payload: {},
    idempotencyKey: 'job',
    deadline: request.deadline,
  };
  return {
    runtime,
    db,
    query,
    calls,
    auth,
    artifacts,
    queue,
    connector,
    profile,
    request,
    connection,
    row,
    validateInputs,
    onCompleted,
    job,
  };
}

describe('protected credentials', () => {
  it('authenticates instance, owner and credential identity and supports key rotation', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const first = new CredentialVault('old', new Map([['old', oldKey]]));
    const scope = {
      instanceId,
      ownerUserId: userId,
      credentialId: randomUUID(),
    };
    const value = first.seal(scope, { secret: 'never-public' });
    expect(JSON.stringify(value)).not.toContain('never-public');
    expect(first.open(scope, value)).toEqual({ secret: 'never-public' });
    expect(() =>
      first.open({ ...scope, ownerUserId: randomUUID() }, value),
    ).toThrow();
    expect(() =>
      first.open({ ...scope, credentialId: randomUUID() }, value),
    ).toThrow();
    expect(() =>
      first.open({ ...scope, instanceId: randomUUID() }, value),
    ).toThrow();
    const rotating = new CredentialVault(
      'new',
      new Map([
        ['old', oldKey],
        ['new', newKey],
      ]),
    );
    const rewritten = rotating.seal(scope, rotating.open(scope, value));
    expect(rewritten.keyId).toBe('new');
    expect(
      new CredentialVault('new', new Map([['new', newKey]])).open(
        scope,
        rewritten,
      ),
    ).toEqual({ secret: 'never-public' });
    expect(() => new CredentialVault('missing', new Map())).toThrow();
  });
});
describe('explicit automatic RX consent', () => {
  it('stays disabled until a radio/destination/revision opt-in and invalidates consent when the profile changes', async () => {
    const serviceOwner = {
      instanceId,
      userId,
      username: actor.username,
      role: actor.role,
      radioPermissions: [],
    };
    const authorizeBackgroundUser = vi.fn(async () => serviceOwner);
    const f = fixture({ authorizeBackgroundUser });
    f.profile.capability = 'stt.batch';
    f.profile.task = 'speech.transcribe';
    f.connection.capabilities = ['stt.batch'];
    f.connection.connector_id = 'openai-compatible';
    let consent: Record<string, unknown> | undefined;
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (text, values = []) => {
      if (text.includes('SELECT * FROM sd_processing_background_consents'))
        return {
          rows: consent?.['enabled'] ? [consent] : [],
          rowCount: consent?.['enabled'] ? 1 : 0,
        } as never;
      if (text.includes('INSERT INTO sd_processing_background_consents')) {
        consent = {
          id: values[1],
          radio_id: values[2],
          profile_id: values[3],
          profile_revision: values[4],
          connection_id: values[5],
          service_owner_user_id: values[6],
          endpoint: values[7],
          connection_fingerprint: values[8],
          enabled: true,
        };
      }
      return original(text, values);
    });
    const radioId = randomUUID();
    const communication = {
      id: randomUUID(),
      instanceId,
      radioId,
      revision: 1,
      direction: 'rx',
      kind: 'received_voice',
      recording: { artifactId: randomUUID(), state: 'available' },
    } as Communication;
    expect(
      await f.runtime.enqueueFinalizedCommunication(communication),
    ).toEqual({ status: 'disabled' });
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    await f.runtime.consentToAutomaticRx(actor, {
      radioId,
      profileId: f.profile.profileId,
      profileRevision: 1,
      endpoint: f.connection.endpoint,
      serviceOwnerUserId: userId,
      allowAutomaticUpload: true,
    });
    expect(
      (await f.runtime.enqueueFinalizedCommunication(communication)).status,
    ).toBe('queued');
    expect(f.queue.enqueue).toHaveBeenCalledOnce();
    expect(authorizeBackgroundUser).toHaveBeenCalled();
    const persisted = f.calls.find((call) =>
      call.text.includes('INSERT INTO sd_processing_jobs'),
    )!;
    expect(JSON.parse(persisted.values[6] as string)).toMatchObject({
      kind: 'service',
      userId,
      consentId: consent!['id'],
    });
    expect(JSON.parse(persisted.values[6] as string)).not.toHaveProperty(
      'sessionId',
    );
    f.profile.revision = 2;
    expect(
      await f.runtime.enqueueFinalizedCommunication(communication),
    ).toEqual({ status: 'requires_configuration' });
    expect(f.queue.enqueue).toHaveBeenCalledOnce();
  });
  it('refuses instance-wide subscription automation and missing background authorization', async () => {
    const f = fixture();
    await expect(
      f.runtime.consentToAutomaticRx(actor, {
        radioId: randomUUID(),
        profileId: f.profile.profileId,
        profileRevision: 1,
        endpoint: f.connection.endpoint,
        serviceOwnerUserId: userId,
        allowAutomaticUpload: true,
      }),
    ).rejects.toMatchObject({ code: 'REQUIRES_CONFIGURATION' });
    const currentUser = {
      instanceId,
      userId,
      username: actor.username,
      role: actor.role,
      radioPermissions: [],
    };
    const g = fixture({ authorizeBackgroundUser: async () => currentUser });
    g.profile.capability = 'stt.batch';
    g.profile.task = 'speech.transcribe';
    g.connection.owner_user_id = userId as never;
    await expect(
      g.runtime.consentToAutomaticRx(actor, {
        radioId: randomUUID(),
        profileId: g.profile.profileId,
        profileRevision: 1,
        endpoint: g.connection.endpoint,
        serviceOwnerUserId: userId,
        allowAutomaticUpload: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
describe('processing job authorization and terminal commit', () => {
  it('uses transactional enqueue and saves only through the guarded final commit', async () => {
    const f = fixture();
    const queued = await f.runtime.enqueue(actor, f.request, 'client-request');
    expect(queued.jobId).toBe(f.request.jobId);
    expect(f.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttempts: 1 }),
      f.db,
    );
    const commit = vi.fn(
      async (write: (db: DatabasePort) => Promise<unknown>) => write(f.db),
    );
    await f.runtime.execute(f.job, new AbortController().signal, { commit });
    expect(commit).toHaveBeenCalledOnce();
    expect(f.onCompleted).toHaveBeenCalledOnce();
    expect(f.auth.authorize).toHaveBeenCalledTimes(3);
    expect(f.artifacts.delete).not.toHaveBeenCalled();
    expect(
      f.calls.some((call) => call.text.includes("state='completed'")),
    ).toBe(true);
  });
  it('suppresses late results and deletes generated artifacts if the source commit is rejected', async () => {
    const f = fixture();
    await expect(
      f.runtime.execute(f.job, new AbortController().signal, {
        commit: async () => {
          throw new SignalDockError('OPERATION_CONFLICT', 'Source deleted.');
        },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(f.artifacts.delete).toHaveBeenCalledOnce();
    expect(f.onCompleted).not.toHaveBeenCalled();
    expect(
      f.calls.some((call) => call.text.includes("state='completed'")),
    ).toBe(false);
  });
  it('fails before provider IO when the initiating session has been revoked', async () => {
    const f = fixture();
    vi.mocked(f.auth.authorize).mockRejectedValue(
      new SignalDockError('UNAUTHORIZED', 'Session revoked.'),
    );
    await expect(
      f.runtime.execute(f.job, new AbortController().signal, {
        commit: async (write) => write(f.db),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.connector.execute).not.toHaveBeenCalled();
    expect(f.artifacts.put).not.toHaveBeenCalled();
  });
  it('checks revocation again before publishing a completed result', async () => {
    const f = fixture();
    vi.mocked(f.auth.authorize)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(
        new SignalDockError('UNAUTHORIZED', 'Revoked during inference.'),
      );
    await expect(
      f.runtime.execute(f.job, new AbortController().signal, {
        commit: async (write) => write(f.db),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.artifacts.delete).toHaveBeenCalledOnce();
    expect(f.onCompleted).not.toHaveBeenCalled();
  });
  it('rejects a stale profile at terminal commit and cleans the synthesized output', async () => {
    const f = fixture();
    await expect(
      f.runtime.execute(f.job, new AbortController().signal, {
        commit: async (write) => {
          f.profile.revision = 2;
          return write(f.db);
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(f.artifacts.delete).toHaveBeenCalledOnce();
    expect(f.onCompleted).not.toHaveBeenCalled();
  });
  it('does not replay running jobs or transmit previews to a different assigned radio', async () => {
    const f = fixture();
    f.row.state = 'running';
    await expect(
      f.runtime.execute(f.job, new AbortController().signal, {
        commit: async (write) => write(f.db),
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(f.connector.execute).not.toHaveBeenCalled();
    f.row.state = 'completed';
    f.row.radio_id = randomUUID() as never;
    f.row.result = {
      output: { kind: 'audio', artifactId: randomUUID() },
    } as never;
    await expect(
      f.runtime.prepareTransmission(actor, f.request.jobId, randomUUID()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.artifacts.read).not.toHaveBeenCalled();
  });
});
