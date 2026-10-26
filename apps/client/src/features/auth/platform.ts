import { createMemoryCredentialStore } from './credentials';
import type { SessionControllerOptions } from './session-controller';
export function createPlatformAuthOptions(): SessionControllerOptions {
  return {
    credentials: createMemoryCredentialStore(),
    modeForServer: () => 'token',
  };
}
