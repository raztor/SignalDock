import {
  IdSchema,
  SignalDockError,
  TuningCommandSchema,
  type RadioDescriptor,
  type RadioSnapshot,
  type TuningCommand,
} from '@signaldock/contracts';
import type { RadioDriver } from '@signaldock/radio-driver-sdk';

export interface ControlLease {
  grantId: string;
  radioId: string;
  ownerId: string;
  generation: string;
  expiresAt: number;
}

/** Domain-only foundation; callers must authorize users before issuing grants. */
export class RadioRuntime {
  private readonly drivers = new Map<string, RadioDriver>();
  private readonly leases = new Map<string, ControlLease>();
  private readonly outcomes = new Map<
    string,
    { fingerprint: string; snapshot: RadioSnapshot }
  >();
  private readonly inFlight = new Set<string>();
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

  list(): RadioDescriptor[] {
    return [...this.drivers.values()].map((driver) =>
      structuredClone(driver.descriptor),
    );
  }
  snapshot(radioId: string): RadioSnapshot {
    return this.driver(radioId).getSnapshot();
  }

  acquireControl(radioId: string, ownerId: string): ControlLease {
    IdSchema.parse(ownerId);
    const driver = this.driver(radioId);
    const snapshot = driver.getSnapshot();
    if (snapshot.connection !== 'ready')
      throw new SignalDockError('RADIO_UNAVAILABLE', 'The radio is not ready.');
    this.expireLeases();
    const current = this.leases.get(radioId);
    if (current && current.ownerId !== ownerId)
      throw new SignalDockError(
        'CONTROL_BUSY',
        'Another operator controls this radio.',
      );
    for (const lease of this.leases.values()) {
      if (
        lease.radioId !== radioId &&
        this.sharesResources(driver, this.driver(lease.radioId))
      ) {
        throw new SignalDockError(
          'CONTROL_BUSY',
          'A shared radio resource is in use.',
        );
      }
    }
    const lease: ControlLease = {
      grantId: current?.grantId ?? crypto.randomUUID(),
      radioId,
      ownerId,
      generation: snapshot.generation,
      expiresAt: this.now() + 15000,
    };
    this.leases.set(radioId, lease);
    return structuredClone(lease);
  }

  releaseControl(radioId: string, grantId: string): void {
    if (this.leases.get(radioId)?.grantId === grantId)
      this.leases.delete(radioId);
  }

  async applyTuning(input: TuningCommand): Promise<RadioSnapshot> {
    const command = TuningCommandSchema.parse(input);
    const { context } = command;
    const driver = this.driver(context.radioId);
    if (context.generation !== driver.getSnapshot().generation)
      throw new SignalDockError(
        'STALE_GENERATION',
        'The radio generation changed.',
      );
    this.expireLeases();
    const lease = this.leases.get(context.radioId);
    if (!lease || lease.grantId !== context.controlGrant)
      throw new SignalDockError(
        'CONTROL_REQUIRED',
        'A current control grant is required.',
      );
    if (
      context.generation !== driver.getSnapshot().generation ||
      context.generation !== lease.generation
    ) {
      throw new SignalDockError(
        'STALE_GENERATION',
        'The radio generation changed.',
      );
    }
    if (Date.parse(context.deadline) <= this.now())
      throw new SignalDockError('DEADLINE_EXCEEDED', 'The command expired.');
    const key = `${context.radioId}:${context.operationId}`;
    const fingerprint = JSON.stringify(command);
    const previous = this.outcomes.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'The operation ID was reused with different content.',
        );
      return structuredClone(previous.snapshot);
    }
    if (
      [...this.inFlight].some(
        (radioId) =>
          radioId === context.radioId ||
          this.sharesResources(driver, this.driver(radioId)),
      )
    ) {
      throw new SignalDockError(
        'CONTROL_BUSY',
        'A radio operation is already in progress.',
      );
    }
    this.inFlight.add(context.radioId);
    try {
      const snapshot = await driver.applyTuning(command);
      this.outcomes.set(key, {
        fingerprint,
        snapshot: structuredClone(snapshot),
      });
      if (this.outcomes.size > 256)
        this.outcomes.delete(this.outcomes.keys().next().value!);
      return snapshot;
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

  private expireLeases(): void {
    for (const [id, lease] of this.leases) {
      if (
        lease.expiresAt <= this.now() ||
        lease.generation !== this.driver(id).getSnapshot().generation
      )
        this.leases.delete(id);
    }
  }
}
