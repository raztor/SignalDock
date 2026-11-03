/**
 * Pure model for the radio setup wizard: step validation, endpoint checks,
 * Advanced JSON parsing, prefill from an existing configuration and the
 * `POST radios` body. No React / React Native imports, so it runs in node
 * tests. Schema validation (`validateSchemaValue` from `@signaldock/ui`) is
 * passed in by the caller because the UI package needs React Native.
 */
import {
  RadioConfigurationSchema,
  type InstalledDriver,
  type RadioConfiguration,
  type RadioView,
} from '@signaldock/contracts';
import {
  connectionPresentation,
  verificationLabel,
  type StatusPresentation,
} from '../station/station-model';

export const SETUP_STEPS = [
  'Driver',
  'Identity & connection',
  'Settings',
  'Review & save',
  'Access',
] as const;
export const STEP_DRIVER = 0;
export const STEP_IDENTITY = 1;
export const STEP_SETTINGS = 2;
export const STEP_REVIEW = 3;
export const STEP_ACCESS = 4;

export const DISPLAY_NAME_MAX = 100;
export const RESOURCE_GROUP_MAX_LENGTH = 100;
export const RESOURCE_GROUP_LIMIT = 20;

export type SettingsMode = 'form' | 'json';
export type EndpointMode = 'required' | 'optional' | 'none';

export interface RadioSetupState {
  /** `create` posts a new radio; `edit` replaces an existing configuration. */
  mode: 'create' | 'edit';
  /** Generated once per new radio so a retried save stays idempotent. */
  radioId: string;
  driverId: string | undefined;
  displayName: string;
  endpoint: string;
  resourceGroupIds: string[];
  enabled: boolean;
  /** Settings edited through the schema form. */
  config: Record<string, unknown>;
  settingsMode: SettingsMode;
  /** Advanced JSON draft; authoritative while `settingsMode === 'json'`. */
  configText: string;
}

/** Map of setting key → message, as returned by `validateSchemaValue`. */
export type SettingsErrors = Record<string, string>;
/** Injected schema validator (normally `validateSchemaValue` bound to the driver schema). */
export type SettingsValidator = (value: unknown) => SettingsErrors;

export type ConfigParseResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function formatConfigJson(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

/** Fresh wizard state for a new radio. `radioId` must be a new UUID. */
export function initialSetupState(radioId: string): RadioSetupState {
  return {
    mode: 'create',
    radioId,
    driverId: undefined,
    displayName: '',
    endpoint: '',
    resourceGroupIds: [],
    enabled: true,
    config: {},
    settingsMode: 'form',
    configText: '{}',
  };
}

/**
 * Wizard state prefilled from a saved configuration. Settings open in the
 * form when the driver describes them, otherwise in Advanced JSON.
 */
export function prefillFromConfiguration(
  configuration: RadioConfiguration,
  driver?: InstalledDriver,
): RadioSetupState {
  const config = structuredClone(configuration.config ?? {});
  return {
    mode: 'edit',
    radioId: configuration.radioId,
    driverId: configuration.driverId,
    displayName: configuration.displayName,
    endpoint: configuration.endpoint ?? '',
    resourceGroupIds: [...configuration.resourceGroupIds],
    enabled: configuration.enabled,
    config,
    settingsMode: describesSettings(driver) ? 'form' : 'json',
    configText: formatConfigJson(config),
  };
}

/** True when the driver's schema lists at least one setting the form can show. */
export function describesSettings(
  driver: InstalledDriver | undefined,
): boolean {
  const properties = driver?.configSchema.properties;
  return Boolean(properties && Object.keys(properties).length);
}

export function endpointMode(
  driver: InstalledDriver | undefined,
): EndpointMode {
  if (!driver || driver.transport === 'other') return 'optional';
  return driver.requiresEndpoint ? 'required' : 'none';
}

/**
 * Picks a driver. Changing to a different driver clears its settings (they
 * belong to the previous driver) and an endpoint the new one does not use.
 * An empty display name is seeded with the driver's name.
 */
export function selectDriver(
  state: RadioSetupState,
  driver: InstalledDriver,
): RadioSetupState {
  const changed = state.driverId !== driver.driverId;
  const config = changed ? {} : state.config;
  return {
    ...state,
    driverId: driver.driverId,
    displayName: state.displayName.trim()
      ? state.displayName
      : driver.displayName.slice(0, DISPLAY_NAME_MAX),
    endpoint: endpointMode(driver) === 'none' ? '' : state.endpoint,
    config,
    settingsMode: changed
      ? describesSettings(driver)
        ? 'form'
        : 'json'
      : state.settingsMode,
    configText: changed ? '{}' : state.configText,
  };
}

/* -------------------------------------------------------------------------- */
/* Field validation                                                           */
/* -------------------------------------------------------------------------- */

export function validateDisplayName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a display name.';
  if (trimmed.length > DISPLAY_NAME_MAX)
    return `Use at most ${DISPLAY_NAME_MAX} characters.`;
  return undefined;
}

/**
 * Validates a private driver endpoint the way the gRPC driver accepts it:
 * `unix:/absolute/path` or `host:port` (no scheme, path or credentials).
 */
export function validateEndpoint(text: string): string | undefined {
  const value = text.trim();
  if (!value) return 'Enter the driver endpoint.';
  if (/\s/.test(value)) return 'The endpoint cannot contain spaces.';
  if (value.startsWith('unix:')) {
    const path = value.slice(5);
    if (!path.startsWith('/'))
      return 'A Unix socket needs an absolute path, e.g. unix:/run/signaldock/radio.sock.';
    if (path.length < 2) return 'Enter the socket path after unix:.';
    return undefined;
  }
  if (value.includes('://'))
    return 'Enter host:port without a scheme such as https:// or grpc://.';
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    return 'Enter host:port or unix:/absolute/path.';
  }
  if (url.username || url.password)
    return 'Do not put credentials in the endpoint; use a driver credential setting.';
  if (url.pathname !== '/' || url.search || url.hash || value.endsWith('/'))
    return 'Enter host:port without a path.';
  // The driver transport needs an explicit, non-default port (as the server checks).
  if (!url.port)
    return /:\d+$/.test(value)
      ? 'Use the driver service port; port 443 is not accepted.'
      : 'Add the port, e.g. 192.168.1.20:50051.';
  return undefined;
}

/** Non-blocking advice about an endpoint that is valid but may not connect. */
export function endpointNotice(
  endpoint: string,
  config: Record<string, unknown>,
  driver: InstalledDriver | undefined,
): string | undefined {
  const value = endpoint.trim();
  if (!value || value.startsWith('unix:') || validateEndpoint(value))
    return undefined;
  const credential = driver?.configSchema.properties?.['credentialRef'];
  if (credential && typeof config['credentialRef'] !== 'string')
    return 'Network endpoints use authenticated TLS: set a driver credential in Settings.';
  return undefined;
}

export function validateResourceGroup(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a group name.';
  if (trimmed.length > RESOURCE_GROUP_MAX_LENGTH)
    return `Use at most ${RESOURCE_GROUP_MAX_LENGTH} characters.`;
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/** Parses the Advanced JSON editor: must be a JSON object. */
export function parseConfigJson(text: string): ConfigParseResult {
  const source = text.trim();
  if (!source) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (failure) {
    const detail =
      failure instanceof SyntaxError && failure.message
        ? ` ${failure.message.replace(/^JSON\.parse: /, '')}`
        : '';
    return { ok: false, error: `This is not valid JSON.${detail}` };
  }
  if (!isRecord(parsed))
    return {
      ok: false,
      error: 'Settings must be a JSON object, e.g. { "key": "value" }.',
    };
  return { ok: true, value: parsed };
}

const SECRET_KEY = /^(token|password|secret|privateKey|apiKey|authorization)$/i;

/**
 * Paths of keys the station rejects as inline secrets (same rule as the
 * server), e.g. `["auth.token"]`. Secrets belong in credential references.
 */
export function findInlineSecrets(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = Array.isArray(value)
      ? `${prefix}[${key}]`
      : prefix
        ? `${prefix}.${key}`
        : key;
    if (!Array.isArray(value) && SECRET_KEY.test(key)) found.push(path);
    found.push(...findInlineSecrets(child, path));
  }
  return found;
}

/** The settings that would be saved: the JSON draft in JSON mode, else the form value. */
export function currentConfig(state: RadioSetupState): ConfigParseResult {
  return state.settingsMode === 'json'
    ? parseConfigJson(state.configText)
    : { ok: true, value: state.config };
}

export type SettingsModeResult =
  { ok: true; state: RadioSetupState } | { ok: false; error: string };

/** Switches between the form and Advanced JSON, carrying the value across. */
export function switchSettingsMode(
  state: RadioSetupState,
  mode: SettingsMode,
): SettingsModeResult {
  if (mode === state.settingsMode) return { ok: true, state };
  if (mode === 'json')
    return {
      ok: true,
      state: {
        ...state,
        settingsMode: 'json',
        configText: formatConfigJson(state.config),
      },
    };
  const parsed = parseConfigJson(state.configText);
  if (!parsed.ok)
    return {
      ok: false,
      error: `Fix the JSON before switching to the form. ${parsed.error}`,
    };
  return {
    ok: true,
    state: { ...state, settingsMode: 'form', config: parsed.value },
  };
}

/**
 * Blocking problems with the settings keyed by setting (`$json` for a JSON
 * syntax error). Messages already name the setting.
 */
export function settingsIssues(
  state: RadioSetupState,
  validate?: SettingsValidator,
): SettingsErrors {
  const parsed = currentConfig(state);
  if (!parsed.ok) return { $json: parsed.error };
  const errors: SettingsErrors = { ...(validate?.(parsed.value) ?? {}) };
  for (const path of findInlineSecrets(parsed.value))
    errors[path] ??=
      `${path} looks like a secret. Store it as a credential and reference it instead.`;
  return errors;
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

export interface StepContext {
  driver: InstalledDriver | undefined;
  validate?: SettingsValidator;
}

/** Blocking messages for one step; empty means the step is complete. */
export function stepIssues(
  step: number,
  state: RadioSetupState,
  context: StepContext,
): string[] {
  switch (step) {
    case STEP_DRIVER:
      return state.driverId ? [] : ['Choose a driver.'];
    case STEP_IDENTITY: {
      const issues: string[] = [];
      const name = validateDisplayName(state.displayName);
      if (name) issues.push(name);
      const mode = endpointMode(context.driver);
      if (
        mode === 'required' ||
        (mode === 'optional' && state.endpoint.trim())
      ) {
        const endpoint = validateEndpoint(state.endpoint);
        if (endpoint) issues.push(endpoint);
      }
      if (state.resourceGroupIds.length > RESOURCE_GROUP_LIMIT)
        issues.push(`Use at most ${RESOURCE_GROUP_LIMIT} resource groups.`);
      for (const group of state.resourceGroupIds) {
        const error = validateResourceGroup(group);
        if (error) issues.push(`${group || 'Resource group'}: ${error}`);
      }
      return issues;
    }
    case STEP_SETTINGS:
      return Object.values(settingsIssues(state, context.validate));
    case STEP_REVIEW: {
      const built = buildConfigurationBody(state, context.driver);
      return built.ok ? [] : [built.error];
    }
    default:
      return [];
  }
}

/** First step (before `limit`) with blocking issues, or undefined. */
export function firstIncompleteStep(
  state: RadioSetupState,
  context: StepContext,
  limit = STEP_REVIEW,
): number | undefined {
  for (let step = STEP_DRIVER; step < limit; step++)
    if (stepIssues(step, state, context).length) return step;
  return undefined;
}

/** A step can be opened directly once every earlier step is complete. */
export function canOpenStep(
  step: number,
  state: RadioSetupState,
  context: StepContext,
  saved: boolean,
): boolean {
  if (step === STEP_ACCESS) return saved;
  const incomplete = firstIncompleteStep(state, context, step);
  return incomplete === undefined;
}

/** Where the wizard opens: editing skips the driver step. */
export function initialStep(state: RadioSetupState): number {
  return state.mode === 'edit' ? STEP_IDENTITY : STEP_DRIVER;
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                     */
/* -------------------------------------------------------------------------- */

export type BuildResult =
  { ok: true; body: RadioConfiguration } | { ok: false; error: string };

/** Builds the `POST radios` body from the wizard state. */
export function buildConfigurationBody(
  state: RadioSetupState,
  driver: InstalledDriver | undefined,
): BuildResult {
  if (!state.driverId) return { ok: false, error: 'Choose a driver.' };
  const name = validateDisplayName(state.displayName);
  if (name) return { ok: false, error: name };
  const config = currentConfig(state);
  if (!config.ok) return { ok: false, error: config.error };
  const secrets = findInlineSecrets(config.value);
  if (secrets.length)
    return {
      ok: false,
      error: `Remove inline secrets (${secrets.join(', ')}); use a credential reference.`,
    };
  const mode = endpointMode(driver);
  const endpoint = mode === 'none' ? '' : state.endpoint.trim();
  if (mode === 'required' || endpoint) {
    const error = validateEndpoint(endpoint);
    if (error) return { ok: false, error };
  }
  const groups: string[] = [];
  for (const group of state.resourceGroupIds) {
    const trimmed = group.trim();
    if (
      trimmed &&
      !groups.some((g) => g.toLowerCase() === trimmed.toLowerCase())
    )
      groups.push(trimmed);
  }
  const parsed = RadioConfigurationSchema.safeParse({
    radioId: state.radioId,
    displayName: state.displayName.trim(),
    driverId: state.driverId,
    resourceGroupIds: groups,
    enabled: state.enabled,
    ...(endpoint ? { endpoint } : {}),
    config: config.value,
  });
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'The configuration is invalid.',
    };
  return { ok: true, body: parsed.data };
}

/** Saving over an existing radio restarts its driver and needs confirmation. */
export function saveConfirmation(
  state: RadioSetupState,
  previous: RadioConfiguration | undefined,
): { title: string; message: string; confirmLabel: string } | undefined {
  if (state.mode !== 'edit' || !previous) return undefined;
  const name = state.displayName.trim() || previous.displayName;
  if (previous.enabled && !state.enabled)
    return {
      title: `Disable ${name}?`,
      message:
        'The radio disconnects. Control, live audio and any transmission on it stop until it is enabled again.',
      confirmLabel: 'Disable and save',
    };
  return {
    title: `Save changes to ${name}?`,
    message:
      'Saving replaces the stored configuration and reconnects the radio. Control, live audio and any transmission on it stop.',
    confirmLabel: 'Save and reconnect',
  };
}

export interface ReviewRow {
  label: string;
  value: string;
  monospace?: boolean;
}

/** Summary rows for the review step. */
export function reviewRows(
  state: RadioSetupState,
  driver: InstalledDriver | undefined,
): ReviewRow[] {
  const config = currentConfig(state);
  const settings = config.ok ? Object.keys(config.value) : [];
  const rows: ReviewRow[] = [
    { label: 'Name', value: state.displayName.trim() || '—' },
    {
      label: 'Driver',
      value: driver
        ? `${driver.displayName} · ${verificationLabel(driver.verification)}`
        : (state.driverId ?? '—'),
    },
  ];
  if (endpointMode(driver) !== 'none')
    rows.push({
      label: 'Endpoint',
      value: state.endpoint.trim() || 'None',
      monospace: Boolean(state.endpoint.trim()),
    });
  rows.push(
    {
      label: 'Resource groups',
      value: state.resourceGroupIds.length
        ? state.resourceGroupIds.join(', ')
        : 'None',
    },
    { label: 'Status', value: state.enabled ? 'Enabled' : 'Disabled' },
    {
      label: 'Settings',
      value: !config.ok
        ? 'Invalid JSON'
        : settings.length
          ? settings.join(', ')
          : 'Driver defaults',
    },
  );
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Driver cards and configuration list                                        */
/* -------------------------------------------------------------------------- */

const verificationRank = {
  hardware_verified: 0,
  experimental: 1,
  simulated: 2,
} as const;

/** Real hardware drivers first (verified, then experimental), simulators last. */
export function sortDrivers(
  drivers: readonly InstalledDriver[],
): InstalledDriver[] {
  return drivers
    .map((driver, index) => ({ driver, index }))
    .sort(
      (a, b) =>
        verificationRank[a.driver.verification] -
          verificationRank[b.driver.verification] || a.index - b.index,
    )
    .map((entry) => entry.driver);
}

export type DriverCapabilityKey = 'rx' | 'tx' | 'memories' | 'tuning';
export interface DriverCapability {
  key: DriverCapabilityKey;
  label: string;
}

/** Capability chips for a driver card; absent capabilities are not listed. */
export function driverCapabilities(
  driver: InstalledDriver,
): DriverCapability[] {
  const summary = driver.capabilitiesSummary;
  const result: DriverCapability[] = [];
  if (summary.rxAudio) result.push({ key: 'rx', label: 'RX audio' });
  if (summary.txAudio) result.push({ key: 'tx', label: 'TX audio' });
  if (summary.memories) result.push({ key: 'memories', label: 'Memories' });
  result.push({
    key: 'tuning',
    label: summary.tuningWritable ? 'Free tuning' : 'Fixed tuning',
  });
  return result;
}

export function transportLabel(driver: InstalledDriver): string {
  switch (driver.transport) {
    case 'simulator':
      return 'Simulator';
    case 'grpc':
      return 'Driver service';
    default:
      return 'Installed driver';
  }
}

/** Spoken summary for a driver card. */
export function driverAccessibilityLabel(driver: InstalledDriver): string {
  const capabilities = driverCapabilities(driver)
    .map((capability) => capability.label)
    .join(', ');
  const modes = driver.capabilitiesSummary.modes.join(', ');
  return [
    driver.displayName,
    verificationLabel(driver.verification),
    transportLabel(driver),
    capabilities,
    modes ? `Modes ${modes}` : '',
  ]
    .filter(Boolean)
    .join('. ');
}

/**
 * Status for a configuration card. Live status comes from the radio view
 * when this account can see the radio; otherwise only enabled/disabled is
 * known and it is never shown as healthy.
 */
export function configurationStatus(
  configuration: Pick<RadioConfiguration, 'enabled'>,
  view: Pick<RadioView, 'enabled' | 'health' | 'snapshot'> | undefined,
): StatusPresentation {
  if (!configuration.enabled)
    return { tone: 'off', label: 'Disabled', pulse: false };
  if (view) return connectionPresentation(view);
  return {
    tone: 'unknown',
    label: 'Enabled · live status needs listen access',
    pulse: false,
  };
}

/** Configurations sorted by display name for the list. */
export function sortConfigurations(
  configurations: readonly RadioConfiguration[],
): RadioConfiguration[] {
  return [...configurations].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: 'base',
    }),
  );
}
