import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { apiFetch } from '@signaldock/client-sdk';
import type { ClientSession, RecordingRecord } from '@signaldock/contracts';

export interface RecordingPlayerProps {
  session: ClientSession;
  recording: RecordingRecord;
}
export default function RecordingPlayer({
  session,
  recording,
}: RecordingPlayerProps) {
  const [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
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
      <Text style={{ color: '#e7b66b' }}>
        Audio {recording.state}
        {recording.gapReason ? `: ${recording.gapReason}` : ''}
      </Text>
    );
  return (
    <View style={{ gap: 8 }}>
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
            padding: 12,
            backgroundColor: '#213c50',
            borderRadius: 9,
            alignSelf: 'flex-start',
          }}
        >
          <Text style={{ color: '#76e8d0' }}>
            {busy ? 'Loading audio…' : 'Load recording'}
          </Text>
        </Pressable>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: '#ffb4a9' }}>
          {error}
        </Text>
      )}
    </View>
  );
}
