import type { RadioSnapshot } from '@signaldock/contracts';
import type { CaptureContext, HistoryService } from '@signaldock/history';

/** A driver must never assign two tunings to one immutable revision. */
export class TuningHistory {
  private readonly snapshots = new Map<string, RadioSnapshot>();
  private readonly conflicts = new Set<string>();
  constructor(private readonly limit = 4096) {}
  private key(id: string, generation: string, revision: number) {
    return `${id}:${generation}:${revision}`;
  }
  observe(snapshot: RadioSnapshot): void {
    const key = this.key(
      snapshot.radioId,
      snapshot.generation,
      snapshot.revision,
    );
    const previous = this.snapshots.get(key);
    if (
      previous?.observedTuning &&
      snapshot.observedTuning &&
      JSON.stringify(previous.observedTuning) !==
        JSON.stringify(snapshot.observedTuning)
    )
      this.conflicts.add(key);
    this.snapshots.set(key, structuredClone(snapshot));
    if (this.snapshots.size > this.limit) {
      const oldest = this.snapshots.keys().next().value!;
      this.snapshots.delete(oldest);
      this.conflicts.delete(oldest);
    }
  }
  get(
    id: string,
    generation: string,
    revision: number,
  ): RadioSnapshot | undefined {
    const key = this.key(id, generation, revision);
    return this.conflicts.has(key) ? undefined : this.snapshots.get(key);
  }
}

/** Coverage begins with audio ingress and ends at the last observed frame on interruption. */
export class CoverageTracker {
  private readonly active = new Map<
    string,
    { key: string; id?: string; lastAt: number; context: CaptureContext }
  >();
  private pending = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly history: Pick<
      HistoryService,
      'openCoverage' | 'closeCoverage'
    >,
    private readonly onError: (error: unknown) => void,
    private readonly now = Date.now,
  ) {
    this.timer = setInterval(() => {
      for (const [radioId, state] of this.active)
        if (this.now() - state.lastAt >= 3000)
          this.end(radioId, 'audio_ingress_interrupted');
    }, 1000);
    this.timer.unref();
  }
  push(context: CaptureContext): void {
    if (context.direction !== 'rx') return;
    const key = JSON.stringify([
      context.generation,
      context.tuningRevision,
      context.frequencyHz,
      context.attributionConfidence,
    ]);
    const previous = this.active.get(context.radioId);
    const at = this.now();
    if (previous?.key === key) {
      previous.lastAt = at;
      return;
    }
    this.end(context.radioId, 'observed_audio_context_changed');
    const state = { key, lastAt: at, context } as {
      key: string;
      id?: string;
      lastAt: number;
      context: CaptureContext;
    };
    this.active.set(context.radioId, state);
    this.pending = this.pending
      .then(async () => {
        state.id = await this.history.openCoverage({
          instanceId: context.instanceId,
          radioId: context.radioId,
          generation: context.generation,
          attribution: context.attributionConfidence,
          startedAt: new Date(at).toISOString(),
          ...(context.frequencyHz === undefined
            ? {}
            : { frequencyHz: context.frequencyHz }),
        });
      })
      .catch(this.onError);
  }
  observe(snapshot: RadioSnapshot): void {
    const state = this.active.get(snapshot.radioId);
    if (
      state &&
      (snapshot.connection !== 'ready' ||
        snapshot.generation !== state.context.generation ||
        snapshot.revision !== state.context.tuningRevision)
    )
      this.end(snapshot.radioId, 'radio_context_changed');
  }
  private end(radioId: string, reason: string): void {
    const state = this.active.get(radioId);
    if (!state) return;
    this.active.delete(radioId);
    const endedAt = new Date(state.lastAt).toISOString();
    this.pending = this.pending
      .then(async () => {
        if (state.id)
          await this.history.closeCoverage(
            state.context.instanceId,
            state.id,
            endedAt,
            reason,
          );
      })
      .catch(this.onError);
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const radioId of this.active.keys())
      this.end(radioId, 'station_shutdown');
    await this.pending;
  }
}
