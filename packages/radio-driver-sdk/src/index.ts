import {
  RadioDescriptorSchema,
  RadioSnapshotSchema,
  SignalDockError,
  TuningCommandSchema,
  RadioMemorySchema,
  OperationContextSchema,
  TuningSchema,
  type Tuning,
  type RadioDescriptor,
  type RadioSnapshot,
  type TuningCommand,
  type OperationContext,
  type RadioMemory,
} from '@signaldock/contracts';
export {
  GrpcRadioDriver,
  decodeSnapshot,
  mapRpcError,
  type GrpcRadioDriverOptions,
} from './grpc-radio-driver.js';

/** In-process control seam. The private wire contract is exported separately. */
export interface RadioDriver {
  readonly descriptor: RadioDescriptor;
  readonly hardwareEndpoint?: string;
  connect(): Promise<RadioSnapshot>;
  disconnect(): Promise<void>;
  getSnapshot(): RadioSnapshot;
  reconcile?(): Promise<RadioSnapshot>;
  watchSnapshots?(signal: AbortSignal): AsyncIterable<RadioSnapshot>;
  listMemories?(): Promise<RadioMemory[]>;
  readMemory?(memoryId: string): Promise<RadioMemory>;
  selectMemory?(
    context: OperationContext,
    memoryId: string,
  ): Promise<RadioSnapshot>;
  writeMemory?(
    context: OperationContext,
    memory: RadioMemory,
  ): Promise<RadioMemory>;
  applyTuning(command: TuningCommand): Promise<RadioSnapshot>;
}

export class SimulatedRadioDriver implements RadioDriver {
  readonly descriptor: RadioDescriptor;
  private state: RadioSnapshot;
  private readonly memories = new Map<string, RadioMemory>();
  constructor(
    descriptor: RadioDescriptor,
    private readonly now = Date.now,
    memories?: readonly RadioMemory[],
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
    const range = this.descriptor.capabilities.tuning.ranges[0]!;
    for (const memory of memories ?? [
      {
        memoryId: '0',
        name: 'Local calling',
        tuning: {
          rxHz: range.minHz,
          mode: this.descriptor.capabilities.tuning.modes[0]!,
        },
      },
      {
        memoryId: '1',
        name: 'Local alternate',
        tuning: {
          rxHz: Math.min(range.maxHz, range.minHz + 12500),
          mode: this.descriptor.capabilities.tuning.modes[0]!,
        },
      },
    ]) {
      const parsed = RadioMemorySchema.parse(structuredClone(memory));
      this.memories.set(parsed.memoryId, parsed);
    }
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
      selectedMemoryId: this.memories.keys().next().value,
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

  async listMemories(): Promise<RadioMemory[]> {
    if (!this.descriptor.capabilities.memories?.read)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio does not support memory reads.',
      );
    return [...this.memories.values()].map((memory) => structuredClone(memory));
  }
  async readMemory(memoryId: string): Promise<RadioMemory> {
    const memory = (await this.listMemories()).find(
      (candidate) => candidate.memoryId === memoryId,
    );
    if (!memory) throw new SignalDockError('NOT_FOUND', 'Unknown memory.');
    return memory;
  }
  async selectMemory(
    context: OperationContext,
    memoryId: string,
  ): Promise<RadioSnapshot> {
    if (!this.descriptor.capabilities.memories?.select)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio does not support memory selection.',
      );
    const memory = await this.readMemory(memoryId);
    this.validateTuning(context, memory.tuning, false);
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      selectedMemoryId: memory.memoryId,
      observedTuning: structuredClone(memory.tuning),
      desiredTuning: structuredClone(memory.tuning),
      tuningConfidence: 'confirmed',
    };
    return this.getSnapshot();
  }
  async writeMemory(
    context: OperationContext,
    memory: RadioMemory,
  ): Promise<RadioMemory> {
    if (!this.descriptor.capabilities.memories?.write)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'This radio does not support memory writes.',
      );
    const parsed = RadioMemorySchema.parse(memory);
    await this.readMemory(parsed.memoryId);
    this.validateTuning(context, parsed.tuning, false);
    this.memories.set(parsed.memoryId, structuredClone(parsed));
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      ...(this.state.selectedMemoryId === parsed.memoryId
        ? {
            observedTuning: structuredClone(parsed.tuning),
            desiredTuning: structuredClone(parsed.tuning),
          }
        : {}),
    };
    return structuredClone(parsed);
  }

  async applyTuning(input: TuningCommand): Promise<RadioSnapshot> {
    const { context, tuning } = TuningCommandSchema.parse(input);
    this.validateTuning(context, tuning);
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      desiredTuning: tuning,
      observedTuning: tuning,
      tuningConfidence: 'confirmed',
    };
    if (this.state.selectedMemoryId) {
      const memory = this.memories.get(this.state.selectedMemoryId);
      if (memory)
        this.memories.set(memory.memoryId, {
          ...memory,
          tuning: structuredClone(tuning),
        });
    }
    return this.getSnapshot();
  }
  private validateTuning(
    contextInput: OperationContext,
    tuningInput: Tuning,
    requireWritable = true,
  ): void {
    const context = OperationContextSchema.parse(contextInput);
    const tuning = TuningSchema.parse(tuningInput);
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
    if (requireWritable && !capability.writable)
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
        memories: { read: true, write: true, select: true },
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
        memories: { read: true, write: false, select: false },
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
