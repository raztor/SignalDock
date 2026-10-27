import { fork } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalDockError, ErrorCodeSchema } from '@signaldock/contracts';
import type { AudioDecodeMode, AudioDecodeResult } from './audio.js';

/** Accepts bounded bytes only: no user path, shell, network endpoint or radio control capability. */
export function decodeRecording(
  mode: AudioDecodeMode,
  bytes: Uint8Array,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AudioDecodeResult> {
  if (bytes.length > 16 * 1024 * 1024)
    return Promise.reject(
      new SignalDockError(
        'INVALID_ARGUMENT',
        'Recording exceeds the decoder byte limit.',
      ),
    );
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    return Promise.reject(
      new SignalDockError(
        'INVALID_ARGUMENT',
        'Decoder timeout must be 1–30000 ms.',
      ),
    );
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const workspace = dirname(dirname(packageRoot));
    const readRoots = [
      packageRoot,
      dirname(
        dirname(fileURLToPath(import.meta.resolve('@signaldock/contracts'))),
      ),
      `${workspace}/node_modules/@signaldock/contracts`,
      dirname(fileURLToPath(import.meta.resolve('zod'))),
    ];
    const worker = fork(new URL('./worker-entry.js', import.meta.url), [], {
      env: { NODE_ENV: 'production' },
      serialization: 'advanced',
      execArgv: [
        '--permission',
        ...readRoots.map((root) => `--allow-fs-read=${root}`),
        '--max-old-space-size=64',
        '--stack-size=2048',
      ],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (error?: unknown, result?: AudioDecodeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      worker.kill('SIGKILL');
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      finish(
        options.signal?.reason ??
          new SignalDockError('DEADLINE_EXCEEDED', 'Decoder cancelled.'),
      );
    const timer = setTimeout(
      () =>
        finish(
          new SignalDockError(
            'DEADLINE_EXCEEDED',
            'Decoder exceeded its time limit.',
          ),
        ),
      timeoutMs,
    );
    worker.once(
      'message',
      (message: {
        ok: boolean;
        result?: AudioDecodeResult;
        code?: unknown;
        message?: string;
      }) => {
        if (message.ok && message.result) finish(undefined, message.result);
        else
          finish(
            new SignalDockError(
              ErrorCodeSchema.safeParse(message.code).data ??
                'INVALID_ARGUMENT',
              message.message ?? 'Decoder failed.',
            ),
          );
      },
    );
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled)
        finish(
          new SignalDockError(
            'INTERNAL_ERROR',
            `Decoder worker exited before a result (${code}).`,
          ),
        );
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.send({ mode, bytes }, (error) => {
      if (error) finish(error);
    });
  });
}
