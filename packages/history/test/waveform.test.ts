import { describe, expect, it } from 'vitest';
import { wav } from '../src/capture.js';
import {
  computePeaks,
  decodePcmS16,
  parseRawPcm,
  parseWav,
  pcmDurationMs,
  waveformFromRecording,
} from '../src/waveform.js';

function pcm(samples: readonly number[]): Uint8Array {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes;
}

describe('waveform peak extraction', () => {
  it('parses the WAV files written by the capture recorder', () => {
    const bytes = wav([pcm([0, 1000, -2000, 3000])], 8000, 1);
    const audio = parseWav(bytes);
    expect(audio).toMatchObject({
      sampleRateHz: 8000,
      channels: 1,
      dataOffset: 44,
      dataLength: 8,
    });
    expect(pcmDurationMs(audio!)).toBe(1);
  });

  it('computes full-scale peaks per point across channels', () => {
    // 8 stereo frames: the louder channel defines each point's peak.
    const samples = [
      0, 16384, 0, -8192, 32767, 0, 0, 0, -32768, 0, 0, 100, 0, 0, 0, 0,
    ];
    const audio = parseWav(wav([pcm(samples)], 8000, 2))!;
    expect(computePeaks(audio, 4)).toEqual([0.5, 1, 1, 0]);
    expect(computePeaks(audio, 1)).toEqual([1]);
  });

  it('fills every point when there are fewer frames than points', () => {
    const audio = parseWav(wav([pcm([16384, 0])], 8000, 1))!;
    const peaks = computePeaks(audio, 4);
    expect(peaks).toHaveLength(4);
    expect(peaks.every((peak) => peak >= 0 && peak <= 1)).toBe(true);
    expect(peaks[0]).toBe(0.5);
    expect(() => computePeaks(audio, 0)).toThrow(RangeError);
    expect(() => computePeaks(audio, 513)).toThrow(RangeError);
  });

  it('returns no peaks for an empty data chunk', () => {
    const audio = parseWav(wav([], 8000, 1))!;
    expect(computePeaks(audio, 64)).toEqual([]);
    expect(waveformFromRecording(wav([], 8000, 1), 'audio/wav')).toEqual({
      peaks: [],
      durationMs: 0,
    });
  });

  it('skips unknown chunks and tolerates truncated data', () => {
    const data = pcm([1000, 2000, 3000, 4000]);
    const header = Buffer.from(wav([data], 16000, 1));
    const list = Buffer.alloc(8 + 3);
    list.write('LIST', 0);
    list.writeUInt32LE(3, 4);
    const padded = Buffer.concat([
      header.subarray(0, 36),
      list,
      Buffer.alloc(1),
      header.subarray(36, 44 + 6),
    ]);
    const audio = parseWav(padded)!;
    expect(audio.dataLength).toBe(6);
    expect(audio.dataOffset).toBe(36 + 12 + 8);
    expect(computePeaks(audio, 3)).toEqual([0.031, 0.061, 0.092]);
  });

  it('rejects unsupported containers and encodings', () => {
    expect(parseWav(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBeUndefined();
    const eightBit = Buffer.from(wav([pcm([1, 2])], 8000, 1));
    eightBit.writeUInt16LE(8, 34);
    expect(parseWav(eightBit)).toBeUndefined();
    const float = Buffer.from(wav([pcm([1, 2])], 8000, 1));
    float.writeUInt16LE(3, 20);
    expect(parseWav(float)).toBeUndefined();
    expect(decodePcmS16(pcm([1, 2]), 'audio/ogg')).toBeUndefined();
    expect(
      waveformFromRecording(new Uint8Array([1, 2, 3]), 'audio/wav', 64),
    ).toBeUndefined();
  });

  it('decodes WAVE_FORMAT_EXTENSIBLE PCM', () => {
    const data = pcm([16384, -16384]);
    const bytes = Buffer.alloc(68 + data.byteLength);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(60 + data.byteLength, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(40, 16);
    bytes.writeUInt16LE(0xfffe, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.writeUInt16LE(22, 36);
    bytes.writeUInt16LE(16, 38);
    bytes.writeUInt32LE(4, 40);
    Buffer.from([
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa,
      0x00, 0x38, 0x9b, 0x71,
    ]).copy(bytes, 44);
    bytes.write('data', 60);
    bytes.writeUInt32LE(data.byteLength, 64);
    Buffer.from(data).copy(bytes, 68);
    expect(waveformFromRecording(bytes, 'audio/wave', 2)).toEqual({
      peaks: [0.5, 0.5],
      durationMs: 0,
    });
  });

  it('decodes raw s16le PCM only with an explicit sample rate', () => {
    const data = pcm(new Array(8000).fill(8192));
    expect(parseRawPcm(data, 'audio/pcm')).toBeUndefined();
    expect(parseRawPcm(data, 'audio/pcm;encoding=s16be;rate=8000')).toBe(
      undefined,
    );
    expect(waveformFromRecording(data, 'audio/pcm; rate=8000', 2)).toEqual({
      peaks: [0.25, 0.25],
      durationMs: 1000,
    });
    expect(
      waveformFromRecording(data, 'audio/x-pcm;rate=8000;channels=2', 1),
    ).toEqual({ peaks: [0.25], durationMs: 500 });
  });
});
