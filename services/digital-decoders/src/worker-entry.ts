import { decodeWave, type AudioDecodeMode } from './audio.js';

process.once(
  'message',
  (message: { mode: AudioDecodeMode; bytes: Uint8Array }) => {
    let response: unknown;
    try {
      response = { ok: true, result: decodeWave(message.mode, message.bytes) };
    } catch (error) {
      response = {
        ok: false,
        code:
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : 'INVALID_ARGUMENT',
        message: error instanceof Error ? error.message : 'Decoder failed.',
      };
    }
    process.send!(response, () => {
      process.disconnect();
    });
  },
);
