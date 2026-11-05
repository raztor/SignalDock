import { describe, expect, it, vi } from 'vitest';
import { SignalDockError, type RadioSnapshot } from '@signaldock/contracts';
import {
  SimulatedRadioDriver,
  simulationDescriptors,
} from '@signaldock/radio-driver-sdk';
import { RadioRuntime } from '../src/runtime/radio-runtime.js';
import { DriverSupervisor } from '../src/runtime/driver-supervisor.js';

async function fixture(uncertain = false) {
  const base = new SimulatedRadioDriver(simulationDescriptors()[0]!);
  await base.connect();
  let state = base.getSnapshot();
  const initialGeneration = state.generation;
  const operations: string[] = [];
  vi.spyOn(base, 'getSnapshot').mockImplementation(() =>
    structuredClone(state),
  );
  const connect = vi.spyOn(base, 'connect').mockImplementation(async () => {
    operations.push('connect');
    state = {
      ...state,
      generation: crypto.randomUUID(),
      revision: 1,
      connection: 'ready',
      txState: 'idle',
    };
    return structuredClone(state);
  });
  const disconnect = vi
    .spyOn(base, 'disconnect')
    .mockImplementation(async () => {
      operations.push('disconnect');
      if (uncertain) {
        uncertain = false;
        throw new SignalDockError(
          'RADIO_STATE_UNCERTAIN',
          'Fixture physical idle is not confirmed.',
        );
      }
      state = { ...state, connection: 'disconnected', txState: 'idle' };
    });
  let first = true;
  const driver = Object.assign(base, {
    async *watchSnapshots(signal: AbortSignal): AsyncIterable<RadioSnapshot> {
      if (first) {
        first = false;
        state = {
          ...state,
          revision: state.revision + 1,
          connection: 'degraded',
          tuningConfidence: 'unknown',
        };
        yield structuredClone(state);
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  const runtime = new RadioRuntime();
  runtime.register(driver);
  const invalidate = vi.spyOn(runtime, 'invalidateControl');
  const supervisor = new DriverSupervisor(runtime, 5);
  return {
    supervisor,
    radioId: base.descriptor.radioId,
    runtime,
    connect,
    disconnect,
    operations,
    initialGeneration,
    invalidate,
  };
}
describe('persistent driver recovery', () => {
  it('recovers a degraded snapshot stream through disconnect and a fresh connection', async () => {
    const f = await fixture();
    f.supervisor.start(f.radioId);
    try {
      await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
      expect(f.operations).toEqual(['disconnect', 'connect']);
      expect(f.runtime.snapshot(f.radioId).generation).not.toBe(
        f.initialGeneration,
      );
      expect(f.runtime.snapshot(f.radioId).connection).toBe('ready');
      expect(f.invalidate).toHaveBeenCalledWith(
        f.radioId,
        'driver_unavailable',
      );
    } finally {
      await f.supervisor.close();
    }
  });
  it('does not reconnect past an unconfirmed physical stop, then retries when idle is confirmed', async () => {
    const f = await fixture(true);
    f.supervisor.start(f.radioId);
    try {
      await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
      expect(f.operations).toEqual(['disconnect', 'disconnect', 'connect']);
      expect(f.runtime.snapshot(f.radioId).txState).toBe('idle');
    } finally {
      await f.supervisor.close();
    }
    const attempts = f.disconnect.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.disconnect.mock.calls.length).toBe(attempts);
    expect(f.connect).toHaveBeenCalledOnce();
  });
});
