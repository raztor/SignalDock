export interface CredentialScope {
  baseUrl: string;
  instanceId: string;
  keyId: string;
  publicKey: string;
}
export interface StoredRefresh {
  scope: CredentialScope;
  userId: string;
  refreshToken: string;
}
export interface RefreshCredentialStore {
  get(scope: CredentialScope): Promise<StoredRefresh | null>;
  set(value: StoredRefresh): Promise<void>;
  delete(scope: CredentialScope, expectedRefreshToken?: string): Promise<void>;
}
export function credentialScopeKey(scope: CredentialScope): string {
  return JSON.stringify([
    scope.baseUrl,
    scope.instanceId,
    scope.keyId,
    scope.publicKey,
  ]);
}
export function createMemoryCredentialStore(): RefreshCredentialStore {
  const records = new Map<string, StoredRefresh>();
  return {
    get: async (scope) => records.get(credentialScopeKey(scope)) ?? null,
    set: async (value) => {
      records.set(credentialScopeKey(value.scope), value);
    },
    delete: async (scope, expected) => {
      const key = credentialScopeKey(scope);
      if (expected === undefined || records.get(key)?.refreshToken === expected)
        records.delete(key);
    },
  };
}
