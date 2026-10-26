import { create } from '@bufbuild/protobuf';
import {
  SignalDockError,
  type AudioFormat,
  type PcmAudioFrame,
  type TxGrant,
} from '@signaldock/contracts';
import {
  type TxDriverPort,
  type TxObservation,
} from '@signaldock/radio-runtime/tx';
import * as wire from '@signaldock/radio-driver-sdk/wire';
import { BoundedAudioQueue } from './pcm.js';

export interface WireRadioAudioClient {
  prepareTransmission(
    input: wire.PrepareTransmissionRequest,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState>;
  pushTxAudio(
    input: AsyncIterable<wire.TxAudioRequest>,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState>;
  renewTransmission(
    input: wire.RenewTransmissionRequest,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState>;
  endTransmission(
    input: wire.EndTransmissionRequest,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState>;
  observeTransmission(
    input: wire.ObserveTransmissionRequest,
    signal?: AbortSignal,
  ): Promise<wire.TransmissionState>;
  openRxStream(input: {
    streamId: string;
    generation: string;
    signal?: AbortSignal;
  }): AsyncIterable<wire.AudioFrame>;
}
export function safeWireInteger(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new SignalDockError('INVALID_ARGUMENT', `Unsafe driver ${label}.`);
  return Number(value);
}
export function normalizeWireAudio(frame: wire.AudioFrame): PcmAudioFrame {
  if (
    !frame.streamId ||
    !frame.format ||
    frame.format.encoding !== 'pcm_s16le' ||
    frame.format.channels !== 1 ||
    ![8000, 16000, 24000, 32000, 44100, 48000].includes(
      frame.format.sampleRateHz,
    ) ||
    frame.payload.length % 2 ||
    frame.payload.length > 9600
  ) {
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'Driver must provide bounded normalized PCM.',
    );
  }
  if (
    !['confirmed', 'inferred', 'unknown'].includes(frame.attributionConfidence)
  )
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Invalid driver attribution.',
    );
  return {
    streamId: frame.streamId,
    sequence: safeWireInteger(frame.sequence, 'sequence'),
    mediaTimeUs: safeWireInteger(frame.mediaTimeUs, 'media clock'),
    tuningRevision: safeWireInteger(frame.tuningRevision, 'revision'),
    format: {
      encoding: 'pcm_s16le',
      sampleRateHz: frame.format.sampleRateHz,
      channels: frame.format.channels,
    },
    data: new Uint8Array(frame.payload),
    attributionConfidence:
      frame.attributionConfidence as PcmAudioFrame['attributionConfidence'],
    discontinuity: frame.discontinuity,
    endOfBurst: frame.endOfBurst,
  };
}
export async function* grpcRxFrames(
  client: WireRadioAudioClient,
  generation: string,
  signal: AbortSignal,
): AsyncIterable<PcmAudioFrame> {
  const streamId = crypto.randomUUID();
  let lastSequence = -1;
  let lastMediaTime = -1;
  for await (const frame of client.openRxStream({
    streamId,
    generation,
    signal,
  })) {
    signal.throwIfAborted();
    const normalized = normalizeWireAudio(frame);
    if (
      normalized.streamId !== streamId ||
      normalized.sequence <= lastSequence ||
      (!normalized.discontinuity && normalized.mediaTimeUs < lastMediaTime)
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Driver RX stream identity or media sequence is invalid.',
      );
    lastSequence = normalized.sequence;
    lastMediaTime = normalized.mediaTimeUs;
    yield normalized;
  }
}

/** Bounded client-streaming adapter. No operation or audio is automatically replayed. */
export function createGrpcTxDriver(client: WireRadioAudioClient): TxDriverPort {
  const streams = new Map<
    string,
    {
      queue: BoundedAudioQueue<wire.TxAudioRequest>;
      pending: Promise<wire.TransmissionState>;
      error?: unknown;
    }
  >();
  function observation(
    grant: TxGrant,
    state: wire.TransmissionState,
  ): TxObservation {
    if (
      state.radioId !== grant.radioId ||
      state.generation !== grant.generation ||
      state.txGrantId !== grant.txGrantId
    )
      throw new SignalDockError(
        'STALE_GENERATION',
        'Driver returned another transmission context.',
      );
    return {
      state:
        state.state === 'idle'
          ? 'idle'
          : state.state === 'transmitting'
            ? 'transmitting'
            : 'unknown',
      physicallyConfirmed: state.physicallyConfirmed,
    };
  }
  return {
    async prepare(
      grant: TxGrant,
      format: AudioFormat,
      signal: AbortSignal,
    ): Promise<void> {
      const result = await client.prepareTransmission(
        create(wire.PrepareTransmissionRequestSchema, {
          context: {
            operationId: crypto.randomUUID(),
            radioId: grant.radioId,
            generation: grant.generation,
            expectedRevision: BigInt(grant.tuningRevision),
            controlGrant: grant.controlGrant,
            deadlineUtc: new Date(grant.expiresAt).toISOString(),
            fencing: BigInt(grant.fencing),
            ownerId: grant.ownerId,
            sessionId: grant.sessionId,
          },
          txGrantId: grant.txGrantId,
          expiresAtUtc: new Date(grant.expiresAt).toISOString(),
          maxUntilUtc: new Date(grant.maxUntil).toISOString(),
          fencing: BigInt(grant.fencing),
          format,
        }),
        signal,
      );
      observation(grant, result);
      signal.throwIfAborted();
      const queue = new BoundedAudioQueue<wire.TxAudioRequest>(4);
      const pending = client.pushTxAudio(queue, signal);
      const stream: {
        queue: BoundedAudioQueue<wire.TxAudioRequest>;
        pending: Promise<wire.TransmissionState>;
        error?: unknown;
      } = { queue, pending };
      streams.set(grant.txGrantId, stream);
      void pending.then(
        (result) => {
          try {
            observation(grant, result);
            stream.error = new SignalDockError(
              'RADIO_UNAVAILABLE',
              'The driver TX audio stream ended.',
            );
          } catch (error) {
            stream.error = error;
          }
          queue.close();
        },
        (error: unknown) => {
          stream.error = error;
          queue.close();
        },
      );
    },
    async write(grant, frame, signal) {
      signal.throwIfAborted();
      const stream = streams.get(grant.txGrantId);
      if (!stream)
        throw new SignalDockError(
          'CONTROL_REQUIRED',
          'The driver TX stream is not prepared.',
        );
      if (stream.error) throw stream.error;
      stream.queue.push(
        create(wire.TxAudioRequestSchema, {
          radioId: grant.radioId,
          generation: grant.generation,
          txGrantId: grant.txGrantId,
          fencing: BigInt(grant.fencing),
          frame: {
            streamId: frame.streamId,
            sequence: BigInt(frame.sequence),
            mediaTimeUs: BigInt(frame.mediaTimeUs),
            format: frame.format,
            payload: frame.data,
            tuningRevision: BigInt(frame.tuningRevision),
            attributionConfidence: frame.attributionConfidence,
            discontinuity: frame.discontinuity,
            endOfBurst: frame.endOfBurst ?? false,
          },
        }),
      );
    },
    async renew(grant, signal) {
      const result = await client.renewTransmission(
        create(wire.RenewTransmissionRequestSchema, {
          radioId: grant.radioId,
          generation: grant.generation,
          txGrantId: grant.txGrantId,
          expiresAtUtc: new Date(grant.expiresAt).toISOString(),
          fencing: BigInt(grant.fencing),
        }),
        signal,
      );
      observation(grant, result);
    },
    async end(grant, reason) {
      const stream = streams.get(grant.txGrantId);
      stream?.queue.close();
      try {
        return observation(
          grant,
          await client.endTransmission(
            create(wire.EndTransmissionRequestSchema, {
              radioId: grant.radioId,
              generation: grant.generation,
              txGrantId: grant.txGrantId,
              reason,
              fencing: BigInt(grant.fencing),
            }),
          ),
        );
      } finally {
        streams.delete(grant.txGrantId);
      }
    },
    async observe(grant) {
      return observation(
        grant,
        await client.observeTransmission(
          create(wire.ObserveTransmissionRequestSchema, {
            radioId: grant.radioId,
            generation: grant.generation,
            txGrantId: grant.txGrantId,
          }),
        ),
      );
    },
  };
}
