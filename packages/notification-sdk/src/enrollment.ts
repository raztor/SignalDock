import { z } from 'zod';
import {
  ChallengeRequestSchema,
  GrantRequestSchema,
  RevokeRequestSchema,
  RelayError,
  RelayGrantSchema,
  type GrantRequest,
  type RelayGrant,
} from './protocol.js';
import { relaySigningMessage } from './message.js';

export interface InstallationSigner {
  publicKey: string;
  sign(message: Uint8Array): Promise<string>;
}
const challengeData = z.strictObject({
  kind: z.literal('enrollment-challenge'),
  challengeId: z.uuid(),
  installationId: z.uuid(),
  challenge: z.string().length(64),
  clientNonce: z.string().min(32).max(128),
});

/** Key persistence and push-token permission remain platform adapters, never server passwords. */
export class InstallationEnrollmentClient {
  private pending: {
    challengeId: string;
    nonce: string;
    expiresAt: string;
  } | null = null;
  private readonly base: URL;
  constructor(
    baseUrl: string,
    private readonly installationId: string,
    private readonly signer: InstallationSigner,
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
    private readonly now = Date.now,
  ) {
    const url = new URL(baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new RelayError(
        'INVALID_REQUEST',
        'Use a trusted HTTPS relay or loopback for private development.',
      );
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    this.base = url;
  }
  async begin(
    pushToken: string,
    projectId: string,
    privateInvitation: string,
    clientNonce: string,
  ): Promise<void> {
    const payload = ChallengeRequestSchema.parse({
      installationId: this.installationId,
      publicKey: this.signer.publicKey,
      pushToken,
      projectId,
      clientNonce,
    });
    const result = z
      .strictObject({ challengeId: z.uuid(), expiresAt: z.iso.datetime() })
      .parse(
        await this.request(
          'v1/enrollment/challenges',
          payload,
          privateInvitation,
        ),
      );
    this.pending = {
      challengeId: result.challengeId,
      nonce: clientNonce,
      expiresAt: result.expiresAt,
    };
  }
  async acknowledgeReceivedChallenge(data: unknown): Promise<void> {
    const challenge = challengeData.parse(data);
    if (
      !this.pending ||
      challenge.installationId !== this.installationId ||
      challenge.challengeId !== this.pending.challengeId ||
      challenge.clientNonce !== this.pending.nonce ||
      Date.parse(this.pending.expiresAt) <= this.now()
    )
      throw new RelayError(
        'FORBIDDEN',
        'This challenge does not match an enrollment started on this installation.',
      );
    const payload = {
      challengeId: challenge.challengeId,
      installationId: challenge.installationId,
      challenge: challenge.challenge,
      clientNonce: challenge.clientNonce,
    };
    await this.signed('v1/enrollment/acknowledge', 'enrollment-ack', payload);
    this.pending = null;
  }
  async authorize(
    input: Omit<GrantRequest, 'installationId' | 'sentAt'>,
  ): Promise<RelayGrant> {
    const payload = GrantRequestSchema.parse({
      ...input,
      installationId: this.installationId,
      sentAt: new Date(this.now()).toISOString(),
    });
    return RelayGrantSchema.parse(
      await this.signed('v1/grants', 'grant', payload),
    );
  }
  async revoke(input: {
    requestId: string;
    nonce: string;
    grantId?: string;
  }): Promise<void> {
    const payload = RevokeRequestSchema.parse({
      ...input,
      installationId: this.installationId,
      sentAt: new Date(this.now()).toISOString(),
    });
    await this.signed('v1/revocations', 'revoke', payload);
  }
  private async signed(
    path: string,
    domain: string,
    payload: unknown,
  ): Promise<unknown> {
    const signature = await this.signer.sign(
      new TextEncoder().encode(relaySigningMessage(domain, payload)),
    );
    return this.request(path, { payload, signature });
  }
  private async request(
    path: string,
    body: unknown,
    invitation?: string,
  ): Promise<unknown> {
    const response = await this.fetcher(new URL(path, this.base), {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        ...(invitation ? { Authorization: `Bearer ${invitation}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new RelayError(
        'UNAVAILABLE',
        `The relay request failed (HTTP ${response.status}).`,
      );
    return response.status === 204 ? undefined : response.json();
  }
}
