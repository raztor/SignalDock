import {
  Icon,
  Pressable,
  StatusIndicator,
  Text,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { useStation } from '../../station/StationProvider';
import { TX_LIMIT_MS, useRadioMedia } from '../MediaProvider';
import { LevelMeter } from './LevelMeter';
import { PttButton } from './PttButton';

/** Container width from which PTT and listening sit side by side. */
const SIDE_BY_SIDE_WIDTH = 440;

export interface ListenToggleProps {
  /** `compact` is an icon-only 48 px button for dense bars. */
  size?: 'regular' | 'compact';
}

/** Listen on/off switch for the selected radio (`useRadioMedia`). */
export function ListenToggle({ size = 'regular' }: ListenToggleProps) {
  const { colors } = useTheme();
  const { state, access, listen, stopListening } = useRadioMedia();
  const listening = state.listening;
  const disabled = !listening && !access.canListen;
  const compact = size === 'compact';
  const foreground = listening ? colors.onPrimary : colors.primary;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="Listen to radio audio"
      accessibilityHint={
        disabled && access.listenReason ? access.listenReason : undefined
      }
      accessibilityState={{ checked: listening }}
      disabled={disabled}
      onPress={() => (listening ? stopListening() : listen())}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: compact ? 'auto' : 'flex-start',
        gap: space.sm,
        minWidth: compact ? 48 : undefined,
        paddingHorizontal: compact ? space.md : space.lg,
        paddingVertical: space.md,
        borderRadius: compact ? 24 : radius.md,
        borderWidth: 1,
        borderColor: listening ? colors.primary : colors.inputBorder,
        backgroundColor: listening ? colors.primary : colors.surfaceElevated,
      }}
    >
      <Icon name="headphones" size={18} color={foreground} />
      {compact ? null : (
        <Text style={{ ...type.label, color: foreground }}>
          {listening ? 'Stop listening' : 'Listen'}
        </Text>
      )}
    </Pressable>
  );
}

function Note({ title, message }: { title: string; message: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        gap: space.sm,
        padding: space.lg,
        borderRadius: radius.md,
        backgroundColor: colors.surface,
      }}
    >
      <Text accessibilityRole="header" style={type.heading}>
        {title}
      </Text>
      <Text style={{ color: colors.textSecondary }}>{message}</Text>
    </View>
  );
}

/**
 * Live audio for the selected radio: listen toggle, received level, hero PTT
 * with the 30 s ring, and the reasons when something is unavailable. Must be
 * rendered inside `StationProvider` and `MediaProvider`.
 */
export function LivePanel() {
  const { colors } = useTheme();
  const { radioId, selected } = useStation();
  const media = useRadioMedia();
  const [width, setWidth] = useState(0);
  const { state, access } = media;
  if (!radioId) return null;
  if (!media.supported)
    return (
      <Note
        title="Live audio"
        message="Live listening and voice transmission are available in the web app for now. Radio control remains available here."
      />
    );
  if (!media.configured)
    return (
      <Note
        title="Live audio"
        message="Live audio is not configured on this server. Radio control remains available."
      />
    );
  const sideBySide = width >= SIDE_BY_SIDE_WIDTH;
  const active = state.pending || state.transmitting;
  const limitSeconds = Math.round(TX_LIMIT_MS / 1000);
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        gap: space.lg,
        padding: space.lg,
        borderRadius: radius.md,
        backgroundColor: colors.surface,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: space.sm,
        }}
      >
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" style={type.heading}>
            Live audio
          </Text>
          <Text
            numberOfLines={1}
            style={{ ...type.caption, color: colors.textSecondary }}
          >
            {selected?.displayName ?? 'Selected radio'}
          </Text>
        </View>
        <StatusIndicator
          tone={state.listening ? 'ok' : 'off'}
          label={
            state.listening
              ? 'Listening'
              : access.canListen
                ? 'Not listening'
                : 'Listening unavailable'
          }
          size="compact"
        />
      </View>
      <View
        style={{
          flexDirection: sideBySide ? 'row' : 'column',
          alignItems: sideBySide ? 'center' : 'stretch',
          gap: space.xl,
        }}
      >
        <View style={{ alignItems: 'center' }}>
          <PttButton size="hero" />
        </View>
        <View style={{ flex: sideBySide ? 1 : undefined, gap: space.md }}>
          <ListenToggle />
          {!state.listening && access.listenReason ? (
            <Text style={{ ...type.caption, color: colors.textSecondary }}>
              {access.listenReason}
            </Text>
          ) : null}
          <LevelMeter level={media.rxLevel} listening={state.listening} />
          {/* Always mounted so the message after TX ends is announced. */}
          <View
            accessibilityLiveRegion="polite"
            style={
              active ? { position: 'absolute', width: 0, height: 0 } : undefined
            }
          >
            {!active ? (
              <Text style={{ ...type.caption, color: colors.textSecondary }}>
                {state.message}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
      <Text style={{ ...type.caption, color: colors.textSecondary }}>
        One operator controls this radio at a time. Each transmission stops
        after {limitSeconds} seconds and needs a new press. Release immediately
        if the carrier state is uncertain. With the keyboard, focus the button
        and hold Space or Enter.
      </Text>
    </View>
  );
}
