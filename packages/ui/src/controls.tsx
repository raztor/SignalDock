import {
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Platform,
  TextInput as NativeTextInput,
  View,
  type StyleProp,
  type TextInputKeyPressEvent,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import {
  commitChipText,
  hasChipSeparator,
  removeChip,
} from './chip-input-model';
import { Icon, type IconName } from './icons';
import { Pressable, Text, TextInput } from './primitives';
import {
  canStepNumber,
  clampNumber,
  parseNumberInput,
  stepNumber,
} from './schema-form-model';
import { useTheme } from './theme';
import { layout, radius, space, type, type Colors } from './tokens';

export type ControlTone = 'neutral' | 'primary' | 'warning' | 'error';

/** Dense controls (chips, compact segments) keep a 48 pt hit area with slop. */
const denseHitSlop = { top: 6, bottom: 6, left: 4, right: 4 } as const;

/** Resolves whether the platform asks for reduced motion (false until known). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (current) setReduced(value);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (value: boolean) => setReduced(value),
    );
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

// ─── SegmentedControl ──────────────────────────────────────────────────────

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  size?: 'regular' | 'compact';
}

/**
 * Index of the next enabled option from `from` in `direction` (wrapping), or
 * undefined when none is enabled.
 */
function nextEnabled(
  enabled: readonly boolean[],
  from: number,
  direction: 1 | -1,
): number | undefined {
  const count = enabled.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (((from + direction * step) % count) + count) % count;
    if (enabled[index]) return index;
  }
  return undefined;
}

/**
 * Single choice among a few options, with radio-group semantics. Wraps when
 * narrow. Web follows the ARIA radio group pattern: one Tab stop (the checked
 * option, or the first enabled one) and arrow keys move and select.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
  size = 'regular',
}: SegmentedControlProps<T>) {
  const { colors } = useTheme();
  const compact = size === 'compact';
  const web = Platform.OS === 'web';
  const nodes = useRef<({ focus?: () => void } | null)[]>([]);
  const enabled = options.map(
    (option) => !disabled && option.disabled !== true,
  );
  const checkedIndex = options.findIndex((option) => option.value === value);
  const tabStop =
    checkedIndex >= 0 && enabled[checkedIndex]
      ? checkedIndex
      : enabled.indexOf(true);
  const onKeyDown = (event: {
    nativeEvent: { key: string };
    preventDefault(): void;
  }) => {
    const key = event.nativeEvent.key;
    const direction =
      key === 'ArrowRight' || key === 'ArrowDown'
        ? 1
        : key === 'ArrowLeft' || key === 'ArrowUp'
          ? -1
          : undefined;
    if (direction === undefined) return;
    const from = checkedIndex >= 0 ? checkedIndex : tabStop;
    const next = nextEnabled(enabled, from < 0 ? -1 : from, direction);
    const option = next === undefined ? undefined : options[next];
    if (next === undefined || !option) return;
    event.preventDefault();
    nodes.current[next]?.focus?.();
    if (option.value !== value) onChange(option.value);
  };
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      {...(web ? { onKeyDown } : {})}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignSelf: 'flex-start',
        maxWidth: '100%',
        gap: 2,
        padding: 2,
        borderWidth: 1,
        borderColor: colors.inputBorder,
        borderRadius: radius.md,
        backgroundColor: colors.surface,
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const inactive = disabled || option.disabled === true;
        return (
          <Pressable
            key={option.value}
            ref={(node: { focus?: () => void } | null) => {
              nodes.current[index] = node;
            }}
            {...(web ? { tabIndex: index === tabStop ? 0 : -1 } : {})}
            accessibilityRole="radio"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ checked: selected }}
            disabled={inactive}
            hitSlop={compact ? denseHitSlop : undefined}
            onPress={() => {
              if (!selected) onChange(option.value);
            }}
            style={{
              minHeight: compact ? 32 : layout.touch - 6,
              paddingHorizontal: compact ? space.sm + 2 : space.md,
              alignItems: 'center',
              borderRadius: radius.md - 2,
              backgroundColor: selected ? colors.primary : 'transparent',
            }}
          >
            <Text
              numberOfLines={1}
              style={[
                type.label,
                compact && { fontSize: 13, lineHeight: 18 },
                { color: selected ? colors.onPrimary : colors.textPrimary },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Chip / ChipGroup ──────────────────────────────────────────────────────

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  icon?: IconName;
  tone?: ControlTone;
  /** Dashed outline, e.g. a value that is inferred rather than confirmed. */
  dashed?: boolean;
  /** Monospace label (frequencies). */
  monospace?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

function chipColors(colors: Colors, tone: ControlTone, selected: boolean) {
  if (selected)
    return {
      background: colors.primary,
      foreground: colors.onPrimary,
      border: colors.primary,
    };
  switch (tone) {
    case 'primary':
      return {
        background: colors.selected,
        foreground: colors.primary,
        border: colors.selected,
      };
    case 'warning':
      return {
        background: colors.surface,
        foreground: colors.warning,
        border: colors.warning,
      };
    case 'error':
      return {
        background: colors.surface,
        foreground: colors.error,
        border: colors.error,
      };
    default:
      return {
        background: colors.surfaceElevated,
        foreground: colors.textPrimary,
        border: colors.surfaceElevated,
      };
  }
}

/** Compact label, filter toggle or removable value. */
export function Chip({
  label,
  selected,
  onPress,
  onRemove,
  icon,
  tone = 'neutral',
  dashed = false,
  monospace = false,
  disabled = false,
  accessibilityLabel,
}: ChipProps) {
  const { colors } = useTheme();
  const palette = chipColors(colors, tone, selected === true);
  const container: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: dashed ? 'dashed' : 'solid',
    borderColor: dashed ? palette.foreground : palette.border,
    backgroundColor: palette.background,
  };
  const content = (
    <>
      {selected === true && !icon && (
        <Icon name="check" size={14} color={palette.foreground} />
      )}
      {icon && <Icon name={icon} size={14} color={palette.foreground} />}
      <Text
        numberOfLines={1}
        style={[
          type.label,
          { fontSize: 13, lineHeight: 18, color: palette.foreground },
          monospace && {
            fontFamily: type.frequency.fontFamily,
            fontVariant: ['tabular-nums'],
          },
        ]}
      >
        {label}
      </Text>
    </>
  );
  const inner: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingLeft: space.md,
    paddingRight: onRemove ? space.xs : space.md,
    minHeight: 30,
    flexShrink: 1,
  };
  return (
    <View style={[container, disabled && { opacity: 0.45 }]}>
      {onPress ? (
        <Pressable
          accessibilityRole={selected === undefined ? 'button' : 'checkbox'}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={
            selected === undefined ? {} : { checked: selected }
          }
          disabled={disabled}
          hitSlop={denseHitSlop}
          onPress={onPress}
          style={[inner, { minHeight: 30, borderRadius: 999 }]}
        >
          {content}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityLabel={accessibilityLabel ?? label}
          style={inner}
        >
          {content}
        </View>
      )}
      {onRemove && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          disabled={disabled}
          hitSlop={denseHitSlop}
          onPress={onRemove}
          style={{
            minHeight: 30,
            minWidth: 30,
            alignItems: 'center',
            borderRadius: 999,
            marginRight: 2,
          }}
        >
          <Icon name="close" size={14} color={palette.foreground} />
        </Pressable>
      )}
    </View>
  );
}

/** Wrapping row of chips announced as one group. */
export function ChipGroup({
  children,
  accessibilityLabel,
  style,
}: PropsWithChildren<{
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}>) {
  return (
    <View
      role="group"
      aria-label={accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: space.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ─── ChipInput ─────────────────────────────────────────────────────────────

export interface ChipInputProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  accessibilityLabel: string;
  validate?: (value: string) => string | undefined;
  maxItems?: number;
  disabled?: boolean;
}

/**
 * Free-form list entry: Enter, comma or leaving the field creates a chip,
 * Backspace on an empty field removes the last one, each chip is removable.
 * Duplicates are ignored case-insensitively.
 */
export function ChipInput({
  values,
  onChange,
  placeholder,
  accessibilityLabel,
  validate,
  maxItems,
  disabled = false,
}: ChipInputProps) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const [focused, setFocused] = useState(false);
  const full = maxItems !== undefined && values.length >= maxItems;
  const commit = (text: string) => {
    const result = commitChipText(values, text, {
      ...(validate ? { validate } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
    });
    if (result.values.length !== values.length) onChange(result.values);
    setDraft(result.remaining);
    setError(result.error);
  };
  const onKeyPress = (event: TextInputKeyPressEvent) => {
    if (event.nativeEvent.key === 'Backspace' && draft === '' && values.length)
      onChange(removeChip(values));
  };
  return (
    <View style={{ gap: space.xs }}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: space.sm,
          minHeight: layout.touch,
          paddingHorizontal: space.sm,
          paddingVertical: space.xs + 2,
          borderWidth: focused ? 2 : 1,
          margin: focused ? 0 : 1,
          borderColor: error
            ? colors.error
            : focused
              ? colors.focus
              : colors.inputBorder,
          borderRadius: radius.md,
          backgroundColor: colors.surface,
          opacity: disabled ? 0.45 : 1,
        }}
      >
        {values.map((value, index) => (
          <Chip
            key={`${value}-${index}`}
            label={value}
            disabled={disabled}
            onRemove={() => onChange(removeChip(values, index))}
          />
        ))}
        <NativeTextInput
          value={draft}
          editable={!disabled && !full}
          placeholder={full ? `Limit of ${maxItems} reached` : placeholder}
          placeholderTextColor={colors.textSecondary}
          selectionColor={colors.primary}
          accessibilityLabel={accessibilityLabel}
          accessibilityHint="Press Enter or type a comma to add each entry."
          autoCapitalize="none"
          autoCorrect={false}
          submitBehavior="submit"
          returnKeyType="done"
          onChangeText={(text) => {
            if (hasChipSeparator(text)) commit(text);
            else {
              setDraft(text);
              if (error) setError(undefined);
            }
          }}
          onSubmitEditing={() => commit(draft)}
          onKeyPress={onKeyPress}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (draft.trim()) commit(draft);
          }}
          style={[
            type.body,
            {
              flexGrow: 1,
              flexBasis: 120,
              minWidth: 90,
              minHeight: 36,
              paddingVertical: space.xs,
              paddingHorizontal: space.xs,
              color: colors.textPrimary,
            },
            Platform.OS === 'web' && { outlineStyle: 'none' as never },
          ]}
        />
      </View>
      {error && (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={[type.caption, { color: colors.error }]}
        >
          {error}
        </Text>
      )}
    </View>
  );
}

// ─── StatusIndicator / Badge ───────────────────────────────────────────────

export type StatusTone =
  'ok' | 'pending' | 'warning' | 'error' | 'off' | 'unknown';

function StatusMark({
  tone,
  size,
  colors,
}: {
  tone: StatusTone;
  size: number;
  colors: Colors;
}) {
  const hidden =
    Platform.OS === 'web'
      ? { 'aria-hidden': true }
      : {
          accessibilityElementsHidden: true,
          importantForAccessibility: 'no-hide-descendants' as const,
        };
  // Each tone has its own shape so status never depends on color alone.
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12" {...hidden}>
      {tone === 'ok' && <Circle cx={6} cy={6} r={5} fill={colors.success} />}
      {tone === 'pending' && (
        <Circle
          cx={6}
          cy={6}
          r={4.5}
          fill="none"
          stroke={colors.warning}
          strokeWidth={2}
          strokeDasharray="2.4 1.6"
        />
      )}
      {tone === 'warning' && (
        <Path d="M6 1 11.2 10.5H.8L6 1Z" fill={colors.warning} />
      )}
      {tone === 'error' && (
        <Path d="M6 .8 11.2 6 6 11.2.8 6 6 .8Z" fill={colors.error} />
      )}
      {tone === 'off' && (
        <Circle
          cx={6}
          cy={6}
          r={4.5}
          fill="none"
          stroke={colors.inputBorder}
          strokeWidth={2}
        />
      )}
      {tone === 'unknown' && (
        <>
          <Circle
            cx={6}
            cy={6}
            r={4.5}
            fill="none"
            stroke={colors.textSecondary}
            strokeWidth={1.5}
            strokeDasharray="1.5 1.5"
          />
          <Circle cx={6} cy={6} r={1.2} fill={colors.textSecondary} />
        </>
      )}
    </Svg>
  );
}

export interface StatusIndicatorProps {
  tone: StatusTone;
  label: string;
  /** Gentle opacity pulse (skipped when the platform asks for reduced motion). */
  pulse?: boolean;
  size?: 'regular' | 'compact';
}

/** Status shape + text. Pending/warning use amber, errors red, off is hollow. */
export function StatusIndicator({
  tone,
  label,
  pulse = false,
  size = 'regular',
}: StatusIndicatorProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  const animate = pulse && !reduced;
  useEffect(() => {
    if (!animate) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 700,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animate, opacity]);
  const compact = size === 'compact';
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: compact ? space.xs + 2 : space.sm,
        flexShrink: 1,
      }}
    >
      <Animated.View style={{ opacity }}>
        <StatusMark tone={tone} size={compact ? 9 : 11} colors={colors} />
      </Animated.View>
      <Text
        numberOfLines={1}
        style={[
          compact ? type.caption : type.label,
          compact && { fontWeight: '600' },
          { color: colors.textPrimary },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

export interface BadgeProps {
  label: string;
  tone?: ControlTone;
  icon?: IconName;
}

/** Small non-interactive label, e.g. verification level or mode. */
export function Badge({ label, tone = 'neutral', icon }: BadgeProps) {
  const { colors } = useTheme();
  const palette =
    tone === 'primary'
      ? { background: colors.selected, foreground: colors.primary }
      : tone === 'warning'
        ? { background: colors.surface, foreground: colors.warning }
        : tone === 'error'
          ? { background: colors.surface, foreground: colors.error }
          : {
              background: colors.surfaceElevated,
              foreground: colors.textSecondary,
            };
  const outlined = tone === 'warning' || tone === 'error';
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: outlined ? palette.foreground : palette.background,
        backgroundColor: palette.background,
      }}
    >
      {icon && <Icon name={icon} size={12} color={palette.foreground} />}
      <Text
        numberOfLines={1}
        style={{
          fontSize: 11,
          lineHeight: 16,
          fontWeight: '600',
          letterSpacing: 0.2,
          color: palette.foreground,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// ─── Stepper (wizard progress) ─────────────────────────────────────────────

export interface StepperProps {
  steps: readonly string[];
  /** Zero-based index of the current step. */
  current: number;
}

/** Numbered wizard progress: done steps show a check, the current step is filled. */
export function Stepper({ steps, current }: StepperProps) {
  const { colors } = useTheme();
  const active = Math.min(Math.max(current, 0), Math.max(steps.length - 1, 0));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${active + 1} of ${steps.length}: ${steps[active] ?? ''}`}
      accessibilityValue={{ min: 1, max: steps.length, now: active + 1 }}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        rowGap: space.sm,
        columnGap: space.sm,
      }}
    >
      {steps.map((step, index) => {
        const state =
          index < active ? 'done' : index === active ? 'current' : 'upcoming';
        return (
          <View
            key={`${index}-${step}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
            }}
          >
            {index > 0 && (
              <View
                style={{
                  width: space.lg,
                  height: 2,
                  borderRadius: 1,
                  backgroundColor:
                    state === 'upcoming' ? colors.border : colors.primary,
                }}
              />
            )}
            <View
              style={{
                width: 26,
                height: 26,
                borderRadius: 13,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 2,
                borderColor:
                  state === 'upcoming' ? colors.inputBorder : colors.primary,
                backgroundColor:
                  state === 'current'
                    ? colors.primary
                    : state === 'done'
                      ? colors.selected
                      : 'transparent',
              }}
            >
              {state === 'done' ? (
                <Icon name="check" size={14} color={colors.primary} />
              ) : (
                <Text
                  style={[
                    type.caption,
                    {
                      fontWeight: '700',
                      color:
                        state === 'current'
                          ? colors.onPrimary
                          : colors.textSecondary,
                    },
                  ]}
                >
                  {index + 1}
                </Text>
              )}
            </View>
            <Text
              numberOfLines={1}
              style={[
                type.caption,
                {
                  fontWeight: state === 'current' ? '700' : '500',
                  color:
                    state === 'upcoming'
                      ? colors.textSecondary
                      : colors.textPrimary,
                },
              ]}
            >
              {step}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── NumberField ───────────────────────────────────────────────────────────

export interface NumberFieldProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  accessibilityLabel: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  unit?: string;
  placeholder?: string;
  disabled?: boolean;
}

const formatNumberText = (value: number | undefined) =>
  value === undefined ? '' : String(value);

/** Numeric text entry with − / + stepper buttons that stop at the bounds. */
export function NumberField({
  value,
  onChange,
  accessibilityLabel,
  min,
  max,
  step = 1,
  integer = false,
  unit,
  placeholder,
  disabled = false,
}: NumberFieldProps) {
  const { colors } = useTheme();
  const bounds = {
    step,
    integer,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
  const [draft, setDraft] = useState(formatNumberText(value));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDraft((current) => {
      const parsed = parseNumberInput(current, { integer });
      return parsed.ok && parsed.value === value
        ? current
        : formatNumberText(value);
    });
    setError(undefined);
  }, [value, integer]);
  const stepButton = (direction: 1 | -1) => {
    const label = direction > 0 ? 'Increase' : 'Decrease';
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} ${accessibilityLabel}`}
        disabled={disabled || !canStepNumber(value, direction, bounds)}
        onPress={() => onChange(stepNumber(value, direction, bounds))}
        style={{
          width: layout.touch,
          alignItems: 'center',
          backgroundColor: colors.surfaceElevated,
        }}
      >
        <Icon
          name={direction > 0 ? 'plus' : 'minus'}
          size={18}
          color={colors.textPrimary}
        />
      </Pressable>
    );
  };
  return (
    <View style={{ gap: space.xs }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          maxWidth: '100%',
        }}
      >
        {stepButton(-1)}
        <TextInput
          value={draft}
          editable={!disabled}
          accessibilityLabel={accessibilityLabel}
          {...(placeholder ? { placeholder } : {})}
          keyboardType={
            integer && (min === undefined || min >= 0)
              ? 'number-pad'
              : 'numbers-and-punctuation'
          }
          inputMode={integer ? 'numeric' : 'decimal'}
          onChangeText={(text) => {
            setDraft(text);
            const parsed = parseNumberInput(text, { integer });
            if (!parsed.ok) {
              setError(parsed.error);
              return;
            }
            setError(undefined);
            if (parsed.value !== value) onChange(parsed.value);
          }}
          onBlur={() => {
            const parsed = parseNumberInput(draft, { integer });
            if (parsed.ok && parsed.value !== undefined) {
              const clamped = clampNumber(parsed.value, bounds);
              if (clamped !== value) onChange(clamped);
              setDraft(formatNumberText(clamped));
            }
          }}
          style={{
            width: 120,
            textAlign: 'center',
            fontVariant: ['tabular-nums'],
            ...(error ? { borderColor: colors.error } : {}),
          }}
        />
        {stepButton(1)}
        {unit && (
          <Text style={[type.label, { color: colors.textSecondary }]}>
            {unit}
          </Text>
        )}
      </View>
      {error && (
        <Text
          accessibilityRole="alert"
          style={[type.caption, { color: colors.error }]}
        >
          {error}
        </Text>
      )}
    </View>
  );
}

// ─── Overlay ───────────────────────────────────────────────────────────────

export interface OverlayProps {
  visible: boolean;
  onClose: () => void;
  accessibilityLabel: string;
  placement?: 'center' | 'top';
  maxWidth?: number;
  children?: ReactNode;
}

/**
 * Modal surface for sheets and the command palette. The backdrop, Escape (web)
 * and the Android back button close it.
 */
export function Overlay({
  visible,
  onClose,
  accessibilityLabel,
  placement = 'center',
  maxWidth = 560,
  children,
}: OverlayProps) {
  const { colors } = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: placement === 'top' ? 'flex-start' : 'center',
          padding: space.lg,
          paddingTop: placement === 'top' ? space.xxxl * 2 : space.lg,
        }}
      >
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          tabIndex={-1}
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: 0,
            backgroundColor: colors.background,
            opacity: 0.86,
          }}
        />
        <View
          accessibilityViewIsModal
          accessibilityLabel={accessibilityLabel}
          role="dialog"
          aria-modal
          aria-label={accessibilityLabel}
          style={{
            width: '100%',
            maxWidth,
            maxHeight: '100%',
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.lg,
            padding: space.lg,
            gap: space.md,
          }}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}
