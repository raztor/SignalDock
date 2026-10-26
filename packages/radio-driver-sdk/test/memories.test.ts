import { describe, expect, it } from 'vitest';
import { SimulatedRadioDriver, simulationDescriptors } from '../src/index.js';
import type { RadioSnapshot } from '@signaldock/contracts';
function context(snapshot: RadioSnapshot) {
  return {
    operationId: crypto.randomUUID(),
    radioId: snapshot.radioId,
    generation: snapshot.generation,
    expectedRevision: snapshot.revision,
    controlGrant: crypto.randomUUID(),
    deadline: new Date(Date.now() + 5000).toISOString(),
  };
}
describe('simulated memory conformance', () => {
  it('recalls an independent memory without overwriting the previous memory', async () => {
    const radio = new SimulatedRadioDriver(simulationDescriptors()[0]!);
    const initial = await radio.connect();
    const first = await radio.readMemory('0');
    const selected = await radio.selectMemory(context(initial), '1');
    expect(selected.selectedMemoryId).toBe('1');
    expect(await radio.readMemory('0')).toEqual(first);
    const memory = await radio.readMemory('0');
    await radio.writeMemory(context(selected), {
      ...memory,
      name: 'Stored alternate',
      tuning: { rxHz: 146000000, mode: 'FM' },
    });
    expect(radio.getSnapshot().observedTuning).toEqual(selected.observedTuning);
    expect((await radio.readMemory('0')).tuning.rxHz).toBe(146000000);
  });
  it('rejects unsupported selection on the independent receiver', async () => {
    const radio = new SimulatedRadioDriver(simulationDescriptors()[1]!);
    const initial = await radio.connect();
    await expect(
      radio.selectMemory(context(initial), '1'),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(radio.getSnapshot()).toEqual(initial);
  });
});
