import { describe, expect, it } from 'vitest';
import { clampLabelCentre, rangeBarLabels } from './range-bar-labels';

const base = {
  width: 300,
  minText: '146.5',
  maxText: '147.5',
  joinedText: '146.5–147.5',
  showMin: true,
  showMax: true,
  charWidth: 7,
};

describe('clampLabelCentre', () => {
  it('keeps the label inside the bar', () => {
    expect(clampLabelCentre(2, 40, 300)).toBe(20);
    expect(clampLabelCentre(298, 40, 300)).toBe(280);
    expect(clampLabelCentre(150, 40, 300)).toBe(150);
  });

  it('centres a label wider than the bar', () => {
    expect(clampLabelCentre(10, 400, 300)).toBe(150);
  });
});

describe('rangeBarLabels', () => {
  it('labels both handles when they are apart', () => {
    expect(rangeBarLabels({ ...base, minX: 60, maxX: 240 })).toEqual([
      { key: 'min', text: '146.5', x: 60 },
      { key: 'max', text: '147.5', x: 240 },
    ]);
  });

  it('drops labels that repeat the scale edge values', () => {
    expect(
      rangeBarLabels({
        ...base,
        minX: 12,
        maxX: 288,
        showMin: false,
        showMax: false,
      }),
    ).toEqual([]);
    expect(
      rangeBarLabels({ ...base, minX: 60, maxX: 288, showMax: false }),
    ).toEqual([{ key: 'min', text: '146.5', x: 60 }]);
  });

  it('never lets a label run past the right edge', () => {
    const [label] = rangeBarLabels({
      ...base,
      minX: 12,
      maxX: 296,
      showMin: false,
      maxText: '148',
    });
    expect(label).toBeDefined();
    expect(label!.x + (3 * 7) / 2).toBeLessThanOrEqual(300);
  });

  it('joins colliding labels into one centred, clamped label', () => {
    expect(rangeBarLabels({ ...base, minX: 270, maxX: 290 })).toEqual([
      { key: 'both', text: '146.5–147.5', x: 300 - (11 * 7) / 2 },
    ]);
  });

  it('shows a single value once when both handles meet', () => {
    expect(
      rangeBarLabels({ ...base, maxText: '146.5', minX: 150, maxX: 150 }),
    ).toEqual([{ key: 'both', text: '146.5', x: 150 }]);
  });
});
