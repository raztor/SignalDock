import {
  Text,
  radius,
  space,
  type,
  useReducedMotion,
  useScreenActive,
  useTheme,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import {
  LEVEL_SEGMENTS,
  levelDescription,
  levelPollInterval,
  litSegments,
  segmentZone,
  smoothLevel,
} from './level-model';

export interface LevelMeterProps {
  /** Level reader (`useRadioMedia().rxLevel`); absent when unmeasurable. */
  level?: (() => number) | undefined;
  /** Listening is active. Polling only runs while listening. */
  listening: boolean;
  /** Visible label above the meter. */
  label?: string;
  segments?: number;
  size?: 'regular' | 'compact';
}

/** Whether the app is in the foreground (web: page visible). */
function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) =>
      setActive(next === 'active'),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

/**
 * Horizontal segmented received-audio meter. Polls the level at ~15 Hz only
 * while listening, the screen is visible and the app is in the foreground;
 * updates at 2 Hz when the platform asks for reduced motion.
 */
export function LevelMeter({
  level,
  listening,
  label = 'RX level',
  segments = LEVEL_SEGMENTS,
  size = 'regular',
}: LevelMeterProps) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const screenActive = useScreenActive();
  const appActive = useAppActive();
  const measurable = Boolean(level);
  const polling = listening && measurable && screenActive && appActive;
  const [shown, setShown] = useState(0);
  const smoothed = useRef(0);
  const reader = useRef(level);
  reader.current = level;

  useEffect(() => {
    if (!polling) {
      smoothed.current = 0;
      setShown(0);
      return;
    }
    const interval = levelPollInterval(reducedMotion);
    let last = Date.now();
    const sample = () => {
      const read = reader.current;
      const now = Date.now();
      let value = 0;
      try {
        value = read ? read() : 0;
      } catch {
        value = 0;
      }
      smoothed.current = reducedMotion
        ? value
        : smoothLevel(smoothed.current, value, now - last);
      last = now;
      // Same values bail out of re-rendering.
      setShown(litSegments(smoothed.current, segments));
    };
    sample();
    const timer = setInterval(sample, interval);
    return () => clearInterval(timer);
  }, [polling, reducedMotion, segments]);

  const description = levelDescription(
    shown > 0 ? 1 : 0,
    listening,
    measurable,
  );
  const compact = size === 'compact';
  const height = compact ? 12 : 20;
  return (
    <View style={{ gap: space.xs }}>
      {compact ? null : (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            gap: space.sm,
          }}
        >
          <Text
            style={{
              ...type.caption,
              fontWeight: '600',
              color: colors.textSecondary,
            }}
          >
            {label}
          </Text>
          <Text style={{ ...type.caption, color: colors.textSecondary }}>
            {description}
          </Text>
        </View>
      )}
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${label}: ${description}`}
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 3,
          height,
        }}
      >
        {Array.from({ length: segments }, (_, index) => {
          const lit = index < shown;
          const hot = segmentZone(index, segments) === 'hot';
          return (
            <View
              key={index}
              style={{
                flex: 1,
                minWidth: 3,
                height: compact
                  ? height
                  : Math.round(height * (0.45 + (0.55 * index) / segments)),
                borderRadius: radius.sm / 2,
                // Amber is reserved for uncertainty/pending: a loud signal is
                // primary with an outline, not a warning.
                backgroundColor: lit ? colors.primary : colors.border,
                ...(lit && hot
                  ? { borderWidth: 1, borderColor: colors.textPrimary }
                  : {}),
                opacity: listening ? 1 : 0.6,
              }}
            />
          );
        })}
      </View>
    </View>
  );
}
