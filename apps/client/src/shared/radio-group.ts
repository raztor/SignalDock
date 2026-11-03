import { useRef } from 'react';
import { Platform } from 'react-native';
import type { FocusTarget } from './accessibility';
import { radioGroupKeyTarget, radioGroupTabStop } from './radio-group-model';

type KeyEvent = { nativeEvent: { key: string }; preventDefault(): void };

export interface RadioGroupKeyboard {
  /** Spread on the `radiogroup` view. */
  group: { onKeyDown?: (event: KeyEvent) => void };
  /** Spread on the radio item at `index`. */
  item(index: number): {
    ref: (node: FocusTarget) => void;
    tabIndex?: 0 | -1;
    onFocus: () => void;
  };
}

/**
 * Web keyboard support for card-style radio groups (React Native Web only
 * activates Space for buttons): a roving Tab stop, Arrow keys that move and
 * select, and Space that selects. On native the props are inert.
 */
export function useRadioGroupKeyboard({
  enabled,
  checkedIndex,
  onSelect,
}: {
  enabled: readonly boolean[];
  checkedIndex: number;
  onSelect(index: number): void;
}): RadioGroupKeyboard {
  const web = Platform.OS === 'web';
  const nodes = useRef<FocusTarget[]>([]);
  const focused = useRef<number | undefined>(undefined);
  const tabStop = radioGroupTabStop(enabled, checkedIndex);
  return {
    group: web
      ? {
          onKeyDown: (event) => {
            const index = radioGroupKeyTarget({
              key: event.nativeEvent.key,
              enabled,
              checkedIndex,
              focusedIndex: focused.current,
            });
            if (index === undefined) return;
            event.preventDefault();
            nodes.current[index]?.focus?.();
            focused.current = index;
            if (index !== checkedIndex) onSelect(index);
          },
        }
      : {},
    item: (index) => ({
      ref: (node) => {
        nodes.current[index] = node;
      },
      ...(web
        ? { tabIndex: index === tabStop ? (0 as const) : (-1 as const) }
        : {}),
      onFocus: () => {
        focused.current = index;
      },
    }),
  };
}
