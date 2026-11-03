/**
 * Pure placement for the toast stack (no React Native imports so it can be
 * unit tested in a node environment).
 */

export interface ToastInsets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface ToastPlacement {
  bottom: number;
  left: number;
  right: number;
  /** Width of each toast; undefined stretches it between `left` and `right`. */
  toastWidth: number | undefined;
  alignItems: 'stretch' | 'center';
}

export const TOAST_WIDE_WIDTH = 380;

/**
 * Compact layouts: full width above the bottom dock (`insets.bottom`).
 * Wide layouts: centred at the bottom, so the stack never covers the primary
 * actions that screens and wizards place at the bottom-right of the content.
 */
export function toastPlacement(
  wide: boolean,
  gutter: number,
  insets: ToastInsets = {},
): ToastPlacement {
  const left = gutter + (insets.left ?? 0);
  const right = gutter + (insets.right ?? 0);
  const bottom = gutter + (insets.bottom ?? 0);
  return wide
    ? {
        bottom,
        left,
        right,
        toastWidth: TOAST_WIDE_WIDTH,
        alignItems: 'center',
      }
    : { bottom, left, right, toastWidth: undefined, alignItems: 'stretch' };
}
