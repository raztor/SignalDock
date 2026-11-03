import type { BrowserMediaPort } from './controller';
/**
 * Native audio remains gated until Expo development-build acceptance passes.
 * Native connections never expose `level()`, so the received-audio meter
 * reports as unsupported (`RadioMediaController.rxLevelSupported` is false).
 */
export const browserMediaPort: BrowserMediaPort = {
  microphone: async () => {
    throw new Error('Native audio requires a validated development build.');
  },
  connect: async () => {
    throw new Error('Native audio requires a validated development build.');
  },
};
