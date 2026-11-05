import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SignalDockError,
  PCM_WEBSOCKET_FORMAT,
  PCM_WEBSOCKET_PROTOCOL,
  encodePcmSocketFrame,
  decodePcmSocketFrame,
  type MediaSession,
} from '@signaldock/contracts';
import { bounded } from '@signaldock/radio-runtime/tx';
import type {
  MediaBridgeOptions,
  MediaBridgePort,
  MediaSocket,
} from './bridge-port.js';

export class WebSocketCredentials {
  constructor(private readonly serverUrl: string) {
    const url = new URL(serverUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['ws:', 'wss:'].includes(url.protocol) ||
      (url.protocol === 'ws:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Audio requires WSS, except loopback development.',
      );
  }
  async issue(
    input: Pick<
      MediaSession,
      'id' | 'instanceId' | 'radioId' | 'sessionId' | 'mode'
    >,
  ): Promise<MediaSession> {
    return {
      ...input,
      participantIdentity: `session-${input.id}`,
      serverUrl: this.serverUrl,
      token: randomBytes(32).toString('base64url'),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      transport: 'websocket',
    };
  }
  async revoke(_session: MediaSession): Promise<void> {
    /* The bridge owns the authenticated socket. */
  }
}

interface Peer {
  session: MediaSession;
  socket: MediaSocket;
  closed: boolean;
  grantId?: string;
  streamId: string;
  queue: Uint8Array[];
  draining: boolean;
  nextSequence: number;
  samples: number;
  audioStartedAt?: number;
  heartbeat?: ReturnType<typeof setInterval>;
  awaitingPong?: boolean;
  abort: AbortController;
}

export class PcmStreamError extends SignalDockError {
  constructor(
    public readonly diagnostic: {
      reason: 'sequence' | 'clock';
      sequence: number;
      expectedSequence: number;
      lagMs: number;
    },
  ) {
    super(
      'INVALID_ARGUMENT',
      'Microphone audio timing or sequence is invalid.',
    );
  }
}
interface Radio {
  generation: string;
  abort: AbortController;
  pending: Promise<void>;
}

/** The same enrollment and TX supervisor as LiveKit, over the station's HTTPS socket. */
export class WebSocketRadioBridge implements MediaBridgePort {
  private readonly peers = new Map<string, Peer>();
  private readonly radios = new Map<string, Radio>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly options: MediaBridgeOptions) {}

  async attachRadio(
    input: Parameters<MediaBridgePort['attachRadio']>[0],
  ): Promise<void> {
    if (this.closed)
      throw new SignalDockError('RADIO_UNAVAILABLE', 'Audio is shutting down.');
    const opening = this.opening.get(input.radioId);
    if (opening) {
      await opening;
      return this.attachRadio(input);
    }
    if (this.radios.get(input.radioId)?.generation === input.generation) return;
    const work = (async () => {
      await this.detachRadio(input.radioId);
      if (this.closed)
        throw new SignalDockError(
          'RADIO_UNAVAILABLE',
          'Audio is shutting down.',
        );
      const radio: Radio = {
        generation: input.generation,
        abort: new AbortController(),
        pending: Promise.resolve(),
      };
      this.radios.set(input.radioId, radio);
      radio.pending = this.receive(input, radio)
        .catch((error: unknown) => {
          if (!radio.abort.signal.aborted) this.report(input.radioId, error);
        })
        .finally(() => {
          if (this.radios.get(input.radioId) === radio) {
            this.radios.delete(input.radioId);
            this.closeRadioPeers(input.radioId);
            this.track(
              this.options.invalidateRadio(input.radioId, 'audio_source_ended'),
            );
          }
        });
    })();
    this.opening.set(input.radioId, work);
    try {
      await work;
    } finally {
      this.opening.delete(input.radioId);
    }
  }

  private async receive(
    input: Parameters<MediaBridgePort['attachRadio']>[0],
    radio: Radio,
  ): Promise<void> {
    for await (const frame of input.frames(radio.abort.signal)) {
      if (radio.abort.signal.aborted || this.closed) break;
      if (
        frame.format.encoding !== 'pcm_s16le' ||
        frame.format.sampleRateHz !== 32000 ||
        frame.format.channels !== 1
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Audio format changed without a new generation.',
        );
      const tuning = this.options.resolveTuning?.(
        input.radioId,
        input.generation,
        frame.tuningRevision,
      );
      const confidence =
        !tuning?.frequencyHz ||
        frame.attributionConfidence === 'unknown' ||
        tuning.attributionConfidence === 'unknown'
          ? 'unknown'
          : frame.attributionConfidence === 'inferred' ||
              tuning.attributionConfidence === 'inferred'
            ? 'inferred'
            : 'confirmed';
      try {
        this.options.onFrame?.(frame, {
          radioId: input.radioId,
          generation: input.generation,
          direction: 'rx',
          tuningRevision: frame.tuningRevision,
          attributionConfidence: confidence,
          ...(tuning?.frequencyHz ? { frequencyHz: tuning.frequencyHz } : {}),
          ...(tuning?.sourceCodec ? { sourceCodec: tuning.sourceCodec } : {}),
        });
      } catch (error) {
        this.report(input.radioId, error);
      }
      if (!frame.data.length) continue;
      const bytes = encodePcmSocketFrame(frame);
      const allowed = new Set(this.options.listenerIdentities(input.radioId));
      for (const peer of this.peers.values()) {
        if (
          peer.session.radioId !== input.radioId ||
          peer.session.mode !== 'listen'
        )
          continue;
        if (!allowed.has(peer.session.participantIdentity)) {
          this.end(peer, 1008, 'Enrollment ended');
          continue;
        }
        if (peer.socket.bufferedAmount > 5 * 1304) {
          this.end(peer, 1013, 'Audio connection is too slow');
          continue;
        }
        try {
          peer.socket.send(bytes);
        } catch {
          this.end(peer, 1011, 'Audio send failed');
        }
      }
    }
  }

  openSocket(session: MediaSession, socket: MediaSocket): void {
    if (
      this.closed ||
      !this.radios.has(session.radioId) ||
      socket.readyState !== 1
    )
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'The audio source is unavailable.',
      );
    if (this.peers.has(session.participantIdentity))
      throw new SignalDockError(
        'CONTROL_BUSY',
        'This enrollment already has a socket.',
      );
    const grant =
      session.mode === 'transmit'
        ? this.options.authorizeParticipant(
            session.radioId,
            session.participantIdentity,
          )
        : undefined;
    if (session.mode === 'transmit' && !grant)
      throw new SignalDockError(
        'CONTROL_REQUIRED',
        'A current TX grant is required.',
      );
    const peer: Peer = {
      session,
      socket,
      closed: false,
      streamId: crypto.randomUUID(),
      queue: [],
      draining: false,
      nextSequence: 0,
      samples: 0,
      abort: new AbortController(),
      ...(grant ? { grantId: grant.txGrantId } : {}),
    };
    this.peers.set(session.participantIdentity, peer);
    socket.onClose(() => this.end(peer));
    socket.onError(() => this.end(peer, 1011, 'Audio connection failed'));
    if (socket.ping && socket.onPong) {
      socket.onPong(() => {
        peer.awaitingPong = false;
      });
      peer.heartbeat = setInterval(() => {
        if (peer.closed) return;
        if (peer.awaitingPong) {
          this.end(peer, 1001, 'Audio keepalive expired');
          return;
        }
        peer.awaitingPong = true;
        try {
          socket.ping!();
        } catch {
          this.end(peer, 1011, 'Audio keepalive failed');
        }
      }, 20000);
      peer.heartbeat.unref?.();
    }
    socket.onMessage((bytes, binary) => {
      if (peer.closed) return;
      if (session.mode !== 'transmit' || !binary || peer.queue.length >= 10) {
        this.end(peer, 1008, 'Invalid audio stream');
        return;
      }
      peer.queue.push(bytes);
      if (!peer.draining) this.track(this.drain(peer));
    });
    socket.send(
      JSON.stringify({
        type: 'ready',
        protocol: PCM_WEBSOCKET_PROTOCOL,
        format: PCM_WEBSOCKET_FORMAT,
        ...(grant ? { tuningRevision: grant.tuningRevision } : {}),
      }),
    );
  }

  private async drain(peer: Peer): Promise<void> {
    peer.draining = true;
    try {
      while (!peer.closed && peer.queue.length) {
        const bytes = peer.queue.shift()!;
        const packet = decodePcmSocketFrame(bytes);
        peer.audioStartedAt ??= performance.now();
        const expectedTime = Math.round((peer.samples * 1000000) / 32000);
        const lag =
          performance.now() - peer.audioStartedAt - expectedTime / 1000;
        if (
          packet.sequence !== peer.nextSequence ||
          packet.mediaTimeUs !== expectedTime ||
          lag < -200 ||
          lag > 1000
        )
          throw new PcmStreamError({
            reason:
              packet.sequence !== peer.nextSequence ||
              packet.mediaTimeUs !== expectedTime
                ? 'sequence'
                : 'clock',
            sequence: packet.sequence,
            expectedSequence: peer.nextSequence,
            lagMs: Math.round(lag),
          });
        // TCP can deliver several correctly captured frames in one batch.
        // Pace that bounded jitter buffer before the private driver stream;
        // never burst queued microphone audio into its real-time input.
        if (lag < 0)
          await delay(-lag, undefined, { signal: peer.abort.signal });
        if (peer.closed) return;
        const currentLag =
          performance.now() - peer.audioStartedAt - expectedTime / 1000;
        if (currentLag > 1000)
          throw new PcmStreamError({
            reason: 'clock',
            sequence: packet.sequence,
            expectedSequence: peer.nextSequence,
            lagMs: Math.round(currentLag),
          });
        const grant = this.options.authorizeParticipant(
          peer.session.radioId,
          peer.session.participantIdentity,
        );
        if (
          !grant ||
          grant.txGrantId !== peer.grantId ||
          packet.tuningRevision !== grant.tuningRevision
        )
          throw new SignalDockError(
            'CONTROL_REQUIRED',
            'The TX enrollment is no longer current.',
          );
        await this.options.sendTx(grant.txGrantId, {
          ...packet,
          streamId: peer.streamId,
          format: PCM_WEBSOCKET_FORMAT,
          attributionConfidence: 'confirmed',
          discontinuity: false,
        });
        peer.nextSequence++;
        peer.samples += packet.data.length / 2;
      }
    } catch (error) {
      if (!peer.closed) {
        this.report(peer.session.radioId, error);
        this.end(peer, 1008, 'Audio stream rejected');
      }
    } finally {
      peer.draining = false;
    }
  }

  updateListeners(radioId: string): void {
    const allowed = new Set(this.options.listenerIdentities(radioId));
    for (const peer of this.peers.values())
      if (
        peer.session.radioId === radioId &&
        peer.session.mode === 'listen' &&
        !allowed.has(peer.session.participantIdentity)
      )
        this.end(peer, 1008, 'Enrollment ended');
  }
  disconnectParticipant(identity: string): void {
    const peer = this.peers.get(identity);
    if (peer) this.end(peer, 1008, 'Enrollment ended');
  }
  private end(peer: Peer, code = 1000, reason = 'Audio closed'): void {
    if (peer.closed) return;
    peer.closed = true;
    peer.abort.abort();
    clearInterval(peer.heartbeat);
    peer.queue.length = 0;
    this.peers.delete(peer.session.participantIdentity);
    try {
      if (peer.socket.readyState === 1) peer.socket.close(code, reason);
    } catch (error) {
      this.report(peer.session.radioId, error);
    }
    if (peer.grantId)
      this.track(
        Promise.resolve().then(() =>
          this.options.stopTx(peer.grantId!, 'audio_socket_closed'),
        ),
      );
  }
  private closeRadioPeers(radioId: string): void {
    for (const peer of this.peers.values())
      if (peer.session.radioId === radioId)
        this.end(peer, 1012, 'Radio generation ended');
  }
  private async detachRadio(radioId: string): Promise<void> {
    const radio = this.radios.get(radioId);
    if (!radio) return;
    this.radios.delete(radioId);
    radio.abort.abort();
    this.closeRadioPeers(radioId);
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        this.options.invalidateRadio(radioId, 'audio_detached'),
      ),
      bounded(radio.pending, undefined, 2500),
    ]);
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(failures, 'Audio source cleanup failed.');
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const peer of this.peers.values()) this.end(peer);
    const opening = await Promise.allSettled([...this.opening.values()]);
    const radios = await Promise.allSettled(
      [...this.radios.keys()].map((id) => this.detachRadio(id)),
    );
    const pending = await Promise.allSettled(
      [...this.pending].map((work) => bounded(work, undefined, 2500)),
    );
    const failures = [...opening, ...radios, ...pending]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(failures, 'Audio cleanup failed.');
  }
  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.catch(() => undefined).finally(() => this.pending.delete(work));
  }
  private report(radioId: string, error: unknown): void {
    try {
      this.options.onError?.(radioId, error);
    } catch {}
  }
}
