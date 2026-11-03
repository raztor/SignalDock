import { createStyles, radius, useTheme } from '@signaldock/ui';
import { useMemo } from 'react';
import { View } from 'react-native';
import {
  formatDuration,
  resamplePeaks,
  waveformBarCount,
} from './history-model';

export interface WaveformProps {
  /** 0..1 peaks; undefined or empty draws a flat duration bar. */
  peaks?: readonly number[];
  durationMs: number;
  /** Transmissions use the error (on-air) tone. */
  transmit?: boolean;
  /** Peaks are still loading: the flat bar is shown dimmed. */
  loading?: boolean;
  height?: number;
}

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const MIN_BAR = 3;

/**
 * Recording amplitude as vertical bars, as wide as the communication is long.
 * Decorative for screen readers apart from its duration label.
 */
export function Waveform({
  peaks,
  durationMs,
  transmit = false,
  loading = false,
  height = 28,
}: WaveformProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const count = waveformBarCount(durationMs);
  const bars = useMemo(
    () => (peaks?.length ? resamplePeaks(peaks, count) : []),
    [peaks, count],
  );
  const color = transmit ? colors.error : colors.secondary;
  const width = count * BAR_WIDTH + (count - 1) * BAR_GAP;
  const duration = formatDuration(durationMs);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        bars.length
          ? `${transmit ? 'Transmitted' : 'Received'} audio waveform, ${duration}`
          : `Audio duration ${duration}`
      }
      style={[styles.frame, { height, maxWidth: '100%' }]}
    >
      {bars.length ? (
        bars.map((peak, index) => (
          <View
            key={index}
            style={[
              styles.bar,
              {
                height: Math.max(MIN_BAR, Math.round(peak * height)),
                backgroundColor: color,
              },
            ]}
          />
        ))
      ) : (
        <View
          style={[
            styles.flat,
            {
              width,
              backgroundColor: color,
              opacity: loading ? 0.25 : 0.5,
            },
          ]}
        />
      )}
    </View>
  );
}

const useStyles = createStyles(() => ({
  frame: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: BAR_GAP,
    overflow: 'hidden',
  },
  bar: { width: BAR_WIDTH, borderRadius: radius.sm, flexShrink: 0 },
  flat: { height: MIN_BAR, borderRadius: radius.sm, flexShrink: 1 },
}));
