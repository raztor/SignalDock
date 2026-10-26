import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Private, atomic first-start secrets survive process/container replacement. */
export async function loadStationSecrets(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'station-secrets.json');
  try {
    await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          setupToken: randomBytes(32).toString('base64url'),
          activeKeyId: 'primary',
          keys: { primary: randomBytes(32).toString('base64') },
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  const stored = JSON.parse(await readFile(path, 'utf8')) as {
    setupToken: string;
    activeKeyId: string;
    keys: Record<string, string>;
  };
  if (
    typeof stored.setupToken !== 'string' ||
    stored.setupToken.length < 24 ||
    typeof stored.activeKeyId !== 'string' ||
    !stored.keys ||
    typeof stored.keys !== 'object'
  )
    throw new Error(
      'Invalid station secrets; restore the original private file.',
    );
  const keys = new Map(
    Object.entries(stored.keys).map(([id, encoded]) => {
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32) throw new Error('Invalid station encryption key.');
      return [id, key] as const;
    }),
  );
  if (!keys.has(stored.activeKeyId))
    throw new Error('Active station encryption key is missing.');
  return {
    setupToken: stored.setupToken,
    activeKeyId: stored.activeKeyId,
    keys,
  };
}
