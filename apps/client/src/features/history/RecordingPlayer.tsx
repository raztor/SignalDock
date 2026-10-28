import { normalizeServerUrl } from '@signaldock/client-sdk';
import type { ClientSession, RecordingRecord } from '@signaldock/contracts';
import {
  Pressable,
  Text,
  radius as uiRadius,
  space as uiSpace,
  useScreenActive,
  useTheme,
} from '@signaldock/ui';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect } from 'react';
import { View } from 'react-native';

export interface RecordingPlayerProps {
  session: ClientSession;
  recording: RecordingRecord;
}
/** Native development-build adapter. Physical playback acceptance remains a rollout gate. */
export default function RecordingPlayer({
  session,
  recording,
}: RecordingPlayerProps) {
  const { colors } = useTheme();
  const active = useScreenActive();
  const player = useAudioPlayer(null);
  useEffect(() => {
    if (!active) player.pause();
  }, [active, player]);
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
      <Text style={{ color: colors.warning }}>
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
    <View style={{ gap: uiSpace.sm }}>
      <Pressable
        accessibilityRole="button"
        onPress={toggle}
        style={{
          padding: uiSpace.md,
          backgroundColor: colors.surfaceElevated,
          borderRadius: uiRadius.md,
          alignSelf: 'flex-start',
        }}
      >
        <Text style={{ color: colors.primary }}>
          {status.playing ? 'Pause recording' : 'Play recording'}
        </Text>
      </Pressable>
      <Text style={{ color: colors.textSecondary }}>
        {Math.floor(status.currentTime)} / {Math.floor(status.duration)} seconds
      </Text>
    </View>
  );
}
