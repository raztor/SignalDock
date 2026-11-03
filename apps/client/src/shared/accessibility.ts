import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, type HostInstance } from 'react-native';

/** Anything a ref can hold that may be focused (web element or host view). */
export type FocusTarget = { focus?: () => void } | null | undefined;

/**
 * Move keyboard (web) or screen-reader (native) focus to `node`. On web the
 * element must be focusable (a control, or text with `tabIndex={-1}`).
 */
export function moveFocus(node: FocusTarget): void {
  if (!node) return;
  if (Platform.OS === 'web') {
    node.focus?.();
    return;
  }
  try {
    AccessibilityInfo.sendAccessibilityEvent(
      node as unknown as HostInstance,
      'focus',
    );
  } catch {
    // The view unmounted before focus could move; nothing to do.
  }
}

/**
 * Ref for a view (usually a heading) that receives focus on mount and every
 * time `key` changes, e.g. a wizard title on each step change. On web give the
 * view `tabIndex={-1}` so it can hold focus.
 */
export function useFocusOnChange(key: unknown) {
  const node = useRef<FocusTarget>(null);
  useEffect(() => {
    // After the new step has rendered (and any focused control unmounted).
    const timer = setTimeout(() => moveFocus(node.current), 0);
    return () => clearTimeout(timer);
  }, [key]);
  return node;
}
