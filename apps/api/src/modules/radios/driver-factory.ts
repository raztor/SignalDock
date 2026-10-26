import {
  RadioCapabilitiesSchema,
  SignalDockError,
  RadioMemorySchema,
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
) => Promise<RadioDriver>;
export class InstalledDriverRegistry {
  private readonly factories = new Map<string, RadioDriverFactory>();
  register(driverId: string, factory: RadioDriverFactory): void {
    if (this.factories.has(driverId))
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'Driver factory is already installed.',
      );
    this.factories.set(driverId, factory);
  }
  create: RadioDriverFactory = async (configuration) => {
    const factory = this.factories.get(configuration.driverId);
    if (!factory)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'This radio driver is not installed.',
      );
    return factory(configuration);
  };
}

/** Simulation is explicitly configured; no simulated radios are silently provisioned. */
export function createSimulatorRegistry(): InstalledDriverRegistry {
  const registry = new InstalledDriverRegistry();
  for (const template of simulationDescriptors())
    registry.register(template.driverId, async (configuration) => {
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
    });
  return registry;
}

/** Install a specific trusted driver ID; configuration cannot execute a downloaded driver. */
export function createGrpcDriverFactory(
  options: {
    resolveCredential?: (reference: string) => Promise<string>;
    connectTimeoutMs?: number;
  } = {},
): RadioDriverFactory {
  return async (configuration) => {
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
    try {
      await driver.establishSession();
      return driver;
    } catch (error) {
      driver.close();
      throw error;
    }
  };
}
