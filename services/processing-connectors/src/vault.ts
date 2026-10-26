import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SignalDockError } from '@signaldock/contracts';

export interface CredentialScope { instanceId: string; credentialId: string; ownerUserId: string | null }
export interface CredentialEnvelope { version: 1; keyId: string; iv: string; ciphertext: string; tag: string }
/** Key material must come from persistent operator-managed secrets, never from a database row. */
export class CredentialVault {
  constructor(private readonly activeKeyId: string, private readonly keys: ReadonlyMap<string, Uint8Array>) {
    if (!activeKeyId || !keys.has(activeKeyId) || [...keys.values()].some((key) => key.byteLength !== 32)) {
      throw new SignalDockError('REQUIRES_CONFIGURATION', 'Configure a persistent 32-byte processing credential key.');
    }
  }
  seal(scope: CredentialScope, value: unknown): CredentialEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([scope.instanceId, scope.credentialId, scope.ownerUserId])));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { version: 1, keyId: this.activeKeyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  }
  open<T>(scope: CredentialScope, envelope: CredentialEnvelope): T {
    const key = this.keys.get(envelope.keyId);
    if (envelope.version !== 1 || !key) throw new SignalDockError('REQUIRES_CONFIGURATION', 'The credential encryption key is unavailable.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAAD(Buffer.from(JSON.stringify([scope.instanceId, scope.credentialId, scope.ownerUserId])));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as T;
    } catch { throw new SignalDockError('UNAUTHORIZED', 'The stored processing credential could not be authenticated.'); }
  }
}
