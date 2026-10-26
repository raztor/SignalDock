import { describe, expect, it } from 'vitest';
import type { RadioSnapshot } from '@signaldock/contracts';
import { CoverageTracker, TuningHistory } from '../src/app/radio-context.js';

const snapshot: RadioSnapshot = {
  radioId: crypto.randomUUID(),
  generation: crypto.randomUUID(),
  revision: 1,
  connection: 'ready',
  observedTuning: { rxHz: 147540000, mode: 'FM' },
  tuningConfidence: 'confirmed',
  txState: 'idle',
};
describe('observed audio context', () => {
  it('never substitutes latest tuning for a missing or contradictory revision', () => {
    const history = new TuningHistory(2);
    history.observe(snapshot);
    history.observe({
      ...snapshot,
      revision: 2,
      observedTuning: { rxHz: 146500000, mode: 'FM' },
    });
    expect(
      history.get(snapshot.radioId, snapshot.generation, 1)?.observedTuning
        ?.rxHz,
    ).toBe(147540000);
    expect(
      history.get(snapshot.radioId, crypto.randomUUID(), 1),
    ).toBeUndefined();
    history.observe({
      ...snapshot,
      observedTuning: { rxHz: 145000000, mode: 'FM' },
    });
    expect(
      history.get(snapshot.radioId, snapshot.generation, 1),
    ).toBeUndefined();
    history.observe(snapshot);
    expect(
      history.get(snapshot.radioId, snapshot.generation, 1),
    ).toBeUndefined();
  });
  it('records coverage only from ingress and ends at the last observed frame', async () => {
    const opened: unknown[] = [],
      closed: unknown[] = [];
    let now = Date.parse('2026-10-26T00:00:00Z');
    const tracker = new CoverageTracker(
      {
        openCoverage: async (input) => {
          opened.push(input);
          return crypto.randomUUID();
        },
        closeCoverage: async (...args) => {
          closed.push(args);
        },
      },
      (error) => {
        throw error;
      },
      () => now,
    );
    tracker.observe(snapshot);
    expect(opened).toHaveLength(0);
    const context = {
      instanceId: crypto.randomUUID(),
      radioId: snapshot.radioId,
      generation: snapshot.generation,
      direction: 'rx' as const,
      tuningRevision: 1,
      frequencyHz: 147540000,
      attributionConfidence: 'confirmed' as const,
    };
    tracker.push(context);
    now += 1000;
    tracker.push(context);
    now += 5000;
    tracker.observe({ ...snapshot, connection: 'disconnected' });
    await tracker.close();
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect((closed[0] as unknown[])[2]).toBe('2026-10-26T00:00:01.000Z');
  });
});
