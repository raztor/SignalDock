import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdSchema, PublicIdentitySchema } from '@signaldock/contracts';

export interface InstanceIdentity {
  instanceId: string;
  identity: { keyId: string; publicKey: string; algorithm: 'Ed25519' };
}

function keyId(publicKey: string): string {
  return `sha256:${createHash('sha256')
    .update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
    .digest('hex')}`;
}

/** Atomic creation prevents concurrent first starts from replacing an existing identity. */
export async function loadInstanceIdentity(
  directory: string,
): Promise<InstanceIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'identity.json');
  try {
    await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const privateKey = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const content = {
      instanceId: randomUUID(),
      identity: { keyId: keyId(publicKey), publicKey, algorithm: 'Ed25519' },
      privateKey,
    };
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(content) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      try {
        await link(temporary, path);
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST')
          throw linkError;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  const stored: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    typeof stored !== 'object' ||
    stored === null ||
    !('instanceId' in stored) ||
    !('identity' in stored) ||
    !('privateKey' in stored) ||
    typeof stored.privateKey !== 'string'
  ) {
    throw new Error(
      'Invalid instance identity file; restore the original identity from backup.',
    );
  }
  const identity = PublicIdentitySchema.parse(stored.identity);
  const instanceId = IdSchema.parse(stored.instanceId);
  const privateKey = createPrivateKey(stored.privateKey);
  if (
    privateKey.asymmetricKeyType !== 'ed25519' ||
    keyId(identity.publicKey) !== identity.keyId ||
    createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !==
      identity.publicKey
  ) {
    throw new Error(
      'Instance identity keys do not match; restore the original identity from backup.',
    );
  }
  return { instanceId, identity };
}
