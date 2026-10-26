import {
  Client,
  Metadata,
  credentials,
  status,
  type ChannelCredentials,
  type ClientWritableStream,
  type ServiceError,
} from '@grpc/grpc-js';
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type DescMethodUnary,
  type DescMethodServerStreaming,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import { once } from 'node:events';
import { isAbsolute, resolve } from 'node:path';
import {
  DRIVER_PROTOCOL_VERSION,
  ErrorCodeSchema,
  RadioCapabilitiesSchema,
  RadioDescriptorSchema,
  RadioSnapshotSchema,
  RadioMemorySchema,
  SignalDockError,
  TuningCommandSchema,
  type RadioDescriptor,
  type RadioSnapshot,
  type TuningCommand,
  type OperationContext,
  type RadioMemory,
} from '@signaldock/contracts';
import type { RadioDriver } from './index.js';
import * as wire from './generated/signaldock/driver/v1/driver_pb.js';

export interface GrpcRadioDriverOptions {
  descriptor: RadioDescriptor;
  endpoint: string;
  token?: string;
  tls?: { ca?: Uint8Array; privateKey?: Uint8Array; certificate?: Uint8Array };
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

/** Private gRPC transport. It never retries writes or replays audio. */
export class GrpcRadioDriver implements RadioDriver {
  readonly hardwareEndpoint: string;
  private readonly client: Client;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private description: RadioDescriptor;
  private state: RadioSnapshot;
  private readonly streams = new Set<{ cancel(): void }>();
  private readonly retiredGenerations = new Set<string>();

  constructor(private readonly options: GrpcRadioDriverOptions) {
    this.description = RadioDescriptorSchema.parse(
      structuredClone(options.descriptor),
    );
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 25000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30000
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Driver timeout must be between 1 and 30000 ms.',
      );
    if (
      !Number.isInteger(this.connectTimeoutMs) ||
      this.connectTimeoutMs < 1 ||
      this.connectTimeoutMs > 30000
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Driver connection timeout must be between 1 and 30000 ms.',
      );
    const transport = connectionOptions(options);
    this.hardwareEndpoint = transport.endpoint;
    this.client = new Client(transport.endpoint, transport.credentials, {
      'grpc.max_receive_message_length': 1048576,
      'grpc.max_send_message_length': 1048576,
      'grpc.enable_retries': 0,
    });
    this.state = {
      radioId: this.description.radioId,
      generation: crypto.randomUUID(),
      revision: 0,
      connection: 'disconnected',
      tuningConfidence: 'unknown',
      txState: 'unknown',
    };
  }

  get descriptor(): RadioDescriptor {
    return structuredClone(this.description);
  }

  /** Establish a new controller session after backend startup, never replaying TX. */
  async establishSession(): Promise<RadioSnapshot> {
    try {
      // Drivers must reject Disconnect while physical idle cannot be confirmed.
      // A new Connect may reset its controller fence only after that boundary.
      await this.disconnect(this.connectTimeoutMs);
      await this.connect();
      const snapshot = await this.reconcile(this.connectTimeoutMs);
      if (snapshot.connection !== 'ready' || snapshot.txState !== 'idle') {
        throw new SignalDockError(
          'RADIO_STATE_UNCERTAIN',
          'A new driver session requires confirmed physical idle.',
        );
      }
      return snapshot;
    } catch (error) {
      this.markUnavailable();
      throw error;
    }
  }

  async connect(): Promise<RadioSnapshot> {
    try {
      const description = await this.unary(
        wire.RadioDriverService.method.describe,
        {},
        { deadline: Date.now() + this.connectTimeoutMs },
      );
      if (
        description.driverId !== this.description.driverId ||
        description.protocolMin > DRIVER_PROTOCOL_VERSION ||
        description.protocolMax < DRIVER_PROTOCOL_VERSION
      ) {
        throw new SignalDockError(
          'API_INCOMPATIBLE',
          'The driver identity or protocol does not match this radio configuration.',
        );
      }
      const capability = description.capabilities;
      if (!capability)
        throw new SignalDockError(
          'API_INCOMPATIBLE',
          'The driver omitted its capabilities.',
        );
      this.description = {
        ...this.description,
        capabilities: RadioCapabilitiesSchema.parse({
          tuning: {
            writable: capability.tuningWritable,
            ranges: capability.tuningRanges.map((range) => ({
              minHz: safeInteger(range.minHz),
              maxHz: safeInteger(range.maxHz),
            })),
            modes: capability.modes,
          },
          rxAudio: capability.rxAudio,
          txAudio: capability.txAudio,
          ptt: capability.pttMechanism,
          physicalTxObservation: capability.physicalTxObservation,
          memories: {
            read: capability.memoryRead,
            write: capability.memoryWrite,
            select: capability.memorySelect,
          },
          independentlyReceivableChannels:
            capability.independentlyReceivableChannels,
          verification: capability.verification,
        }),
      };
      return this.acceptSnapshot(
        await this.unary(
          wire.RadioDriverService.method.connect,
          {
            radioId: this.description.radioId,
          },
          { deadline: Date.now() + this.connectTimeoutMs },
        ),
      );
    } catch (error) {
      this.markUnavailable();
      throw error;
    }
  }

  getSnapshot(): RadioSnapshot {
    return structuredClone(this.state);
  }

  async reconcile(timeoutMs = this.timeoutMs): Promise<RadioSnapshot> {
    validateTimeout(timeoutMs);
    try {
      return this.acceptSnapshot(
        await this.unary(
          wire.RadioDriverService.method.reconcile,
          {
            radioId: this.description.radioId,
          },
          { deadline: Date.now() + timeoutMs },
        ),
      );
    } catch (error) {
      this.markUnavailable();
      throw error;
    }
  }

  async disconnect(timeoutMs = this.timeoutMs): Promise<void> {
    validateTimeout(timeoutMs);
    for (const stream of this.streams) stream.cancel();
    this.streams.clear();
    try {
      await this.unary(
        wire.RadioDriverService.method.disconnect,
        {
          radioId: this.description.radioId,
        },
        { deadline: Date.now() + timeoutMs },
      );
    } finally {
      this.state = {
        ...this.state,
        connection: 'disconnected',
        tuningConfidence: 'unknown',
        txState: this.state.txState === 'idle' ? 'idle' : 'unknown',
      };
    }
  }

  close(): void {
    for (const stream of this.streams) stream.cancel();
    this.streams.clear();
    this.client.close();
    this.markUnavailable();
  }

  async applyTuning(input: TuningCommand): Promise<RadioSnapshot> {
    const command = TuningCommandSchema.parse(input);
    if (command.context.radioId !== this.description.radioId)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Command targets another radio.',
      );
    const context = command.context;
    const tuning = command.tuning;
    try {
      return this.acceptSnapshot(
        await this.unary(
          wire.RadioDriverService.method.applyTuning,
          {
            context: operationToWire(context),
            tuning: {
              rxHz: BigInt(tuning.rxHz),
              mode: tuning.mode,
              ...(tuning.txHz === undefined
                ? {}
                : { txHz: BigInt(tuning.txHz) }),
            },
          },
          {
            deadline: Math.min(
              Date.now() + this.timeoutMs,
              Date.parse(context.deadline),
            ),
          },
        ),
      );
    } catch (error) {
      if (
        !(error instanceof SignalDockError) ||
        [
          'RADIO_UNAVAILABLE',
          'DEADLINE_EXCEEDED',
          'RADIO_STATE_UNCERTAIN',
        ].includes(error.code)
      )
        this.markUnavailable();
      throw error;
    }
  }

  async *watchEvents(
    options: { afterSequence?: bigint; signal?: AbortSignal } = {},
  ): AsyncGenerator<wire.RadioEvent> {
    let sequence = options.afterSequence ?? 0n;
    let generation = this.state.generation;
    for await (const event of this.serverStream(
      wire.RadioDriverService.method.watchEvents,
      {
        radioId: this.description.radioId,
        generation,
        afterSequence: sequence,
      },
      options.signal,
    )) {
      if (
        event.radioId !== this.description.radioId ||
        event.protocolVersion !== DRIVER_PROTOCOL_VERSION
      )
        throw new SignalDockError(
          'API_INCOMPATIBLE',
          'Driver event routing or protocol is invalid.',
        );
      if (event.generation !== generation) {
        generation = event.generation;
        sequence = 0n;
      }
      if (event.sequence <= sequence) continue;
      sequence = event.sequence;
      if (event.payload.case === 'snapshot')
        this.acceptSnapshot(event.payload.value);
      yield event;
    }
  }

  async *watchSnapshots(signal: AbortSignal): AsyncGenerator<RadioSnapshot> {
    for await (const event of this.watchEvents({ signal }))
      if (event.payload.case === 'snapshot') yield this.getSnapshot();
  }

  openRxStream(options: {
    streamId: string;
    generation: string;
    signal?: AbortSignal;
  }): AsyncGenerator<wire.AudioFrame> {
    return this.serverStream(
      wire.RadioDriverService.method.openRxStream,
      {
        radioId: this.description.radioId,
        generation: options.generation,
        streamId: options.streamId,
      },
      options.signal,
    );
  }

  async listMemories(): Promise<RadioMemory[]> {
    if (!this.descriptor.capabilities.memories?.read)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Driver does not support memory reads.',
      );
    const result = await this.unary(
      wire.RadioDriverService.method.listMemories,
      { radioId: this.description.radioId },
    );
    return result.memories.map(memoryFromWire);
  }
  async readMemory(memoryId: string): Promise<RadioMemory> {
    if (!this.descriptor.capabilities.memories?.read)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Driver does not support memory reads.',
      );
    return memoryFromWire(
      await this.unary(wire.RadioDriverService.method.readMemory, {
        radioId: this.description.radioId,
        memoryId,
      }),
    );
  }
  async selectMemory(
    context: OperationContext,
    memoryId: string,
  ): Promise<RadioSnapshot> {
    if (!this.descriptor.capabilities.memories?.select)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Driver does not support memory selection.',
      );
    try {
      return this.acceptSnapshot(
        await this.unary(
          wire.RadioDriverService.method.selectMemory,
          { context: operationToWire(context), memoryId },
          {
            deadline: Math.min(
              Date.now() + this.timeoutMs,
              Date.parse(context.deadline),
            ),
          },
        ),
      );
    } catch (error) {
      this.failWrite(error);
    }
  }
  async writeMemory(
    context: OperationContext,
    memory: RadioMemory,
  ): Promise<RadioMemory> {
    if (!this.descriptor.capabilities.memories?.write)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Driver does not support memory writes.',
      );
    try {
      const result = memoryFromWire(
        await this.unary(
          wire.RadioDriverService.method.writeMemory,
          {
            context: operationToWire(context),
            memory: {
              memoryId: memory.memoryId,
              name: memory.name,
              tuning: {
                rxHz: BigInt(memory.tuning.rxHz),
                mode: memory.tuning.mode,
                ...(memory.tuning.txHz === undefined
                  ? {}
                  : { txHz: BigInt(memory.tuning.txHz) }),
              },
            },
          },
          {
            deadline: Math.min(
              Date.now() + this.timeoutMs,
              Date.parse(context.deadline),
            ),
          },
        ),
      );
      await this.reconcile();
      return result;
    } catch (error) {
      this.failWrite(error);
    }
  }

  prepareTransmission(
    input: MessageInitShape<typeof wire.PrepareTransmissionRequestSchema>,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState> {
    return this.unary(
      wire.RadioDriverService.method.prepareTransmission,
      input,
      { ...(signal ? { signal } : {}) },
    );
  }
  endTransmission(
    input: MessageInitShape<typeof wire.EndTransmissionRequestSchema>,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState> {
    return this.unary(wire.RadioDriverService.method.endTransmission, input, {
      ...(signal ? { signal } : {}),
    });
  }
  observeTransmission(
    input: MessageInitShape<typeof wire.ObserveTransmissionRequestSchema>,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState> {
    return this.unary(
      wire.RadioDriverService.method.observeTransmission,
      input,
      { ...(signal ? { signal } : {}) },
    );
  }
  renewTransmission(
    input: MessageInitShape<typeof wire.RenewTransmissionRequestSchema>,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState> {
    return this.unary(wire.RadioDriverService.method.renewTransmission, input, {
      ...(signal ? { signal } : {}),
    });
  }

  async pushTxAudio(
    frames: AsyncIterable<wire.TxAudioRequest>,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState> {
    signal?.throwIfAborted();
    const method = wire.RadioDriverService.method.pushTxAudio;
    let call: ClientWritableStream<wire.TxAudioRequest>;
    const completion = new Promise<wire.TransmissionState>(
      (resolveResult, reject) => {
        call = this.client.makeClientStreamRequest<
          wire.TxAudioRequest,
          wire.TransmissionState
        >(
          methodPath(method.name),
          (value) => Buffer.from(toBinary(method.input, value)),
          (bytes) => fromBinary(method.output, bytes),
          this.metadata(),
          {},
          (error, result) =>
            error
              ? reject(mapRpcError(error))
              : result
                ? resolveResult(result)
                : reject(
                    new SignalDockError(
                      'RADIO_STATE_UNCERTAIN',
                      'Driver returned no TX result.',
                    ),
                  ),
        );
      },
    );
    const activeCall = call!;
    const abort = () => activeCall.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    this.streams.add(activeCall);
    void (async () => {
      try {
        for await (const frame of frames) {
          signal?.throwIfAborted();
          if (
            frame.radioId !== this.description.radioId ||
            !frame.frame ||
            frame.frame.payload.byteLength > 65536
          )
            throw new SignalDockError(
              'INVALID_ARGUMENT',
              'Invalid or oversized TX audio frame.',
            );
          if (!activeCall.write(frame))
            await once(activeCall, 'drain', signal ? { signal } : {});
        }
        activeCall.end();
      } catch {
        activeCall.cancel();
      }
    })();
    try {
      return await completion;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.streams.delete(activeCall);
    }
  }

  private metadata(): Metadata {
    const metadata = new Metadata();
    if (this.options.token)
      metadata.set('authorization', `Bearer ${this.options.token}`);
    return metadata;
  }

  private async unary<I extends DescMessage, O extends DescMessage>(
    method: DescMethodUnary<I, O>,
    input: MessageInitShape<I>,
    options: { deadline?: number; signal?: AbortSignal } = {},
  ): Promise<MessageShape<O>> {
    options.signal?.throwIfAborted();
    const deadline = options.deadline ?? Date.now() + this.timeoutMs;
    if (deadline <= Date.now())
      throw new SignalDockError(
        'DEADLINE_EXCEEDED',
        'The driver command expired before dispatch.',
      );
    return new Promise((resolveResult, reject) => {
      const call = this.client.makeUnaryRequest<
        MessageShape<I>,
        MessageShape<O>
      >(
        methodPath(method.name),
        (value) => Buffer.from(toBinary(method.input, value)),
        (bytes) => fromBinary(method.output, bytes),
        create(method.input, input),
        this.metadata(),
        { deadline },
        (error, result) => {
          options.signal?.removeEventListener('abort', abort);
          if (error) reject(mapRpcError(error));
          else if (result) resolveResult(result);
          else
            reject(
              new SignalDockError(
                'RADIO_STATE_UNCERTAIN',
                'Driver returned no result.',
              ),
            );
        },
      );
      const abort = () => call.cancel();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }

  private async *serverStream<I extends DescMessage, O extends DescMessage>(
    method: DescMethodServerStreaming<I, O>,
    input: MessageInitShape<I>,
    signal?: AbortSignal,
  ): AsyncGenerator<MessageShape<O>> {
    signal?.throwIfAborted();
    const call = this.client.makeServerStreamRequest<
      MessageShape<I>,
      MessageShape<O>
    >(
      methodPath(method.name),
      (value) => Buffer.from(toBinary(method.input, value)),
      (bytes) => fromBinary(method.output, bytes),
      create(method.input, input),
      this.metadata(),
      {},
    );
    const abort = () => call.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    this.streams.add(call);
    try {
      for await (const value of call) {
        signal?.throwIfAborted();
        yield value as MessageShape<O>;
      }
    } catch (error) {
      if (!signal?.aborted) throw mapRpcError(error as ServiceError);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.streams.delete(call);
      call.cancel();
    }
  }

  private failWrite(error: unknown): never {
    if (
      !(error instanceof SignalDockError) ||
      [
        'RADIO_UNAVAILABLE',
        'DEADLINE_EXCEEDED',
        'RADIO_STATE_UNCERTAIN',
      ].includes(error.code)
    )
      this.markUnavailable();
    throw error;
  }

  private acceptSnapshot(snapshot: wire.RadioSnapshot): RadioSnapshot {
    const parsed = decodeSnapshot(snapshot);
    if (parsed.radioId !== this.description.radioId)
      throw new SignalDockError(
        'API_INCOMPATIBLE',
        'Driver snapshot targets another radio.',
      );
    if (this.retiredGenerations.has(parsed.generation))
      throw new SignalDockError(
        'STALE_GENERATION',
        'Driver snapshot belongs to a retired generation.',
      );
    if (
      parsed.generation === this.state.generation &&
      parsed.revision < this.state.revision
    )
      throw new SignalDockError(
        'STALE_REVISION',
        'Driver snapshot moved backwards.',
      );
    if (parsed.generation !== this.state.generation)
      this.retiredGenerations.add(this.state.generation);
    this.state = parsed;
    return this.getSnapshot();
  }
  private markUnavailable(): void {
    this.state = {
      ...this.state,
      connection: 'degraded',
      tuningConfidence: 'unknown',
      txState: this.state.txState === 'idle' ? 'idle' : 'unknown',
    };
  }
}

const methodPath = (method: string) =>
  `/${wire.RadioDriverService.typeName}/${method}`;
function validateTimeout(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 30000)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Driver timeout must be between 1 and 30000 ms.',
    );
}
function operationToWire(
  context: OperationContext,
): MessageInitShape<typeof wire.OperationContextSchema> {
  return {
    operationId: context.operationId,
    radioId: context.radioId,
    generation: context.generation,
    expectedRevision: BigInt(context.expectedRevision),
    deadlineUtc: context.deadline,
    controlGrant: context.controlGrant,
    fencing: BigInt(context.fencing ?? 0),
    ownerId: context.ownerId ?? '',
    sessionId: context.sessionId ?? '',
  };
}
function memoryFromWire(memory: wire.Memory): RadioMemory {
  if (!memory.tuning)
    throw new SignalDockError(
      'API_INCOMPATIBLE',
      'Driver memory has no tuning.',
    );
  return RadioMemorySchema.parse({
    memoryId: memory.memoryId,
    name: memory.name,
    tuning: {
      rxHz: safeInteger(memory.tuning.rxHz),
      mode: memory.tuning.mode,
      ...(memory.tuning.txHz === undefined
        ? {}
        : { txHz: safeInteger(memory.tuning.txHz) }),
    },
  });
}
function safeInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new SignalDockError(
      'API_INCOMPATIBLE',
      'Driver integer exceeds the supported domain range.',
    );
  return Number(value);
}
export function decodeSnapshot(snapshot: wire.RadioSnapshot): RadioSnapshot {
  const tuning = (value: wire.Tuning) => ({
    rxHz: safeInteger(value.rxHz),
    mode: value.mode,
    ...(value.txHz === undefined ? {} : { txHz: safeInteger(value.txHz) }),
  });
  return RadioSnapshotSchema.parse({
    radioId: snapshot.radioId,
    generation: snapshot.generation,
    revision: safeInteger(snapshot.revision),
    connection: snapshot.connection,
    ...(snapshot.observedTuning
      ? { observedTuning: tuning(snapshot.observedTuning) }
      : {}),
    ...(snapshot.desiredTuning
      ? { desiredTuning: tuning(snapshot.desiredTuning) }
      : {}),
    tuningConfidence: snapshot.tuningConfidence,
    txState: snapshot.txState,
    ...(snapshot.selectedMemoryId === undefined
      ? {}
      : { selectedMemoryId: snapshot.selectedMemoryId }),
  });
}
function connectionOptions(options: GrpcRadioDriverOptions): {
  endpoint: string;
  credentials: ChannelCredentials;
} {
  if (options.endpoint.startsWith('unix:')) {
    const path = options.endpoint.slice(5);
    if (!isAbsolute(path))
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Driver Unix socket must use an absolute path.',
      );
    return {
      endpoint: `unix:${resolve(path)}`,
      credentials: credentials.createInsecure(),
    };
  }
  let url: URL;
  try {
    url = new URL(`https://${options.endpoint}`);
  } catch {
    throw new SignalDockError('INVALID_ARGUMENT', 'Invalid driver endpoint.');
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.port
  )
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Driver endpoint must be host:port without a path or credentials.',
    );
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (loopback && options.allowInsecureLoopback && !options.tls)
    return {
      endpoint: options.endpoint,
      credentials: credentials.createInsecure(),
    };
  if (!options.token && !options.tls?.certificate)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Remote driver transport requires authenticated TLS.',
    );
  if (!!options.tls?.certificate !== !!options.tls?.privateKey)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Client TLS certificate and key must be configured together.',
    );
  return {
    endpoint: options.endpoint,
    credentials: credentials.createSsl(
      options.tls?.ca ? Buffer.from(options.tls.ca) : undefined,
      options.tls?.privateKey ? Buffer.from(options.tls.privateKey) : undefined,
      options.tls?.certificate
        ? Buffer.from(options.tls.certificate)
        : undefined,
    ),
  };
}
export function mapRpcError(error: ServiceError): SignalDockError {
  try {
    const details: unknown = JSON.parse(error.details);
    if (
      typeof details === 'object' &&
      details &&
      'code' in details &&
      'message' in details &&
      typeof details.message === 'string'
    ) {
      const code = ErrorCodeSchema.safeParse(details.code);
      if (code.success)
        return new SignalDockError(code.data, details.message.slice(0, 500));
    }
  } catch {
    /* Non-JSON transport errors are normalized below. */
  }
  const code =
    error.code === status.UNAUTHENTICATED
      ? 'UNAUTHORIZED'
      : error.code === status.PERMISSION_DENIED
        ? 'FORBIDDEN'
        : error.code === status.UNIMPLEMENTED
          ? 'CAPABILITY_UNSUPPORTED'
          : error.code === status.DEADLINE_EXCEEDED
            ? 'DEADLINE_EXCEEDED'
            : error.code === status.INVALID_ARGUMENT
              ? 'INVALID_ARGUMENT'
              : 'RADIO_UNAVAILABLE';
  return new SignalDockError(code, 'The private radio driver request failed.');
}
