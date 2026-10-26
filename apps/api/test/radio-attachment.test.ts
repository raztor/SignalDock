import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SimulatedRadioDriver,
  simulationDescriptors,
  type RadioDriver,
} from '@signaldock/radio-driver-sdk';
import {
  SignalDockError,
  type DatabasePort,
  type Principal,
  type RadioConfiguration,
} from '@signaldock/contracts';
import {
  RadioApplicationService,
  RadioRepository,
  type RadioDriverFactory,
} from '../src/modules/radios/index.js';
const instanceId = crypto.randomUUID();
const principal: Principal = {
  instanceId,
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  username: 'test',
  role: 'administrator',
  radioPermissions: [],
};
class FixtureDatabase implements DatabasePort {
  readonly rows: Record<string, unknown>[] = [];
  async query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ) {
    if (sql.startsWith('INSERT')) {
      const [instance, id, name, driver, endpoint, config, groups, enabled] =
        values;
      const row = {
        instance_id: instance,
        id,
        display_name: name,
        driver_id: driver,
        endpoint,
        configuration: JSON.parse(String(config)),
        resource_group_ids: JSON.parse(String(groups)),
        enabled,
      };
      const i = this.rows.findIndex((r) => r['id'] === id);
      if (i < 0) this.rows.push(row);
      else this.rows[i] = row;
      return { rows: [] as T[], rowCount: 1 };
    }
    return {
      rows: this.rows.filter((r) => r['instance_id'] === values[0]) as T[],
      rowCount: this.rows.length,
    };
  }
  async transaction<T>(work: (tx: DatabasePort) => Promise<T>): Promise<T> {
    return work(this);
  }
}
const active: RadioApplicationService[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((service) => service.close()));
});
const config = (endpoint?: string): RadioConfiguration => ({
  radioId: crypto.randomUUID(),
  displayName: 'Radio',
  driverId: 'simulator.tunable',
  enabled: true,
  resourceGroupIds: [],
  config: {},
  ...(endpoint ? { endpoint } : {}),
});
async function driver(configuration: RadioConfiguration) {
  const result = new SimulatedRadioDriver({
    ...simulationDescriptors()[0]!,
    radioId: configuration.radioId,
    displayName: configuration.displayName,
  });
  await result.connect();
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function create(
  configurations: RadioConfiguration[],
  factory: RadioDriverFactory,
  extra: { attachmentTimeoutMs?: number; attachmentConcurrency?: number } = {},
) {
  const database = new FixtureDatabase();
  const repository = new RadioRepository(database, instanceId);
  for (const c of configurations) await repository.save(c);
  const service = new RadioApplicationService({
    instanceId,
    database,
    auth: {
      authenticate: async () => principal,
      authorize: async () => undefined,
    },
    driverFactory: factory,
    attachmentRetryMs: 10,
    ...extra,
  });
  active.push(service);
  await service.start();
  return service;
}
describe('independent initial radio attachment supervision', () => {
  it('starts without waiting for a delayed radio and attaches an independent radio', async () => {
    const slow = config(),
      fast = config();
    const gate = deferred<RadioDriver>();
    const factory = vi.fn<RadioDriverFactory>(async (c) =>
      c.radioId === slow.radioId ? gate.promise : driver(c),
    );
    const started = Date.now();
    const service = await create([slow, fast], factory);
    expect(Date.now() - started).toBeLessThan(500);
    await vi.waitFor(() =>
      expect(service.runtime.list().map((d) => d.radioId)).toContain(
        fast.radioId,
      ),
    );
    expect(service.runtime.list().map((d) => d.radioId)).not.toContain(
      slow.radioId,
    );
    gate.resolve(await driver(slow));
    await vi.waitFor(() => expect(service.runtime.list()).toHaveLength(2));
  });
  it('retries an initial failure automatically while other radios stay usable', async () => {
    const first = config(),
      second = config();
    let attempts = 0;
    const service = await create([first, second], async (c) => {
      if (c.radioId === first.radioId && ++attempts < 2)
        throw new SignalDockError('RADIO_UNAVAILABLE', 'Fixture unavailable.');
      return driver(c);
    });
    await vi.waitFor(() => expect(service.runtime.list()).toHaveLength(2));
    expect(attempts).toBe(2);
    expect((await service.get(principal, first.radioId)).health.state).toBe(
      'connected',
    );
  });
  it('cancels shutdown opening and disposes a late result without registering it', async () => {
    const c = config();
    const gate = deferred<RadioDriver>();
    let signal: AbortSignal | undefined;
    const service = await create([c], async (_c, context) => {
      signal = context?.signal;
      return gate.promise;
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await service.close();
    expect(signal?.aborted).toBe(true);
    const late = await driver(c);
    const disconnect = vi.spyOn(late, 'disconnect');
    gate.resolve(late);
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(service.runtime.list()).toEqual([]);
  });
  it('cancels an obsolete configuration and waits for its endpoint to settle before reopening', async () => {
    const c = config('unix:/private/tmp/shared-attachment.sock');
    const gate = deferred<RadioDriver>();
    let attempts = 0;
    let initialSignal: AbortSignal | undefined;
    const service = await create([c], async (current, context) => {
      attempts++;
      if (attempts === 1) {
        initialSignal = context?.signal;
        return gate.promise;
      }
      return driver(current);
    });
    await vi.waitFor(() => expect(attempts).toBe(1));
    await service.configure(principal, { ...c, displayName: 'Updated' });
    expect(initialSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);
    const late = await driver(c);
    const disconnect = vi.spyOn(late, 'disconnect');
    gate.resolve(late);
    await vi.waitFor(() =>
      expect(service.runtime.list()[0]?.displayName).toBe('Updated'),
    );
    expect(disconnect).toHaveBeenCalledOnce();
    expect(attempts).toBe(2);
  });
  it('bounds attempts and retains endpoint exclusion while a timed-out connector ignores cancellation', async () => {
    const c = config('unix:/private/tmp/timed-attachment.sock');
    const gate = deferred<RadioDriver>();
    let attempts = 0;
    let signal: AbortSignal | undefined;
    const service = await create(
      [c],
      async (current, context) => {
        attempts++;
        if (attempts === 1) {
          signal = context?.signal;
          return gate.promise;
        }
        return driver(current);
      },
      { attachmentTimeoutMs: 20 },
    );
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(attempts).toBe(1);
    expect((await service.get(principal, c.radioId)).health.errorCode).toBe(
      'DEADLINE_EXCEEDED',
    );
    gate.resolve(await driver(c));
    await vi.waitFor(() => expect(service.runtime.list()).toHaveLength(1));
    expect(attempts).toBe(2);
  });
  it('bounds concurrent openings and does not duplicate canonical physical endpoints', async () => {
    const a = config('unix:/private/tmp/sd-endpoint.sock'),
      b = config('unix:/private/tmp/../tmp/sd-endpoint.sock'),
      c = config('unix:/private/tmp/sd-independent.sock');
    const gates = new Map<string, ReturnType<typeof deferred<RadioDriver>>>();
    const factory = vi.fn<RadioDriverFactory>(async (current) => {
      const gate = deferred<RadioDriver>();
      gates.set(current.radioId, gate);
      return gate.promise;
    });
    const service = await create([a, b, c], factory, {
      attachmentConcurrency: 2,
    });
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(gates.has(b.radioId)).toBe(false);
    gates.get(a.radioId)!.resolve(await driver(a));
    gates.get(c.radioId)!.resolve(await driver(c));
    await vi.waitFor(() => expect(service.runtime.list()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
