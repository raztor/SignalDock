import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import {
  SignalDockError,
  type RadioConfiguration,
} from '@signaldock/contracts';
import type { RadioDriver } from '@signaldock/radio-driver-sdk';
import type { RadioDriverFactory } from './driver-factory.js';

/** Bounded initial connection supervision; never replays operations or starts TX. */
export class RadioAttachmentSupervisor {
  private readonly records = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private readonly endpoints = new Set<string>();
  private readonly connected = new Map<string, string>();
  private active = 0;
  private closed = false;
  constructor(
    private readonly options: {
      factory: RadioDriverFactory;
      current: (configuration: RadioConfiguration) => boolean;
      register: (driver: RadioDriver) => void;
      failure: (radioId: string, error: unknown) => void;
      retryMs?: number;
      attemptTimeoutMs?: number;
      concurrency?: number;
    },
  ) {
    for (const [name, value, max] of [
      ['retryMs', options.retryMs ?? 500, 30000],
      ['attemptTimeoutMs', options.attemptTimeoutMs ?? 120000, 120000],
      ['concurrency', options.concurrency ?? 4, 16],
    ] as const) {
      if (!Number.isInteger(value) || value < 1 || value > max)
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          `Invalid radio attachment ${name}.`,
        );
    }
  }
  start(configuration: RadioConfiguration): void {
    if (this.closed || this.records.has(configuration.radioId)) return;
    const controller = new AbortController();
    const task = this.run(configuration, controller.signal).catch(
      (error: unknown) => {
        if (!controller.signal.aborted)
          this.options.failure(configuration.radioId, error);
      },
    );
    this.records.set(configuration.radioId, { controller, task });
  }
  async stop(radioId: string): Promise<void> {
    const record = this.records.get(radioId);
    if (!record) return;
    record.controller.abort();
    await record.task;
    if (this.records.get(radioId) === record) this.records.delete(radioId);
  }
  release(radioId: string): void {
    for (const [key, owner] of this.connected)
      if (owner === radioId) this.connected.delete(key);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.records.keys()].map((id) => this.stop(id)));
  }
  private async run(
    configuration: RadioConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    const key = endpointKey(configuration);
    let failures = 0;
    while (!signal.aborted && this.options.current(configuration)) {
      if (
        this.active >= (this.options.concurrency ?? 4) ||
        this.endpoints.has(key) ||
        this.connected.has(key)
      ) {
        if (!(await pause(this.options.retryMs ?? 500, signal))) return;
        continue;
      }
      this.active++;
      this.endpoints.add(key);
      const attempt = new AbortController();
      const abort = () => attempt.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(
        () =>
          attempt.abort(
            new SignalDockError(
              'DEADLINE_EXCEEDED',
              'Initial radio attachment timed out.',
            ),
          ),
        this.options.attemptTimeoutMs ?? 120000,
      );
      if (signal.aborted) abort();
      // Keep the endpoint reserved until the underlying open/late cleanup settles,
      // even when its abort wrapper has already returned to shutdown/reconfigure.
      const opening = Promise.resolve()
        .then(() => {
          attempt.signal.throwIfAborted();
          return this.options.factory(configuration, {
            signal: attempt.signal,
          });
        })
        .then(async (driver) => {
          if (
            attempt.signal.aborted ||
            this.closed ||
            !this.options.current(configuration)
          ) {
            await dispose(driver);
            throw (
              attempt.signal.reason ??
              new Error('Radio attachment was superseded.')
            );
          }
          return driver;
        })
        .finally(() => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', abort);
          this.active--;
          this.endpoints.delete(key);
        });
      try {
        const driver = await untilAborted(opening, attempt.signal);
        if (
          signal.aborted ||
          this.closed ||
          !this.options.current(configuration)
        ) {
          await dispose(driver);
          return;
        }
        try {
          this.options.register(driver);
          this.connected.set(key, configuration.radioId);
        } catch (error) {
          await dispose(driver);
          throw error;
        }
        return;
      } catch (error) {
        if (
          signal.aborted ||
          this.closed ||
          !this.options.current(configuration)
        )
          return;
        this.options.failure(configuration.radioId, error);
        failures++;
      }
      if (
        !(await pause(
          Math.min(
            30000,
            (this.options.retryMs ?? 500) * 2 ** Math.min(failures - 1, 6),
          ),
          signal,
        ))
      )
        return;
    }
  }
}
function endpointKey(configuration: RadioConfiguration): string {
  const endpoint = configuration.endpoint;
  if (!endpoint) return `radio:${configuration.radioId}`;
  if (endpoint.startsWith('unix:')) return `unix:${resolve(endpoint.slice(5))}`;
  try {
    return new URL(`https://${endpoint}`).host.toLowerCase();
  } catch {
    return endpoint;
  }
}
async function dispose(driver: RadioDriver): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = Promise.resolve().then(() => driver.disconnect());
    await Promise.race([
      operation,
      new Promise<void>((resolveValue) => {
        timeout = setTimeout(resolveValue, 5000);
      }),
    ]);
  } catch {
    /* A closed transport cannot establish physical state; it is never registered. */
  } finally {
    if (timeout) clearTimeout(timeout);
    if ('close' in driver && typeof driver.close === 'function') driver.close();
  }
}
async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await delay(ms, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error('Radio attachment cancelled.'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(
      (value) => {
        cleanup();
        resolveValue(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
