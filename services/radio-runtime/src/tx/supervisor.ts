import {
  SignalDockError,
  type AudioFormat,
  type PcmAudioFrame,
  type RadioSnapshot,
  type TxGrant,
  type TxState,
} from '@signaldock/contracts';

export interface TxRuntimePort {
  snapshot(radioId: string): RadioSnapshot;
  validateControl(input: {
    radioId: string;
    grantId: string;
    ownerId: string;
    sessionId?: string;
    generation: string;
  }): { fencing: number; expiresAt: number };
  reserveTransmission(input: {
    radioId: string;
    generation: string;
    controlGrant: string;
    ownerId: string;
    sessionId: string;
    txGrantId: string;
  }): void;
  releaseTransmission(
    radioId: string,
    txGrantId: string,
    confirmed: boolean,
  ): void;
}
export interface TxObservation {
  state: 'idle' | 'transmitting' | 'unknown';
  physicallyConfirmed: boolean;
}
export interface TxCurrentObservation extends TxObservation {
  radioId: string;
  generation: string;
}
export interface TxDriverPort {
  prepare(
    grant: TxGrant,
    format: AudioFormat,
    signal: AbortSignal,
  ): Promise<void>;
  write(
    grant: TxGrant,
    frame: PcmAudioFrame,
    signal: AbortSignal,
  ): Promise<void>;
  renew(grant: TxGrant, signal: AbortSignal): Promise<void>;
  end(grant: TxGrant, reason: string): Promise<TxObservation>;
  observe(grant: TxGrant): Promise<TxObservation>;
  /** Fresh current-epoch hardware observation, never a cached/runtime overlay. */
  observeCurrent?(context: {
    radioId: string;
    generation: string;
  }): Promise<TxCurrentObservation>;
}
export interface TxStartInput {
  radioId: string;
  ownerId: string;
  sessionId: string;
  controlGrant: string;
  generation: string;
  expectedRevision: number;
  instanceId?: string;
  source?: 'microphone' | 'tts';
}
export interface TxStatus {
  grant: TxGrant;
  state: TxState;
  reason?: string;
}
interface ActiveTx extends TxStatus {
  controller: AbortController;
  driver: TxDriverPort;
  format: AudioFormat;
  lastSequence: number;
  streamId?: string;
  lastMediaTimeUs: number;
  writing: boolean;
  openingSettled: boolean;
  pendingOperations: number;
  tuningKey: string;
  nextObservationAt: number;
  observing: boolean;
  source: 'microphone' | 'tts';
  stopPromise?: Promise<TxStatus>;
}

/** Local supervision is independent of the HTTP request and SFU token lifetime. */
export class TxSupervisor {
  private readonly active = new Map<string, ActiveTx>();
  private readonly byRadio = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxContinuousMs: number;
  private readonly timeoutMs: number;
  private closed = false;
  constructor(
    private readonly options: {
      runtime: TxRuntimePort;
      driver: (radioId: string) => TxDriverPort;
      now?: () => number;
      leaseMs?: number;
      maxContinuousMs?: number;
      operationTimeoutMs?: number;
      autoWatchdog?: boolean;
      onState?: (status: TxStatus) => void;
      onFrame?: (
        frame: PcmAudioFrame,
        grant: TxGrant,
        source: 'microphone' | 'tts',
      ) => void;
      onCaptureError?: (error: unknown, grant: TxGrant) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 1500;
    this.maxContinuousMs = options.maxContinuousMs ?? 30000;
    this.timeoutMs = options.operationTimeoutMs ?? 2500;
    if (options.autoWatchdog !== false) {
      this.timer = setInterval(() => {
        void this.sweep();
      }, 100);
      this.timer.unref?.();
    }
  }

  async start(input: TxStartInput, format: AudioFormat): Promise<TxStatus> {
    if (this.closed)
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'Transmission supervision is shutting down.',
      );
    const snapshot = this.options.runtime.snapshot(input.radioId);
    if (snapshot.generation !== input.generation)
      throw new SignalDockError(
        'STALE_GENERATION',
        'The radio generation changed.',
      );
    if (snapshot.revision !== input.expectedRevision)
      throw new SignalDockError('STALE_REVISION', 'The radio tuning changed.');
    if (
      snapshot.connection !== 'ready' ||
      snapshot.txState !== 'idle' ||
      snapshot.tuningConfidence !== 'confirmed' ||
      !snapshot.observedTuning
    )
      throw new SignalDockError(
        'RADIO_STATE_UNCERTAIN',
        'Radio state must be confirmed before transmission.',
      );
    if (this.byRadio.has(input.radioId))
      throw new SignalDockError(
        'CONTROL_BUSY',
        'A transmission already owns this radio.',
      );
    if (
      [...this.active.values()].some(
        (tx) =>
          tx.grant.sessionId === input.sessionId &&
          !['idle', 'failed_before_tx'].includes(tx.state),
      )
    )
      throw new SignalDockError(
        'CONTROL_BUSY',
        'A session can transmit on only one radio.',
      );
    this.assertFormat(format);
    const lease = this.options.runtime.validateControl({
      radioId: input.radioId,
      grantId: input.controlGrant,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      generation: input.generation,
    });
    const now = this.now();
    const grant: TxGrant = {
      txGrantId: crypto.randomUUID(),
      radioId: input.radioId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      controlGrant: input.controlGrant,
      generation: input.generation,
      fencing: lease.fencing,
      tuningRevision: snapshot.revision,
      expiresAt: Math.min(now + this.leaseMs, lease.expiresAt),
      maxUntil: now + this.maxContinuousMs,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    };
    const tx: ActiveTx = {
      grant,
      state: 'preparing',
      controller: new AbortController(),
      driver: this.options.driver(input.radioId),
      format: { ...format },
      lastSequence: -1,
      lastMediaTimeUs: -1,
      writing: false,
      openingSettled: false,
      pendingOperations: 0,
      tuningKey: JSON.stringify(snapshot.observedTuning),
      nextObservationAt: 0,
      observing: false,
      source: input.source ?? 'microphone',
    };
    this.options.runtime.reserveTransmission({
      radioId: input.radioId,
      generation: input.generation,
      controlGrant: input.controlGrant,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      txGrantId: grant.txGrantId,
    });
    this.active.set(grant.txGrantId, tx);
    this.byRadio.set(input.radioId, grant.txGrantId);
    this.notify(tx);
    try {
      const opening = Promise.resolve().then(() =>
        tx.driver.prepare({ ...grant }, format, tx.controller.signal),
      );
      void opening.then(
        () => {
          tx.openingSettled = true;
        },
        () => {
          tx.openingSettled = true;
        },
      );
      await bounded(opening, tx.controller.signal, this.timeoutMs);
      if (tx.controller.signal.aborted || this.expired(tx))
        throw new SignalDockError(
          'DEADLINE_EXCEEDED',
          'Transmission preparation expired or was cancelled.',
        );
      tx.state = 'granted';
      this.notify(tx);
      return this.status(tx);
    } catch (error) {
      await this.stop(grant.txGrantId, 'preparation_failed');
      throw error;
    }
  }

  async renew(
    txGrantId: string,
    ownerId: string,
    sessionId: string,
  ): Promise<TxStatus> {
    const tx = this.require(txGrantId, ownerId, sessionId);
    if (
      !['granted', 'transmitting', 'tx_unconfirmed'].includes(tx.state) ||
      this.expired(tx)
    ) {
      await this.stop(txGrantId, 'grant_expired');
      throw new SignalDockError('DEADLINE_EXCEEDED', 'The TX grant expired.');
    }
    try {
      const lease = this.options.runtime.validateControl({
        radioId: tx.grant.radioId,
        grantId: tx.grant.controlGrant,
        ownerId,
        sessionId,
        generation: tx.grant.generation,
      });
      if (lease.fencing !== tx.grant.fencing)
        throw new SignalDockError(
          'STALE_GENERATION',
          'The control fence changed.',
        );
      tx.grant.expiresAt = Math.min(
        this.now() + this.leaseMs,
        tx.grant.maxUntil,
        lease.expiresAt,
      );
      await bounded(
        this.admitted(tx, () =>
          tx.driver.renew({ ...tx.grant }, tx.controller.signal),
        ),
        tx.controller.signal,
        Math.min(this.timeoutMs, this.leaseMs),
      );
      return this.status(tx);
    } catch (error) {
      await this.stop(txGrantId, 'renewal_failed');
      throw error;
    }
  }

  async push(txGrantId: string, frame: PcmAudioFrame): Promise<TxStatus> {
    const tx = this.require(txGrantId);
    if (
      this.expired(tx) ||
      !['granted', 'transmitting', 'tx_unconfirmed'].includes(tx.state)
    ) {
      await this.stop(txGrantId, 'grant_expired');
      throw new SignalDockError(
        'DEADLINE_EXCEEDED',
        'The TX grant is inactive.',
      );
    }
    const snapshot = this.options.runtime.snapshot(tx.grant.radioId);
    if (
      snapshot.generation !== tx.grant.generation ||
      snapshot.tuningConfidence !== 'confirmed' ||
      JSON.stringify(snapshot.observedTuning) !== tx.tuningKey
    ) {
      await this.stop(txGrantId, 'radio_context_changed');
      throw new SignalDockError(
        'STALE_REVISION',
        'The transmission destination changed.',
      );
    }
    try {
      this.assertFormat(frame.format);
      if (
        frame.format.sampleRateHz !== tx.format.sampleRateHz ||
        frame.format.channels !== tx.format.channels ||
        frame.data.byteLength === 0 ||
        frame.data.byteLength % (2 * frame.format.channels) ||
        frame.data.byteLength >
          (frame.format.sampleRateHz * frame.format.channels * 2) / 10 ||
        !frame.streamId ||
        !Number.isSafeInteger(frame.sequence) ||
        frame.sequence < 0 ||
        frame.sequence <= tx.lastSequence ||
        !Number.isSafeInteger(frame.mediaTimeUs) ||
        frame.mediaTimeUs < 0 ||
        frame.mediaTimeUs < tx.lastMediaTimeUs ||
        frame.tuningRevision !== tx.grant.tuningRevision ||
        (tx.streamId && tx.streamId !== frame.streamId)
      ) {
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Audio frame format, sequence, size, or radio context is invalid.',
        );
      }
      if (tx.writing)
        throw new SignalDockError(
          'CONTROL_BUSY',
          'TX audio backpressure requires serial writes.',
        );
    } catch (error) {
      await this.stop(txGrantId, 'invalid_audio');
      throw error;
    }
    tx.writing = true;
    try {
      const acceptedFrame = {
        ...frame,
        format: { ...frame.format },
        data: frame.data.slice(),
      };
      await bounded(
        this.admitted(tx, () =>
          tx.driver.write({ ...tx.grant }, acceptedFrame, tx.controller.signal),
        ),
        tx.controller.signal,
        Math.min(this.timeoutMs, this.leaseMs),
      );
      if (tx.controller.signal.aborted || this.expired(tx))
        throw new SignalDockError(
          'DEADLINE_EXCEEDED',
          'The TX grant expired during an audio write.',
        );
      try {
        this.options.onFrame?.(acceptedFrame, { ...tx.grant }, tx.source);
      } catch (error) {
        try {
          this.options.onCaptureError?.(error, { ...tx.grant });
        } catch {
          /* Recording telemetry cannot disable the TX watchdog. */
        }
      }
      tx.streamId = frame.streamId;
      tx.lastSequence = frame.sequence;
      tx.lastMediaTimeUs = frame.mediaTimeUs;
      if (tx.state === 'granted') tx.state = 'tx_unconfirmed';
      if (!tx.observing && this.now() >= tx.nextObservationAt) {
        tx.observing = true;
        tx.nextObservationAt = this.now() + 250;
        void bounded(
          tx.driver.observe({ ...tx.grant }),
          tx.controller.signal,
          this.timeoutMs,
        )
          .then((observation) => {
            if (!tx.controller.signal.aborted) {
              tx.state =
                observation.state === 'transmitting' &&
                observation.physicallyConfirmed
                  ? 'transmitting'
                  : 'tx_unconfirmed';
              this.notify(tx);
            }
          })
          .catch(() => {
            if (!tx.controller.signal.aborted) {
              tx.state = 'tx_unconfirmed';
              this.notify(tx);
            }
          })
          .finally(() => {
            tx.observing = false;
          });
      }
      this.notify(tx);
      return this.status(tx);
    } catch (error) {
      await this.stop(txGrantId, 'audio_failed');
      throw error;
    } finally {
      tx.writing = false;
    }
  }

  stop(txGrantId: string, reason = 'released'): Promise<TxStatus> {
    const tx = this.require(txGrantId);
    if (tx.state === 'idle') return Promise.resolve(this.status(tx));
    if (tx.stopPromise) return tx.stopPromise;
    tx.controller.abort(new Error(reason));
    tx.state = 'stopping';
    tx.reason = reason;
    this.notify(tx);
    tx.stopPromise = (async () => {
      let confirmed = false;
      const operationsSettledBeforeEnd =
        tx.openingSettled && tx.pendingOperations === 0;
      try {
        const observed = await bounded(
          tx.driver.end({ ...tx.grant }, reason),
          undefined,
          this.timeoutMs,
        );
        confirmed =
          operationsSettledBeforeEnd &&
          observed.state === 'idle' &&
          observed.physicallyConfirmed;
      } catch {
        /* A failed link cannot establish physical carrier release. */
      }
      tx.state = confirmed ? 'idle' : 'stop_unconfirmed';
      this.options.runtime.releaseTransmission(
        tx.grant.radioId,
        tx.grant.txGrantId,
        confirmed,
      );
      if (confirmed) {
        this.byRadio.delete(tx.grant.radioId);
      }
      this.notify(tx);
      if (this.active.size > 256) {
        for (const [id, item] of this.active) {
          if (item.state === 'idle') {
            this.active.delete(id);
            break;
          }
        }
      }
      return this.status(tx);
    })();
    return tx.stopPromise;
  }

  get(txGrantId: string, ownerId?: string, sessionId?: string): TxStatus {
    return this.status(this.require(txGrantId, ownerId, sessionId));
  }
  async invalidateControl(
    radioId: string,
    reason = 'control_invalidated',
  ): Promise<void> {
    const id = this.byRadio.get(radioId);
    if (id) await this.stop(id, reason);
  }
  async reconcile(radioId: string): Promise<boolean> {
    const id = this.byRadio.get(radioId);
    if (!id) return true;
    const tx = this.require(id);
    if (
      tx.state !== 'stop_unconfirmed' ||
      !tx.openingSettled ||
      tx.pendingOperations !== 0
    )
      return false;
    const before = this.options.runtime.snapshot(radioId);
    const generation = before.generation;
    if (before.connection !== 'ready') return false;
    let observed: TxObservation;
    const currentDriver = this.options.driver(radioId);
    if (currentDriver.observeCurrent) {
      const proof = await bounded(
        currentDriver.observeCurrent({
          radioId,
          generation,
        }),
        undefined,
        this.timeoutMs,
      );
      if (proof.radioId !== radioId || proof.generation !== generation)
        throw new SignalDockError(
          'STALE_GENERATION',
          'Current radio observation belongs to another context.',
        );
      observed = proof;
    } else if (generation === tx.grant.generation) {
      observed = await bounded(
        tx.driver.observe({ ...tx.grant }),
        undefined,
        this.timeoutMs,
      );
    } else return false;
    const after = this.options.runtime.snapshot(radioId);
    if (
      after.generation !== generation ||
      after.connection !== 'ready' ||
      this.byRadio.get(radioId) !== id ||
      tx.state !== 'stop_unconfirmed'
    )
      return false;
    if (observed.state !== 'idle' || !observed.physicallyConfirmed)
      return false;
    tx.state = 'idle';
    this.byRadio.delete(radioId);
    this.options.runtime.releaseTransmission(radioId, id, true);
    this.notify(tx);
    return true;
  }
  async revokeSession(sessionId: string): Promise<void> {
    await Promise.all(
      [...this.active.values()]
        .filter((tx) => tx.grant.sessionId === sessionId && tx.state !== 'idle')
        .map((tx) => this.stop(tx.grant.txGrantId, 'session_revoked')),
    );
  }
  async sweep(): Promise<void> {
    await Promise.all(
      [...this.active.values()]
        .filter(
          (tx) =>
            ['preparing', 'granted', 'transmitting', 'tx_unconfirmed'].includes(
              tx.state,
            ) && this.expired(tx),
        )
        .map((tx) => this.stop(tx.grant.txGrantId, 'watchdog_expired')),
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      [...this.active.values()]
        .filter((tx) => tx.state !== 'idle')
        .map((tx) => this.stop(tx.grant.txGrantId, 'shutdown')),
    );
  }
  private expired(tx: ActiveTx): boolean {
    return this.now() >= Math.min(tx.grant.expiresAt, tx.grant.maxUntil);
  }
  private admitted<T>(tx: ActiveTx, work: () => Promise<T>): Promise<T> {
    tx.pendingOperations++;
    const pending = Promise.resolve().then(work);
    void pending.then(
      () => {
        tx.pendingOperations--;
      },
      () => {
        tx.pendingOperations--;
      },
    );
    return pending;
  }
  private require(id: string, ownerId?: string, sessionId?: string): ActiveTx {
    const tx = this.active.get(id);
    if (!tx) throw new SignalDockError('NOT_FOUND', 'Unknown TX grant.');
    if (
      (ownerId && tx.grant.ownerId !== ownerId) ||
      (sessionId && tx.grant.sessionId !== sessionId)
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'TX grant belongs to another session.',
      );
    return tx;
  }
  private assertFormat(format: AudioFormat): void {
    if (
      format.encoding !== 'pcm_s16le' ||
      ![8000, 16000, 24000, 32000, 44100, 48000].includes(
        format.sampleRateHz,
      ) ||
      format.channels !== 1
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Only supported-rate mono PCM s16le is accepted.',
      );
  }
  private status(tx: ActiveTx): TxStatus {
    return {
      grant: { ...tx.grant },
      state: tx.state,
      ...(tx.reason ? { reason: tx.reason } : {}),
    };
  }
  private notify(tx: ActiveTx): void {
    try {
      this.options.onState?.(this.status(tx));
    } catch {
      /* Telemetry must not disable supervision. */
    }
  }
}

export function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('Operation cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new SignalDockError('DEADLINE_EXCEEDED', 'Driver operation timed out.'),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    void work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
