/**
 * Pure helpers for `SegmentedControl` (no React Native imports so they can be
 * unit tested in a node environment).
 */

/**
 * Index of the next enabled option from `from` in `direction` (wrapping), or
 * undefined when none is enabled. `from` may be -1 to start before the first.
 */
export function nextEnabled(
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

export interface SegmentLayout {
  x: number;
  width: number;
}

/**
 * Horizontal scroll offset that brings `segment` fully into a viewport of
 * `viewport` width currently scrolled to `scrollX`, keeping `margin` points
 * of the neighbouring option visible. Returns undefined when the segment is
 * already visible (or the viewport is not measured yet).
 */
export function revealOffset(
  segment: SegmentLayout,
  scrollX: number,
  viewport: number,
  margin = 0,
): number | undefined {
  if (viewport <= 0) return undefined;
  const start = segment.x - margin;
  const end = segment.x + segment.width + margin;
  if (start < scrollX) return Math.max(0, start);
  if (end > scrollX + viewport) return Math.max(0, end - viewport);
  return undefined;
}
