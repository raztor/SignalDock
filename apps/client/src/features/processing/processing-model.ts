/**
 * Pure model for the Processing screen: connector cards, the connection wizard,
 * curated option/setting schemas, profiles, jobs, the speech (TTS) flow and
 * automatic RX transcription consent. No React or React Native imports, so it
 * runs in node tests. Schema types come from `@signaldock/ui` as types only.
 */
import type {
  Communication,
  ConnectorManifest,
  ProcessingBackgroundConsentView,
  ProcessingCapability,
  ProcessingConnectionView,
  ProcessingJobView,
  ProcessingProfile,
  PublicUser,
} from '@signaldock/contracts';
import type {
  FormSchema,
  FormSchemaProperty,
  IconName,
  StatusTone,
} from '@signaldock/ui';

// ─── Shared types ──────────────────────────────────────────────────────────

/** Task definition as returned by `GET processing/connectors`. */
export interface ProcessingTask {
  taskId: string;
  version: number;
  capability: ProcessingCapability;
}

/**
 * A connector manifest as the API returns it. Future servers may add an
 * options schema, a settings schema or a model list; the client reads them
 * when present and falls back to curated values otherwise.
 */
export type ConnectorManifestView = ConnectorManifest & {
  title?: unknown;
  description?: unknown;
  configSchema?: unknown;
  optionsSchema?: unknown;
  settingsSchema?: unknown;
  models?: unknown;
};

export type Gate = { enabled: true } | { enabled: false; reason: string };

export const SUBSCRIPTION_CONNECTOR_ID = 'openai-subscription-oauth';
export const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1';
export const TEXT_INPUT_MAX = 64000;
export const DISPLAY_NAME_MAX = 100;
export const JOB_DEADLINE_MS = 5 * 60_000;
export const JOB_POLL_MS = 3000;

// ─── Capabilities ──────────────────────────────────────────────────────────

export interface CapabilityPresentation {
  capability: ProcessingCapability;
  label: string;
  icon: IconName;
}

const CAPABILITIES: Record<
  ProcessingCapability,
  Omit<CapabilityPresentation, 'capability'>
> = {
  'stt.batch': { label: 'Transcription', icon: 'wave' },
  'stt.streaming': { label: 'Live transcription', icon: 'signal' },
  'tts.synthesize': { label: 'Speech', icon: 'mic' },
  'text.structured': { label: 'Text analysis', icon: 'note' },
};

export function capabilityPresentation(
  capability: ProcessingCapability,
): CapabilityPresentation {
  return { capability, ...CAPABILITIES[capability] };
}

// ─── Connectors ────────────────────────────────────────────────────────────

interface KnownConnector {
  title: string;
  description: string;
  defaultEndpoint?: string;
  /** The endpoint is fixed by the connector (the server rejects any other). */
  fixedEndpoint?: boolean;
  apiKey: ApiKeyRequirement;
  /** Capabilities preselected for a new connection (subset of the manifest). */
  defaultCapabilities?: readonly ProcessingCapability[];
  defaultOptions?: Record<string, unknown>;
}

export type ApiKeyRequirement = 'required' | 'optional' | 'none';

const KNOWN_CONNECTORS: Record<string, KnownConnector> = {
  'openai-api': {
    title: 'OpenAI API',
    description: 'Official OpenAI API billed with an API key.',
    defaultEndpoint: OPENAI_API_ENDPOINT,
    fixedEndpoint: true,
    apiKey: 'required',
  },
  'openai-compatible': {
    title: 'OpenAI-compatible',
    description:
      'Any server that implements the OpenAI API, in the cloud or on your network.',
    defaultEndpoint: 'https://provider.example/v1',
    apiKey: 'optional',
    defaultCapabilities: ['text.structured'],
    defaultOptions: { protocol: 'responses' },
  },
  'azure-speech': {
    title: 'Azure Speech',
    description: 'Microsoft Azure transcription and speech synthesis.',
    defaultEndpoint: 'https://REGION.api.cognitive.microsoft.com',
    apiKey: 'required',
  },
  ollama: {
    title: 'Ollama',
    description: 'Local models served by Ollama on your network.',
    defaultEndpoint: 'http://ollama:11434',
    apiKey: 'none',
    defaultOptions: { allowPrivateNetwork: true },
  },
  [SUBSCRIPTION_CONNECTOR_ID]: {
    title: 'OpenAI subscription',
    description: 'Your own eligible OpenAI account, linked from the server.',
    apiKey: 'none',
  },
  'local.analysis': {
    title: 'Local analysis',
    description: 'Built-in rule-based analysis that runs on this server.',
    apiKey: 'none',
    defaultOptions: { allowPrivateNetwork: true },
  },
};

function known(connectorId: string): KnownConnector | undefined {
  return Object.prototype.hasOwnProperty.call(KNOWN_CONNECTORS, connectorId)
    ? KNOWN_CONNECTORS[connectorId]
    : undefined;
}

/** 'fixture.text' → 'Fixture text'. */
export function humanizeConnectorId(id: string): string {
  const words = id
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return id;
  const sentence = words.join(' ').toLowerCase();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function connectorTitle(connectorId: string): string {
  return known(connectorId)?.title ?? humanizeConnectorId(connectorId);
}

export interface ConnectorCardModel {
  connectorId: string;
  title: string;
  description: string;
  version: string;
  execution: 'local' | 'cloud';
  executionLabel: 'Local' | 'Cloud';
  simulated: boolean;
  capabilities: CapabilityPresentation[];
  /** False when the wizard cannot create a connection for this connector. */
  selectable: boolean;
  reason?: string;
  accessibilityLabel: string;
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function connectorCard(
  manifest: ConnectorManifestView,
): ConnectorCardModel {
  const info = known(manifest.connectorId);
  const title =
    textField(manifest.title) ??
    info?.title ??
    humanizeConnectorId(manifest.connectorId);
  const description =
    textField(manifest.description) ??
    info?.description ??
    (manifest.execution === 'local'
      ? 'Runs on this server or your network.'
      : 'Sends data to a cloud provider.');
  const reason = manifest.simulated
    ? 'Simulated connectors are for development and cannot be saved.'
    : manifest.connectorId === SUBSCRIPTION_CONNECTOR_ID
      ? 'Linked through the subscription setup command, not this wizard.'
      : undefined;
  const capabilities = manifest.capabilities.map(capabilityPresentation);
  const executionLabel = manifest.execution === 'local' ? 'Local' : 'Cloud';
  return {
    connectorId: manifest.connectorId,
    title,
    description,
    version: manifest.version,
    execution: manifest.execution,
    executionLabel,
    simulated: manifest.simulated,
    capabilities,
    selectable: reason === undefined,
    ...(reason ? { reason } : {}),
    accessibilityLabel: [
      title,
      executionLabel,
      manifest.simulated ? 'Simulated' : undefined,
      capabilities.map((item) => item.label).join(', '),
      reason,
    ]
      .filter(Boolean)
      .join('. '),
  };
}

/** Cards for the wizard: selectable first, subscription excluded (it has its own card). */
export function connectorCards(
  manifests: readonly ConnectorManifestView[],
): ConnectorCardModel[] {
  return manifests
    .filter((manifest) => manifest.connectorId !== SUBSCRIPTION_CONNECTOR_ID)
    .map(connectorCard)
    .sort(
      (a, b) =>
        Number(b.selectable) - Number(a.selectable) ||
        a.title.localeCompare(b.title),
    );
}

export function hasSubscriptionConnector(
  manifests: readonly ConnectorManifestView[],
): boolean {
  return manifests.some(
    (manifest) => manifest.connectorId === SUBSCRIPTION_CONNECTOR_ID,
  );
}

export function apiKeyRequirement(connectorId: string): ApiKeyRequirement {
  return known(connectorId)?.apiKey ?? 'optional';
}

export function endpointFixed(connectorId: string): boolean {
  return known(connectorId)?.fixedEndpoint === true;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

/** Narrows a schema exposed by a server to the object shape SchemaForm accepts. */
export function exposedSchema(value: unknown): FormSchema | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const candidate = value as { type?: unknown; properties?: unknown };
  if (candidate.type !== 'object') return undefined;
  if (
    candidate.properties !== undefined &&
    (!candidate.properties ||
      typeof candidate.properties !== 'object' ||
      Array.isArray(candidate.properties))
  )
    return undefined;
  return value as FormSchema;
}

const allowPrivateNetwork = (defaultValue: boolean): FormSchemaProperty => ({
  type: 'boolean',
  title: 'Allow private network',
  description:
    'Required for endpoints on this computer or your local network. Plain http:// is accepted only for these.',
  default: defaultValue,
});

/**
 * Connection options ("configuration") for a connector. Uses the schema the
 * server exposes when present, otherwise a curated schema for known connector
 * IDs, otherwise undefined (the UI then offers Advanced JSON only).
 */
export function connectionOptionSchema(
  manifest: ConnectorManifestView | undefined,
  capabilities: readonly ProcessingCapability[],
): FormSchema | undefined {
  if (!manifest) return undefined;
  const exposed =
    exposedSchema(manifest.configSchema) ??
    exposedSchema(manifest.optionsSchema);
  if (exposed) return exposed;
  switch (manifest.connectorId) {
    case 'openai-api':
      return { type: 'object', properties: {} };
    case 'openai-compatible':
      return {
        type: 'object',
        properties: {
          protocol: {
            type: 'string',
            title: 'Protocol',
            description:
              'The API this server implements for text analysis. Speech uses the audio endpoints.',
            enum: ['responses', 'chat-completions'],
            'x-enum-labels': {
              responses: 'Responses',
              'chat-completions': 'Chat Completions',
            },
            default: 'responses',
          },
          supportsJsonSchema: {
            type: 'boolean',
            title: 'Structured JSON output',
            description:
              'Turn on only if the server enforces JSON Schema output.',
            default: false,
          },
          allowPrivateNetwork: allowPrivateNetwork(false),
        },
      };
    case 'azure-speech':
      return {
        type: 'object',
        properties: {
          ttsEndpoint: {
            type: 'string',
            format: 'uri',
            title: 'Speech synthesis endpoint',
            description:
              'Azure Speech synthesis base URL, for example https://REGION.tts.speech.microsoft.com.',
            'x-placeholder': 'https://REGION.tts.speech.microsoft.com',
          },
        },
        ...(capabilities.includes('tts.synthesize')
          ? { required: ['ttsEndpoint'] }
          : {}),
      };
    case 'ollama':
    case 'local.analysis':
      return {
        type: 'object',
        properties: { allowPrivateNetwork: allowPrivateNetwork(true) },
      };
    default:
      return undefined;
  }
}

const providerToken = '^[A-Za-z0-9_-]+$';

/**
 * Profile settings for a connector and capability: exposed schema first, then
 * curated settings, else undefined (Advanced JSON only).
 */
export function profileSettingsSchema(
  manifest: ConnectorManifestView | undefined,
  capability: ProcessingCapability | undefined,
): FormSchema | undefined {
  if (!manifest || !capability) return undefined;
  const exposed = settingsFromExposed(manifest.settingsSchema, capability);
  if (exposed) return exposed;
  const id = manifest.connectorId;
  if (id === 'openai-api' || id === 'openai-compatible') {
    if (capability === 'stt.batch')
      return {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            title: 'Language',
            description:
              'Optional language code such as en or es. Leave empty to detect it.',
            maxLength: 200,
            'x-placeholder': 'en',
          },
        },
      };
    if (capability === 'tts.synthesize')
      return {
        type: 'object',
        required: ['voice'],
        properties: {
          voice: {
            type: 'string',
            title: 'Voice',
            description: 'A voice name the provider offers.',
            maxLength: 200,
            'x-placeholder': 'alloy',
          },
        },
      };
    return { type: 'object', properties: {} };
  }
  if (id === 'azure-speech') {
    const language: FormSchemaProperty = {
      type: 'string',
      title: 'Locale',
      description: 'Azure locale such as en-US or es-CL.',
      pattern: providerToken,
      maxLength: 200,
      'x-placeholder': 'en-US',
    };
    if (capability === 'tts.synthesize')
      return {
        type: 'object',
        required: ['language', 'voice'],
        properties: {
          language,
          voice: {
            type: 'string',
            title: 'Voice',
            description: 'Azure neural voice name.',
            pattern: providerToken,
            maxLength: 200,
            'x-placeholder': 'en-US-JennyNeural',
          },
        },
      };
    return { type: 'object', required: ['language'], properties: { language } };
  }
  if (
    id === 'ollama' ||
    id === 'local.analysis' ||
    id === SUBSCRIPTION_CONNECTOR_ID
  )
    return { type: 'object', properties: {} };
  return undefined;
}

function settingsFromExposed(
  value: unknown,
  capability: ProcessingCapability,
): FormSchema | undefined {
  const direct = exposedSchema(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  return exposedSchema((value as Record<string, unknown>)[capability]);
}

/** Matches the server rule: configuration and settings never hold credentials. */
const CREDENTIAL_KEY = /token|secret|password|key|authorization/i;

/** Dotted paths of credential-shaped keys anywhere in an options object. */
export function credentialShapedKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      credentialShapedKeys(item, `${prefix}[${index}]`),
    );
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [
      ...(CREDENTIAL_KEY.test(key) ? [path] : []),
      ...credentialShapedKeys(child, path),
    ];
  });
}

export const OPTIONS_SIZE_LIMIT = 16000;

/** Server-equivalent safety checks for configuration and profile settings. */
export function optionsSafetyError(value: unknown): string | undefined {
  const keys = credentialShapedKeys(value);
  if (keys.length)
    return `Remove ${keys.join(', ')}: credentials belong in the encrypted API key field, never in options or settings.`;
  if (JSON.stringify(value ?? {}).length > OPTIONS_SIZE_LIMIT)
    return 'Options are too large.';
  return undefined;
}

export type JsonObjectResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function parseJsonObject(text: string): JsonObjectResult {
  if (!text.trim()) return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, error: 'Options must be a JSON object.' };
  return { ok: true, value: value as Record<string, unknown> };
}

export function formatJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

// ─── Endpoint policy (mirrors the server; the server stays authoritative) ──

export function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^\[f[cd]/i.test(hostname) ||
    (!hostname.includes('.') && !hostname.includes(':') && hostname !== '')
  );
}

export interface EndpointCheck {
  /** Blocking problem. */
  error?: string;
  /** The endpoint is on this computer or a private network. */
  local: boolean;
}

/**
 * Syntax-only check (step 2). The network rule that depends on the
 * "Allow private network" option is checked by `endpointPolicy`.
 */
export function endpointSyntax(text: string): EndpointCheck {
  const value = text.trim();
  if (!value) return { error: 'Enter the provider endpoint.', local: false };
  if (value.length > 1000)
    return { error: 'The endpoint is too long.', local: false };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      error: 'Enter a full URL such as https://provider.example/v1.',
      local: false,
    };
  }
  const local = isLocalHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return { error: 'Use an https:// endpoint.', local };
  if (parsed.username || parsed.password)
    return {
      error:
        'Do not put credentials in the endpoint. Use the API key field instead.',
      local,
    };
  if (parsed.search || parsed.hash)
    return {
      error: 'The endpoint cannot contain a query (?) or fragment (#).',
      local,
    };
  if (
    /^(169\.254\.|100\.100\.100\.200$|metadata\.)/i.test(parsed.hostname) ||
    /^\[fe[89ab]/i.test(parsed.hostname)
  )
    return {
      error: 'Link-local and cloud metadata addresses are not allowed.',
      local,
    };
  if (parsed.protocol === 'http:' && !local)
    return {
      error:
        'Use https://. Plain http:// is accepted only for local endpoints.',
      local,
    };
  return { local };
}

export function endpointPolicy(
  text: string,
  options: Readonly<Record<string, unknown>>,
  connectorId?: string,
): EndpointCheck {
  const syntax = endpointSyntax(text);
  if (syntax.error) return syntax;
  if (
    connectorId &&
    endpointFixed(connectorId) &&
    text.trim().replace(/\/+$/, '') !== OPENAI_API_ENDPOINT
  )
    return {
      error: `This connector only uses ${OPENAI_API_ENDPOINT}.`,
      local: syntax.local,
    };
  if (syntax.local && options['allowPrivateNetwork'] !== true)
    return {
      error:
        'This is a local endpoint. Turn on "Allow private network" in Options.',
      local: true,
    };
  return { local: syntax.local };
}

// ─── Connection wizard ─────────────────────────────────────────────────────

export const CONNECTION_STEPS = [
  'Provider',
  'Credentials',
  'Options',
  'Review',
] as const;
export type ConnectionStep = 0 | 1 | 2 | 3;

export interface ConnectionDraft {
  connectorId: string;
  displayName: string;
  endpoint: string;
  capabilities: ProcessingCapability[];
  options: Record<string, unknown>;
  /** Write-only; cleared after every save attempt. */
  apiKey: string;
}

export function initialConnectionDraft(
  manifest: ConnectorManifestView,
): ConnectionDraft {
  const info = known(manifest.connectorId);
  const defaults = info?.defaultCapabilities?.filter((capability) =>
    manifest.capabilities.includes(capability),
  );
  return {
    connectorId: manifest.connectorId,
    displayName: '',
    endpoint: info?.defaultEndpoint ?? '',
    capabilities: defaults?.length ? [...defaults] : [...manifest.capabilities],
    options: {
      ...(manifest.execution === 'local' ? { allowPrivateNetwork: true } : {}),
      ...info?.defaultOptions,
    },
    apiKey: '',
  };
}

export function toggleCapability(
  current: readonly ProcessingCapability[],
  capability: ProcessingCapability,
): ProcessingCapability[] {
  return current.includes(capability)
    ? current.filter((item) => item !== capability)
    : [...current, capability];
}

export type DraftErrors = Partial<
  Record<
    | 'connector'
    | 'displayName'
    | 'endpoint'
    | 'capabilities'
    | 'apiKey'
    | 'options',
    string
  >
>;

/**
 * Errors that block leaving `step`. Schema validation of the options is done
 * by the caller (with `validateSchemaValue`) and passed in as `optionErrors`.
 */
export function connectionStepErrors(
  step: ConnectionStep,
  draft: ConnectionDraft | undefined,
  manifest: ConnectorManifestView | undefined,
  optionErrors: Readonly<Record<string, string>> = {},
): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft || !manifest) {
    errors.connector = 'Choose a provider.';
    return errors;
  }
  const card = connectorCard(manifest);
  if (!card.selectable) errors.connector = card.reason ?? 'Choose a provider.';
  if (step === 0) return errors;
  if (draft.displayName.trim().length > DISPLAY_NAME_MAX)
    errors.displayName = `Use at most ${DISPLAY_NAME_MAX} characters.`;
  const syntax = endpointSyntax(draft.endpoint);
  if (syntax.error) errors.endpoint = syntax.error;
  if (!draft.capabilities.length)
    errors.capabilities = 'Choose at least one capability.';
  else if (
    draft.capabilities.some(
      (capability) => !manifest.capabilities.includes(capability),
    )
  )
    errors.capabilities = 'This connector does not declare that capability.';
  if (
    apiKeyRequirement(draft.connectorId) === 'required' &&
    !draft.apiKey.trim()
  )
    errors.apiKey = 'This provider requires an API key.';
  if (draft.apiKey.length > 64000) errors.apiKey = 'The API key is too long.';
  if (step === 1) return errors;
  const firstOptionError = Object.values(optionErrors)[0];
  const safety = optionsSafetyError(draft.options);
  if (safety) errors.options = safety;
  else if (firstOptionError) errors.options = firstOptionError;
  const policy = endpointPolicy(
    draft.endpoint,
    draft.options,
    draft.connectorId,
  );
  if (!errors.endpoint && policy.error) errors.endpoint = policy.error;
  return errors;
}

export function firstError(errors: DraftErrors): string | undefined {
  return Object.values(errors).find((value) => Boolean(value));
}

export interface CreateConnectionBody {
  connectorId: string;
  displayName: string;
  endpoint: string;
  capabilities: ProcessingCapability[];
  configuration: Record<string, unknown>;
  apiKey?: string;
}

export function connectionRequestBody(
  draft: ConnectionDraft,
): CreateConnectionBody {
  const apiKey = draft.apiKey.trim();
  return {
    connectorId: draft.connectorId,
    displayName:
      draft.displayName.trim().slice(0, DISPLAY_NAME_MAX) ||
      connectorTitle(draft.connectorId),
    endpoint: draft.endpoint.trim(),
    capabilities: [...draft.capabilities],
    configuration: { ...draft.options },
    ...(apiKey && apiKeyRequirement(draft.connectorId) !== 'none'
      ? { apiKey: draft.apiKey }
      : {}),
  };
}

export interface ReviewRow {
  label: string;
  value: string;
}

export function connectionReview(draft: ConnectionDraft): ReviewRow[] {
  const requirement = apiKeyRequirement(draft.connectorId);
  const options = Object.entries(draft.options);
  return [
    { label: 'Provider', value: connectorTitle(draft.connectorId) },
    {
      label: 'Name',
      value:
        draft.displayName.trim() ||
        `${connectorTitle(draft.connectorId)} (default)`,
    },
    { label: 'Endpoint', value: draft.endpoint.trim() },
    {
      label: 'Capabilities',
      value: draft.capabilities
        .map((capability) => capabilityPresentation(capability).label)
        .join(', '),
    },
    {
      label: 'API key',
      value:
        requirement === 'none'
          ? 'Not used'
          : draft.apiKey.trim()
            ? 'Provided · stored encrypted'
            : 'Not provided',
    },
    {
      label: 'Options',
      value: options.length
        ? options
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
            .join(', ')
        : 'None',
    },
  ];
}

// ─── Connections ───────────────────────────────────────────────────────────

export interface ConnectionStatusPresentation {
  tone: StatusTone;
  label: string;
}

export function connectionStatus(
  status: ProcessingConnectionView['status'],
): ConnectionStatusPresentation {
  switch (status) {
    case 'connected':
      return { tone: 'ok', label: 'Connected' };
    case 'configured':
      return { tone: 'pending', label: 'Configured · not yet used' };
    case 'requires_configuration':
      return { tone: 'warning', label: 'Needs configuration' };
    case 'expired':
      return { tone: 'warning', label: 'Expired · reauthorize' };
    case 'revoked':
      return { tone: 'off', label: 'Revoked' };
  }
}

/** Mirrors the connector execution scope: compatible servers on a private network run locally. */
export function connectionExecution(
  connection: ProcessingConnectionView | undefined,
  manifest: ConnectorManifestView | undefined,
): 'local' | 'cloud' | undefined {
  if (!connection) return undefined;
  if (connection.connection.connectorId === 'openai-compatible') {
    const check = endpointSyntax(connection.endpoint);
    return check.local &&
      connection.configuration['allowPrivateNetwork'] === true
      ? 'local'
      : 'cloud';
  }
  return manifest?.execution;
}

export function activeConnections(
  connections: readonly ProcessingConnectionView[],
): ProcessingConnectionView[] {
  return connections.filter((connection) => connection.status !== 'revoked');
}

// ─── Tasks & profiles ──────────────────────────────────────────────────────

export interface TaskPresentation {
  title: string;
  description: string;
  icon: IconName;
}

const TASKS: Record<string, TaskPresentation> = {
  'speech.transcribe': {
    title: 'Transcribe recordings',
    description: 'Turns received or transmitted audio into text.',
    icon: 'wave',
  },
  'speech.synthesize': {
    title: 'Synthesize speech',
    description: 'Creates a private audio preview from text.',
    icon: 'mic',
  },
  'conversation.summarize': {
    title: 'Summarize conversations',
    description: 'Writes a short summary of a communication.',
    icon: 'note',
  },
  'callsign.extract': {
    title: 'Extract callsigns',
    description: 'Finds callsigns mentioned in a transcript.',
    icon: 'user',
  },
  'entities.extract': {
    title: 'Extract entities',
    description: 'Finds places, people and other entities in a transcript.',
    icon: 'filter',
  },
};

export function taskPresentation(task: {
  taskId: string;
  capability: ProcessingCapability;
}): TaskPresentation {
  if (Object.prototype.hasOwnProperty.call(TASKS, task.taskId))
    return TASKS[task.taskId]!;
  const capability = capabilityPresentation(task.capability);
  return {
    title: humanizeConnectorId(task.taskId),
    description: `${capability.label} task.`,
    icon: capability.icon,
  };
}

export function tasksForConnection(
  tasks: readonly ProcessingTask[],
  connection: ProcessingConnectionView | undefined,
): ProcessingTask[] {
  if (!connection) return [];
  return tasks.filter((task) =>
    connection.capabilities.includes(task.capability),
  );
}

/** Latest version of each task ID (the API lists every installed version). */
export function latestTasks(
  tasks: readonly ProcessingTask[],
): ProcessingTask[] {
  const latest = new Map<string, ProcessingTask>();
  for (const task of tasks) {
    const current = latest.get(task.taskId);
    if (!current || task.version > current.version)
      latest.set(task.taskId, task);
  }
  return [...latest.values()];
}

export function taskFor(
  tasks: readonly ProcessingTask[],
  taskId: string | undefined,
): ProcessingTask | undefined {
  if (!taskId) return undefined;
  return latestTasks(tasks).find((task) => task.taskId === taskId);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === 'string' && !!item.trim(),
      )
    : [];
}

/**
 * Known models for the picker: models the connector exposes (if any, either a
 * list or a per-capability map), then models already used by profiles on
 * connections of the same connector and capability.
 */
export function modelSuggestions(input: {
  manifest: ConnectorManifestView | undefined;
  capability: ProcessingCapability | undefined;
  profiles: readonly ProcessingProfile[];
  connections: readonly ProcessingConnectionView[];
}): string[] {
  const { manifest, capability } = input;
  if (!manifest || !capability) return [];
  const exposed = Array.isArray(manifest.models)
    ? stringList(manifest.models)
    : manifest.models && typeof manifest.models === 'object'
      ? stringList((manifest.models as Record<string, unknown>)[capability])
      : [];
  const sameConnector = new Set(
    input.connections
      .filter((item) => item.connection.connectorId === manifest.connectorId)
      .map((item) => item.connection.connectionId),
  );
  const used = input.profiles
    .filter(
      (profile) =>
        profile.capability === capability &&
        sameConnector.has(profile.connectionId),
    )
    .map((profile) => profile.model);
  const seen = new Set<string>();
  return [...exposed, ...used].filter((model) => {
    const key = model.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ProfileDraft {
  connectionId: string | undefined;
  taskId: string | undefined;
  model: string;
  settings: Record<string, unknown>;
  allowCloud: boolean;
}

export const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  connectionId: undefined,
  taskId: undefined,
  model: '',
  settings: {},
  allowCloud: false,
};

export interface CloudNotice {
  tone: 'neutral' | 'warning';
  message: string;
}

export function cloudNotice(
  execution: 'local' | 'cloud' | undefined,
  allowCloud: boolean,
): CloudNotice {
  if (execution === 'cloud' && !allowCloud)
    return {
      tone: 'warning',
      message:
        'This connection is a cloud service. Jobs with this profile are refused until cloud processing is allowed.',
    };
  if (execution === 'cloud')
    return {
      tone: 'neutral',
      message:
        'Recordings or text processed with this profile are sent to the provider’s cloud service.',
    };
  if (execution === 'local' && allowCloud)
    return {
      tone: 'neutral',
      message:
        'This connection runs locally today. Allowing cloud processing only matters if its endpoint moves off your network.',
    };
  return {
    tone: 'neutral',
    message: 'Processing stays on this server or your network.',
  };
}

export function profileDraftErrors(
  draft: ProfileDraft,
  connection: ProcessingConnectionView | undefined,
  task: ProcessingTask | undefined,
  settingErrors: Readonly<Record<string, string>> = {},
): string | undefined {
  if (!connection) return 'Choose a connection.';
  if (connection.status === 'revoked')
    return 'This connection was revoked. Choose another one.';
  if (!task) return 'Choose a task.';
  if (!connection.capabilities.includes(task.capability))
    return 'This connection does not support the chosen task.';
  if (!draft.model.trim()) return 'Enter a model or deployment name.';
  if (draft.model.length > 200) return 'The model name is too long.';
  const safety = optionsSafetyError(draft.settings);
  if (safety) return safety;
  const settingError = Object.values(settingErrors)[0];
  if (settingError) return settingError;
  return undefined;
}

export interface CreateProfileBody {
  connectionId: string;
  capability: ProcessingCapability;
  task: string;
  model: string;
  allowCloud: boolean;
  settings: Record<string, unknown>;
}

export function profileRequestBody(
  draft: ProfileDraft,
  task: ProcessingTask,
): CreateProfileBody | undefined {
  if (!draft.connectionId) return undefined;
  return {
    connectionId: draft.connectionId,
    capability: task.capability,
    task: task.taskId,
    model: draft.model.trim(),
    allowCloud: draft.allowCloud,
    settings: { ...draft.settings },
  };
}

export function profileTitle(
  profile: ProcessingProfile,
  tasks: readonly ProcessingTask[],
): string {
  const task = profile.task
    ? (taskFor(tasks, profile.task) ?? {
        taskId: profile.task,
        capability: profile.capability,
      })
    : undefined;
  return task
    ? taskPresentation(task).title
    : capabilityPresentation(profile.capability).label;
}

export function profileLabel(
  profile: ProcessingProfile,
  tasks: readonly ProcessingTask[],
  connections: readonly ProcessingConnectionView[],
): string {
  const connection = connections.find(
    (item) => item.connection.connectionId === profile.connectionId,
  );
  return [
    profileTitle(profile, tasks),
    profile.model,
    connection?.displayName,
    `revision ${profile.revision}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function profilesFor(
  profiles: readonly ProcessingProfile[],
  capabilities: readonly ProcessingCapability[],
): ProcessingProfile[] {
  return profiles.filter((profile) =>
    capabilities.includes(profile.capability),
  );
}

// ─── Jobs ──────────────────────────────────────────────────────────────────

export type JobState = ProcessingJobView['state'];

export interface JobPresentation {
  tone: StatusTone;
  label: string;
  icon: IconName;
  pulse: boolean;
  /** 0..1 position in the job lifecycle (not provider progress). */
  progress: number;
  active: boolean;
  cancellable: boolean;
}

export function jobPresentation(state: JobState): JobPresentation {
  switch (state) {
    case 'queued':
      return {
        tone: 'pending',
        label: 'Queued',
        icon: 'clock',
        pulse: false,
        progress: 0.2,
        active: true,
        cancellable: true,
      };
    case 'running':
      return {
        tone: 'pending',
        label: 'Running',
        icon: 'play',
        pulse: true,
        progress: 0.6,
        active: true,
        cancellable: true,
      };
    case 'retry_wait':
      return {
        tone: 'warning',
        label: 'Waiting to retry',
        icon: 'clock',
        pulse: false,
        progress: 0.4,
        active: true,
        cancellable: false,
      };
    case 'completed':
      return {
        tone: 'ok',
        label: 'Completed',
        icon: 'check',
        pulse: false,
        progress: 1,
        active: false,
        cancellable: false,
      };
    case 'failed':
      return {
        tone: 'error',
        label: 'Failed',
        icon: 'alert',
        pulse: false,
        progress: 1,
        active: false,
        cancellable: false,
      };
    case 'cancelled':
      return {
        tone: 'off',
        label: 'Cancelled',
        icon: 'close',
        pulse: false,
        progress: 1,
        active: false,
        cancellable: false,
      };
    case 'requires_configuration':
      return {
        tone: 'warning',
        label: 'Needs configuration',
        icon: 'settings',
        pulse: false,
        progress: 1,
        active: false,
        cancellable: false,
      };
  }
}

export function hasActiveJobs(jobs: readonly ProcessingJobView[]): boolean {
  return jobs.some((job) => jobPresentation(job.state).active);
}

export function sortJobs(
  jobs: readonly ProcessingJobView[],
): ProcessingJobView[] {
  return [...jobs].sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.jobId.localeCompare(b.jobId),
  );
}

export type JobOutput =
  | { kind: 'text'; label: string; text: string }
  | { kind: 'audio'; label: string; detail: string }
  | { kind: 'data'; label: string; text: string }
  | { kind: 'none' };

export function jobOutput(job: ProcessingJobView): JobOutput {
  const output = job.result?.output;
  if (!output) return { kind: 'none' };
  switch (output.kind) {
    case 'transcript':
      return {
        kind: 'text',
        label: 'Transcript',
        text: output.text || '(No speech detected)',
      };
    case 'summary':
      return { kind: 'text', label: 'Summary', text: output.text };
    case 'audio':
      return {
        kind: 'audio',
        label: 'Speech preview',
        detail: [
          output.durationSeconds !== undefined
            ? `${output.durationSeconds.toFixed(1)} s`
            : undefined,
          formatBytes(output.byteLength),
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'extension':
      return {
        kind: 'data',
        label: humanizeConnectorId(output.schemaId),
        text: JSON.stringify(output.data),
      };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function jobTitle(
  job: ProcessingJobView,
  tasks: readonly ProcessingTask[],
): string {
  const task = taskFor(tasks, job.task);
  return task
    ? taskPresentation(task).title
    : (TASKS[job.task]?.title ?? humanizeConnectorId(job.task));
}

export function isAudioJob(job: ProcessingJobView | undefined): boolean {
  return job?.state === 'completed' && job.result?.output.kind === 'audio';
}

// ─── Job requests ──────────────────────────────────────────────────────────

export interface JobRequestInput {
  profile: ProcessingProfile | undefined;
  tasks: readonly ProcessingTask[];
  communication: Communication | undefined;
  text: string;
  radioId: string | undefined;
  now: number;
  idempotencyKey: string;
}

export type JobRequestResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** Builds `POST processing/jobs` exactly as the previous screen did. */
export function buildJobRequest(input: JobRequestInput): JobRequestResult {
  const { profile, communication } = input;
  if (!profile?.task)
    return { ok: false, error: 'Select a processing profile.' };
  const task = taskFor(input.tasks, profile.task);
  if (!task) return { ok: false, error: 'This profile task is unavailable.' };
  const audio = task.capability === 'stt.batch';
  const recording = communication?.recording;
  if (
    audio &&
    (!communication || !recording || recording.state !== 'available')
  )
    return { ok: false, error: 'Select an available recording.' };
  const transcript = communication?.transcripts.at(-1);
  const source =
    communication && task.capability !== 'tts.synthesize'
      ? {
          communicationId: communication.id,
          communicationRevision: communication.revision,
          ...(audio && recording ? { artifactId: recording.artifactId } : {}),
          ...(!audio && transcript
            ? { transcriptRevisionId: transcript.id }
            : {}),
        }
      : undefined;
  let requestInput: Record<string, unknown>;
  if (audio && communication && recording) {
    requestInput = {
      kind: 'audio',
      artifactId: recording.artifactId,
      communicationIds: [communication.id],
    };
  } else {
    const text =
      task.capability === 'text.structured'
        ? (transcript?.text ?? input.text)
        : input.text;
    if (!text.trim())
      return {
        ok: false,
        error:
          task.capability === 'tts.synthesize'
            ? 'Enter the text to speak.'
            : 'Select a communication with a transcript or enter text.',
      };
    if (text.length > TEXT_INPUT_MAX)
      return { ok: false, error: 'The text is too long.' };
    requestInput = {
      kind: 'text',
      text,
      communicationIds:
        task.capability === 'text.structured' && communication
          ? [communication.id]
          : [],
    };
  }
  return {
    ok: true,
    body: {
      request: {
        profileId: profile.profileId,
        profileRevision: profile.revision,
        task: task.taskId,
        taskVersion: task.version,
        deadline: new Date(input.now + JOB_DEADLINE_MS).toISOString(),
        input: requestInput,
      },
      idempotencyKey: input.idempotencyKey,
      ...(input.radioId ? { radioId: input.radioId } : {}),
      ...(source ? { source } : {}),
    },
  };
}

export function communicationSummary(communication: Communication): {
  title: string;
  detail: string;
  icon: IconName;
  hasRecording: boolean;
  hasTranscript: boolean;
} {
  const frequency = communication.frequencyHz
    ? `${(communication.frequencyHz / 1e6).toFixed(4)} MHz`
    : 'Frequency unknown';
  const hasRecording = communication.recording?.state === 'available';
  const hasTranscript = communication.transcripts.length > 0;
  return {
    title: new Date(communication.startedAt).toLocaleString(),
    detail: [
      frequency,
      hasRecording ? 'recording' : undefined,
      hasTranscript ? 'transcript' : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
    icon:
      communication.direction === 'rx'
        ? 'rx'
        : communication.direction === 'tx'
          ? 'tx'
          : 'note',
    hasRecording,
    hasTranscript,
  };
}

// ─── Speech (TTS) flow: Edit → Generate → Preview → Transmit ───────────────

export const SPEECH_STEPS = [
  'Edit',
  'Generate',
  'Preview',
  'Transmit',
] as const;

export interface GeneratedSpeech {
  jobId: string;
  /** Text that was synthesized; undefined when picked from the jobs list. */
  text?: string;
}

export interface SpeechFlowInput {
  text: string;
  profile: ProcessingProfile | undefined;
  generated: GeneratedSpeech | undefined;
  job: ProcessingJobView | undefined;
  /** The preview for this job was loaded and played (web) or acknowledged. */
  previewed: boolean;
  previewSupported: boolean;
  radioId: string | undefined;
  radioName: string | undefined;
  canTransmit: boolean;
  /** Why the radio cannot transmit now (permissions, capabilities, state). */
  radioBlockedReason?: string | undefined;
  transmitting: boolean;
  transmitted: boolean;
  busy: boolean;
}

export interface SpeechFlowState {
  /** 0 Edit, 1 Generate, 2 Preview, 3 Transmit. */
  step: 0 | 1 | 2 | 3;
  /** The text changed after generating; the old preview no longer matches. */
  stale: boolean;
  status: string;
  generate: Gate;
  preview: Gate;
  transmit: Gate;
}

export function speechTextError(text: string): string | undefined {
  if (!text.trim()) return 'Enter the text to speak.';
  if (text.length > TEXT_INPUT_MAX) return 'The text is too long.';
  return undefined;
}

export function isSpeechStale(
  text: string,
  generated: GeneratedSpeech | undefined,
): boolean {
  if (!generated) return false;
  return generated.text === undefined
    ? text.trim() !== ''
    : generated.text !== text.trim();
}

const UNREVIEWABLE_SPEECH = 'Generate this speech here to review its text.';

function gate(reason: string | undefined): Gate {
  return reason ? { enabled: false, reason } : { enabled: true };
}

/**
 * The speech flow never transmits implicitly: transmit is enabled only for a
 * completed audio preview of the current text that was previewed (or, where
 * audio preview is unavailable, explicitly acknowledged), with a radio
 * selected and a transmission path available.
 */
export function speechFlowState(input: SpeechFlowInput): SpeechFlowState {
  const stale = isSpeechStale(input.text, input.generated);
  const generated = stale ? undefined : input.generated;
  const job =
    generated && input.job?.jobId === generated.jobId ? input.job : undefined;
  const presentation = job ? jobPresentation(job.state) : undefined;
  const ready = isAudioJob(job);
  const textError = speechTextError(input.text);
  // Without an audio preview the operator reviews the synthesized text, so a
  // job picked from the jobs list (its text is unknown here) cannot be
  // reviewed and therefore cannot be transmitted.
  const reviewable = input.previewSupported || generated?.text !== undefined;
  const previewed = input.previewed && reviewable;

  const generate = gate(
    input.busy
      ? 'Another action is in progress.'
      : !input.profile
        ? 'Choose a speech profile.'
        : textError,
  );
  const preview = gate(
    !generated
      ? 'Generate speech first.'
      : !ready
        ? presentation?.active
          ? 'Speech is still being generated.'
          : 'This job has no audio preview.'
        : !reviewable
          ? UNREVIEWABLE_SPEECH
          : input.busy
            ? 'Another action is in progress.'
            : undefined,
  );
  const transmit = gate(
    !ready
      ? 'Generate and preview speech first.'
      : !reviewable
        ? UNREVIEWABLE_SPEECH
        : !previewed
          ? input.previewSupported
            ? 'Listen to the preview before transmitting.'
            : 'Confirm you reviewed the text before transmitting.'
          : !input.radioId
            ? 'Select a radio first.'
            : !input.canTransmit
              ? 'Prepared speech transmission is not available here.'
              : input.transmitting
                ? 'Transmitting.'
                : input.radioBlockedReason
                  ? input.radioBlockedReason
                  : input.busy
                    ? 'Another action is in progress.'
                    : undefined,
  );

  let step: SpeechFlowState['step'] = 0;
  if (generated) step = 1;
  if (ready) step = 2;
  if (ready && (previewed || input.transmitting || input.transmitted)) step = 3;

  const status = stale
    ? 'The text changed after generating. Generate again before transmitting.'
    : input.transmitting
      ? `On air · transmitting prepared speech${input.radioName ? ` on ${input.radioName}` : ''}`
      : input.transmitted
        ? 'Prepared speech was transmitted.'
        : !generated
          ? 'Write the message, then generate a private preview.'
          : job
            ? ready
              ? !reviewable
                ? UNREVIEWABLE_SPEECH
                : previewed
                  ? 'Preview reviewed. Transmit when ready.'
                  : 'Preview ready. Listen before transmitting.'
              : presentation?.active
                ? `${presentation.label} · generating speech`
                : `${presentation?.label ?? 'Unknown'} · no audio was produced`
            : 'Waiting for the job to appear.';

  return {
    step,
    stale: stale && input.generated !== undefined,
    status,
    generate,
    preview,
    transmit,
  };
}

// ─── Automatic RX transcription ────────────────────────────────────────────

export const AUTOMATIC_RX_NOTICE =
  'Off until explicitly enabled for a radio and destination. Changing the endpoint, connection or profile revision requires new consent. User subscription connections cannot be used here.';
export const AUTOMATIC_RX_CONSENT =
  'I approve automatic uploads of this radio’s RX recordings to the displayed destination and profile revision.';

export interface TranscriptionProfileOption {
  profile: ProcessingProfile;
  connection: ProcessingConnectionView | undefined;
  eligible: boolean;
  reason?: string;
}

/** Profiles usable for automatic RX: instance-owned, recorded STT, not revoked. */
export function transcriptionProfiles(
  profiles: readonly ProcessingProfile[],
  connections: readonly ProcessingConnectionView[],
): TranscriptionProfileOption[] {
  return profiles
    .filter((profile) => profile.capability === 'stt.batch')
    .map((profile) => {
      const connection = connections.find(
        (item) => item.connection.connectionId === profile.connectionId,
      );
      const reason = !connection
        ? 'Its connection is unavailable.'
        : connection.status === 'revoked'
          ? 'Its connection was revoked.'
          : connection.connection.owner.kind !== 'instance'
            ? 'User subscription connections cannot be used.'
            : profile.task !== 'speech.transcribe'
              ? 'Only transcription profiles can be used.'
              : !connection.hasCredentials &&
                  connection.connection.connectorId !== 'openai-compatible'
                ? 'Its connection has no stored credentials.'
                : undefined;
      return {
        profile,
        connection,
        eligible: reason === undefined,
        ...(reason ? { reason } : {}),
      };
    })
    .sort((a, b) => Number(b.eligible) - Number(a.eligible));
}

export interface ServiceOwnerCandidate {
  userId: string;
  username: string;
  eligible: boolean;
  reason?: string;
  current: boolean;
}

/**
 * The service owner must be an enabled administrator (for processing.manage)
 * with history.read on the radio.
 */
export function serviceOwnerCandidates(
  users: readonly PublicUser[],
  radioId: string,
  currentUserId: string,
): ServiceOwnerCandidate[] {
  return users
    .map((user) => {
      const reason = !user.enabled
        ? 'Account disabled.'
        : user.role !== 'administrator'
          ? 'Must be an administrator.'
          : !user.radioPermissions.some(
                (grant) =>
                  grant.radioId === radioId &&
                  grant.permissions.includes('history.read'),
              )
            ? 'No history access to this radio.'
            : undefined;
      return {
        userId: user.id,
        username: user.username,
        eligible: reason === undefined,
        ...(reason ? { reason } : {}),
        current: user.id === currentUserId,
      };
    })
    .sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        Number(b.current) - Number(a.current) ||
        a.username.localeCompare(b.username),
    );
}

export function defaultServiceOwner(
  candidates: readonly ServiceOwnerCandidate[],
  currentUserId: string,
): string | undefined {
  const current = candidates.find(
    (candidate) => candidate.userId === currentUserId && candidate.eligible,
  );
  return current?.userId ?? candidates.find((item) => item.eligible)?.userId;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function activeConsent(
  consents: readonly ProcessingBackgroundConsentView[],
  radioId: string,
): ProcessingBackgroundConsentView | undefined {
  return consents
    .filter((consent) => consent.radioId === radioId && consent.enabled)
    .sort((a, b) => Date.parse(b.consentedAt) - Date.parse(a.consentedAt))[0];
}

export type ConsentHealth =
  { state: 'off' } | { state: 'on' } | { state: 'stale'; reason: string };

/** A consent is stale when its profile revision or endpoint no longer match. */
export function consentHealth(
  consent: ProcessingBackgroundConsentView | undefined,
  profiles: readonly ProcessingProfile[],
  connections: readonly ProcessingConnectionView[],
): ConsentHealth {
  if (!consent) return { state: 'off' };
  const profile = profiles.find((item) => item.profileId === consent.profileId);
  if (!profile)
    return {
      state: 'stale',
      reason: 'The consented profile is no longer available.',
    };
  if (profile.revision !== consent.profileRevision)
    return {
      state: 'stale',
      reason: 'The profile changed since consent. Renew consent to resume.',
    };
  const connection = connections.find(
    (item) => item.connection.connectionId === profile.connectionId,
  );
  if (!connection || connection.status === 'revoked')
    return { state: 'stale', reason: 'The provider connection was revoked.' };
  if (connection.endpoint !== consent.endpoint)
    return {
      state: 'stale',
      reason: 'The provider endpoint changed. Renew consent to resume.',
    };
  return { state: 'on' };
}

export interface ConsentDraft {
  radioId: string | undefined;
  option: TranscriptionProfileOption | undefined;
  serviceOwnerUserId: string;
  approved: boolean;
}

export function consentGate(draft: ConsentDraft, busy: boolean): Gate {
  return gate(
    busy
      ? 'Another action is in progress.'
      : !draft.radioId
        ? 'Choose a radio first.'
        : !draft.option
          ? 'Choose a transcription profile.'
          : !draft.option.eligible
            ? (draft.option.reason ?? 'This profile cannot be used.')
            : !UUID_PATTERN.test(draft.serviceOwnerUserId.trim())
              ? 'Choose the service owner.'
              : !draft.approved
                ? 'Approve automatic uploads to continue.'
                : undefined,
  );
}

export interface ConsentBody {
  radioId: string;
  profileId: string;
  profileRevision: number;
  endpoint: string;
  serviceOwnerUserId: string;
  allowAutomaticUpload: true;
}

export function consentRequestBody(
  draft: ConsentDraft,
): ConsentBody | undefined {
  if (consentGate(draft, false).enabled !== true) return undefined;
  const { option } = draft;
  if (!draft.radioId || !option?.connection) return undefined;
  return {
    radioId: draft.radioId,
    profileId: option.profile.profileId,
    profileRevision: option.profile.revision,
    endpoint: option.connection.endpoint,
    serviceOwnerUserId: draft.serviceOwnerUserId.trim(),
    allowAutomaticUpload: true,
  };
}

/** Radios to show as automation cards: visible radios plus radios with a consent. */
export function automationRadios(
  radios: readonly { radioId: string; displayName: string }[],
  consents: readonly ProcessingBackgroundConsentView[],
): { radioId: string; name: string }[] {
  const result = radios.map((radio) => ({
    radioId: radio.radioId,
    name: radio.displayName || 'Unnamed radio',
  }));
  const seen = new Set(result.map((radio) => radio.radioId));
  for (const consent of consents) {
    if (!consent.enabled || seen.has(consent.radioId)) continue;
    seen.add(consent.radioId);
    result.push({
      radioId: consent.radioId,
      name: `Radio ${consent.radioId.slice(0, 8)}`,
    });
  }
  return result;
}

// ─── Misc ──────────────────────────────────────────────────────────────────

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The operation could not be completed.';
}

export function idempotencyKey(now: number, random: () => number): string {
  return `client-${now}-${random().toString(36).slice(2)}`;
}
