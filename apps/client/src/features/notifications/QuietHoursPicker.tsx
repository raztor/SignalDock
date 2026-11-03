import {
  Icon,
  Pressable,
  SettingToggle,
  Text,
  createStyles,
  layout,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import {
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  formatClockMinutes,
  quietCellLabel,
  quietCellStates,
  quietHourKey,
  quietRangeLabel,
  quietSpanMinutes,
  quietSummary,
  stepQuietBoundary,
  tapQuietHour,
  type QuietDraft,
} from './notification-model';

export interface QuietHoursPickerProps {
  /** Minutes after midnight; `end` is exclusive and may be before `start` (overnight). */
  value: QuietDraft;
  onChange: (value: QuietDraft) => void;
  /** Shown after the range, e.g. 'America/Santiago'. */
  timeZone?: string;
  disabled?: boolean;
}

type Focusable = { focus?: () => void } | null;

const AXIS = ['00', '06', '12', '18', '24'];

/**
 * Quiet hours on a 24-hour bar: tap the first quiet hour, then the last (the
 * selection wraps past midnight), and fine-tune either end in 30-minute steps.
 * The value is minutes; the screen converts it to the backend's 'HH:MM'.
 */
export function QuietHoursPicker({
  value,
  onChange,
  timeZone,
  disabled = false,
}: QuietHoursPickerProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const web = Platform.OS === 'web';
  const [anchor, setAnchor] = useState<number>();
  const [focusHour, setFocusHour] = useState<number>();
  const cells = useRef<Focusable[]>([]);
  const cellStates = quietCellStates(value);
  const tabStop = focusHour ?? anchor ?? Math.floor(value.start / 60);

  const setEnabled = (enabled: boolean) => {
    setAnchor(undefined);
    onChange(
      enabled && quietSpanMinutes(value) === 0
        ? { enabled, start: DEFAULT_QUIET_START, end: DEFAULT_QUIET_END }
        : { ...value, enabled },
    );
  };
  const tap = (hour: number) => {
    const next = tapQuietHour({ range: value, anchor }, hour);
    setAnchor(next.anchor);
    setFocusHour(hour);
    onChange({ enabled: true, ...next.range });
  };
  const step = (boundary: 'start' | 'end', direction: 1 | -1) => {
    setAnchor(undefined);
    onChange({
      enabled: true,
      ...stepQuietBoundary(value, boundary, direction),
    });
  };
  const onKeyDown = (event: {
    nativeEvent: { key: string };
    preventDefault(): void;
  }) => {
    const key = event.nativeEvent.key;
    if (key === 'Escape' && anchor !== undefined) {
      event.preventDefault();
      setAnchor(undefined);
      return;
    }
    const next = quietHourKey(key, tabStop);
    if (next === undefined) return;
    event.preventDefault();
    setFocusHour(next);
    cells.current[next]?.focus?.();
  };

  const stepper = (boundary: 'start' | 'end') => {
    const name = boundary === 'start' ? 'Start' : 'End';
    const clock = formatClockMinutes(value[boundary]);
    return (
      <View style={styles.stepper}>
        <Text style={styles.stepperLabel}>{name}</Text>
        <View style={styles.stepperControls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${name} 30 minutes earlier, now ${clock}`}
            disabled={disabled}
            onPress={() => step(boundary, -1)}
            style={styles.stepButton}
          >
            <Icon name="minus" size={18} color={colors.textPrimary} />
          </Pressable>
          <Text accessibilityLabel={`${name} ${clock}`} style={styles.clock}>
            {clock}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${name} 30 minutes later, now ${clock}`}
            disabled={disabled}
            onPress={() => step(boundary, 1)}
            style={styles.stepButton}
          >
            <Icon name="plus" size={18} color={colors.textPrimary} />
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <SettingToggle
        label="Quiet hours"
        value={value.enabled}
        disabled={disabled}
        onValueChange={setEnabled}
      />
      {!value.enabled ? (
        <Text style={styles.muted}>
          Off. Alerts can arrive at any time of day.
        </Text>
      ) : (
        <>
          <View style={styles.summary} accessibilityLiveRegion="polite">
            <Text style={styles.range}>{quietRangeLabel(value)}</Text>
            <Text style={styles.muted}>
              {quietSummary(value)}
              {timeZone ? ` · ${timeZone}` : ''}
            </Text>
          </View>
          <View
            accessibilityRole="toolbar"
            accessibilityLabel="Quiet hours, one cell per hour"
            {...(web ? { onKeyDown } : {})}
            style={styles.bar}
          >
            {cellStates.map((state, hour) => {
              const pending = anchor === hour;
              return (
                <Pressable
                  key={hour}
                  ref={(node: Focusable) => {
                    cells.current[hour] = node;
                  }}
                  feedback="none"
                  {...(web ? { tabIndex: hour === tabStop ? 0 : -1 } : {})}
                  accessibilityRole="button"
                  accessibilityLabel={`${quietCellLabel(hour, state)}${pending ? ', first hour selected' : ''}`}
                  accessibilityHint={
                    anchor === undefined
                      ? 'Marks the first quiet hour'
                      : 'Marks the last quiet hour'
                  }
                  accessibilityState={{
                    selected: state !== 'off',
                  }}
                  disabled={disabled}
                  onFocus={() => setFocusHour(hour)}
                  onPress={() => tap(hour)}
                  style={[styles.cell, pending && styles.cellPending]}
                >
                  {state !== 'off' && (
                    <View
                      style={[
                        styles.fill,
                        state === 'partial' && styles.fillPartial,
                      ]}
                    />
                  )}
                </Pressable>
              );
            })}
          </View>
          <View
            style={styles.axis}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            {AXIS.map((label) => (
              <Text key={label} style={styles.axisLabel}>
                {label}
              </Text>
            ))}
          </View>
          <Text style={[styles.muted, anchor !== undefined && styles.prompt]}>
            {anchor !== undefined
              ? `First quiet hour ${formatClockMinutes(anchor * 60)}. Now tap the last quiet hour; earlier hours continue past midnight.`
              : 'Tap the first quiet hour, then the last. Use − and + for half hours.'}
          </Text>
          <View style={styles.steppers}>
            {stepper('start')}
            <Icon name="arrow" size={18} />
            {stepper('end')}
          </View>
        </>
      )}
    </View>
  );
}

const useStyles = createStyles((c) => ({
  root: { gap: space.md },
  muted: { ...type.body, color: c.textSecondary },
  prompt: { color: c.warning },
  summary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space.md,
    rowGap: space.xs,
  },
  range: {
    ...type.frequency,
    fontSize: 22,
    lineHeight: 30,
    color: c.textPrimary,
  },
  bar: {
    flexDirection: 'row',
    gap: 2,
    width: '100%',
  },
  cell: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: c.surfaceElevated,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  cellPending: { borderWidth: 2, borderColor: c.warning },
  fill: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: 0,
    backgroundColor: c.secondary,
  },
  fillPartial: { top: '50%' },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  axisLabel: {
    ...type.caption,
    color: c.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  steppers: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: space.md,
  },
  stepper: { gap: space.xs },
  stepperLabel: { ...type.label, color: c.textSecondary },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  stepButton: {
    width: layout.touch,
    alignItems: 'center',
    borderRadius: 0,
    backgroundColor: c.surfaceElevated,
  },
  clock: {
    ...type.label,
    minWidth: 64,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    color: c.textPrimary,
  },
}));
