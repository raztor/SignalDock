import {
  AccessToken,
  RoomServiceClient,
  TrackSource as ServerTrackSource,
} from 'livekit-server-sdk';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import {
  SignalDockError,
  type AudioFormat,
  type MediaSession,
  type PcmAudioFrame,
  type TxGrant,
} from '@signaldock/contracts';
import { pcmBytes, pcmSamples } from './pcm.js';

export interface LiveKitConfiguration {
  serverUrl: string;
  apiKey: string;
  apiSecret: string;
}
export function radioRoom(instanceId: string, radioId: string): string {
  return `sd-${instanceId}-${radioId}`;
}

export class LiveKitCredentials {
  private readonly rooms: RoomServiceClient;
  constructor(readonly config: LiveKitConfiguration) {
    const url = new URL(config.serverUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['ws:', 'wss:'].includes(url.protocol) ||
      (url.protocol === 'ws:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) {
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Media requires WSS, except loopback development.',
      );
    }
    if (config.apiKey.length < 1 || config.apiSecret.length < 16)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'Configure a media API key and a secret of at least 16 characters.',
      );
    const serviceUrl = new URL(url);
    serviceUrl.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    this.rooms = new RoomServiceClient(
      serviceUrl.href,
      config.apiKey,
      config.apiSecret,
    );
  }

  async issue(
    input: {
      id: string;
      instanceId: string;
      radioId: string;
      sessionId: string;
      mode: 'listen' | 'transmit';
    },
    now = Date.now(),
  ): Promise<MediaSession> {
    const identity = `session-${input.id}`;
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity,
      ttl: 60,
      attributes: {
        instanceId: input.instanceId,
        radioId: input.radioId,
        sessionId: input.sessionId,
      },
    });
    token.addGrant({
      roomJoin: true,
      room: radioRoom(input.instanceId, input.radioId),
      canSubscribe: input.mode === 'listen',
      canPublish: input.mode === 'transmit',
      canPublishData: false,
      canPublishSources:
        input.mode === 'transmit' ? [ServerTrackSource.MICROPHONE] : [],
    });
    return {
      ...input,
      participantIdentity: identity,
      serverUrl: this.config.serverUrl,
      token: await token.toJwt(),
      expiresAt: new Date(now + 60000).toISOString(),
    };
  }

  async bridgeToken(instanceId: string, radioId: string): Promise<string> {
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: `bridge-${instanceId}-${radioId}`,
      ttl: 60,
    });
    token.addGrant({
      roomJoin: true,
      room: radioRoom(instanceId, radioId),
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canPublishSources: [ServerTrackSource.MICROPHONE],
    });
    return token.toJwt();
  }

  async revoke(session: MediaSession): Promise<void> {
    await this.rooms.removeParticipant(
      radioRoom(session.instanceId, session.radioId),
      session.participantIdentity,
    );
  }
}

interface RadioBridge {
  room: Room;
  source: AudioSource;
  track: LocalAudioTrack;
  abort: AbortController;
  generation: string;
  pending: Promise<void>;
  readers: Set<ReadableStreamDefaultReader<AudioFrame>>;
}
export interface MediaFrameContext {
  radioId: string;
  generation: string;
  direction: 'rx' | 'tx';
  tuningRevision: number;
  frequencyHz?: number;
  attributionConfidence: 'confirmed' | 'inferred' | 'unknown';
  sourceCodec?: string;
  txGrantId?: string;
}
export type TuningContextResolver = (
  radioId: string,
  generation: string,
  revision: number,
) =>
  | {
      frequencyHz?: number;
      attributionConfidence: 'confirmed' | 'inferred' | 'unknown';
      sourceCodec?: string;
    }
  | undefined;

/** Server-side room bridge. Only backend-enrolled participants can reach TX. */
export class LiveKitRadioBridge {
  private readonly radios = new Map<string, RadioBridge>();
  private readonly opening = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly options: {
      instanceId: string;
      credentials: LiveKitCredentials;
      authorizeParticipant: (
        radioId: string,
        identity: string,
      ) => TxGrant | undefined;
      sendTx: (grantId: string, frame: PcmAudioFrame) => Promise<unknown>;
      stopTx: (grantId: string, reason: string) => Promise<unknown>;
      invalidateRadio: (radioId: string, reason: string) => Promise<unknown>;
      onFrame?: (frame: PcmAudioFrame, context: MediaFrameContext) => void;
      onError?: (radioId: string, error: unknown) => void;
      resolveTuning?: TuningContextResolver;
    },
  ) {}

  async attachRadio(input: {
    radioId: string;
    generation: string;
    format: AudioFormat;
    frames: (signal: AbortSignal) => AsyncIterable<PcmAudioFrame>;
  }): Promise<void> {
    if (this.closed)
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'Media bridge is shutting down.',
      );
    const existing = this.radios.get(input.radioId);
    if (existing?.generation === input.generation) return;
    const pending = this.opening.get(input.radioId);
    if (pending) {
      await pending;
      return this.attachRadio(input);
    }
    const work = this.open(input);
    this.opening.set(input.radioId, work);
    try {
      await work;
    } finally {
      this.opening.delete(input.radioId);
    }
  }

  private async open(input: {
    radioId: string;
    generation: string;
    format: AudioFormat;
    frames: (signal: AbortSignal) => AsyncIterable<PcmAudioFrame>;
  }): Promise<void> {
    await this.detachRadio(input.radioId);
    if (this.closed)
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'Media bridge is shutting down.',
      );
    if (input.format.encoding !== 'pcm_s16le' || input.format.channels !== 1)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'The media bridge requires mono PCM s16le.',
      );
    const room = new Room();
    const abort = new AbortController();
    const source = new AudioSource(input.format.sampleRateHz, 1, 40);
    const track = LocalAudioTrack.createAudioTrack('rx', source);
    const bridge: RadioBridge = {
      room,
      abort,
      source,
      track,
      generation: input.generation,
      pending: Promise.resolve(),
      readers: new Set(),
    };
    room.on(RoomEvent.TrackSubscribed, (remote, _publication, participant) => {
      void this.consumeTx(input.radioId, bridge, remote, participant);
    });
    room.on(RoomEvent.Reconnecting, () => {
      void this.options.invalidateRadio(input.radioId, 'media_reconnecting');
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!abort.signal.aborted) {
        void this.options.invalidateRadio(input.radioId, 'media_disconnected');
        if (this.radios.get(input.radioId) === bridge)
          void this.detachRadio(input.radioId).catch((error: unknown) =>
            this.options.onError?.(input.radioId, error),
          );
      }
    });
    try {
      await room.connect(
        this.options.credentials.config.serverUrl,
        await this.options.credentials.bridgeToken(
          this.options.instanceId,
          input.radioId,
        ),
        {
          autoSubscribe: true,
          dynacast: false,
          dataStream: { maxPayloadByteLength: 65536 },
        },
      );
      const publication = new TrackPublishOptions();
      if (this.closed)
        throw new Error('Media bridge closed during connection.');
      publication.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant!.publishTrack(track, publication);
      if (this.closed)
        throw new Error('Media bridge closed during publication.');
      this.radios.set(input.radioId, bridge);
      bridge.pending = this.publishRx(input, bridge)
        .catch((error: unknown) => {
          if (!abort.signal.aborted)
            this.options.onError?.(input.radioId, error);
        })
        .finally(() => {
          if (!abort.signal.aborted)
            void this.detachRadio(input.radioId).catch((error: unknown) =>
              this.options.onError?.(input.radioId, error),
            );
        });
    } catch (error) {
      abort.abort();
      await room.disconnect().catch(() => undefined);
      await source.close();
      await track.close();
      throw error;
    }
  }

  private async publishRx(
    input: {
      radioId: string;
      generation: string;
      format: AudioFormat;
      frames: (signal: AbortSignal) => AsyncIterable<PcmAudioFrame>;
    },
    bridge: RadioBridge,
  ): Promise<void> {
    for await (const frame of input.frames(bridge.abort.signal)) {
      if (bridge.abort.signal.aborted) break;
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
      this.archive(frame, {
        radioId: input.radioId,
        generation: input.generation,
        direction: 'rx',
        tuningRevision: frame.tuningRevision,
        attributionConfidence: confidence,
        ...(tuning?.frequencyHz ? { frequencyHz: tuning.frequencyHz } : {}),
        ...(tuning?.sourceCodec ? { sourceCodec: tuning.sourceCodec } : {}),
      });
      if (!frame.data.length) continue;
      if (
        frame.format.sampleRateHz !== input.format.sampleRateHz ||
        frame.format.channels !== input.format.channels
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'RX format changed without a new stream generation.',
        );
      const samples = pcmSamples(frame);
      await bridge.source.captureFrame(
        new AudioFrame(samples, frame.format.sampleRateHz, 1, samples.length),
      );
    }
  }

  private async consumeTx(
    radioId: string,
    bridge: RadioBridge,
    track: RemoteTrack,
    participant: RemoteParticipant,
  ): Promise<void> {
    const grant = this.options.authorizeParticipant(
      radioId,
      participant.identity,
    );
    if (!grant || track.kind !== TrackKind.KIND_AUDIO) return;
    const grantId = grant.txGrantId;
    const reader = new AudioStream(track, {
      sampleRate: 32000,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    bridge.readers.add(reader);
    let sequence = 0;
    let samplesRead = 0;
    const streamId = crypto.randomUUID();
    try {
      while (!bridge.abort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (
          this.options.authorizeParticipant(radioId, participant.identity)
            ?.txGrantId !== grantId
        )
          throw new SignalDockError(
            'FORBIDDEN',
            'The media participant has no current TX grant.',
          );
        const frame: PcmAudioFrame = {
          streamId,
          sequence: sequence++,
          mediaTimeUs: Math.round((samplesRead * 1000000) / value.sampleRate),
          format: {
            encoding: 'pcm_s16le',
            sampleRateHz: value.sampleRate,
            channels: value.channels,
          },
          data: pcmBytes(value.data),
          tuningRevision: grant.tuningRevision,
          attributionConfidence: 'confirmed',
          discontinuity: false,
        };
        samplesRead += value.samplesPerChannel;
        await this.options.sendTx(grantId, frame);
      }
    } catch (error) {
      if (!bridge.abort.signal.aborted) this.options.onError?.(radioId, error);
    } finally {
      bridge.readers.delete(reader);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await this.options
        .stopTx(grantId, 'media_track_ended')
        .catch(() => undefined);
    }
  }

  async detachRadio(radioId: string): Promise<void> {
    const bridge = this.radios.get(radioId);
    if (!bridge) return;
    this.radios.delete(radioId);
    bridge.abort.abort();
    await this.options.invalidateRadio(radioId, 'media_detached');
    await Promise.all(
      [...bridge.readers].map((reader) =>
        reader.cancel().catch(() => undefined),
      ),
    );
    await bridge.room.disconnect();
    await bridge.source.close();
    await bridge.track.close();
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.opening.values()]);
    await Promise.all(
      [...this.radios.keys()].map((id) => this.detachRadio(id)),
    );
  }
  private archive(frame: PcmAudioFrame, context: MediaFrameContext): void {
    try {
      this.options.onFrame?.(frame, context);
    } catch (error) {
      this.options.onError?.(context.radioId, error);
    }
  }
}
