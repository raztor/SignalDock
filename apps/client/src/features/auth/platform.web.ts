import { credentialScopeKey, createMemoryCredentialStore } from './credentials';
import type { SessionControllerOptions } from './session-controller';
export function createPlatformAuthOptions(): SessionControllerOptions {
  return {
    credentials: createMemoryCredentialStore(),
    modeForServer: (baseUrl) =>
      new URL(baseUrl).origin === window.location.origin ? 'cookie' : 'token',
    readCsrfToken: (instanceId) => {
      const key = `sd-csrf-${instanceId}=`;
      const value = document.cookie
        .split(';')
        .map((item) => item.trim())
        .find((item) => item.startsWith(key));
      return value ? decodeURIComponent(value.slice(key.length)) : undefined;
    },
    runExclusive: async (scope, action) => {
      if (navigator.locks)
        return navigator.locks.request(
          `signaldock.refresh.${credentialScopeKey(scope)}`,
          action,
        );
      return action();
    },
  };
}
