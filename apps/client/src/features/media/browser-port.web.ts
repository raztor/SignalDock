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
  ): Promise<MediaConnection> {
    const room = new Room({ adaptiveStream: false, dynacast: false });
    const audio = new Set<HTMLMediaElement>();
    let closing = false;
    room.on(RoomEvent.Reconnecting, () => onInterrupted());
    room.on(RoomEvent.Disconnected, () => {
      if (!closing) onInterrupted();
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (
        participant.identity ===
          `bridge-${session.instanceId}-${session.radioId}` &&
        !closing
      )
        onInterrupted();
    });
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (
        session.mode !== 'listen' ||
        participant.identity !==
          `bridge-${session.instanceId}-${session.radioId}` ||
        track.kind !== Track.Kind.Audio
      )
        return;
      const element = track.attach();
      audio.add(element);
      element.autoplay = true;
      document.body.appendChild(element);
      void element.play().catch(() => onInterrupted());
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) {
        audio.delete(element);
        element.remove();
      }
    });
    try {
      await room.connect(session.serverUrl, session.token, {
        autoSubscribe: session.mode === 'listen',
      });
    } catch (error) {
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
        closing = true;
        for (const element of audio) {
          element.pause();
          element.remove();
        }
        audio.clear();
        await room.disconnect();
      },
    };
  },
};
