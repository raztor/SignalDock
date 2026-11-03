import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { paletteShortcut, shortcutLabel } from './command-model';

/**
 * ⌘K / Ctrl+K on web: opens the palette (ignored while typing in another
 * field) or closes it when it is open. No-op on native.
 */
export function usePaletteShortcut(
  open: boolean,
  setOpen: (open: boolean) => void,
): void {
  const state = useRef({ open, setOpen });
  state.current = { open, setOpen };
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const target =
        event.target instanceof HTMLElement ? event.target : undefined;
      const action = paletteShortcut(event, {
        open: state.current.open,
        target: target
          ? {
              tagName: target.tagName,
              isContentEditable: target.isContentEditable,
              ...(target instanceof HTMLInputElement
                ? { type: target.type }
                : {}),
            }
          : undefined,
      });
      if (!action) return;
      // Browsers bind Ctrl+K / ⌘K to their own search field.
      event.preventDefault();
      state.current.setOpen(action === 'open');
    };
    // Capture phase: react-native-web's TextInput stops keydown propagation,
    // so a bubbling listener would never see ⌘K typed in the palette field.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

/** The shortcut as shown in hints ('⌘K' or 'Ctrl K'); undefined on native. */
export function paletteShortcutLabel(): string | undefined {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined')
    return undefined;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform;
  return shortcutLabel(platform);
}
