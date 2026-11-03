import { describe, expect, it } from 'vitest';
import { nextEnabled, revealOffset } from '../src/segmented-model.js';

describe('nextEnabled', () => {
  it('moves in both directions and wraps', () => {
    const enabled = [true, true, true];
    expect(nextEnabled(enabled, 0, 1)).toBe(1);
    expect(nextEnabled(enabled, 2, 1)).toBe(0);
    expect(nextEnabled(enabled, 0, -1)).toBe(2);
  });

  it('skips disabled options', () => {
    expect(nextEnabled([true, false, true], 0, 1)).toBe(2);
    expect(nextEnabled([true, false, true], 2, -1)).toBe(0);
  });

  it('starts before the first option from -1', () => {
    expect(nextEnabled([false, true], -1, 1)).toBe(1);
  });

  it('returns undefined when nothing is enabled', () => {
    expect(nextEnabled([false, false], 0, 1)).toBeUndefined();
    expect(nextEnabled([], 0, 1)).toBeUndefined();
  });
});

describe('revealOffset', () => {
  it('leaves a visible option alone', () => {
    expect(revealOffset({ x: 20, width: 50 }, 0, 200)).toBeUndefined();
  });

  it('scrolls right to show an option past the end', () => {
    expect(revealOffset({ x: 250, width: 60 }, 0, 200)).toBe(110);
    expect(revealOffset({ x: 250, width: 60 }, 0, 200, 16)).toBe(126);
  });

  it('scrolls left to show an option before the start', () => {
    expect(revealOffset({ x: 40, width: 60 }, 100, 200)).toBe(40);
    expect(revealOffset({ x: 10, width: 60 }, 100, 200, 16)).toBe(0);
  });

  it('waits for the viewport to be measured', () => {
    expect(revealOffset({ x: 250, width: 60 }, 0, 0)).toBeUndefined();
  });
});
