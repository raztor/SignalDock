/**
 * Placement of the value labels above the frequency range bar's handles.
 * Pure (no React Native) so it can be unit tested.
 */

export interface RangeBarLabelInput {
  /** Handle centres in points. */
  minX: number;
  maxX: number;
  /** Bar width in points; labels never extend past 0…width. */
  width: number;
  minText: string;
  maxText: string;
  /** Shown instead of both labels when they would collide. */
  joinedText: string;
  /**
   * False when a handle sits on the scale's edge: the scale label below the
   * bar already shows that value, so repeating it is noise.
   */
  showMin: boolean;
  showMax: boolean;
  /** Approximate width of one character (monospace digits). */
  charWidth: number;
  /** Minimum space between two labels. */
  gap?: number;
}

export interface RangeBarLabel {
  key: 'min' | 'max' | 'both';
  text: string;
  /** Centre x (render with `textAnchor="middle"`), clamped inside the bar. */
  x: number;
}

const textWidth = (text: string, charWidth: number) => text.length * charWidth;

/** Centre for a label of `labelWidth` near `x`, kept within 0…width. */
export function clampLabelCentre(
  x: number,
  labelWidth: number,
  width: number,
): number {
  const half = labelWidth / 2;
  if (labelWidth >= width) return width / 2;
  return Math.min(Math.max(x, half), width - half);
}

export function rangeBarLabels(input: RangeBarLabelInput): RangeBarLabel[] {
  const { width, charWidth, gap = 8 } = input;
  if (width <= 0) return [];
  const label = (
    key: RangeBarLabel['key'],
    text: string,
    x: number,
  ): RangeBarLabel => ({
    key,
    text,
    x: clampLabelCentre(x, textWidth(text, charWidth), width),
  });
  const min = input.showMin
    ? label('min', input.minText, input.minX)
    : undefined;
  const max = input.showMax
    ? label('max', input.maxText, input.maxX)
    : undefined;
  if (min && max) {
    const minEnd = min.x + textWidth(min.text, charWidth) / 2;
    const maxStart = max.x - textWidth(max.text, charWidth) / 2;
    if (maxStart - minEnd < gap || input.minText === input.maxText)
      return [
        label(
          'both',
          input.minText === input.maxText ? input.minText : input.joinedText,
          (input.minX + input.maxX) / 2,
        ),
      ];
    return [min, max];
  }
  return [min, max].filter((item): item is RangeBarLabel => !!item);
}
