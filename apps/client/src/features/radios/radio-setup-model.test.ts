import { describe, expect, it } from 'vitest';
import type {
  InstalledDriver,
  RadioConfiguration,
  RadioView,
} from '@signaldock/contracts';
import {
  STEP_ACCESS,
  STEP_DRIVER,
  STEP_IDENTITY,
  STEP_REVIEW,
  STEP_SETTINGS,
  buildConfigurationBody,
  canOpenStep,
  configurationStatus,
  currentConfig,
  describesSettings,
  driverAccessibilityLabel,
  driverCapabilities,
  endpointMode,
  endpointNotice,
  findInlineSecrets,
  firstIncompleteStep,
  initialSetupState,
  initialStep,
  parseConfigJson,
  prefillFromConfiguration,
  reviewRows,
  saveConfirmation,
  selectDriver,
  settingsIssues,
  sortConfigurations,
  sortDrivers,
  stepIssues,
  switchSettingsMode,
  validateDisplayName,
  validateEndpoint,
  validateResourceGroup,
  type RadioSetupState,
} from './radio-setup-model';

const RADIO_ID = '7f1d1c8e-2c55-4a59-9f3a-0f8f2bfb1a11';
const simulator: InstalledDriver = {
  driverId: 'simulator.tunable',
  displayName: 'Simulated tunable radio',
  description: 'For development.',
  transport: 'simulator',
  requiresEndpoint: false,
  verification: 'simulated',
  capabilitiesSummary: {
    rxAudio: false,
    txAudio: false,
    memories: true,
    tuningWritable: true,
    modes: ['FM'],
  },
  configSchema: {
    type: 'object',
    properties: { memories: { type: 'array', items: { type: 'object' } } },
  },
};
const grpc: InstalledDriver = {
  driverId: 'vgc-benlink',
  displayName: 'VGC / benlink',
  description: 'Bluetooth driver service.',
  transport: 'grpc',
  requiresEndpoint: true,
  verification: 'experimental',
  capabilitiesSummary: {
    rxAudio: true,
    txAudio: false,
    memories: true,
    tuningWritable: false,
    modes: ['FM'],
  },
  configSchema: {
    type: 'object',
    properties: {
      credentialRef: { type: 'string', 'x-credential-ref': true },
      connectTimeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
    },
  },
};
const open: InstalledDriver = {
  ...grpc,
  driverId: 'custom.driver',
  displayName: 'custom.driver',
  transport: 'other',
  requiresEndpoint: false,
  verification: 'experimental',
  configSchema: { type: 'object', properties: {}, additionalProperties: true },
};

function filled(overrides: Partial<RadioSetupState> = {}): RadioSetupState {
  return {
    ...selectDriver(initialSetupState(RADIO_ID), grpc),
    displayName: 'Base station',
    endpoint: '127.0.0.1:50051',
    config: { credentialRef: 'bench' },
    ...overrides,
  };
}

describe('wizard state', () => {
  it('starts a new radio at the driver step with the generated ID', () => {
    const state = initialSetupState(RADIO_ID);
    expect(state).toMatchObject({
      mode: 'create',
      radioId: RADIO_ID,
      driverId: undefined,
      enabled: true,
      config: {},
    });
    expect(initialStep(state)).toBe(STEP_DRIVER);
  });

  it('prefills an existing configuration and opens at identity', () => {
    const configuration: RadioConfiguration = {
      radioId: RADIO_ID,
      displayName: 'Mobile',
      driverId: 'vgc-benlink',
      resourceGroupIds: ['bt-adapter'],
      enabled: false,
      endpoint: 'unix:/run/radio.sock',
      config: { credentialRef: 'bench', connectTimeoutMs: 2000 },
    };
    const state = prefillFromConfiguration(configuration, grpc);
    expect(state).toMatchObject({
      mode: 'edit',
      radioId: RADIO_ID,
      driverId: 'vgc-benlink',
      displayName: 'Mobile',
      endpoint: 'unix:/run/radio.sock',
      resourceGroupIds: ['bt-adapter'],
      enabled: false,
      settingsMode: 'form',
    });
    expect(JSON.parse(state.configText)).toEqual(configuration.config);
    expect(initialStep(state)).toBe(STEP_IDENTITY);
    // Copies, so editing the wizard never mutates the loaded list.
    state.config['connectTimeoutMs'] = 1;
    state.resourceGroupIds.push('x');
    expect(configuration.config['connectTimeoutMs']).toBe(2000);
    expect(configuration.resourceGroupIds).toEqual(['bt-adapter']);
    const { endpoint: _endpoint, ...withoutEndpoint } = configuration;
    expect(prefillFromConfiguration(withoutEndpoint, undefined)).toMatchObject({
      endpoint: '',
      settingsMode: 'json',
    });
  });

  it('selecting a driver seeds the name and resets settings only on change', () => {
    const first = selectDriver(initialSetupState(RADIO_ID), grpc);
    expect(first.displayName).toBe('VGC / benlink');
    expect(first.settingsMode).toBe('form');
    const edited = {
      ...first,
      displayName: 'Base',
      endpoint: '10.0.0.2:50051',
      config: { credentialRef: 'bench' },
    };
    expect(selectDriver(edited, grpc)).toEqual(edited);
    const switched = selectDriver(edited, simulator);
    expect(switched).toMatchObject({
      driverId: 'simulator.tunable',
      displayName: 'Base',
      endpoint: '',
      config: {},
      configText: '{}',
    });
    expect(selectDriver(edited, open).settingsMode).toBe('json');
  });

  it('derives endpoint handling and settings description from the driver', () => {
    expect(endpointMode(grpc)).toBe('required');
    expect(endpointMode(simulator)).toBe('none');
    expect(endpointMode(open)).toBe('optional');
    expect(endpointMode(undefined)).toBe('optional');
    expect(describesSettings(grpc)).toBe(true);
    expect(describesSettings(open)).toBe(false);
    expect(describesSettings(undefined)).toBe(false);
  });
});

describe('field validation', () => {
  it('validates display names', () => {
    expect(validateDisplayName('  ')).toBe('Enter a display name.');
    expect(validateDisplayName('x'.repeat(101))).toMatch(/at most 100/);
    expect(validateDisplayName(' Base ')).toBeUndefined();
  });

  it('accepts host:port and absolute unix sockets only', () => {
    expect(validateEndpoint('127.0.0.1:50051')).toBeUndefined();
    expect(validateEndpoint('radio.local:8443')).toBeUndefined();
    expect(validateEndpoint('radio.local:443')).toMatch(/443/);
    expect(validateEndpoint('[::1]:50051')).toBeUndefined();
    expect(validateEndpoint('unix:/run/signaldock/radio.sock')).toBeUndefined();
    expect(validateEndpoint('')).toBe('Enter the driver endpoint.');
    expect(validateEndpoint('unix:relative.sock')).toMatch(/absolute path/);
    expect(validateEndpoint('https://radio.local:443')).toMatch(/scheme/);
    expect(validateEndpoint('radio.local')).toMatch(/port/);
    expect(validateEndpoint('radio.local:50051/path')).toMatch(
      /without a path/,
    );
    expect(validateEndpoint('radio.local:50051/')).toMatch(/without a path/);
    expect(validateEndpoint('user:pw@radio.local:1')).toMatch(/credentials/);
    expect(validateEndpoint('radio local:1')).toMatch(/spaces/);
    expect(validateEndpoint('radio.local:99999')).toBeDefined();
  });

  it('advises a credential for network endpoints of drivers that read one', () => {
    expect(endpointNotice('10.0.0.2:50051', {}, grpc)).toMatch(/credential/);
    expect(
      endpointNotice('10.0.0.2:50051', { credentialRef: 'bench' }, grpc),
    ).toBeUndefined();
    expect(endpointNotice('unix:/run/radio.sock', {}, grpc)).toBeUndefined();
    expect(endpointNotice('not valid', {}, grpc)).toBeUndefined();
    expect(endpointNotice('10.0.0.2:50051', {}, open)).toBeUndefined();
  });

  it('validates resource group names', () => {
    expect(validateResourceGroup(' ')).toBe('Enter a group name.');
    expect(validateResourceGroup('a'.repeat(101))).toMatch(/at most/);
    expect(validateResourceGroup('bt-adapter')).toBeUndefined();
  });
});

describe('Advanced JSON', () => {
  it('parses objects and explains everything else', () => {
    expect(parseConfigJson(' {"a": 1} ')).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(parseConfigJson('')).toEqual({ ok: true, value: {} });
    const broken = parseConfigJson('{"a": }');
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.error).toMatch(/^This is not valid JSON\./);
    for (const value of ['[1]', '"text"', '3', 'null'])
      expect(parseConfigJson(value)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/JSON object/),
      });
  });

  it('finds inline secrets with the server rule', () => {
    expect(
      findInlineSecrets({
        credentialRef: 'bench',
        auth: { Token: 'x', nested: [{ password: 'y' }] },
        apiKey: 'z',
      }),
    ).toEqual(['auth.Token', 'auth.nested[0].password', 'apiKey']);
    expect(findInlineSecrets({ tokenRef: 'x' })).toEqual([]);
  });

  it('switches modes carrying the value and refuses invalid JSON', () => {
    const form = filled({ config: { connectTimeoutMs: 1000 } });
    const json = switchSettingsMode(form, 'json');
    expect(json.ok && JSON.parse(json.state.configText)).toEqual({
      connectTimeoutMs: 1000,
    });
    if (!json.ok) throw new Error('expected json mode');
    const edited = { ...json.state, configText: '{"credentialRef":"b"}' };
    const back = switchSettingsMode(edited, 'form');
    expect(back.ok && back.state.config).toEqual({ credentialRef: 'b' });
    expect(
      switchSettingsMode({ ...edited, configText: '{' }, 'form'),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Fix the JSON/),
    });
    expect(switchSettingsMode(form, 'form')).toEqual({ ok: true, state: form });
  });

  it('uses the JSON draft as the current settings in JSON mode', () => {
    const state = filled({ settingsMode: 'json', configText: '{"a":true}' });
    expect(currentConfig(state)).toEqual({ ok: true, value: { a: true } });
    expect(currentConfig(filled())).toEqual({
      ok: true,
      value: { credentialRef: 'bench' },
    });
  });
});

describe('step validation', () => {
  const context = { driver: grpc };
  it('blocks each step until it is complete', () => {
    const empty = initialSetupState(RADIO_ID);
    expect(stepIssues(STEP_DRIVER, empty, { driver: undefined })).toEqual([
      'Choose a driver.',
    ]);
    const state = filled({ displayName: ' ', endpoint: 'radio.local' });
    expect(stepIssues(STEP_IDENTITY, state, context)).toEqual([
      'Enter a display name.',
      expect.stringMatching(/port/),
    ]);
    expect(stepIssues(STEP_IDENTITY, filled(), context)).toEqual([]);
    expect(
      stepIssues(
        STEP_IDENTITY,
        filled({
          resourceGroupIds: Array.from({ length: 21 }, (_, i) => `g${i}`),
        }),
        context,
      ),
    ).toEqual(['Use at most 20 resource groups.']);
  });

  it('only validates an optional endpoint when one is entered', () => {
    const state = filled({ endpoint: '' });
    expect(stepIssues(STEP_IDENTITY, state, { driver: open })).toEqual([]);
    expect(
      stepIssues(STEP_IDENTITY, { ...state, endpoint: 'x' }, { driver: open }),
    ).toHaveLength(1);
    expect(
      stepIssues(
        STEP_IDENTITY,
        { ...state, endpoint: 'x' },
        {
          driver: simulator,
        },
      ),
    ).toEqual([]);
  });

  it('reports schema, JSON and secret problems on the settings step', () => {
    const validate = (value: unknown): Record<string, string> =>
      (value as Record<string, unknown>)['connectTimeoutMs'] === 0
        ? { connectTimeoutMs: 'Connection timeout must be at least 1 ms.' }
        : {};
    expect(
      stepIssues(STEP_SETTINGS, filled({ config: { connectTimeoutMs: 0 } }), {
        driver: grpc,
        validate,
      }),
    ).toEqual(['Connection timeout must be at least 1 ms.']);
    expect(
      stepIssues(
        STEP_SETTINGS,
        filled({ settingsMode: 'json', configText: '[]' }),
        { driver: grpc, validate },
      ),
    ).toEqual([expect.stringMatching(/JSON object/)]);
    expect(
      settingsIssues(filled({ config: { password: 'x' } }), validate),
    ).toEqual({ password: expect.stringMatching(/credential/) });
    expect(
      stepIssues(STEP_SETTINGS, filled(), { driver: grpc, validate }),
    ).toEqual([]);
  });

  it('finds the first incomplete step and gates direct navigation', () => {
    const state = filled({ displayName: '' });
    expect(firstIncompleteStep(state, context)).toBe(STEP_IDENTITY);
    expect(firstIncompleteStep(filled(), context)).toBeUndefined();
    expect(canOpenStep(STEP_IDENTITY, state, context, false)).toBe(true);
    expect(canOpenStep(STEP_SETTINGS, state, context, false)).toBe(false);
    expect(canOpenStep(STEP_REVIEW, filled(), context, false)).toBe(true);
    expect(canOpenStep(STEP_ACCESS, filled(), context, false)).toBe(false);
    expect(canOpenStep(STEP_ACCESS, filled(), context, true)).toBe(true);
  });
});

describe('POST radios body', () => {
  it('builds a trimmed configuration with the generated radio ID', () => {
    const built = buildConfigurationBody(
      filled({
        displayName: '  Base station ',
        endpoint: ' 127.0.0.1:50051 ',
        resourceGroupIds: [' bt ', 'BT', 'shack'],
        enabled: false,
      }),
      grpc,
    );
    expect(built).toEqual({
      ok: true,
      body: {
        radioId: RADIO_ID,
        displayName: 'Base station',
        driverId: 'vgc-benlink',
        resourceGroupIds: ['bt', 'shack'],
        enabled: false,
        endpoint: '127.0.0.1:50051',
        config: { credentialRef: 'bench' },
      },
    });
  });

  it('drops endpoints for drivers without one and uses the JSON draft', () => {
    const state = {
      ...selectDriver(initialSetupState(RADIO_ID), simulator),
      endpoint: 'stale:1',
      settingsMode: 'json' as const,
      configText: '{"memories": []}',
    };
    const built = buildConfigurationBody(state, simulator);
    expect(built.ok && built.body).toEqual({
      radioId: RADIO_ID,
      displayName: 'Simulated tunable radio',
      driverId: 'simulator.tunable',
      resourceGroupIds: [],
      enabled: true,
      config: { memories: [] },
    });
    expect(
      buildConfigurationBody({ ...filled(), endpoint: '' }, open),
    ).toMatchObject({ ok: true, body: { driverId: 'vgc-benlink' } });
  });

  it('refuses incomplete or unsafe configurations', () => {
    expect(
      buildConfigurationBody(initialSetupState(RADIO_ID), undefined),
    ).toEqual({ ok: false, error: 'Choose a driver.' });
    expect(buildConfigurationBody(filled({ endpoint: '' }), grpc)).toEqual({
      ok: false,
      error: 'Enter the driver endpoint.',
    });
    expect(
      buildConfigurationBody(filled({ config: { token: 'x' } }), grpc),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/token/) });
    expect(
      buildConfigurationBody(
        filled({ settingsMode: 'json', configText: '{' }),
        grpc,
      ).ok,
    ).toBe(false);
    expect(
      buildConfigurationBody(filled({ radioId: 'not-a-uuid' }), grpc).ok,
    ).toBe(false);
    expect(
      stepIssues(STEP_REVIEW, filled({ endpoint: '' }), { driver: grpc }),
    ).toEqual(['Enter the driver endpoint.']);
  });

  it('confirms overwriting or disabling an existing radio', () => {
    const previous: RadioConfiguration = {
      radioId: RADIO_ID,
      displayName: 'Base',
      driverId: 'vgc-benlink',
      resourceGroupIds: [],
      enabled: true,
      config: {},
    };
    expect(saveConfirmation(filled(), undefined)).toBeUndefined();
    const edit = prefillFromConfiguration(previous, grpc);
    expect(saveConfirmation(edit, previous)?.confirmLabel).toBe(
      'Save and reconnect',
    );
    expect(saveConfirmation({ ...edit, enabled: false }, previous)?.title).toBe(
      'Disable Base?',
    );
  });

  it('summarises the review', () => {
    const rows = reviewRows(filled({ resourceGroupIds: ['bt'] }), grpc);
    expect(rows).toEqual([
      { label: 'Name', value: 'Base station' },
      { label: 'Driver', value: 'VGC / benlink · Experimental' },
      { label: 'Endpoint', value: '127.0.0.1:50051', monospace: true },
      { label: 'Resource groups', value: 'bt' },
      { label: 'Status', value: 'Enabled' },
      { label: 'Settings', value: 'credentialRef' },
    ]);
    const simulated = reviewRows(
      { ...selectDriver(initialSetupState(RADIO_ID), simulator) },
      simulator,
    );
    expect(simulated.map((row) => row.label)).not.toContain('Endpoint');
    expect(simulated.at(-1)).toEqual({
      label: 'Settings',
      value: 'Driver defaults',
    });
  });
});

describe('driver cards and configuration list', () => {
  it('orders real drivers before simulators, keeping server order otherwise', () => {
    const verified = {
      ...grpc,
      driverId: 'verified',
      verification: 'hardware_verified' as const,
    };
    expect(
      sortDrivers([simulator, grpc, open, verified]).map((d) => d.driverId),
    ).toEqual([
      'verified',
      'vgc-benlink',
      'custom.driver',
      'simulator.tunable',
    ]);
  });

  it('lists capabilities and speaks a summary', () => {
    expect(driverCapabilities(grpc).map((c) => c.key)).toEqual([
      'rx',
      'memories',
      'tuning',
    ]);
    expect(driverCapabilities(simulator).at(-1)?.label).toBe('Free tuning');
    expect(driverAccessibilityLabel(grpc)).toBe(
      'VGC / benlink. Experimental. Driver service. RX audio, Memories, Fixed tuning. Modes FM',
    );
  });

  it('never shows an unseen enabled radio as healthy', () => {
    const view = {
      enabled: true,
      health: { state: 'connected' },
      snapshot: { connection: 'ready' },
    } as Pick<RadioView, 'enabled' | 'health' | 'snapshot'>;
    expect(configurationStatus({ enabled: true }, view)).toMatchObject({
      tone: 'ok',
      label: 'Ready',
    });
    expect(configurationStatus({ enabled: false }, view).label).toBe(
      'Disabled',
    );
    expect(configurationStatus({ enabled: true }, undefined).tone).toBe(
      'unknown',
    );
  });

  it('sorts configurations by name', () => {
    const make = (displayName: string) =>
      ({ displayName }) as RadioConfiguration;
    expect(
      sortConfigurations([make('b'), make('A'), make('c')]).map(
        (c) => c.displayName,
      ),
    ).toEqual(['A', 'b', 'c']);
  });
});
