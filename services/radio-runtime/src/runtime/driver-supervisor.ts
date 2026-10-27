import { setTimeout as delay } from 'node:timers/promises';
import { SignalDockError, type ErrorCode } from '@signaldock/contracts';
import { RadioRuntime } from './radio-runtime.js';

/** Supervises installed driver connections; never launches arbitrary commands. */
export class DriverSupervisor {
  private readonly tasks = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private readonly failures = new Map<string, ErrorCode>();
  constructor(
    private readonly runtime: RadioRuntime,
    private readonly pollMs = 1000,
  ) {}

  start(radioId: string): void {
    if (this.tasks.has(radioId)) return;
    this.runtime.getDriver(radioId);
    const controller = new AbortController();
    const task = this.run(radioId, controller.signal).catch(() => undefined);
    this.tasks.set(radioId, { controller, task });
  }
  failure(radioId: string): ErrorCode | undefined {
    return this.failures.get(radioId);
  }
  async stop(radioId: string): Promise<void> {
    const running = this.tasks.get(radioId);
    if (!running) return;
    running.controller.abort();
    await running.task;
    this.tasks.delete(radioId);
  }
  async close(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((id) => this.stop(id)));
  }

  private async run(radioId: string, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const driver = this.runtime.getDriver(radioId);
      try {
        if (driver.getSnapshot().connection !== 'ready' || failures)
          await this.runtime.connect(radioId);
        this.failures.delete(radioId);
        failures = 0;
        if (driver.watchSnapshots) {
          for await (const snapshot of driver.watchSnapshots(signal)) {
            if (signal.aborted) break;
            this.runtime.observeSnapshot(snapshot);
          }
        } else {
          await this.runtime.reconcile(radioId);
        }
      } catch (error) {
        if (signal.aborted) break;
        failures++;
        this.failures.set(
          radioId,
          error instanceof SignalDockError ? error.code : 'RADIO_UNAVAILABLE',
        );
        this.runtime.invalidateControl(radioId, 'driver_unavailable');
        this.runtime.observeSnapshot(driver.getSnapshot());
      }
      try {
        await delay(
          Math.min(30000, this.pollMs * 2 ** Math.min(failures, 5)),
          undefined,
          { signal },
        );
      } catch {
        break;
      }
    }
  }
}
