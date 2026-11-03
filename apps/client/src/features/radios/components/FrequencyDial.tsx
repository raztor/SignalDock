import {
  Button,
  Icon,
  Pressable,
  Text,
  TextInput,
  layout,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from 'react';
import {
  Platform,
  View,
  useWindowDimensions,
  type AccessibilityActionEvent,
  type TextStyle,
  type NativeSyntheticEvent,
  type TextInputKeyPressEvent,
} from 'react-native';
import {
  formatFrequency,
  nearestRange,
  parseFrequencyInput,
  type FrequencyRange,
} from '../../station/station-model';
import {
  dialAccessibilityValue,
  dialDigits,
  dialDigitWeights,
  dialKeyAction,
  dialMaxHz,
  edgeMessage,
  moveDigitFocus,
  stepDigit,
  stepDigitIndex,
  stepLabel,
  wheelSteps,
  type DialDigit,
} from './tuning-model';

/** Hidden from assistive technology (`aria-hidden` on web, where the native props would reach the DOM). */
const decorative =
  Platform.OS === 'web'
    ? ({ 'aria-hidden': true } as const)
    : ({
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
      } as const);

const MHZ = 1_000_000;

/** An empty, always-mounted live region that takes no space in the gap layout. */
const emptyLiveRegion = { position: 'absolute', width: 0, height: 0 } as const;

/** Present for assistive technology (e.g. as `aria-describedby` text) but not drawn. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  opacity: 0,
} as const;

export interface FrequencyDialProps {
  /** Draft frequency in Hz. The dial only edits the draft; it never tunes. */
  valueHz: number;
  onChange: (hz: number) => void;
  ranges: readonly FrequencyRange[];
  /** Arrow keys and screen-reader increments move by this many Hz. */
  stepHz: number;
  disabled?: boolean;
  /** Enter on the focused dial (e.g. apply the draft). */
  onSubmit?: () => void;
  /** Escape on the focused dial (e.g. revert the draft). */
  onRevert?: () => void;
  accessibilityLabel?: string;
  size?: 'regular' | 'compact';
}

/**
 * Digit-by-digit frequency editor: up/down per digit, mouse wheel per digit
 * (web, once the dial has focus), keyboard (web: arrows = step, ←/→ = digit focus, PageUp/PageDown =
 * 1 MHz, Enter = submit, Escape = revert) and an optional typed entry.
 * Values outside `ranges` are never produced.
 */
export function FrequencyDial({
  valueHz,
  onChange,
  ranges,
  stepHz,
  disabled = false,
  onSubmit,
  onRevert,
  accessibilityLabel = 'Frequency',
  size,
}: FrequencyDialProps) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const compact = size ? size === 'compact' : width < layout.compact;
  const maxHz = dialMaxHz(ranges, valueHz);
  const weights = useMemo(() => dialDigitWeights(maxHz), [maxHz]);
  const digits = dialDigits(valueHz, weights);
  const [focusIndex, setFocusIndex] = useState<number | undefined>();
  const [focused, setFocused] = useState(false);
  const [message, setMessage] = useState('');
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState('');

  const dialRef = useRef<ComponentRef<typeof View>>(null);
  /** Web: the wheel edits digits only once the dial holds focus, so scrolling the page past it never changes the draft. */
  const engaged = () => {
    const node = dialRef.current as unknown as HTMLElement | null;
    return Boolean(
      node &&
      typeof document !== 'undefined' &&
      typeof node.contains === 'function' &&
      node.contains(document.activeElement),
    );
  };
  // Several wheel/key events can arrive before the parent re-renders.
  const latest = useRef(valueHz);
  latest.current = valueHz;
  const handlers = useRef({ onChange, onSubmit, onRevert, ranges, stepHz });
  handlers.current = { onChange, onSubmit, onRevert, ranges, stepHz };

  useEffect(() => setMessage(''), [valueHz]);

  function change(deltaHz: number, direction: 1 | -1, times = 1): boolean {
    const current = handlers.current;
    let next = latest.current;
    let moved = false;
    for (let index = 0; index < times; index += 1) {
      const candidate = stepDigit(next, deltaHz, direction, current.ranges);
      if (candidate === undefined) {
        setMessage(edgeMessage(next, direction, current.ranges));
        break;
      }
      next = candidate;
      moved = true;
    }
    if (moved) {
      latest.current = next;
      current.onChange(next);
    }
    return moved;
  }

  const fontSize = compact ? 30 : 40;
  const hzFontSize = Math.round(fontSize * 0.62);
  const mainStyle = {
    ...type.frequency,
    fontSize,
    lineHeight: Math.round(fontSize * 1.15),
    letterSpacing: 0,
  };

  function onKeyDown(event: NativeSyntheticEvent<{ key: string }>) {
    if (disabled) return;
    const action = dialKeyAction(event.nativeEvent.key);
    if (!action) return;
    // Enter on a focused digit button presses that button instead.
    if (
      (action.kind === 'submit' || action.kind === 'revert') &&
      event.target !== event.currentTarget
    )
      return;
    event.preventDefault();
    switch (action.kind) {
      case 'step': {
        const weight =
          focusIndex === undefined ? undefined : weights[focusIndex];
        change(weight ?? handlers.current.stepHz, action.direction);
        break;
      }
      case 'megahertz':
        change(MHZ, action.direction);
        break;
      case 'focus':
        setFocusIndex(
          moveDigitFocus(
            focusIndex,
            action.delta,
            weights.length,
            stepDigitIndex(weights, handlers.current.stepHz),
          ),
        );
        break;
      case 'submit':
        handlers.current.onSubmit?.();
        break;
      case 'revert':
        setFocusIndex(undefined);
        handlers.current.onRevert?.();
        break;
    }
  }

  function onAccessibilityAction(event: AccessibilityActionEvent) {
    if (disabled) return;
    if (event.nativeEvent.actionName === 'increment')
      change(handlers.current.stepHz, 1);
    else if (event.nativeEvent.actionName === 'decrement')
      change(handlers.current.stepHz, -1);
  }

  function submitTyped() {
    const result = parseFrequencyInput(typed, ranges);
    if (!result.ok) {
      setTypedError(result.error);
      return;
    }
    setTypedError('');
    setTyping(false);
    setTyped('');
    onChange(result.hz);
  }
  function closeTyping() {
    setTyping(false);
    setTyped('');
    setTypedError('');
  }

  const valueText = dialAccessibilityValue(valueHz);
  const hint = `Adjusts the draft by ${stepLabel(stepHz)}. The radio is not tuned until you apply.`;
  const hintId = `frequency-dial-hint-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const focusedDigit =
    focusIndex === undefined ? undefined : digits[focusIndex];
  const activeRange = nearestRange(valueHz, ranges);
  // react-native-web drops the object `accessibilityValue`, the hint and the
  // state: a slider needs explicit ARIA value attributes there.
  const webProps =
    Platform.OS === 'web'
      ? {
          onKeyDown,
          focusable: !disabled,
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          'aria-valuetext': focusedDigit
            ? `${valueText}, ${focusedDigit.label} digit`
            : valueText,
          ...(Number.isSafeInteger(valueHz)
            ? { 'aria-valuenow': valueHz }
            : {}),
          ...(activeRange
            ? {
                'aria-valuemin': activeRange.minHz,
                'aria-valuemax': activeRange.maxHz,
              }
            : {}),
          'aria-disabled': disabled,
          'aria-describedby': hintId,
        }
      : {};

  return (
    <View style={{ gap: space.sm, minWidth: 0 }}>
      <View
        ref={dialRef}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={hint}
        accessibilityValue={{ text: valueText }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onAccessibilityAction}
        {...webProps}
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            alignSelf: 'flex-start',
            maxWidth: '100%',
            gap: 1,
            paddingHorizontal: space.xs,
            paddingVertical: space.xs,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: focused ? colors.focus : 'transparent',
          },
          focused &&
            Platform.OS === 'web' && {
              outlineColor: colors.focus,
              outlineWidth: 2,
              outlineStyle: 'solid',
            },
        ]}
      >
        {digits.map((digit, index) => {
          const next = digits[index + 1];
          const decimalPoint = digit.weight === MHZ;
          const groupBreak = digit.weight === 1_000;
          return (
            <View
              key={digit.weight}
              style={{ flexDirection: 'row', alignItems: 'center' }}
            >
              <DigitColumn
                digit={digit}
                value={valueHz}
                ranges={ranges}
                disabled={disabled}
                focused={focusIndex === index}
                engaged={engaged}
                fontSize={digit.group === 'hz' ? hzFontSize : fontSize}
                minColumnWidth={compact ? 28 : 32}
                mainStyle={mainStyle}
                onStep={(direction, times) => {
                  setFocusIndex(index);
                  change(digit.weight, direction, times);
                }}
              />
              {decimalPoint && next && (
                <Text
                  {...decorative}
                  style={[
                    mainStyle,
                    { color: colors.textSecondary, paddingHorizontal: 1 },
                  ]}
                >
                  .
                </Text>
              )}
              {groupBreak && next && <View style={{ width: space.sm }} />}
            </View>
          );
        })}
      </View>

      {Platform.OS === 'web' ? (
        <Text nativeID={hintId} style={visuallyHidden}>
          {hint}
        </Text>
      ) : null}

      {/* Always mounted so a new edge message is announced. */}
      <View
        accessibilityLiveRegion="polite"
        style={message ? undefined : emptyLiveRegion}
      >
        {message ? (
          <Text style={[type.caption, { color: colors.warning }]}>
            {message}
          </Text>
        ) : null}
      </View>

      {typing ? (
        <View style={{ gap: space.xs }}>
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: space.sm,
            }}
          >
            <TextInput
              autoFocus
              value={typed}
              onChangeText={(text) => {
                setTyped(text);
                if (typedError) setTypedError('');
              }}
              onSubmitEditing={submitTyped}
              onKeyPress={(event: TextInputKeyPressEvent) => {
                if (event.nativeEvent.key === 'Escape') closeTyping();
              }}
              placeholder={formatFrequency(valueHz)}
              accessibilityLabel="Type a frequency in MHz"
              accessibilityHint="Accepts 146.52, 146.520.000, 146520 kHz or 146520000 Hz."
              inputMode="decimal"
              keyboardType="decimal-pad"
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              editable={!disabled}
              style={{
                ...type.frequency,
                fontSize: 18,
                lineHeight: 24,
                letterSpacing: 0,
                flexGrow: 1,
                minWidth: 160,
                maxWidth: 260,
              }}
            />
            <Button
              label="Set draft"
              onPress={submitTyped}
              disabled={disabled || !typed.trim()}
            />
            <Button label="Cancel" variant="quiet" onPress={closeTyping} />
          </View>
          <View
            accessibilityLiveRegion="polite"
            style={typedError ? undefined : emptyLiveRegion}
          >
            {typedError ? (
              <Text style={[type.caption, { color: colors.error }]}>
                {typedError}
              </Text>
            ) : null}
          </View>
          {typedError ? null : (
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              MHz by default. Units Hz, kHz, MHz and GHz are accepted.
            </Text>
          )}
        </View>
      ) : (
        <Button
          label="Type frequency"
          variant="quiet"
          disabled={disabled}
          onPress={() => setTyping(true)}
        />
      )}
    </View>
  );
}

function DigitColumn({
  digit,
  value,
  ranges,
  disabled,
  focused,
  engaged,
  fontSize,
  minColumnWidth,
  mainStyle,
  onStep,
}: {
  digit: DialDigit;
  value: number;
  ranges: readonly FrequencyRange[];
  disabled: boolean;
  focused: boolean;
  /** Web: whether focus is inside the dial (the wheel is ignored otherwise). */
  engaged: () => boolean;
  fontSize: number;
  /** Narrowest touch column (the digit text keeps its own width). */
  minColumnWidth: number;
  mainStyle: TextStyle;
  onStep: (direction: 1 | -1, times?: number) => void;
}) {
  const { colors } = useTheme();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  const engagedRef = useRef(engaged);
  engagedRef.current = engaged;
  const canUp =
    !disabled && stepDigit(value, digit.weight, 1, ranges) !== undefined;
  const canDown =
    !disabled && stepDigit(value, digit.weight, -1, ranges) !== undefined;

  // Web: the mouse wheel over a digit changes that digit once the dial has
  // focus (page scroll is suppressed only then, over an enabled digit).
  useEffect(() => {
    if (Platform.OS !== 'web' || disabled) return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;
    let accumulated = 0;
    const listener = (event: WheelEvent) => {
      if (!engagedRef.current()) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
      const result = wheelSteps(accumulated, delta);
      accumulated = result.remainder;
      if (result.steps !== 0)
        stepRef.current(
          result.steps > 0 ? 1 : -1,
          Math.min(Math.abs(result.steps), 10),
        );
    };
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener('wheel', listener);
  }, [disabled]);

  const width = Math.round(fontSize * 0.64) + 4;
  const columnWidth = Math.max(width, minColumnWidth);
  const arrow = (direction: 1 | -1, enabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${direction === 1 ? 'Increase' : 'Decrease'} ${digit.label} digit`}
      disabled={!enabled}
      // The focused dial handles the keyboard: one Tab stop, not 18.
      {...(Platform.OS === 'web' ? { tabIndex: -1 as const } : {})}
      hitSlop={{ left: 2, right: 2, top: 6, bottom: 6 }}
      onPress={() => onStep(direction)}
      style={{
        minHeight: 36,
        width: columnWidth,
        alignItems: 'center',
        borderRadius: radius.sm,
      }}
    >
      <Icon
        name={direction === 1 ? 'chevron-up' : 'chevron-down'}
        size={16}
        color={colors.textSecondary}
      />
    </Pressable>
  );

  return (
    <View
      ref={ref}
      style={{
        alignItems: 'center',
        borderRadius: radius.sm,
        backgroundColor: focused ? colors.selected : 'transparent',
      }}
    >
      {arrow(1, canUp)}
      <Text
        {...decorative}
        style={[
          mainStyle,
          {
            fontSize,
            lineHeight: Math.round(fontSize * 1.15),
            width,
            textAlign: 'center',
            color:
              digit.group === 'hz' || digit.leading || disabled
                ? colors.textSecondary
                : colors.textPrimary,
            opacity: digit.leading ? 0.45 : 1,
          },
          focused && {
            textDecorationLine: 'underline',
            textDecorationColor: colors.focus,
          },
        ]}
      >
        {digit.digit}
      </Text>
      {arrow(-1, canDown)}
    </View>
  );
}
