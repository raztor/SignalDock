import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Communication, PcmAudioFrame } from '@signaldock/contracts';
import { HistoryCaptureRecorder, type CaptureContext } from '../src/capture.js';
import { HistoryService, type CaptureInput } from '../src/service.js';

const context: CaptureContext = {
  instanceId: randomUUID(),
  radioId: randomUUID(),
  generation: randomUUID(),
  direction: 'rx',
  tuningRevision: 3,
  frequencyHz: 147540000,
  attributionConfidence: 'confirmed',
};
function frame(
  sequence: number,
  amplitude = 1000,
  extra: Partial<PcmAudioFrame> = {},
): PcmAudioFrame {
  const data = Buffer.alloc(1600);
  for (let index = 0; index < data.byteLength; index += 2)
    data.writeInt16LE(amplitude, index);
  return {
    streamId: 'rx',
    sequence,
    mediaTimeUs: sequence * 100000,
    format: { encoding: 'pcm_s16le', sampleRateHz: 8000, channels: 1 },
    data,
    tuningRevision: 3,
    attributionConfidence: 'confirmed',
    discontinuity: false,
    capturedAt: '2026-10-26T00:00:00.000Z',
    ...extra,
  };
}
function setup(
  options: ConstructorParameters<typeof HistoryCaptureRecorder>[1] = {},
) {
  const saved: { input: CaptureInput; bytes: Uint8Array }[] = [];
  const errors: Error[] = [];
  const history: Pick<HistoryService, 'ingest'> = {
    ingest: async (input: CaptureInput, audio?: { bytes: Uint8Array }) => {
      saved.push({ input, bytes: audio!.bytes });
      return {
        ...input,
        conversationId: randomUUID(),
        revision: 1,
        transcripts: [],
        notes: input.notes ?? [],
        tags: input.tags ?? [],
        retentionHold: false,
      } as Communication;
    },
  };
  const recorder = new HistoryCaptureRecorder(history, {
    ...options,
    onError: (e) => errors.push(e),
  });
  return { recorder, saved, errors };
}
describe('bounded audio capture', () => {
  it('keeps source context and WAV bytes while silence-only frames never become communications', async () => {
    const { recorder, saved } = setup();
    recorder.push(frame(0, 0), context);
    recorder.push(frame(1, 0, { endOfBurst: true }), context);
    const original = frame(2);
    recorder.push(original, context);
    original.data.fill(0);
    recorder.push(frame(3, 1000, { endOfBurst: true }), context);
    await recorder.stop();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.input).toMatchObject({
      frequencyHz: 147540000,
      context: {
        generation: context.generation,
        tuningRevision: 3,
        segmentEnd: 'end_of_burst',
      },
      kind: 'received_voice',
    });
    const wav = Buffer.from(saved[0]!.bytes);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(3200);
    expect(wav.readInt16LE(44)).toBe(1000);
  });
  it('splits discontinuities and never transfers previous frequency attribution into a new generation', async () => {
    const { recorder, saved } = setup();
    recorder.push(frame(0), context);
    const { frequencyHz: _, ...unknown } = context;
    recorder.push(frame(8), {
      ...unknown,
      generation: randomUUID(),
      attributionConfidence: 'unknown',
    });
    await recorder.stop();
    expect(saved).toHaveLength(2);
    expect(saved[0]!.input.context['segmentEnd']).toBe(
      'context_or_stream_discontinuity',
    );
    expect(saved[1]!.input).not.toHaveProperty('frequencyHz');
    expect(saved[1]!.input.frequencyAttribution).toBe('unknown');
  });
  it('archives TX silence and identifies TTS using the same recorder ingress', async () => {
    const { recorder, saved } = setup();
    recorder.push(frame(0, 0, { endOfBurst: true }), {
      ...context,
      direction: 'tx',
      source: 'tts',
      txGrantId: randomUUID(),
    });
    await recorder.stop();
    expect(saved[0]!.input.kind).toBe('transmitted_tts');
  });
  it('rejects malformed/mismatched frames and caps pending work without blocking media', async () => {
    const { recorder, saved, errors } = setup({ maxPendingSegments: 1 });
    recorder.push(frame(0, 1000, { tuningRevision: 4 }), context);
    recorder.push(frame(1, 1000, { endOfBurst: true }), context);
    recorder.push(frame(2, 1000, { endOfBurst: true }), context);
    await recorder.flush();
    recorder.push(frame(3, 1000, { endOfBurst: true }), context);
    await recorder.stop();
    expect(saved).toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(saved[1]!.input.context['droppedSegmentsBefore']).toBe(1);
  });
});
