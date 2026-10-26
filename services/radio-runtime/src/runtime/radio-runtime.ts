import {
  IdSchema,
  SignalDockError,
  TuningCommandSchema,
  OperationContextSchema,
  RadioMemorySchema,
  type RadioDescriptor,
  type RadioSnapshot,
  type TuningCommand,
  type ControlLease,
  type OperationContext,
  type RadioMemory,
} from '@signaldock/contracts';
import type { RadioDriver } from '@signaldock/radio-driver-sdk';

export type { ControlLease } from '@signaldock/contracts';
export interface ControlValidation {
  radioId: string;
  grantId: string;
  ownerId: string;
  sessionId?: string;
  generation: string;
}
export interface TransmissionReservation {
  radioId: string;
  generation: string;
  controlGrant: string;
  ownerId: string;
  sessionId: string;
  txGrantId: string;
}
export interface ControlInvalidation {
  radioId: string;
  lease: ControlLease;
  reason: string;
}

/** Local runtime admission; the API authenticates and authorizes every caller. */
export class RadioRuntime {
  private readonly drivers = new Map<string, RadioDriver>();
  private readonly leases = new Map<string, ControlLease>();
  private readonly fences = new Map<string, number>();
  private readonly transmissions = new Map<
    string,
    TransmissionReservation & { state: RadioSnapshot['txState'] }
  >();
  private readonly outcomes = new Map<
    string,
    { fingerprint: string; result: unknown }
  >();
  private readonly inFlight = new Set<string>();
  private readonly paused = new Set<string>();
  private readonly listeners = new Set<(snapshot: RadioSnapshot) => void>();
  private readonly invalidationListeners = new Set<
    (event: ControlInvalidation) => void
  >();
  constructor(private readonly now = Date.now) {}

  register(driver: RadioDriver): void {
    const id = driver.descriptor.radioId;
    if (
      this.drivers.has(id) ||
      (driver.hardwareEndpoint &&
        [...this.drivers.values()].some(
          (other) => other.hardwareEndpoint === driver.hardwareEndpoint,
        ))
    ) {
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'The radio or hardware endpoint is already registered.',
      );
    }
    this.drivers.set(id, driver);
  }

  unregister(radioId: string): void {
    this.driver(radioId);
    if (this.transmissions.has(radioId) || this.inFlight.has(radioId))
      throw new SignalDockError(
        'CONTROL_BUSY',
        'The radio still has an active or uncertain operation.',
      );
    this.invalidateControl(radioId, 'unregistered');
    this.drivers.delete(radioId);
    this.paused.delete(radioId);
  }

  list(): RadioDescriptor[] {
    return [...this.drivers.values()].map((driver) =>
      structuredClone(driver.descriptor),
    );
  }
  getDriver(radioId: string): RadioDriver {
    return this.driver(radioId);
  }
  snapshot(radioId: string): RadioSnapshot {
    const snapshot = this.driver(radioId).getSnapshot();
    const reservation = this.transmissions.get(radioId);
    return reservation ? { ...snapshot, txState: reservation.state } : snapshot;
  }
  subscribe(listener: (snapshot: RadioSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onControlInvalidated(
    listener: (event: ControlInvalidation) => void,
  ): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  acquireControl(
    radioId: string,
    ownerId: string,
    sessionId = ownerId,
  ): ControlLease {
    IdSchema.parse(ownerId);
    IdSchema.parse(sessionId);
    const driver = this.driver(radioId);
    const snapshot = driver.getSnapshot();
    if (this.paused.has(radioId))
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'The radio is in maintenance.',
      );
    if (snapshot.connection !== 'ready')
      throw new SignalDockError('RADIO_UNAVAILABLE', 'The radio is not ready.');
    this.expireLeases();
    const current = this.leases.get(radioId);
    if (
      current &&
      (current.ownerId !== ownerId || current.sessionId !== sessionId)
    )
      throw new SignalDockError(
        'CONTROL_BUSY',
        'Another session controls this radio.',
      );
    if (!current && this.isOperationBusy(driver))
      throw new SignalDockError(
        'CONTROL_BUSY',
        'A physical resource or uncertain transmission is still reserved.',
      );
    for (const lease of this.leases.values()) {
      if (
        lease.radioId !== radioId &&
        this.sharesResources(driver, this.driver(lease.radioId))
      )
        throw new SignalDockError(
          'CONTROL_BUSY',
          'A shared radio resource is in use.',
        );
    }
    const fencing = current?.fencing ?? (this.fences.get(radioId) ?? 0) + 1;
    this.fences.set(radioId, fencing);
    const lease: ControlLease = {
      grantId: current?.grantId ?? crypto.randomUUID(),
      radioId,
      ownerId,
      sessionId,
      generation: snapshot.generation,
      fencing,
      expiresAt: this.now() + 15000,
    };
    this.leases.set(radioId, lease);
    this.emit(radioId);
    return structuredClone(lease);
  }

  currentControl(radioId: string): ControlLease | null {
    this.driver(radioId);
    this.expireLeases();
    return this.leases.has(radioId)
      ? structuredClone(this.leases.get(radioId)!)
      : null;
  }
  validateControl(input: ControlValidation): ControlLease {
    const snapshot = this.driver(input.radioId).getSnapshot();
    if (this.paused.has(input.radioId))
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'The radio is in maintenance.',
      );
    if (snapshot.generation !== input.generation)
      throw new SignalDockError(
        'STALE_GENERATION',
        'The radio generation changed.',
      );
    this.expireLeases();
    const lease = this.leases.get(input.radioId);
    if (!lease || lease.grantId !== input.grantId)
      throw new SignalDockError(
        'CONTROL_REQUIRED',
        'A current control grant is required.',
      );
    if (
      lease.ownerId !== input.ownerId ||
      (input.sessionId !== undefined && lease.sessionId !== input.sessionId)
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'The control grant belongs to another session.',
      );
    if (snapshot.connection !== 'ready')
      throw new SignalDockError('RADIO_UNAVAILABLE', 'The radio is not ready.');
    return structuredClone(lease);
  }
  renewControl(input: ControlValidation): ControlLease {
    const lease = this.validateControl(input);
    lease.expiresAt = this.now() + 15000;
    this.leases.set(input.radioId, lease);
    return structuredClone(lease);
  }
  releaseControl(radioId: string, grantId: string): void {
    if (this.leases.get(radioId)?.grantId === grantId)
      this.invalidateControl(radioId, 'released');
  }
  invalidateControl(radioId: string, reason = 'revoked'): void {
    const lease = this.leases.get(radioId);
    this.leases.delete(radioId);
    if (lease)
      for (const listener of this.invalidationListeners) {
        try {
          listener({ radioId, lease: structuredClone(lease), reason });
        } catch {
          /* A consumer cannot restore a revoked grant by throwing. */
        }
      }
  }
  revokeSession(sessionId: string): void {
    for (const lease of this.leases.values())
      if (lease.sessionId === sessionId)
        this.invalidateControl(lease.radioId, 'session_revoked');
  }
  revokeUser(ownerId: string): void {
    for (const lease of this.leases.values())
      if (lease.ownerId === ownerId)
        this.invalidateControl(lease.radioId, 'user_revoked');
  }

  reserveTransmission(input: TransmissionReservation): void {
    this.validateControl({
      radioId: input.radioId,
      grantId: input.controlGrant,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      generation: input.generation,
    });
    const driver = this.driver(input.radioId);
    if (
      driver.descriptor.capabilities.ptt === 'unsupported' ||
      !driver.descriptor.capabilities.txAudio
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio cannot transmit audio.',
      );
    if (driver.getSnapshot().txState !== 'idle')
      throw new SignalDockError(
        'RADIO_STATE_UNCERTAIN',
        'The physical transmitter is not confirmed idle.',
      );
    if (this.isOperationBusy(driver))
      throw new SignalDockError(
        'CONTROL_BUSY',
        'A physical radio resource is already reserved.',
      );
    this.transmissions.set(input.radioId, { ...input, state: 'preparing' });
    this.emit(input.radioId);
  }
  setTransmissionState(
    radioId: string,
    txGrantId: string,
    state: 'preparing' | 'transmitting' | 'stopping',
  ): void {
    const reservation = this.transmissions.get(radioId);
    if (
      !reservation ||
      reservation.txGrantId !== txGrantId ||
      reservation.state === 'stop_unconfirmed'
    )
      throw new SignalDockError(
        'CONTROL_REQUIRED',
        'A current transmission reservation is required.',
      );
    reservation.state = state;
    this.emit(radioId);
  }
  releaseTransmission(
    radioId: string,
    txGrantId: string,
    confirmed: boolean,
  ): void {
    const reservation = this.transmissions.get(radioId);
    if (!reservation || reservation.txGrantId !== txGrantId) return;
    if (confirmed) this.transmissions.delete(radioId);
    else {
      reservation.state = 'stop_unconfirmed';
      this.invalidateControl(radioId, 'stop_unconfirmed');
    }
    this.emit(radioId);
  }

  async connect(radioId: string): Promise<RadioSnapshot> {
    this.invalidateControl(radioId, 'reconnecting');
    const snapshot = await this.driver(radioId).connect();
    this.observeSnapshot(snapshot);
    return this.snapshot(radioId);
  }
  async disconnect(radioId: string): Promise<void> {
    this.invalidateControl(radioId, 'disconnecting');
    const reservation = this.transmissions.get(radioId);
    if (reservation) reservation.state = 'stop_unconfirmed';
    try {
      await this.driver(radioId).disconnect();
    } finally {
      this.emit(radioId);
    }
  }
  observeSnapshot(snapshot: RadioSnapshot): void {
    const lease = this.leases.get(snapshot.radioId);
    if (
      lease &&
      (lease.generation !== snapshot.generation ||
        snapshot.connection !== 'ready')
    )
      this.invalidateControl(snapshot.radioId, 'driver_state_changed');
    const reservation = this.transmissions.get(snapshot.radioId);
    if (
      reservation &&
      (reservation.generation !== snapshot.generation ||
        snapshot.connection !== 'ready')
    )
      reservation.state = 'stop_unconfirmed';
    this.emit(snapshot.radioId);
  }
  async reconcile(radioId: string): Promise<RadioSnapshot> {
    const driver = this.driver(radioId);
    const snapshot = driver.reconcile
      ? await driver.reconcile()
      : driver.getSnapshot();
    this.observeSnapshot(snapshot);
    return this.snapshot(radioId);
  }

  async applyTuning(input: TuningCommand): Promise<RadioSnapshot> {
    const command = TuningCommandSchema.parse(input);
    return this.executeMutation(
      command.context,
      { kind: 'tune', tuning: command.tuning },
      (context) =>
        this.driver(context.radioId).applyTuning({
          context,
          tuning: command.tuning,
        }),
    );
  }
  async listMemories(radioId: string): Promise<RadioMemory[]> {
    const driver = this.driver(radioId);
    if (!driver.listMemories || !driver.descriptor.capabilities.memories?.read)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio does not support memory reads.',
      );
    return driver.listMemories();
  }
  async selectMemory(
    context: OperationContext,
    memoryId: string,
  ): Promise<RadioSnapshot> {
    const driver = this.driver(context.radioId);
    if (
      !driver.selectMemory ||
      !driver.descriptor.capabilities.memories?.select
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio does not support memory selection.',
      );
    return this.executeMutation(
      context,
      { kind: 'select_memory', memoryId },
      (validated) => driver.selectMemory!(validated, memoryId),
    );
  }
  async writeMemory(
    context: OperationContext,
    input: RadioMemory,
  ): Promise<RadioMemory> {
    const memory = RadioMemorySchema.parse(input);
    const driver = this.driver(context.radioId);
    if (!driver.writeMemory || !driver.descriptor.capabilities.memories?.write)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio does not support memory writes.',
      );
    return this.executeMutation(
      context,
      { kind: 'write_memory', memory },
      (validated) => driver.writeMemory!(validated, memory),
    );
  }
  pause(radioId: string): void {
    const driver = this.driver(radioId);
    if (
      this.isOperationBusy(driver) ||
      driver.getSnapshot().txState === 'transmitting'
    )
      throw new SignalDockError(
        'CONTROL_BUSY',
        'An active operation prevents radio maintenance.',
      );
    this.paused.add(radioId);
    this.invalidateControl(radioId, 'maintenance');
  }
  resume(radioId: string): void {
    this.paused.delete(radioId);
  }

  private async executeMutation<T>(
    input: OperationContext,
    payload: unknown,
    apply: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    const context = OperationContextSchema.parse(input);
    const driver = this.driver(context.radioId);
    const lease = this.leases.get(context.radioId);
    const validated = this.validateControl({
      radioId: context.radioId,
      grantId: context.controlGrant,
      generation: context.generation,
      ownerId: context.ownerId ?? lease?.ownerId ?? '',
      ...(context.sessionId !== undefined
        ? { sessionId: context.sessionId }
        : lease
          ? { sessionId: lease.sessionId }
          : {}),
    });
    if (context.fencing !== undefined && context.fencing !== validated.fencing)
      throw new SignalDockError(
        'CONTROL_REQUIRED',
        'The control fencing value changed.',
      );
    if (Date.parse(context.deadline) <= this.now())
      throw new SignalDockError('DEADLINE_EXCEEDED', 'The command expired.');
    const key = `${context.radioId}:${context.operationId}`;
    const fingerprint = JSON.stringify({ context, payload });
    const previous = this.outcomes.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'The operation ID was reused with different content.',
        );
      return structuredClone(previous.result) as T;
    }
    if (context.expectedRevision !== driver.getSnapshot().revision)
      throw new SignalDockError(
        'STALE_REVISION',
        'The radio revision changed.',
      );
    if (this.isOperationBusy(driver))
      throw new SignalDockError(
        'CONTROL_BUSY',
        'A radio operation or transmission is already in progress.',
      );
    if (driver.getSnapshot().txState !== 'idle')
      throw new SignalDockError(
        'RADIO_STATE_UNCERTAIN',
        'The physical transmitter is not confirmed idle.',
      );
    this.inFlight.add(context.radioId);
    try {
      const result = await apply({
        ...context,
        ownerId: validated.ownerId,
        sessionId: validated.sessionId,
        fencing: validated.fencing,
      });
      if (driver.getSnapshot().generation !== context.generation) {
        this.invalidateControl(context.radioId, 'driver_generation_changed');
        throw new SignalDockError(
          'STALE_GENERATION',
          'The driver restarted during the operation.',
        );
      }
      this.outcomes.set(key, { fingerprint, result: structuredClone(result) });
      if (this.outcomes.size > 256)
        this.outcomes.delete(this.outcomes.keys().next().value!);
      this.emit(context.radioId);
      return result;
    } catch (error) {
      if (driver.getSnapshot().connection !== 'ready')
        this.invalidateControl(context.radioId, 'driver_unavailable');
      throw error;
    } finally {
      this.inFlight.delete(context.radioId);
    }
  }

  private driver(id: string): RadioDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new SignalDockError('NOT_FOUND', 'Unknown radio.');
    return driver;
  }
  private sharesResources(a: RadioDriver, b: RadioDriver): boolean {
    return a.descriptor.resourceGroupIds.some((group) =>
      b.descriptor.resourceGroupIds.includes(group),
    );
  }
  private isOperationBusy(driver: RadioDriver): boolean {
    return [...this.inFlight, ...this.transmissions.keys()].some(
      (id) =>
        id === driver.descriptor.radioId ||
        this.sharesResources(driver, this.driver(id)),
    );
  }
  private emit(radioId: string): void {
    const snapshot = this.snapshot(radioId);
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        /* Consumers cannot veto runtime transitions. */
      }
    }
  }
  private expireLeases(): void {
    for (const [id, lease] of this.leases) {
      if (
        lease.expiresAt <= this.now() ||
        lease.generation !== this.driver(id).getSnapshot().generation
      )
        this.invalidateControl(id, 'expired');
    }
  }
}
