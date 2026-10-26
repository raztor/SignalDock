import { ax25Fcs } from '../src/aprs.js';

export function wave(samples: Int16Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const data = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), offset);
  text(0, 'RIFF');
  data.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, 'data');
  data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    data.setInt16(44 + i * 2, samples[i]!, true);
  return bytes;
}

export function uiFrame(
  payload = '!4903.50N/07201.75W-Synthetic fixture',
): Uint8Array {
  const address = (call: string, last: boolean) => [
    ...call
      .padEnd(6)
      .split('')
      .map((letter) => letter.charCodeAt(0) << 1),
    0x60 | (last ? 1 : 0),
  ];
  const bytes = Uint8Array.from([
    ...address('APRS', false),
    ...address('N0CALL', true),
    0x03,
    0xf0,
    ...new TextEncoder().encode(payload),
  ]);
  const fcs = ax25Fcs(bytes);
  return Uint8Array.from([...bytes, fcs & 255, fcs >>> 8]);
}

export function afskFixture(rate = 32000): {
  wav: Uint8Array;
  frame: Uint8Array;
} {
  const frame = uiFrame();
  const flag = [0, 1, 1, 1, 1, 1, 1, 0];
  const bits = [...Array.from({ length: 32 }, () => flag).flat()];
  let ones = 0;
  for (const byte of frame) {
    for (let bit = 0; bit < 8; bit++) {
      const value = (byte >>> bit) & 1;
      bits.push(value);
      ones = value ? ones + 1 : 0;
      if (ones === 5) {
        bits.push(0);
        ones = 0;
      }
    }
  }
  bits.push(...flag, ...flag);
  let tone = 1;
  const frequencies = bits.map((bit) => {
    if (!bit) tone = 1 - tone;
    return tone ? 1200 : 2200;
  });
  const samples = new Int16Array(Math.ceil((bits.length * rate) / 1200));
  let phase = 0;
  for (let sample = 0; sample < samples.length; sample++) {
    const frequency =
      frequencies[
        Math.min(frequencies.length - 1, Math.floor((sample * 1200) / rate))
      ]!;
    phase += (2 * Math.PI * frequency) / rate;
    samples[sample] = Math.round(Math.sin(phase) * 16000);
  }
  return { wav: wave(samples, rate), frame };
}

export function dtmfFixture(rate = 16000): Uint8Array {
  const low = [697, 697, 941];
  const high = [1209, 1336, 1477];
  const samples = new Int16Array(Math.round(rate * 0.9));
  for (let digit = 0; digit < 3; digit++)
    for (let i = 0; i < rate * 0.15; i++) {
      const time = i / rate;
      samples[Math.round((digit * 0.25 + 0.05) * rate) + i] = Math.round(
        7000 *
          (Math.sin(time * Math.PI * 2 * low[digit]!) +
            Math.sin(time * Math.PI * 2 * high[digit]!)),
      );
    }
  return wave(samples, rate);
}
