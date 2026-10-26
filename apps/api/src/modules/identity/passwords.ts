import { createRequire } from 'node:module';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(encoded: string, password: string): Promise<boolean>;
}

/** Native Argon2id is resolved only when the identity subsystem is configured. */
export function createArgon2idHasher(): PasswordHasher {
  const require = createRequire(import.meta.url);
  const argon = require('@node-rs/argon2') as {
    hash(
      value: string,
      options: {
        algorithm: number;
        memoryCost: number;
        timeCost: number;
        parallelism: number;
      },
    ): Promise<string>;
    verify(encoded: string, value: string): Promise<boolean>;
  };
  return {
    hash: (password) =>
      argon.hash(password, {
        algorithm: 2,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      }),
    verify: async (encoded, password) => {
      try {
        return await argon.verify(encoded, password);
      } catch {
        return false;
      }
    },
  };
}
