import { describe, expect, it } from 'vitest';
import {
  SimulatedRadioDriver,
  simulationDescriptors,
} from '@signaldock/radio-driver-sdk';
import type { TuningCommand } from '@signaldock/contracts';
import { RadioRuntime, createSimulationRig } from '../src/index.js';

const epoch = Date.parse('2026-10-26T12:00:00Z');
function command(
  runtime: RadioRuntime,
  radioId: string,
  grantId: string,
): TuningCommand {
  const state = runtime.snapshot(radioId);
  return {
    context: {
      operationId: crypto.randomUUID(),
      radioId,
      generation: state.generation,
      expectedRevision: state.revision,
      deadline: new Date(epoch + 10000).toISOString(),
      controlGrant: grantId,
    },
    tuning: { rxHz: radioId.endsWith('1') ? 145500000 : 435000000, mode: 'FM' },
  };
}

describe('multi-radio runtime foundation', () => {
  it('keeps control owners and state independent across two radios', async () => {
    const runtime = await createSimulationRig(() => epoch);
    const [a, b] = runtime.list();
    const lease = runtime.acquireControl(a!.radioId, crypto.randomUUID());
    runtime.acquireControl(b!.radioId, crypto.randomUUID());
    const beforeB = runtime.snapshot(b!.radioId);
    await runtime.applyTuning(command(runtime, a!.radioId, lease.grantId));
    expect(runtime.snapshot(b!.radioId)).toEqual(beforeB);
    expect(runtime.snapshot(a!.radioId).observedTuning?.rxHz).toBe(145500000);
    expect(() =>
      runtime.acquireControl(a!.radioId, crypto.randomUUID()),
    ).toThrow(expect.objectContaining({ code: 'CONTROL_BUSY' }));
  });
  it('returns an operation result without applying the write again', async () => {
    const runtime = await createSimulationRig(() => epoch);
    const radio = runtime.list()[0]!;
    const lease = runtime.acquireControl(radio.radioId, crypto.randomUUID());
    const input = command(runtime, radio.radioId, lease.grantId);
    const first = await runtime.applyTuning(input);
    expect(await runtime.applyTuning(input)).toEqual(first);
    expect(runtime.snapshot(radio.radioId).revision).toBe(2);
    await expect(
      runtime.applyTuning({
        ...input,
        tuning: { rxHz: 146000000, mode: 'FM' },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  });
  it('rejects stale revisions and expired commands', async () => {
    const runtime = await createSimulationRig(() => epoch);
    const radio = runtime.list()[0]!;
    const lease = runtime.acquireControl(radio.radioId, crypto.randomUUID());
    const input = command(runtime, radio.radioId, lease.grantId);
    await runtime.applyTuning(input);
    await expect(
      runtime.applyTuning({
        ...input,
        context: { ...input.context, operationId: crypto.randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(
      runtime.applyTuning({
        ...input,
        context: { ...input.context, deadline: new Date(epoch).toISOString() },
      }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  });
  it('expires ownership and cannot renew a stale driver generation', async () => {
    let now = epoch;
    const runtime = new RadioRuntime(() => now);
    const driver = new SimulatedRadioDriver(
      simulationDescriptors()[0]!,
      () => now,
    );
    await driver.connect();
    runtime.register(driver);
    const lease = runtime.acquireControl(
      driver.descriptor.radioId,
      crypto.randomUUID(),
    );
    const input = command(runtime, lease.radioId, lease.grantId);
    now += 16000;
    await expect(runtime.applyTuning(input)).rejects.toMatchObject({
      code: 'CONTROL_REQUIRED',
    });
    now = epoch;
    await driver.connect();
    await expect(runtime.applyTuning(input)).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });
    expect(runtime.snapshot(lease.radioId).txState).toBe('idle');
  });
  it('does not simulate success for an unsupported tuning write', async () => {
    const runtime = await createSimulationRig(() => epoch);
    const radio = runtime.list()[1]!;
    const lease = runtime.acquireControl(radio.radioId, crypto.randomUUID());
    const before = runtime.snapshot(radio.radioId);
    await expect(
      runtime.applyTuning(command(runtime, radio.radioId, lease.grantId)),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(runtime.snapshot(radio.radioId)).toEqual(before);
  });
  it('rejects tuning outside the advertised ranges', async () => {
    const runtime = await createSimulationRig(() => epoch);
    const radio = runtime.list()[0]!;
    const lease = runtime.acquireControl(radio.radioId, crypto.randomUUID());
    const input = command(runtime, radio.radioId, lease.grantId);
    await expect(
      runtime.applyTuning({
        ...input,
        tuning: { rxHz: 435000000, mode: 'FM' },
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });
  it('excludes operators across a shared physical resource group', async () => {
    const runtime = new RadioRuntime(() => epoch);
    for (const descriptor of simulationDescriptors()) {
      descriptor.resourceGroupIds = ['shared-sound-card'];
      const driver = new SimulatedRadioDriver(descriptor, () => epoch);
      await driver.connect();
      runtime.register(driver);
    }
    const [a, b] = runtime.list();
    const lease = runtime.acquireControl(a!.radioId, crypto.randomUUID());
    expect(() =>
      runtime.acquireControl(b!.radioId, crypto.randomUUID()),
    ).toThrow(expect.objectContaining({ code: 'CONTROL_BUSY' }));
    runtime.releaseControl(a!.radioId, lease.grantId);
    expect(
      runtime.acquireControl(b!.radioId, crypto.randomUUID()).radioId,
    ).toBe(b!.radioId);
  });
  it('does not allow a duplicate hardware endpoint registration', async () => {
    const runtime = new RadioRuntime();
    const [a, b] = simulationDescriptors();
    const driverA = Object.assign(new SimulatedRadioDriver(a!), {
      hardwareEndpoint: 'serial:/dev/example',
    });
    const driverB = Object.assign(new SimulatedRadioDriver(b!), {
      hardwareEndpoint: 'serial:/dev/example',
    });
    runtime.register(driverA);
    expect(() => runtime.register(driverB)).toThrow(
      expect.objectContaining({ code: 'OPERATION_CONFLICT' }),
    );
  });
});
