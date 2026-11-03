/**
 * Pure keyboard rules for card-style radio groups on web (ARIA radio group
 * pattern): one Tab stop, arrow keys move and select (wrapping, skipping
 * disabled items), Space selects the focused item. Node-safe.
 */

export interface RadioGroupKeyInput {
  key: string;
  /** Whether each item can be selected. */
  enabled: readonly boolean[];
  /** Index of the checked item, or -1. */
  checkedIndex: number;
  /** Index of the item that has focus, if known. */
  focusedIndex?: number | undefined;
}

/** The item that receives Tab focus: the checked item, else the first enabled one. */
export function radioGroupTabStop(
  enabled: readonly boolean[],
  checkedIndex: number,
): number {
  return checkedIndex >= 0 && enabled[checkedIndex]
    ? checkedIndex
    : enabled.indexOf(true);
}

/**
 * The item a key press focuses and selects, or undefined when the key does
 * nothing in the group (the browser default then applies).
 */
export function radioGroupKeyTarget(
  input: RadioGroupKeyInput,
): number | undefined {
  const { key, enabled, checkedIndex, focusedIndex } = input;
  if (key === ' ' || key === 'Spacebar') {
    const index = focusedIndex ?? radioGroupTabStop(enabled, checkedIndex);
    return index >= 0 && enabled[index] ? index : undefined;
  }
  const direction =
    key === 'ArrowRight' || key === 'ArrowDown'
      ? 1
      : key === 'ArrowLeft' || key === 'ArrowUp'
        ? -1
        : 0;
  if (!direction) return undefined;
  const count = enabled.length;
  const from = focusedIndex ?? checkedIndex;
  // With nothing focused or checked, forward starts at the first item and
  // backward at the last.
  const start = from >= 0 ? from : direction === 1 ? -1 : count;
  for (let step = 1; step <= count; step += 1) {
    const index = (((start + direction * step) % count) + count) % count;
    if (enabled[index]) return index;
  }
  return undefined;
}
