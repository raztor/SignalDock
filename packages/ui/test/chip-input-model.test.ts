import { describe, expect, it } from 'vitest';
import {
  commitChipText,
  hasChipSeparator,
  removeChip,
} from '../src/chip-input-model.js';

describe('commitChipText', () => {
  it('splits on commas and new lines, trimming empty parts', () => {
    expect(commitChipText([], ' mayday, emergencia ,,\nauxilio ')).toEqual({
      values: ['mayday', 'emergencia', 'auxilio'],
      remaining: '',
    });
  });

  it('ignores duplicates case-insensitively', () => {
    expect(
      commitChipText(['Mayday'], 'mayday, MAYDAY, pan-pan, PAN-PAN'),
    ).toEqual({ values: ['Mayday', 'pan-pan'], remaining: '' });
  });

  it('keeps invalid entries in the input with the first error', () => {
    const validate = (value: string) =>
      value.length < 3 ? 'Use at least 3 characters.' : undefined;
    expect(commitChipText([], 'ok, mayday, no', { validate })).toEqual({
      values: ['mayday'],
      remaining: 'ok, no',
      error: 'Use at least 3 characters.',
    });
  });

  it('stops at maxItems', () => {
    expect(commitChipText(['a'], 'b, c', { maxItems: 2 })).toEqual({
      values: ['a', 'b'],
      remaining: 'c',
      error: 'You can add up to 2 entries.',
    });
  });

  it('returns the same values for blank text', () => {
    expect(commitChipText(['a'], '   ')).toEqual({
      values: ['a'],
      remaining: '',
    });
  });
});

describe('chip helpers', () => {
  it('detects separators', () => {
    expect(hasChipSeparator('a,')).toBe(true);
    expect(hasChipSeparator('a\nb')).toBe(true);
    expect(hasChipSeparator('ab')).toBe(false);
  });

  it('removes by index or the last chip', () => {
    expect(removeChip(['a', 'b', 'c'])).toEqual(['a', 'b']);
    expect(removeChip(['a', 'b', 'c'], 0)).toEqual(['b', 'c']);
    expect(removeChip(['a'], 4)).toEqual(['a']);
    expect(removeChip([])).toEqual([]);
  });
});
