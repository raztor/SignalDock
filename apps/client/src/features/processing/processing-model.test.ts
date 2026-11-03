import type {
  Communication,
  ProcessingBackgroundConsentView,
  ProcessingConnectionView,
  ProcessingJobView,
  ProcessingProfile,
  PublicUser,
} from '@signaldock/contracts';
import { describe, expect, it } from 'vitest';
import {
  activeConsent,
  apiKeyRequirement,
  automationRadios,
  buildJobRequest,
  cloudNotice,
  connectionExecution,
  connectionOptionSchema,
  connectionRequestBody,
  connectionReview,
  connectionStepErrors,
  connectorCard,
  connectorCards,
  consentGate,
  consentHealth,
  consentRequestBody,
  credentialShapedKeys,
  defaultServiceOwner,
  endpointPolicy,
  endpointSyntax,
  exposedSchema,
  hasActiveJobs,
  humanizeConnectorId,
  idempotencyKey,
  initialConnectionDraft,
  isSpeechStale,
  jobOutput,
  jobPresentation,
  latestTasks,
  modelSuggestions,
  optionsSafetyError,
  parseJsonObject,
  profileDraftErrors,
  profileRequestBody,
  profileSettingsSchema,
  serviceOwnerCandidates,
  sortJobs,
  speechFlowState,
  taskPresentation,
  tasksForConnection,
  toggleCapability,
  transcriptionProfiles,
  type ConnectorManifestView,
  type ProcessingTask,
  type SpeechFlowInput,
} from './processing-model';

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const OTHER_USER = '00000000-0000-4000-8000-000000000003';
const RADIO = '00000000-0000-4000-8000-000000000010';
const CONNECTION = '00000000-0000-4000-8000-000000000020';
const PROFILE = '00000000-0000-4000-8000-000000000030';
const COMMUNICATION = '00000000-0000-4000-8000-000000000040';
const ARTIFACT = '00000000-0000-4000-8000-000000000050';
const TRANSCRIPT = '00000000-0000-4000-8000-000000000060';
const JOB = '00000000-0000-4000-8000-000000000070';

const manifest = (
  connectorId: string,
  overrides: Partial<ConnectorManifestView> = {},
): ConnectorManifestView => ({
  connectorId,
  version: '0.1.0',
  sdkVersion: 1,
  capabilities: ['text.structured', 'stt.batch', 'tts.synthesize'],
  simulated: false,
  execution: 'cloud',
  ...overrides,
});

const connection = (
  overrides: Partial<ProcessingConnectionView> = {},
  connectorId = 'openai-api',
): ProcessingConnectionView => ({
  connection: {
    connectionId: CONNECTION,
    connectorId,
    instanceId: INSTANCE,
    owner: { kind: 'instance' },
  },
  displayName: 'Main',
  endpoint: 'https://api.openai.com/v1',
  capabilities: ['stt.batch', 'tts.synthesize'],
  configuration: {},
  status: 'configured',
  hasCredentials: true,
  ...overrides,
});

const profile = (
  overrides: Partial<ProcessingProfile> = {},
): ProcessingProfile => ({
  profileId: PROFILE,
  revision: 2,
  connectionId: CONNECTION,
  capability: 'stt.batch',
  task: 'speech.transcribe',
  model: 'whisper-1',
  allowCloud: true,
  ...overrides,
});

const tasks: ProcessingTask[] = [
  { taskId: 'speech.transcribe', version: 1, capability: 'stt.batch' },
  { taskId: 'speech.synthesize', version: 1, capability: 'tts.synthesize' },
  {
    taskId: 'conversation.summarize',
    version: 1,
    capability: 'text.structured',
  },
  {
    taskId: 'conversation.summarize',
    version: 2,
    capability: 'text.structured',
  },
];

const communication = (
  overrides: Partial<Communication> = {},
): Communication => ({
  id: COMMUNICATION,
  instanceId: INSTANCE,
  radioId: RADIO,
  conversationId: COMMUNICATION,
  kind: 'received_voice',
  direction: 'rx',
  startedAt: '2026-11-01T10:00:00.000Z',
  endedAt: '2026-11-01T10:00:05.000Z',
  frequencyHz: 146520000,
  frequencyAttribution: 'confirmed',
  context: {},
  revision: 3,
  recording: {
    id: ARTIFACT,
    artifactId: ARTIFACT,
    contentType: 'audio/wav',
    sizeBytes: 100,
    sha256: 'x',
    state: 'available',
  },
  transcripts: [],
  notes: [],
  tags: [],
  retentionHold: false,
  ...overrides,
});

const job = (
  overrides: Partial<ProcessingJobView> = {},
): ProcessingJobView => ({
  jobId: JOB,
  instanceId: INSTANCE,
  profileId: PROFILE,
  task: 'speech.synthesize',
  state: 'completed',
  createdAt: '2026-11-01T10:00:00.000Z',
  result: {
    jobId: JOB,
    connectorId: 'openai-api',
    profileRevision: 2,
    simulated: false,
    output: {
      kind: 'audio',
      artifactId: ARTIFACT,
      contentType: 'audio/wav',
      byteLength: 2048,
      durationSeconds: 2.5,
    },
  },
  ...overrides,
});

describe('connector cards', () => {
  it('presents known connectors with capability chips and execution', () => {
    const card = connectorCard(manifest('openai-api'));
    expect(card.title).toBe('OpenAI API');
    expect(card.executionLabel).toBe('Cloud');
    expect(card.capabilities.map((item) => item.label)).toEqual([
      'Text analysis',
      'Transcription',
      'Speech',
    ]);
    expect(card.selectable).toBe(true);
    expect(card.accessibilityLabel).toContain('Cloud');
  });

  it('marks simulated and subscription connectors as not selectable', () => {
    const simulated = connectorCard(
      manifest('fixture.text', { simulated: true, execution: 'local' }),
    );
    expect(simulated.title).toBe('Fixture text');
    expect(simulated.selectable).toBe(false);
    expect(simulated.reason).toMatch(/Simulated/);
    expect(
      connectorCard(manifest('openai-subscription-oauth')).selectable,
    ).toBe(false);
  });

  it('lists selectable cards first and leaves out the subscription', () => {
    const cards = connectorCards([
      manifest('fixture.stt', { simulated: true }),
      manifest('openai-subscription-oauth'),
      manifest('ollama', { execution: 'local' }),
      manifest('azure-speech'),
    ]);
    expect(cards.map((card) => card.connectorId)).toEqual([
      'azure-speech',
      'ollama',
      'fixture.stt',
    ]);
  });

  it('humanizes unknown ids', () => {
    expect(humanizeConnectorId('local.analysis-v2')).toBe('Local analysis v2');
    expect(humanizeConnectorId('')).toBe('');
  });
});

describe('connection draft', () => {
  it('prefills defaults like the previous screen', () => {
    expect(initialConnectionDraft(manifest('openai-api'))).toMatchObject({
      endpoint: 'https://api.openai.com/v1',
      capabilities: ['text.structured', 'stt.batch', 'tts.synthesize'],
      options: {},
    });
    expect(initialConnectionDraft(manifest('openai-compatible'))).toMatchObject(
      {
        capabilities: ['text.structured'],
        options: { protocol: 'responses' },
      },
    );
    expect(
      initialConnectionDraft(
        manifest('ollama', {
          execution: 'local',
          capabilities: ['text.structured'],
        }),
      ),
    ).toMatchObject({
      endpoint: 'http://ollama:11434',
      options: { allowPrivateNetwork: true },
    });
    expect(
      initialConnectionDraft(manifest('custom', { execution: 'local' }))
        .options,
    ).toEqual({ allowPrivateNetwork: true });
  });

  it('toggles capabilities', () => {
    expect(toggleCapability(['stt.batch'], 'tts.synthesize')).toEqual([
      'stt.batch',
      'tts.synthesize',
    ]);
    expect(toggleCapability(['stt.batch'], 'stt.batch')).toEqual([]);
  });

  it('knows which connectors need an API key', () => {
    expect(apiKeyRequirement('openai-api')).toBe('required');
    expect(apiKeyRequirement('openai-compatible')).toBe('optional');
    expect(apiKeyRequirement('ollama')).toBe('none');
    expect(apiKeyRequirement('unknown')).toBe('optional');
  });

  it('gates each step', () => {
    const openai = manifest('openai-api');
    const draft = initialConnectionDraft(openai);
    expect(connectionStepErrors(0, undefined, undefined).connector).toBe(
      'Choose a provider.',
    );
    expect(connectionStepErrors(0, draft, openai)).toEqual({});
    expect(connectionStepErrors(1, draft, openai).apiKey).toMatch(/API key/);
    const keyed = { ...draft, apiKey: 'sk-test' };
    expect(connectionStepErrors(1, keyed, openai)).toEqual({});
    expect(
      connectionStepErrors(1, { ...keyed, capabilities: [] }, openai)
        .capabilities,
    ).toBeDefined();
    expect(
      connectionStepErrors(2, { ...keyed, options: { apiToken: 'x' } }, openai)
        .options,
    ).toMatch(/apiToken/);
    expect(
      connectionStepErrors(2, keyed, openai, { protocol: 'Choose one.' })
        .options,
    ).toBe('Choose one.');
    expect(
      connectionStepErrors(
        3,
        { ...keyed, endpoint: 'https://example.com/v1' },
        openai,
      ).endpoint,
    ).toMatch(/only uses/);
    const simulated = manifest('fixture.text', { simulated: true });
    expect(
      connectionStepErrors(0, initialConnectionDraft(simulated), simulated)
        .connector,
    ).toMatch(/Simulated/);
  });

  it('requires private-network permission for local endpoints at the options step', () => {
    const ollama = manifest('ollama', { execution: 'local' });
    const draft = { ...initialConnectionDraft(ollama), options: {} };
    expect(connectionStepErrors(1, draft, ollama).endpoint).toBeUndefined();
    expect(connectionStepErrors(2, draft, ollama).endpoint).toMatch(
      /Allow private network/,
    );
  });

  it('builds the create body and never sends a key for keyless connectors', () => {
    const draft = {
      ...initialConnectionDraft(manifest('openai-api')),
      apiKey: ' sk-test ',
    };
    expect(connectionRequestBody(draft)).toEqual({
      connectorId: 'openai-api',
      displayName: 'OpenAI API',
      endpoint: 'https://api.openai.com/v1',
      capabilities: ['text.structured', 'stt.batch', 'tts.synthesize'],
      configuration: {},
      apiKey: ' sk-test ',
    });
    const ollama = {
      ...initialConnectionDraft(manifest('ollama', { execution: 'local' })),
      apiKey: 'ignored',
      displayName: '  Lab  ',
    };
    const body = connectionRequestBody(ollama);
    expect(body.apiKey).toBeUndefined();
    expect(body.displayName).toBe('Lab');
  });

  it('summarizes the review without revealing the key', () => {
    const rows = connectionReview({
      ...initialConnectionDraft(manifest('openai-api')),
      apiKey: 'sk-secret',
    });
    expect(rows.find((row) => row.label === 'API key')?.value).toBe(
      'Provided · stored encrypted',
    );
    expect(JSON.stringify(rows)).not.toContain('sk-secret');
  });
});

describe('endpoint policy', () => {
  it('accepts https and rejects unsafe URLs', () => {
    expect(endpointSyntax('https://api.example.com/v1')).toEqual({
      local: false,
    });
    expect(endpointSyntax('').error).toBeDefined();
    expect(endpointSyntax('not a url').error).toMatch(/full URL/);
    expect(endpointSyntax('ftp://example.com').error).toBeDefined();
    expect(endpointSyntax('https://u:p@example.com').error).toMatch(
      /credentials/,
    );
    expect(endpointSyntax('https://example.com/?a=1').error).toMatch(/query/);
    expect(endpointSyntax('http://example.com').error).toMatch(/https/);
    expect(endpointSyntax('http://169.254.169.254').error).toMatch(/metadata/);
  });

  it('allows local http only with allowPrivateNetwork', () => {
    expect(endpointSyntax('http://ollama:11434')).toEqual({ local: true });
    expect(endpointPolicy('http://192.168.1.5:8000', {}).error).toMatch(
      /Allow private network/,
    );
    expect(
      endpointPolicy('http://192.168.1.5:8000', { allowPrivateNetwork: true }),
    ).toEqual({ local: true });
    expect(
      endpointPolicy('https://api.openai.com/v1/', {}, 'openai-api').error,
    ).toBeUndefined();
  });
});

describe('schemas and options', () => {
  it('prefers an exposed schema', () => {
    const configSchema = {
      type: 'object',
      properties: { region: { type: 'string' } },
    };
    expect(
      connectionOptionSchema(manifest('custom', { configSchema }), []),
    ).toBe(configSchema);
    expect(exposedSchema({ type: 'string' })).toBeUndefined();
    expect(exposedSchema({ type: 'object', properties: [] })).toBeUndefined();
  });

  it('has curated connection options for known connectors', () => {
    expect(
      Object.keys(
        connectionOptionSchema(manifest('openai-compatible'), [])?.properties ??
          {},
      ),
    ).toEqual(['protocol', 'supportsJsonSchema', 'allowPrivateNetwork']);
    expect(
      connectionOptionSchema(manifest('azure-speech'), ['tts.synthesize'])
        ?.required,
    ).toEqual(['ttsEndpoint']);
    expect(
      connectionOptionSchema(manifest('azure-speech'), ['stt.batch'])?.required,
    ).toBeUndefined();
    expect(connectionOptionSchema(manifest('custom'), [])).toBeUndefined();
    expect(connectionOptionSchema(undefined, [])).toBeUndefined();
  });

  it('has curated profile settings per capability', () => {
    expect(
      profileSettingsSchema(manifest('openai-api'), 'tts.synthesize')?.required,
    ).toEqual(['voice']);
    expect(
      profileSettingsSchema(manifest('azure-speech'), 'tts.synthesize')
        ?.required,
    ).toEqual(['language', 'voice']);
    expect(
      profileSettingsSchema(manifest('azure-speech'), 'stt.batch')?.required,
    ).toEqual(['language']);
    expect(
      profileSettingsSchema(manifest('ollama'), 'text.structured')?.properties,
    ).toEqual({});
    expect(profileSettingsSchema(manifest('custom'), 'stt.batch')).toBe(
      undefined,
    );
    const perCapability = {
      settingsSchema: {
        'stt.batch': { type: 'object', properties: { x: { type: 'string' } } },
      },
    };
    expect(
      profileSettingsSchema(manifest('custom', perCapability), 'stt.batch')
        ?.properties,
    ).toHaveProperty('x');
  });

  it('finds credential-shaped keys like the server', () => {
    expect(
      credentialShapedKeys({
        protocol: 'x',
        nested: { apiKey: 1, list: [{ Password: 'p' }] },
      }),
    ).toEqual(['nested.apiKey', 'nested.list[0].Password']);
    expect(optionsSafetyError({ authorization: 'Bearer' })).toMatch(
      /authorization/,
    );
    expect(optionsSafetyError({ protocol: 'responses' })).toBeUndefined();
    expect(optionsSafetyError({ big: 'x'.repeat(16001) })).toMatch(/large/);
  });

  it('parses JSON objects only', () => {
    expect(parseJsonObject('')).toEqual({ ok: true, value: {} });
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject('[]')).toEqual({
      ok: false,
      error: 'Options must be a JSON object.',
    });
    expect(parseJsonObject('{').ok).toBe(false);
  });
});

describe('profiles', () => {
  it('presents tasks and filters them by connection', () => {
    expect(taskPresentation(tasks[0]!).title).toBe('Transcribe recordings');
    expect(
      taskPresentation({
        taskId: 'weather.extract',
        capability: 'text.structured',
      }).title,
    ).toBe('Weather extract');
    expect(
      tasksForConnection(tasks, connection()).map((task) => task.taskId),
    ).toEqual(['speech.transcribe', 'speech.synthesize']);
    expect(tasksForConnection(tasks, undefined)).toEqual([]);
    expect(
      latestTasks(tasks).find(
        (task) => task.taskId === 'conversation.summarize',
      )?.version,
    ).toBe(2);
  });

  it('suggests exposed and previously used models', () => {
    const models = modelSuggestions({
      manifest: manifest('openai-api', { models: { 'stt.batch': ['m1'] } }),
      capability: 'stt.batch',
      profiles: [
        profile({ model: 'whisper-1' }),
        profile({ model: 'm1' }),
        profile({ model: 'tts', capability: 'tts.synthesize' }),
      ],
      connections: [connection()],
    });
    expect(models).toEqual(['m1', 'whisper-1']);
    expect(
      modelSuggestions({
        manifest: undefined,
        capability: 'stt.batch',
        profiles: [],
        connections: [],
      }),
    ).toEqual([]);
  });

  it('explains cloud processing', () => {
    expect(cloudNotice('cloud', false).tone).toBe('warning');
    expect(cloudNotice('cloud', true).tone).toBe('neutral');
    expect(cloudNotice('local', false).message).toMatch(/stays/);
    const compatible = connection(
      {
        endpoint: 'http://10.0.0.2:8000/v1',
        configuration: { allowPrivateNetwork: true },
      },
      'openai-compatible',
    );
    expect(connectionExecution(compatible, manifest('openai-compatible'))).toBe(
      'local',
    );
    expect(
      connectionExecution(
        { ...compatible, configuration: {} },
        manifest('openai-compatible'),
      ),
    ).toBe('cloud');
    expect(connectionExecution(connection(), manifest('openai-api'))).toBe(
      'cloud',
    );
  });

  it('validates and builds a profile', () => {
    const draft = {
      connectionId: CONNECTION,
      taskId: 'speech.transcribe',
      model: ' whisper-1 ',
      settings: { language: 'en' },
      allowCloud: true,
    };
    const task = tasks[0]!;
    expect(profileDraftErrors(draft, connection(), task)).toBeUndefined();
    expect(profileDraftErrors(draft, undefined, task)).toMatch(/connection/);
    expect(
      profileDraftErrors(draft, connection({ status: 'revoked' }), task),
    ).toMatch(/revoked/);
    expect(
      profileDraftErrors({ ...draft, model: ' ' }, connection(), task),
    ).toMatch(/model/);
    expect(profileDraftErrors(draft, connection(), tasks[2])).toMatch(
      /does not support/,
    );
    expect(
      profileDraftErrors(draft, connection(), task, { voice: 'Required.' }),
    ).toBe('Required.');
    expect(profileRequestBody(draft, task)).toEqual({
      connectionId: CONNECTION,
      capability: 'stt.batch',
      task: 'speech.transcribe',
      model: 'whisper-1',
      allowCloud: true,
      settings: { language: 'en' },
    });
  });
});

describe('jobs', () => {
  it('presents every state with an icon and text', () => {
    for (const state of [
      'queued',
      'running',
      'retry_wait',
      'completed',
      'failed',
      'cancelled',
      'requires_configuration',
    ] as const) {
      const presentation = jobPresentation(state);
      expect(presentation.label).toBeTruthy();
      expect(presentation.icon).toBeTruthy();
      expect(presentation.progress).toBeGreaterThan(0);
    }
    expect(jobPresentation('running').cancellable).toBe(true);
    expect(jobPresentation('failed').tone).toBe('error');
  });

  it('sorts newest first and detects active jobs', () => {
    const older = job({ jobId: 'a', createdAt: '2026-11-01T09:00:00.000Z' });
    const newer = job({ jobId: 'b', state: 'queued' });
    expect(sortJobs([older, newer]).map((item) => item.jobId)).toEqual([
      'b',
      'a',
    ]);
    expect(hasActiveJobs([older])).toBe(false);
    expect(hasActiveJobs([older, newer])).toBe(true);
  });

  it('summarizes job output', () => {
    expect(jobOutput(job())).toEqual({
      kind: 'audio',
      label: 'Speech preview',
      detail: '2.5 s · 2.0 KB',
    });
    expect(
      jobOutput(
        job({
          result: {
            jobId: JOB,
            connectorId: 'x',
            profileRevision: 1,
            simulated: false,
            output: { kind: 'transcript', text: '', artifactId: ARTIFACT },
          },
        }),
      ),
    ).toEqual({
      kind: 'text',
      label: 'Transcript',
      text: '(No speech detected)',
    });
    expect(jobOutput(job({ result: undefined }))).toEqual({ kind: 'none' });
  });

  it('builds transcription requests from an available recording', () => {
    const result = buildJobRequest({
      profile: profile(),
      tasks,
      communication: communication(),
      text: '',
      radioId: RADIO,
      now: Date.parse('2026-11-01T10:00:00.000Z'),
      idempotencyKey: 'key',
    });
    expect(result).toEqual({
      ok: true,
      body: {
        request: {
          profileId: PROFILE,
          profileRevision: 2,
          task: 'speech.transcribe',
          taskVersion: 1,
          deadline: '2026-11-01T10:05:00.000Z',
          input: {
            kind: 'audio',
            artifactId: ARTIFACT,
            communicationIds: [COMMUNICATION],
          },
        },
        idempotencyKey: 'key',
        radioId: RADIO,
        source: {
          communicationId: COMMUNICATION,
          communicationRevision: 3,
          artifactId: ARTIFACT,
        },
      },
    });
    expect(
      buildJobRequest({
        profile: profile(),
        tasks,
        communication: communication({ recording: undefined }),
        text: '',
        radioId: RADIO,
        now: 0,
        idempotencyKey: 'key',
      }),
    ).toEqual({ ok: false, error: 'Select an available recording.' });
  });

  it('builds summary requests from the latest transcript', () => {
    const result = buildJobRequest({
      profile: profile({
        capability: 'text.structured',
        task: 'conversation.summarize',
      }),
      tasks,
      communication: communication({
        transcripts: [
          {
            id: TRANSCRIPT,
            communicationId: COMMUNICATION,
            revision: 1,
            text: 'Hello net',
            source: 'provider',
            provenance: {},
            createdAt: '2026-11-01T10:00:00.000Z',
          } as Communication['transcripts'][number],
        ],
      }),
      text: 'ignored',
      radioId: undefined,
      now: 0,
      idempotencyKey: 'key',
    });
    expect(result.ok && result.body).toMatchObject({
      request: {
        taskVersion: 2,
        input: {
          kind: 'text',
          text: 'Hello net',
          communicationIds: [COMMUNICATION],
        },
      },
      source: { transcriptRevisionId: TRANSCRIPT },
    });
    expect(result.ok && 'radioId' in result.body).toBe(false);
  });

  it('builds speech requests without a source', () => {
    const result = buildJobRequest({
      profile: profile({
        capability: 'tts.synthesize',
        task: 'speech.synthesize',
      }),
      tasks,
      communication: communication(),
      text: 'CQ CQ',
      radioId: RADIO,
      now: 0,
      idempotencyKey: 'key',
    });
    expect(result.ok && result.body).toMatchObject({
      request: { input: { kind: 'text', text: 'CQ CQ', communicationIds: [] } },
    });
    expect(result.ok && 'source' in result.body).toBe(false);
    expect(
      buildJobRequest({
        profile: profile({
          capability: 'tts.synthesize',
          task: 'speech.synthesize',
        }),
        tasks,
        communication: undefined,
        text: '  ',
        radioId: RADIO,
        now: 0,
        idempotencyKey: 'key',
      }),
    ).toEqual({ ok: false, error: 'Enter the text to speak.' });
    expect(
      buildJobRequest({
        profile: undefined,
        tasks,
        communication: undefined,
        text: 'x',
        radioId: undefined,
        now: 0,
        idempotencyKey: 'key',
      }).ok,
    ).toBe(false);
  });

  it('creates unique idempotency keys', () => {
    expect(idempotencyKey(5, () => 0.5)).toBe('client-5-i');
  });
});

describe('speech flow', () => {
  const base: SpeechFlowInput = {
    text: 'CQ CQ',
    profile: profile({
      capability: 'tts.synthesize',
      task: 'speech.synthesize',
    }),
    generated: undefined,
    job: undefined,
    previewed: false,
    previewSupported: true,
    radioId: RADIO,
    radioName: 'Base',
    canTransmit: true,
    transmitting: false,
    transmitted: false,
    busy: false,
  };

  it('starts at Edit and can generate', () => {
    const state = speechFlowState(base);
    expect(state.step).toBe(0);
    expect(state.generate.enabled).toBe(true);
    expect(state.transmit.enabled).toBe(false);
    expect(speechFlowState({ ...base, text: ' ' }).generate.enabled).toBe(
      false,
    );
    expect(speechFlowState({ ...base, profile: undefined }).generate).toEqual({
      enabled: false,
      reason: 'Choose a speech profile.',
    });
  });

  it('waits for generation, then requires a preview before transmitting', () => {
    const generated = { jobId: JOB, text: 'CQ CQ' };
    const running = speechFlowState({
      ...base,
      generated,
      job: job({ state: 'running', result: undefined }),
    });
    expect(running.step).toBe(1);
    expect(running.preview.enabled).toBe(false);
    const ready = speechFlowState({ ...base, generated, job: job() });
    expect(ready.step).toBe(2);
    expect(ready.preview.enabled).toBe(true);
    expect(ready.transmit).toEqual({
      enabled: false,
      reason: 'Listen to the preview before transmitting.',
    });
    const reviewed = speechFlowState({
      ...base,
      generated,
      job: job(),
      previewed: true,
    });
    expect(reviewed.step).toBe(3);
    expect(reviewed.transmit.enabled).toBe(true);
  });

  it('asks native users to acknowledge instead of listening', () => {
    const state = speechFlowState({
      ...base,
      previewSupported: false,
      generated: { jobId: JOB, text: 'CQ CQ' },
      job: job(),
    });
    expect(state.transmit.enabled).toBe(false);
    expect(!state.transmit.enabled && state.transmit.reason).toMatch(
      /reviewed/,
    );
  });

  it('never lets native users acknowledge a job whose text is not shown', () => {
    // Picked from the jobs list: no text, and no audio preview on native.
    const state = speechFlowState({
      ...base,
      text: '',
      previewSupported: false,
      generated: { jobId: JOB },
      job: job(),
      previewed: true,
    });
    const reason = 'Generate this speech here to review its text.';
    expect(state.preview).toEqual({ enabled: false, reason });
    expect(state.transmit).toEqual({ enabled: false, reason });
    expect(state.step).toBe(2);
    // On web the audio preview is the review, so the same job is usable.
    const web = speechFlowState({
      ...base,
      text: '',
      generated: { jobId: JOB },
      job: job(),
      previewed: true,
    });
    expect(web.transmit.enabled).toBe(true);
  });

  it('invalidates the preview when the text changes', () => {
    const state = speechFlowState({
      ...base,
      text: 'CQ CQ DX',
      generated: { jobId: JOB, text: 'CQ CQ' },
      job: job(),
      previewed: true,
    });
    expect(state.stale).toBe(true);
    expect(state.step).toBe(0);
    expect(state.transmit.enabled).toBe(false);
    expect(isSpeechStale('', { jobId: JOB })).toBe(false);
    expect(isSpeechStale('new', { jobId: JOB })).toBe(true);
  });

  it('never transmits without a radio, a path, or while busy', () => {
    const ready = {
      ...base,
      generated: { jobId: JOB, text: 'CQ CQ' },
      job: job(),
      previewed: true,
    };
    expect(
      speechFlowState({ ...ready, radioId: undefined }).transmit.enabled,
    ).toBe(false);
    expect(
      speechFlowState({ ...ready, canTransmit: false }).transmit.enabled,
    ).toBe(false);
    expect(speechFlowState({ ...ready, busy: true }).transmit.enabled).toBe(
      false,
    );
    const transmitting = speechFlowState({ ...ready, transmitting: true });
    expect(transmitting.transmit.enabled).toBe(false);
    expect(transmitting.status).toMatch(/On air/);
  });

  it('reports why the radio cannot transmit', () => {
    const state = speechFlowState({
      ...base,
      generated: { jobId: JOB, text: 'CQ CQ' },
      job: job(),
      previewed: true,
      radioBlockedReason: 'This radio does not support live transmission.',
    });
    expect(state.transmit).toEqual({
      enabled: false,
      reason: 'This radio does not support live transmission.',
    });
  });

  it('ignores a job that does not match the generated one', () => {
    const state = speechFlowState({
      ...base,
      generated: { jobId: 'other', text: 'CQ CQ' },
      job: job(),
    });
    expect(state.step).toBe(1);
  });
});

describe('automatic RX transcription', () => {
  const users: PublicUser[] = [
    {
      id: USER,
      username: 'admin',
      role: 'administrator',
      enabled: true,
      radioPermissions: [{ radioId: RADIO, permissions: ['history.read'] }],
    },
    {
      id: OTHER_USER,
      username: 'operator',
      role: 'operator',
      enabled: true,
      radioPermissions: [{ radioId: RADIO, permissions: ['history.read'] }],
    },
    {
      id: '00000000-0000-4000-8000-000000000004',
      username: 'aardvark',
      role: 'administrator',
      enabled: true,
      radioPermissions: [],
    },
  ];

  it('ranks eligible service owners and explains the rest', () => {
    const candidates = serviceOwnerCandidates(users, RADIO, USER);
    expect(candidates.map((item) => [item.username, item.eligible])).toEqual([
      ['admin', true],
      ['aardvark', false],
      ['operator', false],
    ]);
    expect(candidates[1]?.reason).toMatch(/history/);
    expect(candidates[2]?.reason).toMatch(/administrator/);
    expect(defaultServiceOwner(candidates, USER)).toBe(USER);
    expect(defaultServiceOwner(candidates.slice(1), USER)).toBeUndefined();
  });

  it('only offers instance-owned transcription profiles', () => {
    const options = transcriptionProfiles(
      [
        profile(),
        profile({ profileId: 'b', task: 'other.task' }),
        profile({ profileId: 'c', capability: 'tts.synthesize' }),
      ],
      [connection()],
    );
    expect(options.map((item) => item.eligible)).toEqual([true, false]);
    const userOwned = transcriptionProfiles(
      [profile()],
      [
        connection({
          connection: {
            connectionId: CONNECTION,
            connectorId: 'openai-api',
            instanceId: INSTANCE,
            owner: { kind: 'user', userId: USER },
          },
        }),
      ],
    );
    expect(userOwned[0]?.reason).toMatch(/subscription/);
    expect(
      transcriptionProfiles(
        [profile()],
        [connection({ hasCredentials: false })],
      )[0]?.reason,
    ).toMatch(/credentials/);
  });

  it('gates consent and builds the exact request', () => {
    const [option] = transcriptionProfiles([profile()], [connection()]);
    const draft = {
      radioId: RADIO,
      option,
      serviceOwnerUserId: USER,
      approved: false,
    };
    expect(consentGate(draft, false)).toEqual({
      enabled: false,
      reason: 'Approve automatic uploads to continue.',
    });
    expect(consentRequestBody(draft)).toBeUndefined();
    expect(consentGate({ ...draft, approved: true }, true).enabled).toBe(false);
    expect(
      consentGate(
        { ...draft, approved: true, serviceOwnerUserId: 'nope' },
        false,
      ).enabled,
    ).toBe(false);
    expect(consentRequestBody({ ...draft, approved: true })).toEqual({
      radioId: RADIO,
      profileId: PROFILE,
      profileRevision: 2,
      endpoint: 'https://api.openai.com/v1',
      serviceOwnerUserId: USER,
      allowAutomaticUpload: true,
    });
  });

  it('detects stale consents', () => {
    const consent: ProcessingBackgroundConsentView = {
      consentId: 'c',
      radioId: RADIO,
      profileId: PROFILE,
      profileRevision: 2,
      endpoint: 'https://api.openai.com/v1',
      serviceOwnerUserId: USER,
      enabled: true,
      consentedAt: '2026-11-01T10:00:00.000Z',
    };
    expect(activeConsent([consent], RADIO)).toBe(consent);
    expect(activeConsent([{ ...consent, enabled: false }], RADIO)).toBe(
      undefined,
    );
    expect(consentHealth(undefined, [], [])).toEqual({ state: 'off' });
    expect(consentHealth(consent, [profile()], [connection()])).toEqual({
      state: 'on',
    });
    expect(
      consentHealth(consent, [profile({ revision: 3 })], [connection()]).state,
    ).toBe('stale');
    expect(
      consentHealth(
        consent,
        [profile()],
        [connection({ endpoint: 'https://other.example' })],
      ).state,
    ).toBe('stale');
    expect(consentHealth(consent, [], []).state).toBe('stale');
    expect(
      automationRadios(
        [{ radioId: RADIO, displayName: 'Base' }],
        [
          consent,
          { ...consent, radioId: 'f0000000-0000-4000-8000-000000000000' },
        ],
      ).map((radio) => radio.name),
    ).toEqual(['Base', 'Radio f0000000']);
  });
});
