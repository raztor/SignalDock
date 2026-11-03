import {
  InstalledDriverSchema,
  RadioCapabilitiesSchema,
  SignalDockError,
  RadioMemorySchema,
  type InstalledDriver,
  type RadioCapabilities,
  type RadioConfiguration,
  type RadioDescriptor,
} from '@signaldock/contracts';
import {
  GrpcRadioDriver,
  SimulatedRadioDriver,
  simulationDescriptors,
  type RadioDriver,
} from '@signaldock/radio-driver-sdk';

export type RadioDriverFactory = (
  configuration: RadioConfiguration,
  context?: { signal: AbortSignal },
) => Promise<RadioDriver>;
/** What administrators see about an installed driver (everything but its ID). */
export type InstalledDriverMetadata = Omit<InstalledDriver, 'driverId'>;

/** Open schema: the driver does not describe its settings (Advanced JSON only). */
export const OPEN_CONFIG_SCHEMA: InstalledDriver['configSchema'] = {
  type: 'object',
  properties: {},
  additionalProperties: true,
};

export class InstalledDriverRegistry {
  private readonly factories = new Map<string, RadioDriverFactory>();
  private readonly metadata = new Map<string, InstalledDriver>();
  /**
   * Installs a trusted driver factory. `metadata` describes it to
   * administrators; it is validated here and must never contain secrets.
   */
  register(
    driverId: string,
    factory: RadioDriverFactory,
    metadata?: InstalledDriverMetadata,
  ): void {
    if (this.factories.has(driverId))
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'Driver factory is already installed.',
      );
    const described = metadata
      ? InstalledDriverSchema.parse({ ...structuredClone(metadata), driverId })
      : undefined;
    this.factories.set(driverId, factory);
    if (described) this.metadata.set(driverId, described);
  }
  /** Installed drivers in registration order; undescribed ones get a generic entry. */
  list(): InstalledDriver[] {
    return [...this.factories.keys()].map((driverId) =>
      structuredClone(
        this.metadata.get(driverId) ??
          InstalledDriverSchema.parse({
            ...undescribedDriver(driverId),
            driverId,
          }),
      ),
    );
  }
  create: RadioDriverFactory = async (configuration, context) => {
    const factory = this.factories.get(configuration.driverId);
    if (!factory)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'This radio driver is not installed.',
      );
    return factory(configuration, context);
  };
}

function undescribedDriver(driverId: string): InstalledDriverMetadata {
  return {
    displayName: driverId.slice(0, 100),
    description: 'This installed driver does not publish a description.',
    transport: 'other',
    requiresEndpoint: false,
    verification: 'experimental',
    capabilitiesSummary: {
      rxAudio: false,
      txAudio: false,
      memories: false,
      tuningWritable: false,
      modes: [],
    },
    configSchema: OPEN_CONFIG_SCHEMA,
  };
}

const megahertz = (hz: number) => {
  const value = hz / 1_000_000;
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
};

/** Summary shown on driver cards, derived from declared capabilities. */
export function capabilitiesSummary(
  capabilities: RadioCapabilities,
): InstalledDriver['capabilitiesSummary'] {
  return {
    rxAudio: capabilities.rxAudio,
    txAudio: capabilities.txAudio,
    memories: Boolean(capabilities.memories?.read),
    tuningWritable: capabilities.tuning.writable,
    modes: [...capabilities.tuning.modes],
  };
}

/** Settings read by the simulator factory: only optional initial memories. */
export const SIMULATOR_CONFIG_SCHEMA: InstalledDriver['configSchema'] = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      title: 'Channel memories',
      description:
        'Initial channel memories, each { memoryId, name, tuning: { rxHz, txHz?, mode } } with frequencies in Hz.',
      items: {
        type: 'object',
        required: ['memoryId', 'name', 'tuning'],
        properties: {
          memoryId: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          tuning: {
            type: 'object',
            required: ['rxHz', 'mode'],
            properties: {
              rxHz: { type: 'integer', minimum: 1 },
              txHz: { type: 'integer', minimum: 1 },
              mode: {
                type: 'string',
                enum: ['FM', 'AM', 'USB', 'LSB', 'CW', 'DIGITAL'],
              },
            },
          },
        },
      },
    },
  },
};

/** Card metadata for a simulator, derived from its `simulationDescriptors()` template. */
export function simulatorMetadata(
  template: RadioDescriptor,
): InstalledDriverMetadata {
  const capabilities = template.capabilities;
  const ranges = capabilities.tuning.ranges
    .map((range) => `${megahertz(range.minHz)}–${megahertz(range.maxHz)} MHz`)
    .join(', ');
  const tuning = capabilities.tuning.writable
    ? `Free tuning ${ranges}`
    : `Fixed tuning ${ranges}`;
  const memories = capabilities.memories?.read
    ? capabilities.memories.write
      ? 'channel memories (read/write)'
      : 'channel memories (read-only)'
    : 'no channel memories';
  return {
    displayName: template.displayName,
    description: `For development and training; no radio hardware. ${tuning}, ${memories}.`,
    transport: 'simulator',
    requiresEndpoint: false,
    verification: capabilities.verification,
    capabilitiesSummary: capabilitiesSummary(capabilities),
    configSchema: SIMULATOR_CONFIG_SCHEMA,
  };
}

/** Settings read by `createGrpcDriverFactory` (nothing else is forwarded to the driver). */
export const GRPC_DRIVER_CONFIG_SCHEMA: InstalledDriver['configSchema'] = {
  type: 'object',
  properties: {
    credentialRef: {
      type: 'string',
      title: 'Driver credential',
      description:
        'Name of a credential in the station driver credentials file. Required for host:port endpoints, which use authenticated TLS.',
      minLength: 1,
      maxLength: 200,
      'x-credential-ref': true,
    },
    connectTimeoutMs: {
      type: 'integer',
      title: 'Connection timeout',
      description:
        'How long to wait for the driver service. Leave empty for the station default.',
      minimum: 1,
      maximum: 30000,
      'x-step': 500,
      'x-unit': 'ms',
    },
  },
};

/** Simulation is explicitly configured; no simulated radios are silently provisioned. */
export function createSimulatorRegistry(): InstalledDriverRegistry {
  const registry = new InstalledDriverRegistry();
  for (const template of simulationDescriptors())
    registry.register(
      template.driverId,
      async (configuration) => {
        const descriptor: RadioDescriptor = {
          ...template,
          radioId: configuration.radioId,
          displayName: configuration.displayName,
          resourceGroupIds: configuration.resourceGroupIds,
        };
        const memories = configuration.config['memories'];
        if (memories !== undefined && !Array.isArray(memories))
          throw new SignalDockError(
            'INVALID_ARGUMENT',
            'Simulator memories must be an array.',
          );
        const driver = new SimulatedRadioDriver(
          descriptor,
          Date.now,
          memories?.map((memory: unknown) => RadioMemorySchema.parse(memory)),
        );
        await driver.connect();
        return driver;
      },
      simulatorMetadata(template),
    );
  return registry;
}

/** Install a specific trusted driver ID; configuration cannot execute a downloaded driver. */
export function createGrpcDriverFactory(
  options: {
    resolveCredential?: (reference: string) => Promise<string>;
    connectTimeoutMs?: number;
  } = {},
): RadioDriverFactory {
  return async (configuration, context) => {
    context?.signal.throwIfAborted();
    if (!configuration.endpoint)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'A private driver endpoint is required.',
      );
    const reference = configuration.config['credentialRef'];
    const connectTimeoutMs =
      configuration.config['connectTimeoutMs'] ?? options.connectTimeoutMs;
    if (
      connectTimeoutMs !== undefined &&
      (typeof connectTimeoutMs !== 'number' ||
        !Number.isInteger(connectTimeoutMs) ||
        connectTimeoutMs < 1 ||
        connectTimeoutMs > 30000)
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Driver connection timeout must be between 1 and 30000 ms.',
      );
    let token: string | undefined;
    if (reference !== undefined) {
      if (typeof reference !== 'string' || !options.resolveCredential)
        throw new SignalDockError(
          'REQUIRES_CONFIGURATION',
          'The driver credential reference cannot be resolved.',
        );
      token = await options.resolveCredential(reference);
    }
    // This conservative bootstrap descriptor is replaced by Describe before the driver is registered.
    const descriptor = {
      radioId: configuration.radioId,
      displayName: configuration.displayName,
      driverId: configuration.driverId,
      resourceGroupIds: configuration.resourceGroupIds,
      capabilities: RadioCapabilitiesSchema.parse({
        tuning: {
          writable: false,
          ranges: [{ minHz: 1, maxHz: 1 }],
          modes: ['FM'],
        },
        rxAudio: false,
        txAudio: false,
        ptt: 'unsupported',
        physicalTxObservation: false,
        independentlyReceivableChannels: 1,
        verification: 'experimental',
      }),
    };
    const driver = new GrpcRadioDriver({
      descriptor,
      endpoint: configuration.endpoint,
      ...(token ? { token } : {}),
      ...(typeof connectTimeoutMs === 'number' ? { connectTimeoutMs } : {}),
    });
    const abort = () => driver.close();
    context?.signal.addEventListener('abort', abort, { once: true });
    try {
      context?.signal.throwIfAborted();
      await driver.establishSession();
      context?.signal.throwIfAborted();
      return driver;
    } catch (error) {
      driver.close();
      throw error;
    } finally {
      context?.signal.removeEventListener('abort', abort);
    }
  };
}
