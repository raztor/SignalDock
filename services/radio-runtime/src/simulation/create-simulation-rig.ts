import {
  SimulatedRadioDriver,
  simulationDescriptors,
} from '@signaldock/radio-driver-sdk';
import { RadioRuntime } from '../runtime/radio-runtime.js';

export async function createSimulationRig(
  now = Date.now,
): Promise<RadioRuntime> {
  const runtime = new RadioRuntime(now);
  for (const descriptor of simulationDescriptors()) {
    const driver = new SimulatedRadioDriver(descriptor, now);
    await driver.connect();
    runtime.register(driver);
  }
  return runtime;
}
