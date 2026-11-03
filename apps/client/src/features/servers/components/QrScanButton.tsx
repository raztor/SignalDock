/**
 * Web (and default) build: there is no QR scanning in the browser, so no scan
 * button is shown. The native build lives in QrScanButton.native.tsx.
 */
export interface QrScanButtonProps {
  /** Receives the canonical station base URL read from a QR code. */
  onScanned: (url: string) => void;
  disabled?: boolean;
}

export function QrScanButton(_props: QrScanButtonProps): null {
  return null;
}
