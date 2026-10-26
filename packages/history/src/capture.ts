import { randomUUID } from 'node:crypto';
import type { Communication, PcmAudioFrame } from '@signaldock/contracts';
import { HistoryService, type CaptureInput } from './service.js';

export interface CaptureContext {
  instanceId: string;
  radioId: string;
  generation: string;
  direction: 'rx' | 'tx';
  tuningRevision: number;
  frequencyHz?: number;
  attributionConfidence: 'confirmed' | 'inferred' | 'unknown';
  sourceCodec?: string;
  source?: 'microphone' | 'tts';
  txGrantId?: string;
}
export interface CaptureRecorderOptions {
  activityThreshold?: number;
  preRollMs?: number;
  silenceMs?: number;
  maxSegmentMs?: number;
  idleFlushMs?: number;
  maxBufferedBytes?: number;
  maxPendingSegments?: number;
  onFinalized?: (communication: Communication) => void | Promise<void>;
  onError?: (error: Error, context?: CaptureContext) => void;
  now?: () => number;
}
interface Segment {
  context: CaptureContext;
  streamId: string;
  sampleRateHz: number;
  channels: number;
  sequence: number;
  firstMediaTimeUs: number;
  lastMediaTimeUs: number;
  startedAt: number;
  lastArrival: number;
  chunks: Uint8Array[];
  bytes: number;
  durationMs: number;
  silentMs: number;
  active: boolean;
}

/** Bounded, nonblocking audio ingress. It never controls a radio or starts TX. */
export class HistoryCaptureRecorder {
  private readonly segments = new Map<string, Segment>();
  private pending: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private dropped = 0;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly history: Pick<HistoryService, 'ingest'>,
    private readonly options: CaptureRecorderOptions = {},
  ) {
    this.timer = setInterval(() => this.expire(), 250);
    this.timer.unref();
  }
  push(frame: PcmAudioFrame, context: CaptureContext): void {
    if (this.stopped) return;
    try {
      if (
        frame.format.encoding !== 'pcm_s16le' ||
        ![1, 2].includes(frame.format.channels) ||
        !Number.isInteger(frame.format.sampleRateHz) ||
        frame.format.sampleRateHz < 8000 ||
        frame.format.sampleRateHz > 96000 ||
        frame.data.byteLength % (2 * frame.format.channels) !== 0 ||
        frame.data.byteLength > 1024 * 1024 ||
        !Number.isSafeInteger(frame.sequence) ||
        !Number.isSafeInteger(frame.mediaTimeUs)
      )
        throw new Error('Unsupported recording PCM frame.');
      if (frame.tuningRevision !== context.tuningRevision)
        throw new Error(
          'Recording context does not match frame tuning revision.',
        );
      const key = `${context.instanceId}:${context.radioId}:${context.direction}`;
      let segment = this.segments.get(key);
      if (
        segment &&
        (segment.streamId !== frame.streamId ||
          segment.context.generation !== context.generation ||
          segment.context.tuningRevision !== context.tuningRevision ||
          segment.context.frequencyHz !== context.frequencyHz ||
          segment.context.attributionConfidence !==
            context.attributionConfidence ||
          segment.context.txGrantId !== context.txGrantId ||
          segment.context.source !== context.source ||
          segment.channels !== frame.format.channels ||
          segment.sampleRateHz !== frame.format.sampleRateHz ||
          frame.discontinuity ||
          frame.sequence !== segment.sequence + 1 ||
          frame.mediaTimeUs < segment.lastMediaTimeUs)
      ) {
        this.finalize(key, 'context_or_stream_discontinuity');
        segment = undefined;
      }
      const now = this.now();
      if (!segment) {
        const parsed = frame.capturedAt ? Date.parse(frame.capturedAt) : now;
        segment = {
          context: { ...context },
          streamId: frame.streamId,
          sampleRateHz: frame.format.sampleRateHz,
          channels: frame.format.channels,
          sequence: frame.sequence,
          firstMediaTimeUs: frame.mediaTimeUs,
          lastMediaTimeUs: frame.mediaTimeUs,
          startedAt: Number.isFinite(parsed) ? parsed : now,
          lastArrival: now,
          chunks: [],
          bytes: 0,
          durationMs: 0,
          silentMs: 0,
          active: false,
        };
        this.segments.set(key, segment);
      }
      const durationMs =
        (frame.data.byteLength /
          (frame.format.channels * 2 * frame.format.sampleRateHz)) *
        1000;
      segment.sequence = frame.sequence;
      segment.lastMediaTimeUs = frame.mediaTimeUs;
      segment.lastArrival = now;
      segment.chunks.push(new Uint8Array(frame.data));
      segment.bytes += frame.data.byteLength;
      segment.durationMs += durationMs;
      const active =
        context.direction === 'tx' ||
        this.rms(frame.data) >= (this.options.activityThreshold ?? 0.008);
      if (active) {
        segment.active = true;
        segment.silentMs = 0;
      } else segment.silentMs += durationMs;
      if (!segment.active) {
        while (
          segment.chunks.length > 1 &&
          segment.durationMs > (this.options.preRollMs ?? 200)
        ) {
          const removed = segment.chunks.shift()!;
          const duration =
            (removed.byteLength /
              (segment.channels * 2 * segment.sampleRateHz)) *
            1000;
          segment.bytes -= removed.byteLength;
          segment.durationMs -= duration;
          segment.startedAt += duration;
          segment.firstMediaTimeUs += duration * 1000;
        }
      }
      if (
        frame.endOfBurst ||
        (segment.active &&
          segment.silentMs >= (this.options.silenceMs ?? 500)) ||
        segment.durationMs >= (this.options.maxSegmentMs ?? 30000) ||
        this.bufferedBytes() >=
          (this.options.maxBufferedBytes ?? 8 * 1024 * 1024)
      )
        this.finalize(
          key,
          frame.endOfBurst
            ? 'end_of_burst'
            : segment.silentMs >= (this.options.silenceMs ?? 500)
              ? 'silence'
              : 'segment_limit',
        );
    } catch (error) {
      this.report(error, context);
    }
  }
  async flush(): Promise<void> {
    for (const key of [...this.segments.keys()]) this.finalize(key, 'flush');
    await this.pending;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.flush();
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private expire(): void {
    for (const [key, segment] of this.segments)
      if (
        this.now() - segment.lastArrival >=
        (this.options.idleFlushMs ?? 1200)
      )
        this.finalize(key, 'stream_idle');
  }
  private bufferedBytes(): number {
    let total = 0;
    for (const segment of this.segments.values()) total += segment.bytes;
    return total;
  }
  private rms(bytes: Uint8Array): number {
    if (!bytes.byteLength) return 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let total = 0;
    for (let index = 0; index < bytes.byteLength; index += 2) {
      const amplitude = view.getInt16(index, true) / 32768;
      total += amplitude * amplitude;
    }
    return Math.sqrt(total / (bytes.byteLength / 2));
  }
  private finalize(key: string, reason: string): void {
    const segment = this.segments.get(key);
    this.segments.delete(key);
    if (!segment?.active || !segment.bytes) return;
    if (this.pendingCount >= (this.options.maxPendingSegments ?? 8)) {
      this.dropped++;
      this.report(
        new Error('Recording queue is full; segment dropped.'),
        segment.context,
      );
      return;
    }
    const { context } = segment;
    const input: CaptureInput = {
      id: randomUUID(),
      instanceId: context.instanceId,
      radioId: context.radioId,
      kind:
        context.direction === 'rx'
          ? 'received_voice'
          : context.source === 'tts'
            ? 'transmitted_tts'
            : 'transmitted_voice',
      direction: context.direction,
      startedAt: new Date(segment.startedAt).toISOString(),
      endedAt: new Date(segment.startedAt + segment.durationMs).toISOString(),
      frequencyAttribution: context.attributionConfidence,
      ...(context.frequencyHz === undefined
        ? {}
        : { frequencyHz: context.frequencyHz }),
      context: {
        generation: context.generation,
        tuningRevision: context.tuningRevision,
        streamId: segment.streamId,
        sourceCodec: context.sourceCodec ?? 'pcm_s16le',
        source: context.source ?? context.direction,
        ...(context.txGrantId ? { txGrantId: context.txGrantId } : {}),
        firstMediaTimeUs: segment.firstMediaTimeUs,
        lastMediaTimeUs: segment.lastMediaTimeUs,
        segmentEnd: reason,
        droppedSegmentsBefore: this.dropped,
      },
    };
    this.dropped = 0;
    const bytes = wav(segment.chunks, segment.sampleRateHz, segment.channels);
    this.pendingCount++;
    this.pending = this.pending
      .then(async () => {
        const communication = await this.history.ingest(input, {
          bytes,
          contentType: 'audio/wav',
        });
        await this.options.onFinalized?.(communication);
      })
      .catch((error) => this.report(error, context))
      .finally(() => {
        this.pendingCount--;
      });
  }
  private report(error: unknown, context?: CaptureContext): void {
    try {
      this.options.onError?.(
        error instanceof Error ? error : new Error('Recording failed.'),
        context,
      );
    } catch {
      /* Reporting cannot break live media. */
    }
  }
}

export function wav(
  chunks: readonly Uint8Array[],
  sampleRateHz: number,
  channels: number,
): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + size, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(size, 40);
  let offset = 44;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
