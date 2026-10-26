import { spawn } from 'node:child_process';
import { SignalDockError, type PcmAudioFrame } from '@signaldock/contracts';

const demuxers: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/mp4': 'mov',
};
/** Authorized bytes only. The decoder can read pipes, never file/network URLs. */
export function decodePreparedAudio(
  input: { bytes: Uint8Array; contentType: string },
  signal: AbortSignal,
  ffmpeg = 'ffmpeg',
): Promise<Uint8Array> {
  const demuxer =
    demuxers[input.contentType.split(';')[0]!.trim().toLowerCase()];
  if (
    !demuxer ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > 16 * 1024 * 1024
  )
    return Promise.reject(
      new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Prepared audio must be a supported bounded audio artifact.',
      ),
    );
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const process = spawn(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'pipe',
        '-f',
        demuxer,
        '-i',
        'pipe:0',
        '-t',
        '31',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '32000',
        '-c:a',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const output: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.kill('SIGKILL');
      reject(error);
    };
    const abort = () =>
      fail(signal.reason ?? new Error('Audio conversion cancelled.'));
    const timer = setTimeout(
      () =>
        fail(
          new SignalDockError(
            'DEADLINE_EXCEEDED',
            'Audio conversion timed out.',
          ),
        ),
      15000,
    );
    signal.addEventListener('abort', abort, { once: true });
    process.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 32000 * 2 * 30)
        fail(
          new SignalDockError(
            'TX_LIMIT_REACHED',
            'Prepared audio exceeds the 30-second transmission limit.',
          ),
        );
      else output.push(chunk);
    });
    process.stderr.on('data', () => undefined);
    process.stdin.on('error', () => undefined);
    process.once('error', () =>
      fail(
        new SignalDockError(
          'REQUIRES_CONFIGURATION',
          'The configured audio decoder is unavailable.',
        ),
      ),
    );
    process.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0 || bytes === 0 || bytes % 2)
        reject(
          new SignalDockError(
            'INVALID_ARGUMENT',
            'Prepared audio could not be decoded.',
          ),
        );
      else resolve(new Uint8Array(Buffer.concat(output)));
    });
    process.stdin.end(input.bytes);
  });
}

export async function* preparedPcmFrames(
  bytes: Uint8Array,
  tuningRevision: number,
  signal: AbortSignal,
): AsyncIterable<PcmAudioFrame> {
  const streamId = crypto.randomUUID();
  const started = performance.now();
  let sequence = 0;
  for (let offset = 0; offset < bytes.length; offset += 1280) {
    signal.throwIfAborted();
    const delay = started + sequence * 20 - performance.now();
    if (delay > 0)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, delay);
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
      });
    signal.throwIfAborted();
    const data = new Uint8Array(1280);
    data.set(bytes.subarray(offset, offset + 1280));
    yield {
      streamId,
      sequence,
      mediaTimeUs: sequence++ * 20000,
      format: { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
      data,
      tuningRevision,
      attributionConfidence: 'confirmed',
      discontinuity: false,
    };
  }
}
