import { describe, expect, it } from 'vitest';
import { ax25Fcs, ax25ToTnc2, parseAprsTnc2 } from '../src/aprs.js';
import { decodeWave, readPcmWave } from '../src/audio.js';
import { decodeRecording } from '../dist/isolation.js';
import { afskFixture, dtmfFixture, uiFrame, wave } from './fixtures.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('APRS and AX.25 parsing', () => {
  it('parses uncompressed coordinates, symbol, route and original payload', () => {
    const result = parseAprsTnc2(
      'N0CALL>APRS,WIDE1-1*:!4903.50N/07201.75W-Synthetic fixture',
    );
    expect(result.position?.latitude).toBeCloseTo(49.0583333333, 8);
    expect(result.position?.longitude).toBeCloseTo(-72.0291666667, 8);
    expect(result.path).toEqual(['WIDE1-1*']);
    expect(result.comment).toBe('Synthetic fixture');
  });
  it('supports timestamped southern/eastern reports and retains no-position packets', () => {
    const result = parseAprsTnc2(
      'N0CALL>APRS:/261230z3456.78S/05823.45E>Station',
    );
    expect(result.position?.latitude).toBeCloseTo(-34.9463333333);
    expect(result.position?.longitude).toBeCloseTo(58.3908333333);
    expect(parseAprsTnc2('N0CALL>APRS:>Ready')).toMatchObject({
      kind: 'status',
      comment: 'Ready',
    });
  });
  it('does not invent a position for compressed or ambiguous coordinates', () => {
    expect(parseAprsTnc2('N0CALL>APRS:!/5L!!<*e7>7P[')).toMatchObject({
      kind: 'position_unsupported',
    });
    const ambiguous = parseAprsTnc2('N0CALL>APRS:!4903.  N/07201.  W-Test');
    expect(ambiguous.kind).toBe('position_ambiguous');
    expect(ambiguous.position).toBeUndefined();
  });
  it.each([
    'INVALID',
    'N0CALL>APRS:!9960.00N/07201.75W-Test',
    'N0CALL>APRS:>Line\nN1CALL>APRS:>Other',
  ])('rejects malformed packet %s', (packet) => {
    expect(() => parseAprsTnc2(packet)).toThrow();
  });
  it('validates the standard CRC check vector and a UI frame checksum', () => {
    expect(ax25Fcs(new TextEncoder().encode('123456789'))).toBe(0x906e);
    const frame = uiFrame();
    expect(ax25ToTnc2(frame)).toBe(
      'N0CALL>APRS:!4903.50N/07201.75W-Synthetic fixture',
    );
    frame[20]! ^= 1;
    expect(() => ax25ToTnc2(frame)).toThrow('checksum');
  });
});

describe('recorded PCM demodulation', () => {
  it.each([16000, 22050, 32000, 48000])(
    'decodes a synthetic Bell 202/HDLC/FCS packet at %s Hz',
    (rate) => {
      const fixture = afskFixture(rate);
      const result = decodeWave('AFSK1200', fixture.wav);
      expect(result.packets).toHaveLength(1);
      expect(result.packets[0]?.frameBase64).toBe(
        Buffer.from(fixture.frame).toString('base64'),
      );
    },
  );
  it('detects timed DTMF sequences without labeling silence or single-frequency audio', () => {
    const result = decodeWave('DTMF', dtmfFixture());
    expect(result.tones.map((tone) => tone.symbol).join('')).toBe('12#');
    expect(result.tones[0]?.startMs).toBeGreaterThanOrEqual(20);
    expect(result.tones[0]?.endMs).toBeLessThan(230);
    const single = Int16Array.from(
      { length: 16000 },
      (_, i) => Math.sin((i / 16000) * 2 * Math.PI * 697) * 12000,
    );
    expect(decodeWave('DTMF', wave(single, 16000)).tones).toEqual([]);
    expect(
      decodeWave('AFSK1200', wave(new Int16Array(16000), 16000)).packets,
    ).toEqual([]);
  });
  it('rejects unsupported audio instead of pretending to decode it', () => {
    const stereo = dtmfFixture();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => readPcmWave(stereo)).toThrow('mono PCM16');
    expect(() => readPcmWave(new Uint8Array([1, 2, 3]))).toThrow();
  });
  it('executes the real decoder in a bounded worker', async () => {
    const result = await decodeRecording('DTMF', dtmfFixture());
    expect(result.tones.map((tone) => tone.symbol).join('')).toBe('12#');
  });
  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)(
    'decodes a generated AFSK fixture after a synthetic SBC round trip',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'signaldock-afsk-'));
      try {
        writeFileSync(join(directory, 'input.wav'), afskFixture().wav);
        execFileSync('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-i',
          join(directory, 'input.wav'),
          '-c:a',
          'sbc',
          '-global_quality',
          '1888',
          '-sbc_delay',
          '0.0075',
          '-f',
          'sbc',
          join(directory, 'audio.sbc'),
        ]);
        execFileSync('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-f',
          'sbc',
          '-i',
          join(directory, 'audio.sbc'),
          '-ac',
          '1',
          '-ar',
          '32000',
          '-c:a',
          'pcm_s16le',
          join(directory, 'roundtrip.wav'),
        ]);
        expect(
          decodeWave('AFSK1200', readFileSync(join(directory, 'roundtrip.wav')))
            .packets,
        ).toHaveLength(1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('terminates a worker on timeout and honors cancellation', async () => {
    await expect(
      decodeRecording('AFSK1200', wave(new Int16Array(48000 * 120), 48000), {
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    const controller = new AbortController();
    const pending = decodeRecording('AFSK1200', afskFixture().wav, {
      signal: controller.signal,
    });
    controller.abort(new Error('Owner cancelled.'));
    await expect(pending).rejects.toThrow('Owner cancelled.');
  });
});
