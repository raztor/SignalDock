import { randomUUID } from 'expo-crypto';

/** Secure operation IDs on web and native (`expo-crypto`). */
export function operationId(): string {
  return randomUUID();
}
