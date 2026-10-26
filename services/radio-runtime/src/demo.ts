import { createSimulationRig } from './index.js';

const runtime = await createSimulationRig();
const radio = runtime.list()[0]!;
const lease = runtime.acquireControl(radio.radioId, crypto.randomUUID());
const before = runtime.snapshot(radio.radioId);
const after = await runtime.applyTuning({
  context: {
    operationId: crypto.randomUUID(),
    radioId: radio.radioId,
    generation: before.generation,
    expectedRevision: before.revision,
    controlGrant: lease.grantId,
    deadline: new Date(Date.now() + 5000).toISOString(),
  },
  tuning: { rxHz: 145500000, mode: 'FM' },
});
runtime.releaseControl(radio.radioId, lease.grantId);
console.log(
  JSON.stringify(
    { simulated: true, radios: runtime.list(), before, after },
    null,
    2,
  ),
);
