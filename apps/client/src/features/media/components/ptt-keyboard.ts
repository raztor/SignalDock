/**
 * Keyboard release tracking for the web push-to-talk button.
 *
 * react-native-web only ends a keyboard press when the `keyup` lands on a
 * button-like element (or the key is Enter). If focus moves while Space is
 * held, the release is lost and TX would continue. This helper listens for the
 * PTT key's `keyup` on the whole document, whatever its target, and reports
 * the release once.
 *
 * Plain TypeScript (no DOM or React Native imports) so it can be unit tested
 * in node.
 */

/** Keys that start a keyboard press on the PTT button. */
export function isPttKey(key: string | undefined): boolean {
  return key === ' ' || key === 'Spacebar' || key === 'Enter';
}

export interface PttKeyEvent {
  key?: string;
  repeat?: boolean;
}

/** The subset of `Document` the tracker uses. */
export interface PttKeyTarget {
  addEventListener(
    type: 'keyup',
    listener: (event: PttKeyEvent) => void,
    capture: boolean,
  ): void;
  removeEventListener(
    type: 'keyup',
    listener: (event: PttKeyEvent) => void,
    capture: boolean,
  ): void;
}

export interface PttKeyboardRelease {
  /** Call from the button's `onKeyDown`. Arms the release listener once. */
  keyDown(event: PttKeyEvent): void;
  /** True while a PTT key press is being tracked. */
  readonly held: boolean;
  /** Removes the listener without reporting a release (unmount). */
  dispose(): void;
}

export function createPttKeyboardRelease(
  target: PttKeyTarget,
  onRelease: () => void,
): PttKeyboardRelease {
  let listener: ((event: PttKeyEvent) => void) | undefined;
  const dispose = () => {
    if (!listener) return;
    target.removeEventListener('keyup', listener, true);
    listener = undefined;
  };
  return {
    get held() {
      return listener !== undefined;
    },
    keyDown(event) {
      if (event.repeat || !isPttKey(event.key) || listener) return;
      listener = (up) => {
        if (!isPttKey(up.key)) return;
        dispose();
        onRelease();
      };
      target.addEventListener('keyup', listener, true);
    },
    dispose,
  };
}
