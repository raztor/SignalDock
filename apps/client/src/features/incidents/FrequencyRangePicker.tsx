import {
  Chip,
  NumberField,
  Text,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  PanResponder,
  Platform,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Svg, { Circle, Rect, Text as SvgText } from 'react-native-svg';
import {
  formatFrequency,
  formatMegahertzShort,
  type FrequencyRange,
} from '../station/station-model';
import {
  createRangeScale,
  draftLabel,
  dragStepHz,
  hzToMhz,
  initialRange,
  keyboardStepHz,
  mhzToHz,
  moveRangeHandle,
  nearestHandle,
  pickerDomain,
  rangeKeyAction,
  rangeResult,
  stepRangeHandle,
  type FrequencyRangeDraft,
  type RangeHandle,
} from './incident-model';

export interface FrequencyRangePickerProps {
  /** `{ any: true }` matches every frequency; otherwise both bounds in Hz. */
  value: FrequencyRangeDraft;
  onChange: (value: FrequencyRangeDraft) => void;
  /** Ranges that frame the bar, e.g. the selected radio's tuning ranges. */
  scale?: readonly FrequencyRange[];
  disabled?: boolean;
  /** Group label, default 'Frequency range'. */
  label?: string;
}

/** Hidden from assistive technology (`aria-hidden` on web). */
const decorative =
  Platform.OS === 'web'
    ? ({ 'aria-hidden': true } as const)
    : ({
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
      } as const);

const HEIGHT = 56;
const BAR_Y = 14;
const BAR_HEIGHT = 14;
const HANDLE_R = 9;
const LABEL_Y = 50;
const HANDLE_HIT = 44;
const STEPPER_MHZ = 0.1;

/**
 * Frequency bounds for a detection rule: two MHz steppers plus a band bar with
 * two draggable handles. Emits integer Hz. Each handle is a slider (arrow
 * keys, Page Up/Down, Home/End on web; increment/decrement for screen readers).
 */
export function FrequencyRangePicker({
  value,
  onChange,
  scale,
  disabled = false,
  label = 'Frequency range',
}: FrequencyRangePickerProps) {
  const { colors } = useTheme();
  const result = rangeResult(value);
  const toggleAny = () => {
    if (value.any) {
      const fallback = initialRange(scale);
      onChange({
        any: false,
        minHz: value.minHz ?? fallback.minHz,
        maxHz: value.maxHz ?? fallback.maxHz,
      });
    } else onChange({ ...value, any: true });
  };
  return (
    <View
      role="group"
      aria-label={label}
      accessibilityLabel={label}
      style={{ gap: space.md }}
    >
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.sm,
        }}
      >
        <Text style={[type.label, { color: colors.textPrimary }]}>{label}</Text>
        <Chip
          label="Any frequency"
          selected={value.any}
          disabled={disabled}
          onPress={toggleAny}
          accessibilityLabel="Any frequency: the rule matches every frequency"
        />
      </View>
      {value.any ? (
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          The rule matches transcripts on every frequency.
        </Text>
      ) : (
        <>
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: space.lg,
            }}
          >
            <Bound
              title="Lowest"
              valueHz={value.minHz}
              maxHz={value.maxHz}
              disabled={disabled}
              onChange={(minHz) => onChange({ ...value, minHz })}
            />
            <Bound
              title="Highest"
              valueHz={value.maxHz}
              minHz={value.minHz}
              disabled={disabled}
              onChange={(maxHz) => onChange({ ...value, maxHz })}
            />
          </View>
          {value.minHz !== undefined &&
          value.maxHz !== undefined &&
          value.minHz <= value.maxHz ? (
            <RangeBar
              range={{ minHz: value.minHz, maxHz: value.maxHz }}
              scale={scale}
              disabled={disabled}
              onChange={(range) => onChange({ any: false, ...range })}
            />
          ) : null}
          <Text
            accessibilityLiveRegion="polite"
            {...(result.ok ? {} : { accessibilityRole: 'alert' as const })}
            style={[
              type.caption,
              { color: result.ok ? colors.textSecondary : colors.error },
            ]}
          >
            {result.ok ? `Matches ${draftLabel(value)}.` : result.error}
          </Text>
        </>
      )}
    </View>
  );
}

function Bound({
  title,
  valueHz,
  minHz,
  maxHz,
  disabled,
  onChange,
}: {
  title: string;
  valueHz: number | undefined;
  minHz?: number | undefined;
  maxHz?: number | undefined;
  disabled: boolean;
  onChange: (hz: number | undefined) => void;
}) {
  const { colors } = useTheme();
  const min = hzToMhz(minHz) ?? 0.001;
  const max = hzToMhz(maxHz);
  return (
    <View style={{ gap: space.xs, minWidth: 0 }}>
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        {title}
      </Text>
      <NumberField
        accessibilityLabel={`${title} frequency in megahertz`}
        value={hzToMhz(valueHz)}
        onChange={(mhz) => onChange(mhzToHz(mhz))}
        step={STEPPER_MHZ}
        min={min}
        {...(max !== undefined ? { max } : {})}
        unit="MHz"
        placeholder="146.520"
        disabled={disabled}
      />
    </View>
  );
}

function RangeBar({
  range,
  scale,
  disabled,
  onChange,
}: {
  range: FrequencyRange;
  scale: readonly FrequencyRange[] | undefined;
  disabled: boolean;
  onChange: (range: FrequencyRange) => void;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [focused, setFocused] = useState<RangeHandle | undefined>();
  const container = useRef<ComponentRef<typeof View>>(null);
  // Freeze the span while dragging so the bar never rescales under a finger.
  const frozen = useRef<FrequencyRange | null>(null);
  const liveDomain = pickerDomain(scale, range);
  const domain = frozen.current ?? liveDomain;
  const bar = useMemo(
    () => createRangeScale(domain, width),
    [domain.minHz, domain.maxHz, width],
  );
  const latest = useRef({ range, bar, onChange, disabled });
  latest.current = { range, bar, onChange, disabled };
  const drag = useRef<{
    handle: RangeHandle;
    originX: number | undefined;
  } | null>(null);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !latest.current.disabled,
        onMoveShouldSetPanResponder: () => !latest.current.disabled,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event: GestureResponderEvent) => {
          const pageX = event.nativeEvent.pageX;
          frozen.current = latest.current.bar.domain;
          drag.current = { handle: 'min', originX: undefined };
          container.current?.measure((_x, _y, _w, _h, originX) => {
            if (!drag.current) return;
            const { bar: current, range: now } = latest.current;
            const hz = current.hzAt(pageX - originX);
            drag.current = { handle: nearestHandle(now, hz), originX };
            moveTo(hz);
          });
        },
        onPanResponderMove: (_event, gesture) => {
          const origin = drag.current?.originX;
          if (origin === undefined) return;
          moveTo(latest.current.bar.hzAt(gesture.moveX - origin));
        },
        onPanResponderRelease: () => {
          drag.current = null;
          frozen.current = null;
        },
        onPanResponderTerminate: () => {
          drag.current = null;
          frozen.current = null;
        },
      }),
    [],
  );

  function moveTo(hz: number) {
    const handle = drag.current?.handle;
    if (!handle) return;
    const { range: now, bar: current, onChange: emit } = latest.current;
    const next = moveRangeHandle(
      now,
      handle,
      hz,
      current.domain,
      dragStepHz(current.domain),
    );
    if (next.minHz !== now.minHz || next.maxHz !== now.maxHz) emit(next);
  }

  function step(handle: RangeHandle, direction: 1 | -1, large = false) {
    if (disabled) return;
    const next = stepRangeHandle(
      range,
      handle,
      direction * keyboardStepHz(liveDomain, large),
      liveDomain,
    );
    if (next.minHz !== range.minHz || next.maxHz !== range.maxHz)
      onChange(next);
  }
  function onKeyDown(
    handle: RangeHandle,
    event: NativeSyntheticEvent<{ key: string }>,
  ) {
    if (disabled) return;
    const action = rangeKeyAction(event.nativeEvent.key);
    if (!action) return;
    event.preventDefault();
    if (action.kind === 'step') {
      step(handle, action.direction, action.large);
      return;
    }
    const target =
      handle === 'min'
        ? action.edge === 'start'
          ? liveDomain.minHz
          : range.maxHz
        : action.edge === 'start'
          ? range.minHz
          : liveDomain.maxHz;
    const next = moveRangeHandle(range, handle, target, liveDomain, 1);
    if (next.minHz !== range.minHz || next.maxHz !== range.maxHz)
      onChange(next);
  }

  const minX = bar.x(range.minHz);
  const maxX = bar.x(range.maxHz);
  const handle = (which: RangeHandle) => {
    const hz = which === 'min' ? range.minHz : range.maxHz;
    const name = which === 'min' ? 'Lowest frequency' : 'Highest frequency';
    const valueText = `${formatFrequency(hz)} megahertz`;
    const webProps =
      Platform.OS === 'web'
        ? {
            onKeyDown: (event: NativeSyntheticEvent<{ key: string }>) =>
              onKeyDown(which, event),
            focusable: !disabled,
            role: 'slider' as const,
            'aria-label': name,
            'aria-valuetext': valueText,
            'aria-valuenow': hz,
            'aria-valuemin': which === 'min' ? liveDomain.minHz : range.minHz,
            'aria-valuemax': which === 'min' ? range.maxHz : liveDomain.maxHz,
            'aria-disabled': disabled,
            onFocus: () => setFocused(which),
            onBlur: () => setFocused(undefined),
          }
        : {};
    return (
      <View
        key={which}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={name}
        accessibilityHint="Swipe up or down to adjust."
        accessibilityValue={{ text: valueText }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event: AccessibilityActionEvent) => {
          if (event.nativeEvent.actionName === 'increment') step(which, 1);
          else if (event.nativeEvent.actionName === 'decrement')
            step(which, -1);
        }}
        {...webProps}
        style={[
          {
            position: 'absolute',
            top: BAR_Y + BAR_HEIGHT / 2 - HANDLE_HIT / 2,
            left: (which === 'min' ? minX : maxX) - HANDLE_HIT / 2,
            width: HANDLE_HIT,
            height: HANDLE_HIT,
            borderRadius: HANDLE_HIT / 2,
          },
          focused === which && {
            outlineColor: colors.focus,
            outlineWidth: 2,
            outlineStyle: 'solid',
          },
        ]}
      />
    );
  };

  const edgeLabel = (hz: number) => formatMegahertzShort(hz);
  const labelsOverlap = maxX - minX < 64;

  return (
    <View
      ref={container}
      onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
      {...responder.panHandlers}
      style={{
        height: HEIGHT,
        width: '100%',
        opacity: disabled ? 0.45 : 1,
        ...(Platform.OS === 'web'
          ? ({ touchAction: 'none', cursor: 'pointer' } as object)
          : {}),
      }}
    >
      {width > 0 && (
        <Svg width={width} height={HEIGHT} pointerEvents="none" {...decorative}>
          <Rect
            x={bar.inset}
            y={BAR_Y}
            width={Math.max(0, width - bar.inset * 2)}
            height={BAR_HEIGHT}
            rx={radius.sm}
            fill={colors.surfaceElevated}
          />
          <Rect
            x={minX}
            y={BAR_Y}
            width={Math.max(2, maxX - minX)}
            height={BAR_HEIGHT}
            fill={colors.secondary}
          />
          {(['min', 'max'] as const).map((which) => (
            <Circle
              key={which}
              cx={which === 'min' ? minX : maxX}
              cy={BAR_Y + BAR_HEIGHT / 2}
              r={HANDLE_R}
              fill={colors.surface}
              stroke={colors.primary}
              strokeWidth={3}
            />
          ))}
          <SvgText
            x={2}
            y={LABEL_Y}
            fontSize={11}
            fontFamily={type.frequency.fontFamily}
            fill={colors.textSecondary}
          >
            {edgeLabel(domain.minHz)}
          </SvgText>
          <SvgText
            x={width - 2}
            y={LABEL_Y}
            fontSize={11}
            fontFamily={type.frequency.fontFamily}
            fill={colors.textSecondary}
            textAnchor="end"
          >
            {`${edgeLabel(domain.maxHz)} MHz`}
          </SvgText>
          {labelsOverlap ? (
            <SvgText
              x={(minX + maxX) / 2}
              y={BAR_Y - 3}
              fontSize={11}
              fontFamily={type.frequency.fontFamily}
              fill={colors.textPrimary}
              textAnchor="middle"
            >
              {range.minHz === range.maxHz
                ? edgeLabel(range.minHz)
                : `${edgeLabel(range.minHz)}–${edgeLabel(range.maxHz)}`}
            </SvgText>
          ) : (
            (['min', 'max'] as const).map((which) => (
              <SvgText
                key={`label-${which}`}
                x={which === 'min' ? minX : maxX}
                y={BAR_Y - 3}
                fontSize={11}
                fontFamily={type.frequency.fontFamily}
                fill={colors.textPrimary}
                textAnchor="middle"
              >
                {edgeLabel(which === 'min' ? range.minHz : range.maxHz)}
              </SvgText>
            ))
          )}
        </Svg>
      )}
      {width > 0 && handle('min')}
      {width > 0 && handle('max')}
    </View>
  );
}
