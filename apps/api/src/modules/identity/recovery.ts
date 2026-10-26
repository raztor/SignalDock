import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { PostgresDatabase } from '@signaldock/database';
import { IdSchema, SignalDockError } from '@signaldock/contracts';
import {
  SqlIdentityRepository,
  type IdentityRepository,
} from './identity.repository.js';
import { createArgon2idHasher, type PasswordHasher } from './passwords.js';

export async function recoverAdministratorPassword(input: {
  repository: IdentityRepository;
  passwords: PasswordHasher;
  username: string;
  password: string;
}): Promise<{ userId: string; revokedSessionIds: string[] }> {
  const username = input.username.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) ||
    input.password.length < 12 ||
    input.password.length > 1024
  ) {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Use a valid username and a password containing 12–1024 characters.',
    );
  }
  const passwordHash = await input.passwords.hash(input.password);
  return input.repository.transaction(async (repository) => {
    await repository.lockAdministrators();
    const user = await repository.findUserByName(username);
    if (!user?.enabled || user.role !== 'administrator')
      throw new SignalDockError(
        'NOT_FOUND',
        'No enabled administrator matches that username.',
      );
    const now = new Date().toISOString();
    await repository.updateUser({
      ...user,
      passwordHash,
      authVersion: user.authVersion + 1,
      updatedAt: now,
    });
    return {
      userId: user.id,
      revokedSessionIds: await repository.revokeUserSessions(user.id, now),
    };
  });
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY)
    throw new Error(
      'Run recovery from a local interactive terminal; passwords are not accepted in arguments or environment variables.',
    );
  const index = process.argv.indexOf('--username');
  const username = index >= 0 ? process.argv[index + 1] : undefined;
  if (!username || process.argv.length !== 4)
    throw new Error('Usage: node recovery.js --username ADMIN_USERNAME');
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const directory =
    process.env['SIGNALDOCK_DATA_DIR'] ??
    fileURLToPath(new URL('../../../../../.local/instance', import.meta.url));
  const identity: unknown = JSON.parse(
    await readFile(join(directory, 'identity.json'), 'utf8'),
  );
  if (typeof identity !== 'object' || !identity || !('instanceId' in identity))
    throw new Error('Existing instance identity is required.');
  const instanceId = IdSchema.parse(identity.instanceId);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  let password: string;
  let repeated: string;
  try {
    process.stderr.write('New administrator password: ');
    password = await prompt.question('');
    process.stderr.write('\nRepeat password: ');
    repeated = await prompt.question('');
    process.stderr.write('\n');
  } finally {
    prompt.close();
    muted.end();
  }
  if (password !== repeated) throw new Error('Passwords do not match.');
  const database = new PostgresDatabase({
    connectionString,
    application_name: `signaldock-recovery-${randomUUID()}`,
  });
  try {
    const result = await recoverAdministratorPassword({
      repository: new SqlIdentityRepository(database, instanceId),
      passwords: createArgon2idHasher(),
      username,
      password,
    });
    console.log(
      `Administrator password changed; ${result.revokedSessionIds.length} sessions revoked.`,
    );
  } finally {
    await database.close();
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Administrator recovery failed.',
    );
    process.exitCode = 1;
  });
}
