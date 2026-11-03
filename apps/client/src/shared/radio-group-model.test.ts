import { describe, expect, it } from 'vitest';
import { radioGroupKeyTarget, radioGroupTabStop } from './radio-group-model';

describe('radio group keyboard', () => {
  const enabled = [true, false, true, true];

  it('puts the Tab stop on the checked item, else the first enabled one', () => {
    expect(radioGroupTabStop(enabled, 2)).toBe(2);
    expect(radioGroupTabStop(enabled, 1)).toBe(0);
    expect(radioGroupTabStop(enabled, -1)).toBe(0);
    expect(radioGroupTabStop([false, false], -1)).toBe(-1);
  });

  it('moves with arrows, wrapping and skipping disabled items', () => {
    const at = (key: string, focusedIndex: number) =>
      radioGroupKeyTarget({ key, enabled, checkedIndex: 0, focusedIndex });
    expect(at('ArrowRight', 0)).toBe(2);
    expect(at('ArrowDown', 3)).toBe(0);
    expect(at('ArrowLeft', 0)).toBe(3);
    expect(at('ArrowUp', 2)).toBe(0);
  });

  it('starts from the ends when nothing is focused or checked', () => {
    expect(
      radioGroupKeyTarget({ key: 'ArrowRight', enabled, checkedIndex: -1 }),
    ).toBe(0);
    expect(
      radioGroupKeyTarget({ key: 'ArrowLeft', enabled, checkedIndex: -1 }),
    ).toBe(3);
  });

  it('selects the focused item with Space, never a disabled one', () => {
    expect(
      radioGroupKeyTarget({
        key: ' ',
        enabled,
        checkedIndex: 0,
        focusedIndex: 3,
      }),
    ).toBe(3);
    expect(
      radioGroupKeyTarget({
        key: 'Spacebar',
        enabled,
        checkedIndex: 0,
        focusedIndex: 1,
      }),
    ).toBeUndefined();
    expect(radioGroupKeyTarget({ key: ' ', enabled, checkedIndex: 2 })).toBe(2);
  });

  it('ignores other keys and empty groups', () => {
    expect(
      radioGroupKeyTarget({ key: 'Enter', enabled, checkedIndex: 0 }),
    ).toBeUndefined();
    expect(
      radioGroupKeyTarget({ key: 'ArrowRight', enabled: [], checkedIndex: -1 }),
    ).toBeUndefined();
  });
});
