import { describe, expect, it } from 'vitest';
import { TOAST_WIDE_WIDTH, toastPlacement } from '../src/toast-model.js';

describe('toastPlacement', () => {
  it('stretches compact toasts above the bottom dock', () => {
    expect(toastPlacement(false, 16, { bottom: 120 })).toEqual({
      bottom: 136,
      left: 16,
      right: 16,
      toastWidth: undefined,
      alignItems: 'stretch',
    });
  });

  it('centres wide toasts so bottom-right actions stay uncovered', () => {
    expect(toastPlacement(true, 16)).toEqual({
      bottom: 16,
      left: 16,
      right: 16,
      toastWidth: TOAST_WIDE_WIDTH,
      alignItems: 'center',
    });
  });

  it('centres within the content when a sidebar inset is given', () => {
    const placement = toastPlacement(true, 16, { left: 224, bottom: 40 });
    expect(placement.left).toBe(240);
    expect(placement.right).toBe(16);
    expect(placement.bottom).toBe(56);
  });
});
