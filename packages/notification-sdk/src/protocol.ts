import { z } from 'zod';

export const RelayCategorySchema = z.enum([
  'communication',
  'transcript',
  'incident',
  'control',
  'radio',
  'storage',
  'processing',
]);
export type RelayCategory = z.infer<typeof RelayCategorySchema>;
const id = z.uuid();
const time = z.iso.datetime();
const key = z.string().min(50).max(2048);
export const ChallengeRequestSchema = z.strictObject({
  installationId: id,
  publicKey: key,
  projectId: id,
  clientNonce: z.string().min(32).max(128),
  pushToken: z
    .string()
    .regex(/^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/)
    .max(256),
});
export const ChallengeAckSchema = z.strictObject({
  challengeId: id,
  installationId: id,
  challenge: z.string().length(64),
  clientNonce: z.string().min(32).max(128),
});
export const GrantRequestSchema = z.strictObject({
  installationId: id,
  requestId: id,
  nonce: id,
  sentAt: time,
  instanceId: id,
  instancePublicKey: key,
  subscriptionRef: id,
  categories: z.array(RelayCategorySchema).min(1).max(8),
  radioIds: z.array(id).max(64),
  expiresAt: time,
});
export type GrantRequest = z.infer<typeof GrantRequestSchema>;
export const RelaySendSchema = z.strictObject({
  grantId: id,
  instanceId: id,
  requestId: id,
  nonce: id,
  notificationId: id,
  eventId: id,
  category: RelayCategorySchema,
  radioId: id.optional(),
  sentAt: time,
  expiresAt: time,
});
export type RelaySend = z.infer<typeof RelaySendSchema>;
export const RevokeRequestSchema = z.strictObject({
  installationId: id,
  grantId: id.optional(),
  requestId: id,
  nonce: id,
  sentAt: time,
});
export type RevokeRequest = z.infer<typeof RevokeRequestSchema>;
export const InspectRequestSchema = z.strictObject({
  grantId: id,
  instanceId: id,
  nonce: id,
  sentAt: time,
});
export const SignatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(128);

export interface SignedRequest<T> {
  payload: T;
  signature: string;
}
export type DeliveryState =
  'relay_accepted' | 'provider_accepted' | 'failed' | 'expired';
export interface DeliveryResult {
  requestId: string;
  state: DeliveryState;
  ticketId?: string;
  errorCode?: string;
}
export const RelayGrantSchema = z.strictObject({
  grantId: id,
  installationId: id,
  instanceId: id,
  instancePublicKey: key,
  subscriptionRef: id,
  categories: z.array(RelayCategorySchema).min(1).max(8),
  radioIds: z.array(id).max(64),
  expiresAt: time,
  revokedAt: time.nullable(),
});
export type RelayGrant = z.infer<typeof RelayGrantSchema>;
export interface RelayInstallation {
  installationId: string;
  publicKey: string;
  tokenCiphertext: string;
  projectId: string;
  verifiedAt: string;
  revokedAt: string | null;
}
export interface RelayChallenge {
  challengeId: string;
  installationId: string;
  publicKey: string;
  projectId: string;
  clientNonce: string;
  challengeHash: string;
  tokenCiphertext: string;
  expiresAt: string;
}

export class RelayError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_REQUEST'
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'EXPIRED'
      | 'REPLAY'
      | 'RATE_LIMITED'
      | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}
