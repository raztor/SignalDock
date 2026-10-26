import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { normalizeServerUrl } from '@signaldock/client-sdk';
import type { ClientSession, RecordingRecord } from '@signaldock/contracts';

export interface RecordingPlayerProps {
  session: ClientSession;
  recording: RecordingRecord;
}
/** Native development-build adapter. Physical playback acceptance remains a rollout gate. */
export default function RecordingPlayer({
  session,
  recording,
}: RecordingPlayerProps) {
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  useEffect(() => {
    player.pause();
    player.replace(null);
  }, [
    player,
    session.baseUrl,
    session.instanceId,
    session.accessToken,
    recording.id,
  ]);
  if (recording.state !== 'available')
    return (
      <Text style={{ color: '#e7b66b' }}>
        Audio {recording.state}
        {recording.gapReason ? `: ${recording.gapReason}` : ''}
      </Text>
    );
  function toggle() {
    if (status.playing) {
      player.pause();
      return;
    }
    if (!player.isLoaded)
      player.replace({
        uri: new URL(
          `api/v1/recordings/${recording.id}`,
          normalizeServerUrl(session.baseUrl),
        ).href,
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
    if (status.didJustFinish) void player.seekTo(0);
    player.play();
  }
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        onPress={toggle}
        style={{
          padding: 12,
          backgroundColor: '#213c50',
          borderRadius: 9,
          alignSelf: 'flex-start',
        }}
      >
        <Text style={{ color: '#76e8d0' }}>
          {status.playing ? 'Pause recording' : 'Play recording'}
        </Text>
      </Pressable>
      <Text style={{ color: '#9fb0c9' }}>
        {Math.floor(status.currentTime)} / {Math.floor(status.duration)} seconds
      </Text>
    </View>
  );
}
