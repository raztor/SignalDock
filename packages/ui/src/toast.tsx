import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  AccessibilityInfo,
  Platform,
  useWindowDimensions,
  View,
} from 'react-native';
import { Icon, type IconName } from './icons';
import { Pressable, Text } from './primitives';
import { useTheme } from './theme';
import { layout, radius, space, type } from './tokens';

export type ToastTone = 'neutral' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  action?: { label: string; onPress: () => void };
  /**
   * Overrides the default 4 s (7 s for errors; 15 s with an action). The
   * timer pauses while the pointer or focus is on the toast's buttons.
   */
  durationMs?: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. A no-op returning '' without a provider. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

export interface ToastInsets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export const TOAST_LIMIT = 3;
export const TOAST_DURATION_MS = 4000;
export const TOAST_ERROR_DURATION_MS = 7000;
/** Toasts with an action stay longer so keyboard users can reach it. */
export const TOAST_ACTION_DURATION_MS = 15000;

const noop: ToastApi = { show: () => '', dismiss: () => {} };
const ToastContext = createContext<ToastApi>(noop);

/** Toast API; safe to call in isolated screens rendered without a provider. */
export const useToast = () => useContext(ToastContext);

interface ToastEntry extends ToastOptions {
  id: string;
  tone: ToastTone;
  durationMs: number;
}

const toneIcon: Record<ToastTone, IconName | undefined> = {
  neutral: undefined,
  success: 'check',
  warning: 'alert',
  error: 'close',
};
const tonePrefix: Record<ToastTone, string> = {
  neutral: '',
  success: '',
  warning: 'Warning: ',
  error: 'Error: ',
};

/**
 * Hosts a polite live region with up to three toasts: bottom on compact
 * layouts, bottom-right on wide ones. Pass `insets` (for example from
 * `useSafeAreaInsets()` plus the tab bar height) to keep toasts clear of
 * system UI.
 */
export function ToastProvider({
  children,
  insets,
}: PropsWithChildren<{ insets?: ToastInsets }>) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);
  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const show = useCallback(
    (options: ToastOptions) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      const tone = options.tone ?? 'neutral';
      const durationMs =
        options.durationMs ??
        (options.action
          ? TOAST_ACTION_DURATION_MS
          : tone === 'error'
            ? TOAST_ERROR_DURATION_MS
            : TOAST_DURATION_MS);
      const entry: ToastEntry = { ...options, id, tone, durationMs };
      setToasts((current) => {
        const next = [...current, entry];
        for (const dropped of next.slice(
          0,
          Math.max(0, next.length - TOAST_LIMIT),
        )) {
          const timer = timers.current.get(dropped.id);
          if (timer) clearTimeout(timer);
          timers.current.delete(dropped.id);
        }
        return next.slice(-TOAST_LIMIT);
      });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationMs),
      );
      if (Platform.OS === 'ios')
        AccessibilityInfo.announceForAccessibility(
          `${tonePrefix[tone]}${options.message}`,
        );
      return id;
    },
    [dismiss],
  );
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  /** Stop the timer while the operator is on the toast; restart after. */
  const hold = useCallback(
    (toast: ToastEntry, held: boolean) => {
      const timer = timers.current.get(toast.id);
      if (timer) clearTimeout(timer);
      timers.current.delete(toast.id);
      if (!held)
        timers.current.set(
          toast.id,
          setTimeout(() => dismiss(toast.id), toast.durationMs),
        );
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const wide = width >= layout.compact;
  return (
    <ToastContext.Provider value={api}>
      <View style={{ flex: 1 }}>
        {children}
        <View
          pointerEvents="box-none"
          accessibilityLiveRegion="polite"
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            bottom: space.lg + (insets?.bottom ?? 0),
            right: space.lg + (insets?.right ?? 0),
            left: wide ? undefined : space.lg + (insets?.left ?? 0),
            width: wide ? 380 : undefined,
            maxWidth: wide ? '90%' : undefined,
            gap: space.sm,
            alignItems: 'stretch',
          }}
        >
          {toasts.map((toast) => {
            const icon = toneIcon[toast.tone];
            const accent =
              toast.tone === 'error'
                ? colors.error
                : toast.tone === 'warning'
                  ? colors.warning
                  : toast.tone === 'success'
                    ? colors.success
                    : colors.border;
            return (
              <View
                key={toast.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  paddingLeft: space.md,
                  paddingRight: space.xs,
                  paddingVertical: space.xs,
                  minHeight: layout.touch + space.sm,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderLeftWidth: 4,
                  borderColor: colors.border,
                  borderLeftColor: accent,
                  backgroundColor: colors.surfaceElevated,
                }}
              >
                {icon && <Icon name={icon} size={18} color={accent} />}
                <Text
                  accessibilityLabel={`${tonePrefix[toast.tone]}${toast.message}`}
                  style={[type.body, { flex: 1, color: colors.textPrimary }]}
                >
                  {toast.message}
                </Text>
                {toast.action && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={toast.action.label}
                    onFocus={() => hold(toast, true)}
                    onBlur={() => hold(toast, false)}
                    onHoverIn={() => hold(toast, true)}
                    onHoverOut={() => hold(toast, false)}
                    onPress={() => {
                      toast.action?.onPress();
                      dismiss(toast.id);
                    }}
                    style={{ paddingHorizontal: space.md }}
                  >
                    <Text style={[type.label, { color: colors.primary }]}>
                      {toast.action.label}
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss notification"
                  onFocus={() => hold(toast, true)}
                  onBlur={() => hold(toast, false)}
                  onHoverIn={() => hold(toast, true)}
                  onHoverOut={() => hold(toast, false)}
                  onPress={() => dismiss(toast.id)}
                  style={{ width: layout.touch, alignItems: 'center' }}
                >
                  <Icon name="close" size={16} color={colors.textSecondary} />
                </Pressable>
              </View>
            );
          })}
        </View>
      </View>
    </ToastContext.Provider>
  );
}
