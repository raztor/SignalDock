import { describe, expect, it } from 'vitest';
import {
  decodePcmSocketFrame,
  encodePcmSocketFrame,
} from '../src/pcm-websocket.js';

describe('PCM WebSocket wire format', () => {
  it('round-trips counters beyond 32 bits and exact PCM bytes', () => {
    const frame = {
      sequence: 2 ** 40,
      mediaTimeUs: 2 ** 45,
      tuningRevision: 2 ** 42,
      data: Uint8Array.of(0, 128, 255, 127),
    };
    expect(decodePcmSocketFrame(encodePcmSocketFrame(frame))).toEqual(frame);
  });
  it('rejects truncated, oversized, fractional and non-finite packets', () => {
    for (const length of [0, 24, 25, 1306])
      expect(() => decodePcmSocketFrame(new Uint8Array(length))).toThrow();
    for (const sequence of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() =>
        encodePcmSocketFrame({
          sequence,
          mediaTimeUs: 0,
          tuningRevision: 0,
          data: new Uint8Array(1280),
        }),
      ).toThrow();
  });
});
