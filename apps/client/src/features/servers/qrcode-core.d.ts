/**
 * Minimal types for the encoder core of the `qrcode` package (MIT). Only the
 * pure symbol encoder is imported: it has no canvas, file system or PNG
 * dependencies, so it bundles for web and native alike.
 */
declare module 'qrcode/lib/core/qrcode' {
  export interface QrBitMatrix {
    size: number;
    data: Uint8Array;
    get(row: number, col: number): number;
  }
  export interface QrSymbol {
    modules: QrBitMatrix;
    version: number;
  }
  export function create(
    data: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
  ): QrSymbol;
}
