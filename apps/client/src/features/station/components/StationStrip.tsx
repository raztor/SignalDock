import {
  Badge,
  Icon,
  layout,
  Pressable,
  radius,
  space,
  StatusIndicator,
  Text,
  type,
  useTheme,
  type Colors,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useRadioMedia } from '../../media/MediaProvider';
import { PttButton } from '../../media/components/PttButton';
import { useStation } from '../StationProvider';
import type { TxPresentation } from '../station-model';
import {
  showStripPtt,
  stationStripPresentation,
  TX_STOP_NOTICE_MS,
  txStopNotice,
} from './station-strip-model';

export interface StationStripProps {
  /** Navigates to the Radios section. Never changes the radio or its tuning. */
  onOpenRadio(): void;
}

/**
 * Persistent compact bar for the selected radio, shown on every section except
 * Radios so operators can keep listening and hold PTT while they work
 * elsewhere. It renders nothing when no radio is selected.
 */
export function StationStrip({ onOpenRadio }: StationStripProps) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < layout.compact;
  const { radioId, selected, loaded, controlState } = useStation();
  const media = useRadioMedia();
  const notice = useTxStopNotice(
    media.state.pending || media.state.transmitting,
    media.state.message,
  );
  if (!radioId) return null;

  const {
    name,
    status,
    frequency,
    known,
    confidence,
    requested,
    tx,
    accessibilityLabel,
  } = stationStripPresentation({ selected, loaded });
  const { state, access } = media;
  const showListen = media.available;
  const listenDisabled = !state.listening && !access.canListen;
  const showPtt = showStripPtt({
    available: media.available,
    canTransmit: access.canTransmit,
    transmitting: state.transmitting,
    pending: state.pending,
  });

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel={`Station: ${name}`}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: compact ? space.sm : space.md,
        rowGap: space.xs,
        paddingHorizontal: compact ? space.md : space.lg,
        paddingVertical: space.sm,
        backgroundColor: colors.surfaceElevated,
        borderColor: colors.border,
        borderTopWidth: 1,
        ...(compact
          ? {}
          : { borderWidth: 1, borderRadius: radius.lg, margin: space.md }),
      }}
    >
      {!compact && <Icon name="knob" size={20} color={colors.textSecondary} />}
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={{ flexGrow: 1, flexShrink: 1, minWidth: 140, gap: 2 }}
      >
        <Text
          numberOfLines={1}
          style={[type.caption, { color: colors.textSecondary }]}
        >
          {name}
          {known && confidence.style !== 'solid'
            ? ` · ${confidence.label}`
            : ''}
        </Text>
        <View style={{ alignSelf: 'flex-start' }}>
          <Text
            numberOfLines={1}
            style={[
              type.frequency,
              {
                fontSize: compact ? 18 : 20,
                lineHeight: compact ? 24 : 26,
                letterSpacing: -0.5,
                color: known ? colors.textPrimary : colors.textSecondary,
              },
              confidence.style === 'dotted' && {
                borderBottomWidth: 2,
                borderStyle: 'dotted',
                borderColor: colors.warning,
              },
            ]}
          >
            {frequency}
          </Text>
        </View>
        {requested ? (
          <Text
            numberOfLines={1}
            style={[type.caption, { color: colors.warning, fontWeight: '600' }]}
          >
            Requested {requested}
          </Text>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: space.sm,
          flexShrink: 1,
        }}
      >
        <StatusIndicator
          tone={status.tone}
          label={status.label}
          pulse={status.pulse}
          size="compact"
        />
        <View accessibilityLiveRegion="polite">
          {tx && <TxPill presentation={tx} colors={colors} />}
        </View>
        {controlState === 'mine' && !compact && (
          <Badge label="You have control" tone="primary" icon="lock" />
        )}
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          marginLeft: 'auto',
        }}
      >
        {showListen && (
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel={`Listen to ${name}`}
            accessibilityHint={
              listenDisabled ? access.listenReason : state.message
            }
            accessibilityState={{ checked: state.listening }}
            disabled={listenDisabled}
            onPress={() =>
              state.listening ? media.stopListening() : media.listen()
            }
            style={{
              width: layout.touch,
              height: layout.touch,
              borderRadius: layout.touch / 2,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: state.listening
                ? colors.primary
                : colors.inputBorder,
              backgroundColor: state.listening
                ? colors.primary
                : colors.surface,
            }}
          >
            <Icon
              name="headphones"
              size={20}
              color={state.listening ? colors.onPrimary : colors.primary}
            />
          </Pressable>
        )}
        {showPtt && <PttButton size="compact" />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open radio"
          accessibilityHint="Shows tuning, memories and control for this radio."
          onPress={onOpenRadio}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            minWidth: layout.touch,
            paddingHorizontal: compact ? space.md : space.lg,
            justifyContent: 'center',
            backgroundColor: compact ? 'transparent' : colors.surface,
            borderRadius: radius.md,
          }}
        >
          {!compact && (
            <Text style={[type.label, { color: colors.primary }]}>
              Open radio
            </Text>
          )}
          <Icon name="chevron-right" size={20} color={colors.primary} />
        </Pressable>
      </View>
      {/* Always mounted so screen readers announce a new stop reason. */}
      <View
        accessibilityLiveRegion="polite"
        style={notice ? { flexBasis: '100%' } : undefined}
      >
        {notice ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
            }}
          >
            <Icon name="tx" size={14} color={colors.textSecondary} />
            <Text
              numberOfLines={2}
              style={[
                type.caption,
                { color: colors.textPrimary, fontWeight: '600' },
              ]}
            >
              {notice}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Why the last transmission ended on its own (limit, interruption, lost
 * access), shown for a few seconds. A normal release shows nothing.
 */
function useTxStopNotice(active: boolean, message: string): string | undefined {
  const wasActive = useRef(active);
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    const next = txStopNotice({
      wasActive: wasActive.current,
      active,
      message,
    });
    wasActive.current = active;
    if (active) setNotice(undefined);
    else if (next) setNotice(next);
  }, [active, message]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), TX_STOP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return notice;
}

/** Radio-reported TX state. On-air states use the error tone, filled. */
function TxPill({
  presentation,
  colors,
}: {
  presentation: TxPresentation;
  colors: Colors;
}) {
  const onAir = presentation.onAir;
  const foreground = onAir
    ? colors.surface
    : presentation.tone === 'pending' || presentation.tone === 'warning'
      ? colors.warning
      : colors.textSecondary;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={presentation.label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: presentation.uncertain && !onAir ? 'dashed' : 'solid',
        borderColor: onAir ? colors.error : foreground,
        backgroundColor: onAir ? colors.error : colors.surface,
      }}
    >
      <Icon name="tx" size={12} color={foreground} />
      <Text
        numberOfLines={1}
        style={[type.caption, { color: foreground, fontWeight: '700' }]}
      >
        {presentation.label}
      </Text>
    </View>
  );
}
