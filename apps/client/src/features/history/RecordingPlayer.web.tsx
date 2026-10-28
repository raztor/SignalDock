import { apiFetch } from '@signaldock/client-sdk';
import type { ClientSession, RecordingRecord } from '@signaldock/contracts';
import {
  Pressable,
  Text,
  radius as uiRadius,
  space as uiSpace,
  useScreenActive,
  useTheme,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

export interface RecordingPlayerProps {
  session: ClientSession;
  recording: RecordingRecord;
}
export default function RecordingPlayer({
  session,
  recording,
}: RecordingPlayerProps) {
  const { colors } = useTheme();
  const active = useScreenActive();
  const [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!active) audio.current?.pause();
  }, [active]);
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef('');
  useEffect(
    () => () => {
      request.current?.abort();
      audio.current?.pause();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  useEffect(() => {
    request.current?.abort();
    audio.current?.pause();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = '';
    setUrl('');
    setBusy(false);
    setError('');
  }, [session.baseUrl, session.instanceId, session.accessToken, recording.id]);
  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(session, `recordings/${recording.id}`, {
        signal: controller.signal,
      });
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      setUrl(objectUrl.current);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Recording could not be loaded.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  if (recording.state !== 'available')
    return (
      <Text style={{ color: colors.warning }}>
        Audio {recording.state}
        {recording.gapReason ? `: ${recording.gapReason}` : ''}
      </Text>
    );
  return (
    <View style={{ gap: uiSpace.sm }}>
      {url ? (
        <audio
          ref={audio}
          src={url}
          controls
          preload="metadata"
          style={{ width: '100%', maxWidth: 500 }}
          onError={() => setError('The browser could not play this recording.')}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void load()}
          style={{
            padding: uiSpace.md,
            backgroundColor: colors.surfaceElevated,
            borderRadius: uiRadius.md,
            alignSelf: 'flex-start',
          }}
        >
          <Text style={{ color: colors.primary }}>
            {busy ? 'Loading audio…' : 'Load recording'}
          </Text>
        </Pressable>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
    </View>
  );
}
