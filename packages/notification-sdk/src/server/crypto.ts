import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { RelayError } from '../protocol.js';
import { relaySigningMessage } from '../message.js';

export function signingBytes(domain: string, payload: unknown): Buffer {
  return Buffer.from(relaySigningMessage(domain, payload), 'utf8');
}
export function signRelayPayload(
  domain: string,
  payload: unknown,
  privateKey: string,
): string {
  return sign(null, signingBytes(domain, payload), privateKey).toString(
    'base64url',
  );
}
export function assertPublicKey(publicKey: string): void {
  try {
    if (createPublicKey(publicKey).asymmetricKeyType !== 'ed25519')
      throw new Error();
  } catch {
    throw new RelayError(
      'INVALID_REQUEST',
      'An Ed25519 installation or instance public key is required.',
    );
  }
}
export function verifyRelayPayload(
  domain: string,
  payload: unknown,
  signature: string,
  publicKey: string,
): void {
  assertPublicKey(publicKey);
  try {
    if (
      verify(
        null,
        signingBytes(domain, payload),
        publicKey,
        Buffer.from(signature, 'base64url'),
      )
    )
      return;
  } catch {
    /* All malformed signatures share the same public error. */
  }
  throw new RelayError('UNAUTHORIZED', 'The request signature is invalid.');
}
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function matchesSecret(value: string, digest: string): boolean {
  const supplied = Buffer.from(hashSecret(value), 'hex');
  const expected = Buffer.from(digest, 'hex');
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
export class TokenVault {
  private readonly key: Buffer;
  constructor(key: Uint8Array) {
    if (key.length !== 32)
      throw new Error(
        'The relay token encryption key must contain exactly 32 bytes.',
      );
    this.key = Buffer.from(key);
  }
  encrypt(installationId: string, token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(installationId));
    const ciphertext = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      'base64url',
    );
  }
  decrypt(installationId: string, encoded: string): string {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length < 29)
      throw new RelayError(
        'UNAVAILABLE',
        'The device registration could not be read.',
      );
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(installationId));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new RelayError(
        'UNAVAILABLE',
        'The device registration could not be read.',
      );
    }
  }
}
