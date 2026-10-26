import {
  RadioDescriptorSchema,
  RadioSnapshotSchema,
  SignalDockError,
  TuningCommandSchema,
  type RadioDescriptor,
  type RadioSnapshot,
  type TuningCommand,
} from '@signaldock/contracts';

/** In-process control seam. The private wire contract is exported separately. */
export interface RadioDriver {
  readonly descriptor: RadioDescriptor;
  readonly hardwareEndpoint?: string;
  connect(): Promise<RadioSnapshot>;
  disconnect(): Promise<void>;
  getSnapshot(): RadioSnapshot;
  applyTuning(command: TuningCommand): Promise<RadioSnapshot>;
}

export class SimulatedRadioDriver implements RadioDriver {
  readonly descriptor: RadioDescriptor;
  private state: RadioSnapshot;
  constructor(
    descriptor: RadioDescriptor,
    private readonly now = Date.now,
  ) {
    this.descriptor = RadioDescriptorSchema.parse(structuredClone(descriptor));
    this.state = {
      radioId: descriptor.radioId,
      generation: crypto.randomUUID(),
      revision: 0,
      connection: 'disconnected',
      tuningConfidence: 'unknown',
      txState: 'idle',
    };
  }

  async connect(): Promise<RadioSnapshot> {
    const range = this.descriptor.capabilities.tuning.ranges[0]!;
    this.state = RadioSnapshotSchema.parse({
      radioId: this.descriptor.radioId,
      generation: crypto.randomUUID(),
      revision: 1,
      connection: 'ready',
      observedTuning: {
        rxHz: range.minHz,
        mode: this.descriptor.capabilities.tuning.modes[0],
      },
      tuningConfidence: 'confirmed',
      txState: 'idle',
    });
    return this.getSnapshot();
  }

  async disconnect(): Promise<void> {
    this.state = {
      ...this.state,
      connection: 'disconnected',
      revision: this.state.revision + 1,
    };
  }

  getSnapshot(): RadioSnapshot {
    return structuredClone(this.state);
  }

  async applyTuning(input: TuningCommand): Promise<RadioSnapshot> {
    const { context, tuning } = TuningCommandSchema.parse(input);
    if (context.radioId !== this.state.radioId)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Command targets another radio.',
      );
    if (context.generation !== this.state.generation)
      throw new SignalDockError(
        'STALE_GENERATION',
        'The driver generation changed.',
      );
    if (Date.parse(context.deadline) <= this.now())
      throw new SignalDockError('DEADLINE_EXCEEDED', 'The command expired.');
    if (context.expectedRevision !== this.state.revision)
      throw new SignalDockError(
        'STALE_REVISION',
        'The radio revision changed.',
      );
    if (this.state.connection !== 'ready')
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'The simulated radio is disconnected.',
      );
    const capability = this.descriptor.capabilities.tuning;
    if (!capability.writable)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio does not support tuning writes.',
      );
    const frequencies = [
      tuning.rxHz,
      ...(tuning.txHz === undefined ? [] : [tuning.txHz]),
    ];
    if (
      !capability.modes.includes(tuning.mode) ||
      frequencies.some(
        (hz) =>
          !capability.ranges.some(
            (range) => hz >= range.minHz && hz <= range.maxHz,
          ),
      )
    ) {
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Requested tuning is outside this radio capability.',
      );
    }
    if (
      tuning.txHz !== undefined &&
      this.descriptor.capabilities.ptt === 'unsupported'
    ) {
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio is receive-only.',
      );
    }
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      desiredTuning: tuning,
      observedTuning: tuning,
      tuningConfidence: 'confirmed',
    };
    return this.getSnapshot();
  }
}

export function simulationDescriptors(): RadioDescriptor[] {
  return [
    {
      radioId: '00000000-0000-4000-8000-000000000001',
      displayName: 'Simulated tunable radio',
      driverId: 'simulator.tunable',
      resourceGroupIds: [],
      capabilities: {
        tuning: {
          writable: true,
          ranges: [{ minHz: 144000000, maxHz: 148000000 }],
          modes: ['FM'],
        },
        rxAudio: false,
        txAudio: false,
        ptt: 'unsupported',
        physicalTxObservation: false,
        independentlyReceivableChannels: 1,
        verification: 'simulated',
      },
    },
    {
      radioId: '00000000-0000-4000-8000-000000000002',
      displayName: 'Simulated fixed receiver',
      driverId: 'simulator.receiver',
      resourceGroupIds: [],
      capabilities: {
        tuning: {
          writable: false,
          ranges: [{ minHz: 430000000, maxHz: 440000000 }],
          modes: ['FM'],
        },
        rxAudio: false,
        txAudio: false,
        ptt: 'unsupported',
        physicalTxObservation: false,
        independentlyReceivableChannels: 1,
        verification: 'simulated',
      },
    },
  ];
}
