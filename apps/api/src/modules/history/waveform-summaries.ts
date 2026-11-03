import { LruCache } from './lru-cache.js';

/** Waveform decodes allowed to run at once across all requests. */
export const MAX_CONCURRENT_WAVEFORM_DECODES = 2;

/**
 * Finished waveform summaries (LRU) plus the decodes still running.
 *
 * Concurrent requests for the same key share one in-flight computation, so
 * several viewers scrolling the same uncached recordings read and decode each
 * recording once. Distinct keys queue behind a small global concurrency limit
 * so the recording buffers held in memory stay bounded. Callers must authorize
 * the request before calling `load`; this class never checks permissions.
 */
export class WaveformSummaries<V> {
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;

  constructor(
    readonly cache: LruCache<string, V>,
    readonly maxConcurrent: number = MAX_CONCURRENT_WAVEFORM_DECODES,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
      throw new RangeError('Decode concurrency must be a positive integer.');
  }

  /** Number of distinct keys currently being computed or queued. */
  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * Return the cached summary for `key`, join a computation already running
   * for it, or start `compute`. A successful result is cached; a failure is
   * not cached and is reported to every caller that joined it.
   */
  load(key: string, compute: () => Promise<V>): Promise<V> {
    const cached = this.cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = this.limited(compute).then(
      (value) => {
        this.cache.set(key, value);
        this.inFlight.delete(key);
        return value;
      },
      (error: unknown) => {
        this.inFlight.delete(key);
        throw error;
      },
    );
    this.inFlight.set(key, task);
    return task;
  }

  private async limited(compute: () => Promise<V>): Promise<V> {
    if (this.running >= this.maxConcurrent)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running += 1;
    try {
      return await compute();
    } finally {
      // Hand the slot straight to the next queued decode, if any.
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
