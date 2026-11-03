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
