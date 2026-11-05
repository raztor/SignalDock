/** Fixed mono PCM wire format. Authorization and radio generation live in the enrollment. */
export const PCM_WEBSOCKET_PROTOCOL = 'signaldock.pcm.v1';
export const PCM_WEBSOCKET_FORMAT = {
  encoding: 'pcm_s16le',
  sampleRateHz: 32000,
  channels: 1,
} as const;
export interface PcmSocketFrame {
  sequence: number;
  mediaTimeUs: number;
  tuningRevision: number;
  data: Uint8Array;
}
export function encodePcmSocketFrame(frame: PcmSocketFrame): Uint8Array {
  const output = new Uint8Array(24 + frame.data.length);
  const view = new DataView(output.buffer);
  view.setFloat64(0, frame.sequence, true);
  view.setFloat64(8, frame.mediaTimeUs, true);
  view.setFloat64(16, frame.tuningRevision, true);
  output.set(frame.data, 24);
  decodePcmSocketFrame(output);
  return output;
}
export function decodePcmSocketFrame(input: Uint8Array): PcmSocketFrame {
  if (input.length < 26 || input.length > 1304 || input.length % 2)
    throw new Error('PCM packets require 1..640 complete samples.');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const sequence = view.getFloat64(0, true);
  const mediaTimeUs = view.getFloat64(8, true);
  const tuningRevision = view.getFloat64(16, true);
  if (
    ![sequence, mediaTimeUs, tuningRevision].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error('PCM packet counters must be safe nonnegative integers.');
  return { sequence, mediaTimeUs, tuningRevision, data: input.slice(24) };
}
