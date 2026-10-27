import {
  RadioConfigurationSchema,
  RadioViewSchema,
  SignalDockError,
  TuningCommandSchema,
  type AuthenticationPort,
  type DatabasePort,
  type ErrorCode,
  type EventPublisherPort,
  type OperationContext,
  type Principal,
  type RadioConfiguration,
  type RadioMemory,
  type RadioSnapshot,
  type RadioView,
  type TuningCommand,
} from '@signaldock/contracts';
import { DriverSupervisor, RadioRuntime } from '@signaldock/radio-runtime';
import { RadioRepository } from './radio.repository.js';
import { RadioAttachmentSupervisor } from './attachment-supervisor.js';
import {
  createSimulatorRegistry,
  type RadioDriverFactory,
} from './driver-factory.js';

export class RadioApplicationService {
  readonly runtime: RadioRuntime;
  private readonly repository: RadioRepository;
  private readonly supervisor: DriverSupervisor;
  private readonly configurations = new Map<string, RadioConfiguration>();
  private readonly failures = new Map<string, ErrorCode>();
  private readonly changing = new Set<string>();
  private readonly configurationChanges = new Map<string, Promise<void>>();
  private readonly attachments: RadioAttachmentSupervisor;
  private closed = false;
  private readonly unlisten: () => void;
  constructor(
    private readonly options: {
      instanceId: string;
      database: DatabasePort;
      auth: AuthenticationPort;
      runtime?: RadioRuntime;
      driverFactory?: RadioDriverFactory;
      events?: EventPublisherPort;
      attachmentRetryMs?: number;
      attachmentTimeoutMs?: number;
      attachmentConcurrency?: number;
    },
  ) {
    this.runtime = options.runtime ?? new RadioRuntime();
    this.repository = new RadioRepository(options.database, options.instanceId);
    this.supervisor = new DriverSupervisor(this.runtime);
    this.attachments = new RadioAttachmentSupervisor({
      factory: options.driverFactory ?? createSimulatorRegistry().create,
      current: (configuration) =>
        !this.closed &&
        !this.changing.has(configuration.radioId) &&
        this.configurations.get(configuration.radioId) === configuration &&
        configuration.enabled,
      register: (driver) => {
        this.runtime.register(driver);
        this.failures.delete(driver.descriptor.radioId);
        this.supervisor.start(driver.descriptor.radioId);
      },
      failure: (radioId, error) =>
        this.failures.set(
          radioId,
          error instanceof SignalDockError ? error.code : 'RADIO_UNAVAILABLE',
        ),
      ...(options.attachmentRetryMs === undefined
        ? {}
        : { retryMs: options.attachmentRetryMs }),
      ...(options.attachmentTimeoutMs === undefined
        ? {}
        : { attemptTimeoutMs: options.attachmentTimeoutMs }),
      ...(options.attachmentConcurrency === undefined
        ? {}
        : { concurrency: options.attachmentConcurrency }),
    });
    let sequence = 0;
    this.unlisten = this.runtime.subscribe((snapshot) => {
      if (options.events)
        void options.events
          .publish({
            protocolVersion: 1,
            eventId: crypto.randomUUID(),
            instanceId: options.instanceId,
            radioId: snapshot.radioId,
            streamGeneration: snapshot.generation,
            sequence: ++sequence,
            occurredAt: new Date().toISOString(),
            type: 'radio.snapshot',
            payloadVersion: 1,
            payload: snapshot,
          })
          .catch(() => undefined);
    });
  }
  async start(): Promise<void> {
    for (const configuration of await this.repository.list()) {
      this.configurations.set(configuration.radioId, configuration);
      if (configuration.enabled && !this.closed)
        this.attachments.start(configuration);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.unlisten();
    await this.attachments.close();
    await Promise.allSettled([...this.configurationChanges.values()]);
    await this.supervisor.close();
    await Promise.all(
      this.runtime.list().map(async (driver) => {
        try {
          await this.runtime.disconnect(driver.radioId);
        } catch {
          /* Shutdown retains uncertainty in the local runtime. */
        }
        const transport = this.runtime.getDriver(driver.radioId);
        if ('close' in transport && typeof transport.close === 'function')
          transport.close();
      }),
    );
  }
  async list(principal: Principal): Promise<RadioView[]> {
    this.assertInstance(principal);
    const result: RadioView[] = [];
    for (const config of this.configurations.values()) {
      try {
        await this.options.auth.authorize(
          principal,
          'radio.listen',
          config.radioId,
        );
      } catch (error) {
        if (error instanceof SignalDockError && error.code === 'FORBIDDEN')
          continue;
        throw error;
      }
      result.push(this.view(config));
    }
    return result;
  }
  async get(principal: Principal, radioId: string): Promise<RadioView> {
    await this.authorize(principal, 'radio.listen', radioId);
    return this.view(this.configuration(radioId));
  }
  async listConfigurations(
    principal: Principal,
  ): Promise<RadioConfiguration[]> {
    await this.authorize(principal, 'instance.admin');
    if (this.closed)
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'Radio service is shutting down.',
      );
    return [...this.configurations.values()].map((configuration) =>
      structuredClone(configuration),
    );
  }
  async configure(
    principal: Principal,
    input: RadioConfiguration,
  ): Promise<RadioConfiguration> {
    await this.authorize(principal, 'instance.admin');
    if (this.closed)
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'Radio service is shutting down.',
      );
    const configuration = RadioConfigurationSchema.parse(input);
    rejectInlineSecrets(configuration.config);
    if (this.changing.has(configuration.radioId))
      throw new SignalDockError(
        'CONTROL_BUSY',
        'Radio configuration is already changing.',
      );
    const registered = this.runtime
      .list()
      .some((radio) => radio.radioId === configuration.radioId);
    if (registered) this.runtime.pause(configuration.radioId);
    this.changing.add(configuration.radioId);
    let complete!: () => void;
    this.configurationChanges.set(
      configuration.radioId,
      new Promise<void>((resolveValue) => {
        complete = resolveValue;
      }),
    );
    try {
      await this.attachments.stop(configuration.radioId);
      await this.repository.save(configuration);
      this.configurations.set(configuration.radioId, configuration);
      if (registered) {
        await this.supervisor.stop(configuration.radioId);
        const driver = this.runtime.getDriver(configuration.radioId);
        try {
          await this.runtime.disconnect(configuration.radioId);
        } catch {
          /* No TX or operation can be active after pause; discard the closed connection. */
        } finally {
          if ('close' in driver && typeof driver.close === 'function')
            driver.close();
          this.runtime.unregister(configuration.radioId);
          this.attachments.release(configuration.radioId);
        }
      }
      this.failures.delete(configuration.radioId);
      return structuredClone(configuration);
    } finally {
      this.changing.delete(configuration.radioId);
      this.runtime.resume(configuration.radioId);
      const current = this.configurations.get(configuration.radioId);
      if (
        current?.enabled &&
        !this.closed &&
        !this.runtime.list().some((radio) => radio.radioId === current.radioId)
      )
        this.attachments.start(current);
      this.configurationChanges.delete(configuration.radioId);
      complete();
    }
  }
  async connection(
    principal: Principal,
    radioId: string,
    action: 'connect' | 'disconnect',
  ): Promise<RadioConfiguration> {
    await this.authorize(principal, 'instance.admin');
    return this.configure(principal, {
      ...this.configuration(radioId),
      enabled: action === 'connect',
    });
  }
  async acquireControl(principal: Principal, radioId: string) {
    await this.authorize(principal, 'radio.control', radioId);
    this.available(radioId);
    return this.runtime.acquireControl(
      radioId,
      principal.userId,
      principal.sessionId,
    );
  }
  async renewControl(
    principal: Principal,
    radioId: string,
    grantId: string,
    generation: string,
  ) {
    await this.authorize(principal, 'radio.control', radioId);
    this.available(radioId);
    return this.runtime.renewControl({
      radioId,
      grantId,
      generation,
      ownerId: principal.userId,
      sessionId: principal.sessionId,
    });
  }
  async releaseControl(
    principal: Principal,
    radioId: string,
    grantId: string,
    generation: string,
  ): Promise<void> {
    await this.authorize(principal, 'radio.control', radioId);
    this.runtime.validateControl({
      radioId,
      grantId,
      generation,
      ownerId: principal.userId,
      sessionId: principal.sessionId,
    });
    this.runtime.releaseControl(radioId, grantId);
  }
  async tune(
    principal: Principal,
    radioId: string,
    input: TuningCommand,
  ): Promise<RadioSnapshot> {
    await this.authorize(principal, 'radio.control', radioId);
    this.available(radioId);
    const command = TuningCommandSchema.parse(input);
    return this.runtime.applyTuning({
      ...command,
      context: this.context(principal, radioId, command.context),
    });
  }
  async memories(
    principal: Principal,
    radioId: string,
  ): Promise<RadioMemory[]> {
    await this.authorize(principal, 'radio.listen', radioId);
    this.available(radioId);
    return this.runtime.listMemories(radioId);
  }
  async selectMemory(
    principal: Principal,
    radioId: string,
    memoryId: string,
    context: OperationContext,
  ): Promise<RadioSnapshot> {
    await this.authorize(principal, 'radio.control', radioId);
    this.available(radioId);
    return this.runtime.selectMemory(
      this.context(principal, radioId, context),
      memoryId,
    );
  }
  async writeMemory(
    principal: Principal,
    radioId: string,
    memoryId: string,
    context: OperationContext,
    memory: RadioMemory,
  ): Promise<RadioMemory> {
    await this.authorize(principal, 'radio.control', radioId);
    this.available(radioId);
    if (memory.memoryId !== memoryId)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Memory body and route do not match.',
      );
    return this.runtime.writeMemory(
      this.context(principal, radioId, context),
      memory,
    );
  }
  private context(
    principal: Principal,
    radioId: string,
    context: OperationContext,
  ): OperationContext {
    if (
      context.radioId !== radioId ||
      (context.ownerId !== undefined && context.ownerId !== principal.userId) ||
      (context.sessionId !== undefined &&
        context.sessionId !== principal.sessionId)
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'The operation context belongs to another radio or session.',
      );
    const lease = this.runtime.validateControl({
      radioId,
      grantId: context.controlGrant,
      generation: context.generation,
      ownerId: principal.userId,
      sessionId: principal.sessionId,
    });
    if (context.fencing !== undefined && context.fencing !== lease.fencing)
      throw new SignalDockError(
        'CONTROL_REQUIRED',
        'The fencing value changed.',
      );
    return {
      ...context,
      ownerId: principal.userId,
      sessionId: principal.sessionId,
      fencing: lease.fencing,
    };
  }
  private async authorize(
    principal: Principal,
    permission: Parameters<AuthenticationPort['authorize']>[1],
    radioId?: string,
  ): Promise<void> {
    this.assertInstance(principal);
    await this.options.auth.authorize(principal, permission, radioId);
  }
  private assertInstance(principal: Principal): void {
    if (principal.instanceId !== this.options.instanceId)
      throw new SignalDockError(
        'FORBIDDEN',
        'This session belongs to another instance.',
      );
  }
  private configuration(radioId: string): RadioConfiguration {
    const configuration = this.configurations.get(radioId);
    if (!configuration)
      throw new SignalDockError('NOT_FOUND', 'Unknown radio.');
    return configuration;
  }
  private available(radioId: string): void {
    if (this.closed)
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'Radio service is shutting down.',
      );
    const configuration = this.configuration(radioId);
    if (
      !configuration.enabled ||
      this.changing.has(radioId) ||
      !this.runtime.list().some((driver) => driver.radioId === radioId)
    )
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'This radio is not connected.',
      );
  }
  private view(config: RadioConfiguration): RadioView {
    const descriptor =
      this.runtime.list().find((radio) => radio.radioId === config.radioId) ??
      null;
    const failure =
      this.failures.get(config.radioId) ??
      this.supervisor.failure(config.radioId);
    const snapshot = descriptor ? this.runtime.snapshot(config.radioId) : null;
    return RadioViewSchema.parse({
      radioId: config.radioId,
      displayName: config.displayName,
      driverId: config.driverId,
      resourceGroupIds: config.resourceGroupIds,
      enabled: config.enabled,
      descriptor,
      snapshot,
      control: descriptor ? this.runtime.currentControl(config.radioId) : null,
      health: {
        state: failure
          ? 'failed'
          : snapshot?.connection === 'ready'
            ? 'connected'
            : 'configured',
        ...(failure ? { errorCode: failure } : {}),
      },
    });
  }
}
function rejectInlineSecrets(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(token|password|secret|privateKey|apiKey|authorization)$/i.test(key))
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Use a credential reference instead of an inline driver secret.',
      );
    rejectInlineSecrets(child);
  }
}
