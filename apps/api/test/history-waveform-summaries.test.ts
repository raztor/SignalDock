import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/modules/history/lru-cache.js';
import { WaveformSummaries } from '../src/modules/history/waveform-summaries.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('history waveform summaries', () => {
  it('shares one in-flight computation per key and caches the result', async () => {
    const cache = new LruCache<string, { peaks: number[] }>(10);
    const summaries = new WaveformSummaries(cache);
    const gate = deferred<{ peaks: number[] }>();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return gate.promise;
    };
    const first = summaries.load('a', compute);
    const second = summaries.load('a', compute);
    await settle();
    expect(calls).toBe(1);
    expect(summaries.pending).toBe(1);
    expect(cache.size).toBe(0);
    gate.resolve({ peaks: [0.5] });
    expect(await first).toEqual({ peaks: [0.5] });
    expect(await second).toBe(await first);
    expect(summaries.pending).toBe(0);
    expect(cache.get('a')).toEqual({ peaks: [0.5] });
    // Served from the cache without computing again.
    expect(await summaries.load('a', compute)).toEqual({ peaks: [0.5] });
    expect(calls).toBe(1);
  });

  it('reports a failure to every caller and does not cache it', async () => {
    const cache = new LruCache<string, number>(10);
    const summaries = new WaveformSummaries(cache);
    const gate = deferred<number>();
    const first = summaries.load('a', () => gate.promise);
    const second = summaries.load('a', () => Promise.resolve(2));
    gate.reject(new Error('storage offline'));
    await expect(first).rejects.toThrow('storage offline');
    await expect(second).rejects.toThrow('storage offline');
    expect(cache.size).toBe(0);
    expect(summaries.pending).toBe(0);
    // A later request retries.
    expect(await summaries.load('a', () => Promise.resolve(3))).toBe(3);
  });

  it('runs at most the configured number of decodes at once', async () => {
    const summaries = new WaveformSummaries(
      new LruCache<string, number>(10),
      2,
    );
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const results = gates.map((gate, index) =>
      summaries.load(`k${index}`, async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      }),
    );
    await settle();
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve(1);
    await settle();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.reject(new Error('boom'));
    gates[2]!.resolve(2);
    await expect(results[0]).rejects.toThrow('boom');
    expect(await results[1]).toBe(1);
    expect(await results[2]).toBe(2);
    expect(peak).toBe(2);
    // The slots are free again after a failure.
    expect(
      await Promise.all([
        summaries.load('x', () => Promise.resolve(10)),
        summaries.load('y', () => Promise.resolve(11)),
        summaries.load('z', () => Promise.resolve(12)),
      ]),
    ).toEqual([10, 11, 12]);
  });

  it('rejects an invalid concurrency limit', () => {
    expect(() => new WaveformSummaries(new LruCache(1), 0)).toThrow(RangeError);
  });
});
