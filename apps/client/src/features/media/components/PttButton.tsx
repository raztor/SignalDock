import {
  Icon,
  Pressable,
  Text,
  space,
  type,
  useReducedMotion,
  useScreenActive,
  useTheme,
  type Colors,
} from '@signaldock/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useStation } from '../../station/StationProvider';
import { TX_LIMIT_MS, useRadioMedia } from '../MediaProvider';
import {
  createPttKeyboardRelease,
  type PttKeyboardRelease,
  type PttKeyEvent,
} from './ptt-keyboard';
import {
  PTT_RELEASE_GRACE_MS,
  pttPresentation,
  type PttPresentation,
  type PttTone,
} from './ptt-model';

export interface PushToTalk {
  presentation: PttPresentation;
  /** Wire to `onPressIn`: starts TX only from the ready state. */
  pressIn(): void;
  /** Wire to `onPressOut` and `onBlur`: stops this press (pending or transmitting). */
  pressOut(): void;
  /**
   * Web: wire to `onKeyDown`. Tracks a Space/Enter press so its `keyup` stops
   * TX even when focus has left the button before the key is released.
   */
  keyDown(event: PttKeyEvent): void;
}

/**
 * Hold-to-talk state for the selected radio. Must be used inside
 * `MediaProvider`. A press never auto-resumes after the controller stops TX
 * (limit, interruption, lost access); a new press is required.
 */
export function usePushToTalk(): PushToTalk {
  const media = useRadioMedia();
  const { selected } = useStation();
  const reducedMotion = useReducedMotion();
  const { startTransmit, stopTransmit } = media;
  const active = media.state.pending || media.state.transmitting;
  const [now, setNow] = useState(() => Date.now());
  const [releasedAt, setReleasedAt] = useState<number>();
  /** This button started the current press. */
  const holding = useRef(false);
  /** The controller ended TX while the button was still held. */
  const endedWhileHolding = useRef(false);
  const wasActive = useRef(active);
  const presentation = pttPresentation({
    pending: media.state.pending,
    transmitting: media.state.transmitting,
    canTransmit: media.access.canTransmit,
    transmitReason: media.access.transmitReason,
    configured: media.configured,
    supported: media.supported,
    radioTxState: selected?.snapshot?.txState,
    txStartedAt: media.txStartedAt,
    releasedAt,
    now,
    limitMs: TX_LIMIT_MS,
  });
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;

  useEffect(() => {
    if (wasActive.current && !active && holding.current)
      endedWhileHolding.current = true;
    wasActive.current = active;
  }, [active]);

  // Tick the ring/countdown while a press is live or a release is settling.
  const settling =
    releasedAt !== undefined && now - releasedAt < PTT_RELEASE_GRACE_MS;
  const ticking = active || settling;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(
      () => setNow(Date.now()),
      reducedMotion ? 1000 : 200,
    );
    return () => clearInterval(timer);
  }, [ticking, reducedMotion]);

  /** Web keyboard release tracker (created lazily on the first key press). */
  const keyboard = useRef<PttKeyboardRelease>(undefined);

  // Stop if this button unmounts mid-press (layout change, navigation).
  useEffect(
    () => () => {
      keyboard.current?.dispose();
      if (holding.current) {
        holding.current = false;
        stopTransmit('Push to talk closed.');
      }
    },
    [stopTransmit],
  );
  // The same when its screen is hidden but kept mounted (section change).
  const screenActive = useScreenActive();
  useEffect(() => {
    if (screenActive || !holding.current) return;
    keyboard.current?.dispose();
    holding.current = false;
    stopTransmit('Push to talk closed.');
  }, [screenActive, stopTransmit]);

  const pressIn = useCallback(() => {
    if (presentationRef.current.phase !== 'ready') return;
    holding.current = true;
    endedWhileHolding.current = false;
    setReleasedAt(undefined);
    startTransmit();
  }, [startTransmit]);
  const pressOut = useCallback(() => {
    const wasHolding = holding.current;
    holding.current = false;
    if (!wasHolding && !presentationRef.current.active) return;
    if (endedWhileHolding.current) {
      // The controller already stopped (and kept its reason); nothing to stop.
      endedWhileHolding.current = false;
      return;
    }
    // Always stop: render state may lag a very short press.
    stopTransmit();
    const released = Date.now();
    setReleasedAt(released);
    setNow(released);
  }, [stopTransmit]);
  const pressOutRef = useRef(pressOut);
  pressOutRef.current = pressOut;

  const keyDown = useCallback((event: PttKeyEvent) => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    keyboard.current ??= createPttKeyboardRelease(document, () =>
      pressOutRef.current(),
    );
    keyboard.current.keyDown(event);
  }, []);

  return { presentation, pressIn, pressOut, keyDown };
}

interface ButtonPalette {
  background: string;
  foreground: string;
  border: string;
  ring: string;
}

function palette(tone: PttTone, phase: string, colors: Colors): ButtonPalette {
  if (phase === 'transmitting')
    return {
      background: colors.error,
      foreground: colors.surface,
      border: colors.error,
      ring: colors.error,
    };
  if (phase === 'preparing')
    return {
      background: colors.warning,
      foreground: colors.surface,
      border: colors.warning,
      ring: colors.warning,
    };
  if (phase === 'ready')
    return {
      background: colors.primary,
      foreground: colors.onPrimary,
      border: colors.primary,
      ring: colors.primary,
    };
  const accent =
    tone === 'error'
      ? colors.error
      : tone === 'warning'
        ? colors.warning
        : colors.textSecondary;
  return {
    background: phase === 'unavailable' ? colors.disabled : colors.surface,
    foreground: accent,
    border: phase === 'unavailable' ? colors.border : accent,
    ring: accent,
  };
}

/**
 * Web: keep the browser from panning, selecting text or opening the callout
 * while a finger holds the button (a small drift would otherwise start a
 * native scroll, fire `pointercancel` and stop TX).
 */
const holdSurface: object =
  Platform.OS === 'web'
    ? {
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }
    : {};

const sizes = {
  hero: { outer: 168, button: 150, stroke: 5 },
  compact: { outer: 56, button: 46, stroke: 3 },
} as const;

export interface PttButtonProps {
  /** `hero` ≈ 168 px with text inside; `compact` 56 px icon button. */
  size?: 'hero' | 'compact';
  /** Show the status line and the unavailable reason below (hero default). */
  showStatus?: boolean;
}

/**
 * Circular hold-to-talk button with a ring showing what is left of the 30 s
 * limit. Pointer: press = start, release/cancel = stop. Web keyboard: Space or
 * Enter on the focused button starts, key up stops (auto-repeat is ignored by
 * the pressable). There is no global hotkey.
 */
export function PttButton({ size = 'hero', showStatus }: PttButtonProps) {
  const { colors } = useTheme();
  const { presentation: ptt, pressIn, pressOut, keyDown } = usePushToTalk();
  const dims = sizes[size];
  const hero = size === 'hero';
  const withStatus = showStatus ?? hero;
  const colorsFor = palette(ptt.tone, ptt.phase, colors);
  const ringRadius = (dims.outer - dims.stroke) / 2;
  const circumference = 2 * Math.PI * ringRadius;
  const center = dims.outer / 2;
  const disabled = !ptt.pressable;
  const preparing = ptt.phase === 'preparing';
  // Compact has no status text: preparing gets a dashed outline so it is not
  // told apart from on-air by colour alone.
  const compactPreparing = !hero && preparing;
  return (
    <View
      style={{
        alignItems: 'center',
        gap: space.sm,
        maxWidth: hero ? 260 : undefined,
      }}
    >
      <View
        style={[
          {
            width: dims.outer,
            height: dims.outer,
            alignItems: 'center',
            justifyContent: 'center',
          },
          holdSurface,
        ]}
      >
        <Svg
          width={dims.outer}
          height={dims.outer}
          style={{ position: 'absolute', top: 0, left: 0 }}
          pointerEvents="none"
          {...(Platform.OS === 'web'
            ? { 'aria-hidden': true }
            : {
                accessibilityElementsHidden: true,
                importantForAccessibility: 'no-hide-descendants' as const,
              })}
        >
          <Circle
            cx={center}
            cy={center}
            r={ringRadius}
            fill="none"
            stroke={colors.border}
            strokeWidth={dims.stroke}
          />
          {ptt.showRing && ptt.ringFraction > 0 ? (
            <Circle
              cx={center}
              cy={center}
              r={ringRadius}
              fill="none"
              stroke={colorsFor.ring}
              strokeWidth={dims.stroke}
              strokeLinecap="round"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={circumference * (1 - ptt.ringFraction)}
              transform={`rotate(-90 ${center} ${center})`}
            />
          ) : null}
        </Svg>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Push to talk, ${ptt.label}`}
          accessibilityHint="Hold to transmit, release to stop."
          accessibilityValue={{ text: ptt.accessibilityValue }}
          accessibilityState={{ busy: ptt.active }}
          disabled={disabled}
          feedback="none"
          hitSlop={(dims.outer - dims.button) / 2}
          onPressIn={pressIn}
          onPressOut={pressOut}
          onBlur={pressOut}
          {...(Platform.OS === 'web'
            ? {
                onContextMenu: (event: { preventDefault(): void }) =>
                  event.preventDefault(),
                onKeyDown: (event: {
                  nativeEvent: { key: string; repeat?: boolean };
                }) =>
                  keyDown({
                    key: event.nativeEvent.key,
                    repeat: event.nativeEvent.repeat === true,
                  }),
              }
            : {})}
          style={[
            {
              width: dims.button,
              height: dims.button,
              minHeight: dims.button,
              borderRadius: dims.button / 2,
              borderWidth: compactPreparing
                ? 2
                : ptt.phase === 'ready' || ptt.active
                  ? 0
                  : 2,
              borderStyle:
                ptt.phase === 'uncertain' || compactPreparing
                  ? 'dashed'
                  : 'solid',
              borderColor: compactPreparing
                ? colorsFor.foreground
                : colorsFor.border,
              backgroundColor: colorsFor.background,
              alignItems: 'center',
              justifyContent: 'center',
              padding: hero ? space.md : 0,
            },
            holdSurface,
          ]}
        >
          {hero ? (
            <View style={{ alignItems: 'center', gap: 2 }}>
              <Icon
                name={ptt.phase === 'transmitting' ? 'tx' : 'mic'}
                size={22}
                color={colorsFor.foreground}
              />
              <Text
                selectable={false}
                numberOfLines={2}
                style={{
                  ...type.label,
                  fontSize: 16,
                  fontWeight: '700',
                  textAlign: 'center',
                  color: colorsFor.foreground,
                }}
              >
                {ptt.label}
              </Text>
              {ptt.detail ? (
                <Text
                  selectable={false}
                  numberOfLines={1}
                  style={{
                    ...type.caption,
                    fontWeight: '500',
                    textAlign: 'center',
                    color: colorsFor.foreground,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {ptt.detail}
                </Text>
              ) : null}
            </View>
          ) : ptt.active && ptt.secondsLeft !== undefined ? (
            <View style={{ alignItems: 'center' }}>
              <Icon
                name={preparing ? 'mic' : 'tx'}
                size={12}
                color={colorsFor.foreground}
              />
              <Text
                selectable={false}
                style={{
                  ...type.caption,
                  fontWeight: '700',
                  lineHeight: 14,
                  color: colorsFor.foreground,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {ptt.secondsLeft}
              </Text>
            </View>
          ) : (
            <Icon name="mic" size={22} color={colorsFor.foreground} />
          )}
        </Pressable>
      </View>
      {withStatus ? (
        <View
          accessibilityLiveRegion="polite"
          style={{ alignItems: 'center', gap: space.xs }}
        >
          <Text
            style={{
              ...type.caption,
              textAlign: 'center',
              color:
                ptt.tone === 'warning'
                  ? colors.warning
                  : ptt.tone === 'error'
                    ? colors.error
                    : colors.textSecondary,
            }}
          >
            {ptt.status}
          </Text>
          {ptt.reason ? (
            <Text
              style={{
                ...type.caption,
                textAlign: 'center',
                color: colors.textSecondary,
              }}
            >
              {ptt.reason}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
