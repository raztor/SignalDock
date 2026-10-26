import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { SessionController } from './session-controller';
export function useAuthSession(controller: SessionController) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active')
        void controller.refreshIfNeeded().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [controller]);
  return state;
}
