import { describe, expect, it } from 'vitest';
import {
  isDark,
  qrMatrix,
  qrPath,
  qrViewBoxSize,
  QR_QUIET_ZONE,
} from './qr-model';

describe('qrMatrix', () => {
  it('encodes a station URL into a square symbol', () => {
    const matrix = qrMatrix('https://radio.example.com/');
    expect(matrix.size).toBe(17 + 4 * matrix.version);
    expect(matrix.dark).toHaveLength(matrix.size * matrix.size);
  });

  it('places the three finder patterns', () => {
    const matrix = qrMatrix('https://radio.example.com/');
    const last = matrix.size - 1;
    for (const [row, col] of [
      [0, 0],
      [0, last - 6],
      [last - 6, 0],
    ] as const) {
      // Outer ring dark, ring inside it light, 3×3 centre dark.
      expect(isDark(matrix, row, col)).toBe(true);
      expect(isDark(matrix, row + 6, col + 6)).toBe(true);
      expect(isDark(matrix, row + 1, col + 1)).toBe(false);
      expect(isDark(matrix, row + 3, col + 3)).toBe(true);
    }
    expect(isDark(matrix, -1, 0)).toBe(false);
    expect(isDark(matrix, 0, matrix.size)).toBe(false);
  });

  it('is deterministic', () => {
    expect(qrMatrix('https://a.example/').dark).toEqual(
      qrMatrix('https://a.example/').dark,
    );
  });
});

describe('qrPath', () => {
  it('merges horizontal runs and offsets by the quiet zone', () => {
    const matrix = {
      size: 3,
      version: 1,
      dark: [true, true, false, false, false, false, false, true, true],
    };
    expect(qrPath(matrix, 1)).toBe('M1 1h2v1h-2zM2 3h2v1h-2z');
    expect(qrViewBoxSize(matrix, 1)).toBe(5);
  });

  it('covers every dark module of a real symbol', () => {
    const matrix = qrMatrix('https://radio.example.com/');
    const covered = qrPath(matrix)
      .split('z')
      .filter(Boolean)
      .reduce((sum, part) => sum + Number(/h(\d+)/.exec(part)?.[1] ?? 0), 0);
    expect(covered).toBe(matrix.dark.filter(Boolean).length);
    expect(qrViewBoxSize(matrix)).toBe(matrix.size + 2 * QR_QUIET_ZONE);
  });
});
