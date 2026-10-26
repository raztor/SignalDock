import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, Text, View } from 'react-native';
import type { FeatureScreenProps } from '@signaldock/contracts';
import { RadioMediaController, type MediaUiState } from './controller';
import { browserMediaPort } from './browser-port';

export function MediaScreen({ session, radioId }: FeatureScreenProps) {
  const latest = useRef(session);
  latest.current = session;
  const controller = useRef<RadioMediaController | undefined>(undefined);
  const [state, setState] = useState<MediaUiState>({
    listening: false,
    transmitting: false,
    pending: false,
    message: 'Select Listen to enable audio.',
  });
  useEffect(() => {
    if (!radioId) return;
    const media = new RadioMediaController({
      session: () => latest.current,
      radioId,
      port: browserMediaPort,
      onState: setState,
    });
    controller.current = media;
    const stop = () => {
      void media.stopTransmit('Transmission interrupted.');
    };
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') stop();
    });
    if (Platform.OS === 'web') {
      window.addEventListener('blur', stop);
      document.addEventListener('visibilitychange', stop);
      window.addEventListener('pointercancel', stop);
    }
    return () => {
      controller.current = undefined;
      subscription.remove();
      if (Platform.OS === 'web') {
        window.removeEventListener('blur', stop);
        document.removeEventListener('visibilitychange', stop);
        window.removeEventListener('pointercancel', stop);
      }
      void media.dispose();
    };
  }, [session.baseUrl, session.instanceId, session.user.id, radioId]);
  if (!radioId) return <Text>Select a radio from the dashboard.</Text>;
  if (Platform.OS !== 'web')
    return (
      <View>
        <Text>
          Live audio on mobile requires a validated native development build.
        </Text>
        <Text>Radio control remains available from the dashboard.</Text>
      </View>
    );
  return (
    <View style={{ gap: 16, padding: 20 }}>
      <Text
        accessibilityRole="header"
        style={{ fontSize: 24, fontWeight: '700' }}
      >
        Live radio audio
      </Text>
      <Text accessibilityLiveRegion="polite">{state.message}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void (state.listening
            ? controller.current?.stop('Listening stopped.')
            : controller.current?.listen());
        }}
        style={{ padding: 16, backgroundColor: '#dbeafe', borderRadius: 12 }}
      >
        <Text>{state.listening ? 'Stop listening' : 'Listen'}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Push to talk. Hold to transmit, release to stop."
        onPressIn={() => {
          void controller.current?.startTransmit();
        }}
        onPressOut={() => {
          void controller.current?.stopTransmit();
        }}
        style={{
          padding: 24,
          borderRadius: 16,
          backgroundColor: state.transmitting
            ? '#ef4444'
            : state.pending
              ? '#fbbf24'
              : '#1d4ed8',
        }}
      >
        <Text
          style={{
            color: state.pending ? '#111827' : 'white',
            fontWeight: '700',
            fontSize: 18,
          }}
        >
          {state.transmitting
            ? 'TRANSMITTING — RELEASE TO STOP'
            : state.pending
              ? 'PREPARING — KEEP HOLDING'
              : 'HOLD TO TALK'}
        </Text>
      </Pressable>
      <Text>
        One operator controls this radio. Transmissions stop after 30 seconds
        and require a new press. Release immediately if carrier status is
        uncertain.
      </Text>
    </View>
  );
}
