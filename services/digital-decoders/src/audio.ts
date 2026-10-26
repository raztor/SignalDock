import { SignalDockError } from '@signaldock/contracts';
import { ax25ToTnc2 } from './aprs.js';

export const DECODER_VERSION = '1.0.0';
export type AudioDecodeMode = 'AFSK1200' | 'DTMF';
export interface DecodedTone {
  symbol: string;
  startMs: number;
  endMs: number;
}
export interface DecodedAudioPacket {
  text: string;
  frameBase64: string;
  offsetMs: number;
}
export interface AudioDecodeResult {
  decoderId: 'signaldock.pcm';
  decoderVersion: string;
  mode: AudioDecodeMode;
  sampleRate: number;
  durationMs: number;
  packets: DecodedAudioPacket[];
  tones: DecodedTone[];
  warnings: string[];
}
export interface PcmAudio {
  samples: Int16Array;
  sampleRate: number;
}

export function readPcmWave(bytes: Uint8Array): PcmAudio {
  if (bytes.byteLength > 16 * 1024 * 1024 || bytes.byteLength < 44)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'WAV input must be between 44 bytes and 16 MiB.',
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + length));
  if (
    text(0, 4) !== 'RIFF' ||
    text(8, 4) !== 'WAVE' ||
    view.getUint32(4, true) + 8 !== bytes.length
  ) {
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'Expected a complete RIFF/WAVE recording.',
    );
  }
  let format:
    | {
        rate: number;
        channels: number;
        bits: number;
        codec: number;
        blockAlign: number;
      }
    | undefined;
  let audio: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = text(offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.length)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'WAV chunk exceeds the recording.',
      );
    if (kind === 'fmt ') {
      if (length < 16 || format)
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'WAV format chunk is invalid.',
        );
      format = {
        codec: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        rate: view.getUint32(start + 4, true),
        blockAlign: view.getUint16(start + 12, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (kind === 'data') {
      if (audio)
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Multiple WAV data chunks are unsupported.',
        );
      audio = bytes.subarray(start, start + length);
    }
    offset = start + length + (length & 1);
  }
  if (
    !format ||
    !audio ||
    format.codec !== 1 ||
    format.channels !== 1 ||
    format.bits !== 16 ||
    format.blockAlign !== 2 ||
    format.rate < 8000 ||
    format.rate > 48000
  ) {
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'Decoder requires mono PCM16 WAV at 8–48 kHz.',
    );
  }
  if (audio.length % 2 || audio.length / 2 / format.rate > 120)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Recording is misaligned or exceeds 120 seconds.',
    );
  const data = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const samples = new Int16Array(audio.length / 2);
  for (let i = 0; i < samples.length; i++)
    samples[i] = data.getInt16(i * 2, true);
  return { samples, sampleRate: format.rate };
}

function power(
  samples: Int16Array,
  start: number,
  end: number,
  frequency: number,
  rate: number,
): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / rate);
  let a = 0;
  let b = 0;
  for (let i = start; i < end; i++) {
    const next = samples[i]! / 32768 + coefficient * a - b;
    b = a;
    a = next;
  }
  return Math.max(0, a * a + b * b - coefficient * a * b) / (end - start) ** 2;
}

export function decodeDtmf(audio: PcmAudio): DecodedTone[] {
  const lows = [697, 770, 852, 941];
  const highs = [1209, 1336, 1477, 1633];
  const keys = ['123A', '456B', '789C', '*0#D'];
  const window = Math.round(audio.sampleRate * 0.04);
  const hop = Math.round(audio.sampleRate * 0.01);
  const found: DecodedTone[] = [];
  let active: DecodedTone | undefined;
  const finish = () => {
    if (active && active.endMs - active.startMs >= 50) found.push(active);
    active = undefined;
  };
  for (let start = 0; start + window <= audio.samples.length; start += hop) {
    const end = start + window;
    const low = lows
      .map((f, index) => ({
        index,
        power: power(audio.samples, start, end, f, audio.sampleRate),
      }))
      .sort((a, b) => b.power - a.power);
    const high = highs
      .map((f, index) => ({
        index,
        power: power(audio.samples, start, end, f, audio.sampleRate),
      }))
      .sort((a, b) => b.power - a.power);
    let meanSquare = 0;
    for (let i = start; i < end; i++)
      meanSquare += (audio.samples[i]! / 32768) ** 2;
    meanSquare /= window;
    const a = low[0]!;
    const b = high[0]!;
    const accepted =
      a.power > 0.001 &&
      b.power > 0.001 &&
      a.power > low[1]!.power * 3 &&
      b.power > high[1]!.power * 3 &&
      a.power / b.power >= 0.25 &&
      a.power / b.power <= 4 &&
      a.power + b.power > meanSquare * 0.35;
    const symbol = accepted ? keys[a.index]![b.index]! : undefined;
    if (!symbol) finish();
    else if (active?.symbol === symbol)
      active.endMs = (end / audio.sampleRate) * 1000;
    else {
      finish();
      active = {
        symbol,
        startMs: (start / audio.sampleRate) * 1000,
        endMs: (end / audio.sampleRate) * 1000,
      };
    }
    if (found.length >= 256) break;
  }
  finish();
  return found;
}

function hdlcFrames(bits: number[]): { frame: Uint8Array; firstBit: number }[] {
  const frames: { frame: Uint8Array; firstBit: number }[] = [];
  let start = -1;
  for (let index = 0; index + 8 <= bits.length; index++) {
    if (
      bits[index] !== 0 ||
      bits[index + 7] !== 0 ||
      !bits.slice(index + 1, index + 7).every((bit) => bit === 1)
    )
      continue;
    if (start >= 0 && index - start >= 128 && index - start <= 32768) {
      const clean: number[] = [];
      let ones = 0;
      let valid = true;
      for (let i = start; i < index; i++) {
        const bit = bits[i]!;
        if (ones === 5) {
          if (bit !== 0) {
            valid = false;
            break;
          }
          ones = 0;
          continue;
        }
        clean.push(bit);
        ones = bit ? ones + 1 : 0;
      }
      if (valid && clean.length % 8 === 0) {
        const bytes = new Uint8Array(clean.length / 8);
        for (let i = 0; i < clean.length; i++)
          bytes[Math.floor(i / 8)]! |= clean[i]! << (i % 8);
        frames.push({ frame: bytes, firstBit: start });
      }
    }
    start = index + 8;
    index += 7;
    if (frames.length > 256) break;
  }
  return frames;
}

/** Bell 202 1200/2200 Hz, 1200-baud NRZI, HDLC bit stuffing and verified AX.25 FCS. */
export function decodeAfsk1200(audio: PcmAudio): DecodedAudioPacket[] {
  const samplesPerBit = audio.sampleRate / 1200;
  const results: DecodedAudioPacket[] = [];
  for (let phase = 0; phase < 8; phase++) {
    const offset = (phase / 8) * samplesPerBit;
    const bits: number[] = [];
    let previous = 1;
    for (
      let symbol = 0;
      offset + (symbol + 1) * samplesPerBit <= audio.samples.length;
      symbol++
    ) {
      const start = Math.round(offset + symbol * samplesPerBit);
      const end = Math.round(offset + (symbol + 1) * samplesPerBit);
      const tone =
        power(audio.samples, start, end, 1200, audio.sampleRate) >=
        power(audio.samples, start, end, 2200, audio.sampleRate)
          ? 1
          : 0;
      bits.push(tone === previous ? 1 : 0);
      previous = tone;
    }
    for (const { frame, firstBit } of hdlcFrames(bits)) {
      try {
        const text = ax25ToTnc2(frame, true);
        const frameBase64 = Buffer.from(frame).toString('base64');
        const offsetMs =
          ((offset + firstBit * samplesPerBit) / audio.sampleRate) * 1000;
        if (
          !results.some(
            (result) =>
              result.frameBase64 === frameBase64 &&
              Math.abs(result.offsetMs - offsetMs) < 10,
          )
        ) {
          results.push({ text, frameBase64, offsetMs });
        }
      } catch {
        /* A candidate with bad framing/FCS is not a decoded packet. */
      }
      if (results.length >= 128)
        return results.sort((a, b) => a.offsetMs - b.offsetMs);
    }
  }
  return results.sort((a, b) => a.offsetMs - b.offsetMs);
}

export function decodeWave(
  mode: AudioDecodeMode,
  bytes: Uint8Array,
): AudioDecodeResult {
  if (mode !== 'AFSK1200' && mode !== 'DTMF')
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'Unsupported audio decoder mode.',
    );
  const audio = readPcmWave(bytes);
  return {
    decoderId: 'signaldock.pcm',
    decoderVersion: DECODER_VERSION,
    mode,
    sampleRate: audio.sampleRate,
    durationMs: (audio.samples.length / audio.sampleRate) * 1000,
    packets: mode === 'AFSK1200' ? decodeAfsk1200(audio) : [],
    tones: mode === 'DTMF' ? decodeDtmf(audio) : [],
    warnings: [
      'Synthetic-sample decoding does not establish compatibility with a particular radio or compressed RF recording.',
    ],
  };
}
