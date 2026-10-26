import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, Text, View } from 'react-native';
import {
  RadioViewSchema,
  type FeatureScreenProps,
  type RadioView,
} from '@signaldock/contracts';
import { apiRequest } from '@signaldock/client-sdk';
import { RadioMediaController, type MediaUiState } from './controller';
import { browserMediaPort } from './browser-port';
import { mediaAccess } from './media-access';

const idleMediaState: MediaUiState = {
  listening: false,
  transmitting: false,
  pending: false,
  message: 'Ready. Select Listen to enable audio.',
};

export function MediaScreen({
  session,
  radioId,
  mediaAvailable = false,
}: FeatureScreenProps & { mediaAvailable?: boolean }) {
  const latest = useRef(session);
  latest.current = session;
  const controller = useRef<RadioMediaController | undefined>(undefined);
  const contextKey = `${session.baseUrl}\0${session.instanceId}\0${session.user.id}\0${radioId ?? ''}\0${mediaAvailable}`;
  const [details, setDetails] = useState<{
    key: string;
    radio: RadioView | null;
    error: string;
  }>({ key: '', radio: null, error: '' });
  const [status, setStatus] = useState({
    key: contextKey,
    value: idleMediaState,
  });
  const state =
    status.key === contextKey && mediaAvailable ? status.value : idleMediaState;
  useEffect(() => {
    if (!radioId) return;
    const cancellation = new AbortController();
    let refreshing = false;
    setDetails({ key: contextKey, radio: null, error: '' });
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const value = await apiRequest<unknown>(
          latest.current,
          `radios/${radioId}`,
          {
            signal: AbortSignal.any([
              cancellation.signal,
              AbortSignal.timeout(5000),
            ]),
          },
        );
        const radio = RadioViewSchema.parse(value);
        if (radio.radioId !== radioId)
          throw new Error('The server returned another radio.');
        if (!cancellation.signal.aborted)
          setDetails({ key: contextKey, radio, error: '' });
      } catch (error) {
        if (!cancellation.signal.aborted)
          setDetails({
            key: contextKey,
            radio: null,
            error:
              error instanceof Error
                ? error.message
                : 'Radio details are unavailable.',
          });
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      cancellation.abort();
      clearInterval(timer);
    };
  }, [contextKey, radioId]);
  const currentDetails = details.key === contextKey ? details : null;
  const access = mediaAccess({
    mediaAvailable,
    radio: currentDetails?.radio ?? null,
    user: session.user,
    radioId: radioId ?? '',
    activeTx: state.pending || state.transmitting,
    radioError: currentDetails?.error,
  });
  useEffect(() => {
    if (!radioId || !mediaAvailable) return;
    setStatus({ key: contextKey, value: idleMediaState });
    let mounted = true;
    const media = new RadioMediaController({
      session: () => latest.current,
      radioId,
      port: browserMediaPort,
      onState: (next) => {
        if (mounted) setStatus({ key: contextKey, value: next });
      },
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
      mounted = false;
      controller.current = undefined;
      subscription.remove();
      if (Platform.OS === 'web') {
        window.removeEventListener('blur', stop);
        document.removeEventListener('visibilitychange', stop);
        window.removeEventListener('pointercancel', stop);
      }
      void media.dispose();
    };
  }, [
    session.baseUrl,
    session.instanceId,
    session.user.id,
    radioId,
    mediaAvailable,
  ]);
  useEffect(() => {
    if (!access.canListen && state.listening)
      void controller.current?.stop(access.listenReason);
    else if (!access.canTransmit && (state.pending || state.transmitting))
      void controller.current?.stopTransmit(access.transmitReason);
  }, [
    access.canListen,
    access.canTransmit,
    access.listenReason,
    access.transmitReason,
    state.listening,
    state.pending,
    state.transmitting,
  ]);
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
      <Text>{currentDetails?.radio?.displayName ?? 'Selected radio'}</Text>
      {currentDetails?.error ? (
        <Text accessibilityRole="alert">{currentDetails.error}</Text>
      ) : null}
      <Text accessibilityLiveRegion="polite">
        {state.listening || state.pending || state.transmitting
          ? state.message
          : !mediaAvailable
            ? 'Live audio is not configured on this server.'
            : currentDetails?.error
              ? 'Radio details are unavailable.'
              : currentDetails?.radio
                ? state.message
                : 'Loading radio audio capabilities.'}
      </Text>
      {access.listenReason ? <Text>{access.listenReason}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={!access.canListen && !state.listening}
        accessibilityState={{ disabled: !access.canListen && !state.listening }}
        onPress={() => {
          void (state.listening
            ? controller.current?.stop('Listening stopped.')
            : access.canListen
              ? controller.current?.listen()
              : undefined);
        }}
        style={{
          padding: 16,
          backgroundColor:
            access.canListen || state.listening ? '#dbeafe' : '#e5e7eb',
          borderRadius: 12,
        }}
      >
        <Text>
          {state.listening
            ? 'Stop listening'
            : access.canListen
              ? 'Listen'
              : 'Listening unavailable'}
        </Text>
      </Pressable>
      {access.transmitReason ? <Text>{access.transmitReason}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={!access.canTransmit && !state.pending && !state.transmitting}
        accessibilityState={{
          disabled:
            !access.canTransmit && !state.pending && !state.transmitting,
        }}
        accessibilityLabel="Push to talk. Hold to transmit, release to stop."
        onPressIn={() => {
          if (access.canTransmit) void controller.current?.startTransmit();
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
              : access.canTransmit
                ? '#1d4ed8'
                : '#6b7280',
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
              : access.canTransmit
                ? 'HOLD TO TALK'
                : 'Transmission unavailable'}
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
