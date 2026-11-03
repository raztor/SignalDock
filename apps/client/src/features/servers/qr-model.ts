/**
 * QR code geometry for "Share station". Encoding comes from the `qrcode`
 * package's pure encoder core; this module turns its module matrix into one
 * SVG path so react-native-svg draws a single element instead of hundreds.
 */
import { create } from 'qrcode/lib/core/qrcode';

/** Light modules required around the symbol by the QR specification. */
export const QR_QUIET_ZONE = 4;

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number;
  version: number;
  /** Row-major, true = dark module. */
  dark: boolean[];
}

/** Encodes `text` with medium error correction (survives ~15 % damage). */
export function qrMatrix(text: string): QrMatrix {
  const symbol = create(text, { errorCorrectionLevel: 'M' });
  const { size, data } = symbol.modules;
  return {
    size,
    version: symbol.version,
    dark: Array.from(data, (value) => value === 1),
  };
}

export function isDark(matrix: QrMatrix, row: number, col: number): boolean {
  if (row < 0 || col < 0 || row >= matrix.size || col >= matrix.size)
    return false;
  return matrix.dark[row * matrix.size + col] === true;
}

/**
 * One path for every dark module, merging horizontal runs. Coordinates are in
 * modules and already offset by `quietZone`, so the viewBox side is
 * `size + 2 * quietZone`.
 */
export function qrPath(matrix: QrMatrix, quietZone = QR_QUIET_ZONE): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row++) {
    let col = 0;
    while (col < matrix.size) {
      if (!isDark(matrix, row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < matrix.size && isDark(matrix, row, col)) col++;
      parts.push(
        `M${start + quietZone} ${row + quietZone}h${col - start}v1h-${col - start}z`,
      );
    }
  }
  return parts.join('');
}

/** Side length of the square viewBox for a matrix plus its quiet zone. */
export function qrViewBoxSize(
  matrix: QrMatrix,
  quietZone = QR_QUIET_ZONE,
): number {
  return matrix.size + quietZone * 2;
}
