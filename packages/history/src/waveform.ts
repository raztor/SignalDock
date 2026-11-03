/**
 * Pure waveform peak extraction from stored recordings.
 *
 * Supports RIFF/WAVE with 16-bit integer PCM (format tag 1, or
 * WAVE_FORMAT_EXTENSIBLE with the PCM sub-format) and raw little-endian
 * signed 16-bit PCM declared as `audio/pcm` / `audio/x-pcm` with a `rate`
 * parameter. Anything else is reported as not decodable.
 */
export const DEFAULT_WAVEFORM_POINTS = 64;
export const MAX_WAVEFORM_POINTS = 512;

export interface PcmS16Audio {
  sampleRateHz: number;
  channels: number;
  /** Byte offset of the first sample within `bytes`. */
  dataOffset: number;
  /** Byte length of whole frames available from `dataOffset`. */
  dataLength: number;
  bytes: Uint8Array;
}
export interface WaveformPeaks {
  /** Peak absolute amplitude per point, 0..1 (full scale, not normalised). */
  peaks: number[];
  durationMs: number;
}

const ascii = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
const PCM_SUBFORMAT_TAIL = [
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b,
  0x71,
];

function validFormat(sampleRateHz: number, channels: number): boolean {
  return (
    Number.isInteger(sampleRateHz) &&
    sampleRateHz >= 1000 &&
    sampleRateHz <= 384000 &&
    Number.isInteger(channels) &&
    channels >= 1 &&
    channels <= 8
  );
}

/** Parse a RIFF/WAVE container holding 16-bit PCM; undefined otherwise. */
export function parseWav(bytes: Uint8Array): PcmS16Audio | undefined {
  if (
    bytes.byteLength < 12 ||
    ascii(bytes, 0) !== 'RIFF' ||
    ascii(bytes, 8) !== 'WAVE'
  )
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: { sampleRateHz: number; channels: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.byteLength) return undefined;
      const tag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRateHz = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      let pcm = tag === 1;
      if (tag === 0xfffe && size >= 40 && body + 40 <= bytes.byteLength) {
        const subFormat = view.getUint16(body + 24, true);
        pcm =
          subFormat === 1 &&
          PCM_SUBFORMAT_TAIL.every(
            (value, index) => bytes[body + 26 + index] === value,
          );
      }
      if (
        !pcm ||
        bits !== 16 ||
        blockAlign !== channels * 2 ||
        !validFormat(sampleRateHz, channels)
      )
        return undefined;
      format = { sampleRateHz, channels };
    } else if (id === 'data') {
      if (!format) return undefined;
      const available = Math.min(size, bytes.byteLength - body);
      const frame = format.channels * 2;
      return {
        ...format,
        dataOffset: body,
        dataLength: available - (available % frame),
        bytes,
      };
    }
    // Chunks are word aligned; a pad byte follows odd-sized chunks.
    offset = body + size + (size % 2);
  }
  return undefined;
}

/** Parse `audio/pcm;rate=8000;channels=1` style raw s16le declarations. */
export function parseRawPcm(
  bytes: Uint8Array,
  contentType: string,
): PcmS16Audio | undefined {
  const [base, ...parameters] = contentType
    .split(';')
    .map((part) => part.trim().toLowerCase());
  if (base !== 'audio/pcm' && base !== 'audio/x-pcm') return undefined;
  const values = new Map(
    parameters.map((parameter) => {
      const [key = '', value = ''] = parameter.split('=');
      return [key.trim(), value.trim().replace(/^"|"$/g, '')] as const;
    }),
  );
  const encoding = values.get('encoding') ?? values.get('format');
  if (encoding && encoding !== 's16le' && encoding !== 'pcm_s16le')
    return undefined;
  const sampleRateHz = Number(values.get('rate'));
  const channels = Number(values.get('channels') ?? '1');
  if (!validFormat(sampleRateHz, channels)) return undefined;
  const frame = channels * 2;
  return {
    sampleRateHz,
    channels,
    dataOffset: 0,
    dataLength: bytes.byteLength - (bytes.byteLength % frame),
    bytes,
  };
}

/** Decode a stored recording by content type; undefined when unsupported. */
export function decodePcmS16(
  bytes: Uint8Array,
  contentType: string,
): PcmS16Audio | undefined {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'audio/wav' || base === 'audio/x-wav' || base === 'audio/wave')
    return parseWav(bytes);
  return parseRawPcm(bytes, contentType);
}

/** Peak absolute amplitude (0..1) per point across all channels. */
export function computePeaks(audio: PcmS16Audio, points: number): number[] {
  if (!Number.isInteger(points) || points < 1 || points > MAX_WAVEFORM_POINTS)
    throw new RangeError('Invalid waveform point count.');
  const frameBytes = audio.channels * 2;
  const frames = Math.floor(audio.dataLength / frameBytes);
  if (frames === 0) return [];
  const view = new DataView(
    audio.bytes.buffer,
    audio.bytes.byteOffset + audio.dataOffset,
    frames * frameBytes,
  );
  const peaks: number[] = [];
  for (let point = 0; point < points; point += 1) {
    const start = Math.min(frames - 1, Math.floor((point * frames) / points));
    const end = Math.max(
      start + 1,
      Math.min(frames, Math.floor(((point + 1) * frames) / points)),
    );
    let peak = 0;
    for (let byte = start * frameBytes; byte < end * frameBytes; byte += 2) {
      const sample = Math.abs(view.getInt16(byte, true));
      if (sample > peak) peak = sample;
    }
    peaks.push(Math.round(Math.min(1, peak / 32767) * 1000) / 1000);
  }
  return peaks;
}

export function pcmDurationMs(audio: PcmS16Audio): number {
  const frames = Math.floor(audio.dataLength / (audio.channels * 2));
  return Math.round((frames * 1000) / audio.sampleRateHz);
}

/** Decode and summarise a recording; undefined when the format is unsupported. */
export function waveformFromRecording(
  bytes: Uint8Array,
  contentType: string,
  points: number = DEFAULT_WAVEFORM_POINTS,
): WaveformPeaks | undefined {
  const audio = decodePcmS16(bytes, contentType);
  if (!audio) return undefined;
  return {
    peaks: computePeaks(audio, points),
    durationMs: pcmDurationMs(audio),
  };
}
