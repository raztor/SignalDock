import {
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  type LocalAudioTrack,
} from 'livekit-client';
import type { MediaSession } from '@signaldock/contracts';
import type {
  BrowserMediaPort,
  MediaConnection,
  Microphone,
} from './controller';

interface BrowserMicrophone extends Microphone {
  track: LocalAudioTrack;
}

/**
 * Measures received audio with a Web Audio AnalyserNode. The AudioContext is
 * created lazily on the first reading and only analyses (it is not connected
 * to the speakers; playback stays on the attached audio element).
 */
function createLevelMeter() {
  const tracks = new Set<MediaStreamTrack>();
  let context: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let sourceTrack: MediaStreamTrack | undefined;
  let samples: Float32Array<ArrayBuffer> | undefined;
  let closed = false;
  const detach = () => {
    source?.disconnect();
    source = undefined;
    sourceTrack = undefined;
  };
  return {
    add(track: MediaStreamTrack) {
      if (!closed) tracks.add(track);
    },
    remove(track: MediaStreamTrack) {
      tracks.delete(track);
      if (sourceTrack === track) detach();
    },
    level(): number {
      if (closed || typeof AudioContext === 'undefined') return 0;
      const track = [...tracks].find((item) => item.readyState === 'live');
      if (!track) {
        detach();
        return 0;
      }
      try {
        context ??= new AudioContext();
        if (context.state === 'suspended')
          void context.resume().catch(() => undefined);
        if (!analyser) {
          analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          samples = new Float32Array(analyser.fftSize);
        }
        if (sourceTrack !== track) {
          detach();
          source = context.createMediaStreamSource(new MediaStream([track]));
          source.connect(analyser);
          sourceTrack = track;
        }
        if (!samples) return 0;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        if (rms <= 0) return 0;
        // Map -60 dBFS..0 dBFS onto 0..1.
        const decibels = 20 * Math.log10(rms);
        return Math.min(1, Math.max(0, (decibels + 60) / 60));
      } catch {
        return 0;
      }
    },
    close() {
      closed = true;
      tracks.clear();
      detach();
      analyser?.disconnect();
      analyser = undefined;
      samples = undefined;
      const closing = context;
      context = undefined;
      if (closing && closing.state !== 'closed')
        void closing.close().catch(() => undefined);
    },
  };
}
export const browserMediaPort: BrowserMediaPort = {
  async microphone(onInterrupted) {
    const track = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    track.mediaStreamTrack.addEventListener('ended', onInterrupted, {
      once: true,
    });
    track.mediaStreamTrack.addEventListener('mute', onInterrupted, {
      once: true,
    });
    return { track, stop: () => track.stop() } as BrowserMicrophone;
  },
  async connect(
    session: MediaSession,
    onInterrupted,
    signal,
  ): Promise<MediaConnection> {
    const room = new Room({ adaptiveStream: false, dynacast: false });
    const audio = new Set<HTMLMediaElement>();
    const meter = createLevelMeter();
    let closing = false;
    const disconnect = async () => {
      closing = true;
      meter.close();
      for (const element of audio) {
        element.pause();
        element.remove();
      }
      audio.clear();
      await room.disconnect();
    };
    const abort = () => {
      void disconnect().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      await disconnect();
      throw new Error('Media connection cancelled.');
    }
    room.on(RoomEvent.Reconnecting, () => {
      if (!closing && !signal.aborted) onInterrupted();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!closing) onInterrupted();
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (
        !closing &&
        !signal.aborted &&
        participant.identity ===
          `bridge-${session.instanceId}-${session.radioId}`
      )
        onInterrupted();
    });
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (
        closing ||
        signal.aborted ||
        session.mode !== 'listen' ||
        participant.identity !==
          `bridge-${session.instanceId}-${session.radioId}` ||
        track.kind !== Track.Kind.Audio
      )
        return;
      const element = track.attach();
      audio.add(element);
      meter.add(track.mediaStreamTrack);
      element.autoplay = true;
      document.body.appendChild(element);
      void element.play().catch(() => onInterrupted());
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      meter.remove(track.mediaStreamTrack);
      for (const element of track.detach()) {
        audio.delete(element);
        element.remove();
      }
    });
    try {
      await room.connect(session.serverUrl, session.token, {
        autoSubscribe: session.mode === 'listen',
      });
      if (signal.aborted) {
        await disconnect();
        throw new Error('Media connection cancelled.');
      }
    } catch (error) {
      signal.removeEventListener('abort', abort);
      closing = true;
      await room.disconnect();
      throw error;
    }
    return {
      publish: async (microphone) => {
        if (closing) throw new Error('Media connection is closed.');
        room.localParticipant.setTrackSubscriptionPermissions(false, [
          {
            participantIdentity: `bridge-${session.instanceId}-${session.radioId}`,
            allowAll: true,
          },
        ]);
        await room.localParticipant.publishTrack(
          (microphone as BrowserMicrophone).track,
          { source: Track.Source.Microphone },
        );
      },
      disconnect: async () => {
        signal.removeEventListener('abort', abort);
        await disconnect();
      },
      ...(session.mode === 'listen' ? { level: () => meter.level() } : {}),
    };
  },
};
