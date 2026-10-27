import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import {
  credentialScopeKey,
  type RefreshCredentialStore,
  type StoredRefresh,
} from './credentials';
import type { SessionControllerOptions } from './session-controller';
export function createPlatformAuthOptions(): SessionControllerOptions {
  let queue: Promise<unknown> = Promise.resolve();
  const key = async (scope: Parameters<RefreshCredentialStore['get']>[0]) =>
    'signaldock.refresh.' +
    (await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      credentialScopeKey(scope),
    ));
  const get: RefreshCredentialStore['get'] = async (scope) => {
    const raw = await SecureStore.getItemAsync(await key(scope));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as StoredRefresh;
      return value &&
        typeof value.refreshToken === 'string' &&
        typeof value.userId === 'string' &&
        credentialScopeKey(value.scope) === credentialScopeKey(scope)
        ? value
        : null;
    } catch {
      return null;
    }
  };
  const mutate = (run: () => Promise<void>) => {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };
  const credentials: RefreshCredentialStore = {
    get,
    set: (value) =>
      mutate(async () => {
        await SecureStore.setItemAsync(
          await key(value.scope),
          JSON.stringify(value),
          { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
        );
      }),
    delete: (scope, expected) =>
      mutate(async () => {
        const previous = await get(scope);
        if (expected === undefined || previous?.refreshToken === expected)
          await SecureStore.deleteItemAsync(await key(scope));
      }),
  };
  return { credentials, modeForServer: () => 'token' };
}
