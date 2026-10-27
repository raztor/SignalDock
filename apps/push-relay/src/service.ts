import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  assertPublicKey,
  hashSecret,
  matchesSecret,
  TokenVault,
  verifyRelayPayload,
} from '@signaldock/notification-sdk/server';
import {
  ChallengeAckSchema,
  ChallengeRequestSchema,
  GrantRequestSchema,
  InspectRequestSchema,
  RelayError,
  RelaySendSchema,
  RevokeRequestSchema,
  SignatureSchema,
  type DeliveryResult,
  type RelayGrant,
  type SignedRequest,
} from '@signaldock/notification-sdk';
import type { PushTransport } from './expo.js';
import type { RelayStore, StoredDelivery } from './store.js';

export interface PrivateRelayOptions {
  mode: 'private-test';
  projectId: string;
  enrollmentSecretHash: string;
  maxInstallationSendsPerMinute?: number;
  maxGrantSendsPerMinute?: number;
  maxChallengeRequestsPerMinute?: number;
}

export class RelayService {
  private readonly challengeAttempts = new Map<
    string,
    { started: number; count: number }
  >();
  constructor(
    private readonly store: RelayStore,
    private readonly vault: TokenVault,
    private readonly transport: PushTransport,
    readonly options: PrivateRelayOptions,
    private readonly now = Date.now,
  ) {
    if (
      options.mode !== 'private-test' ||
      !/^[a-f0-9]{64}$/.test(options.enrollmentSecretHash)
    ) {
      throw new Error(
        'Relay startup requires private-test mode and a configured private enrollment secret.',
      );
    }
    z.uuid().parse(options.projectId);
  }

  async requestChallenge(
    input: unknown,
    enrollmentSecret: string,
  ): Promise<{ challengeId: string; expiresAt: string }> {
    if (!matchesSecret(enrollmentSecret, this.options.enrollmentSecretHash))
      throw new RelayError(
        'UNAUTHORIZED',
        'A private enrollment invitation is required.',
      );
    const request = ChallengeRequestSchema.parse(input);
    assertPublicKey(request.publicKey);
    if (request.projectId !== this.options.projectId)
      throw new RelayError(
        'FORBIDDEN',
        'This app project is not enrolled with this relay.',
      );
    this.limitChallenge(hashSecret(request.pushToken));
    const challenge = randomBytes(32).toString('hex');
    const record = {
      challengeId: randomUUID(),
      installationId: request.installationId,
      publicKey: request.publicKey,
      projectId: request.projectId,
      clientNonce: request.clientNonce,
      challengeHash: hashSecret(challenge),
      tokenCiphertext: this.vault.encrypt(
        request.installationId,
        request.pushToken,
      ),
      expiresAt: this.iso(120000),
    };
    await this.store.transaction(async (tx) => {
      const existing = await tx.getInstallation(request.installationId);
      if (existing && existing.publicKey !== request.publicKey)
        throw new RelayError(
          'FORBIDDEN',
          'The installation key cannot be replaced through enrollment.',
        );
      await tx.saveChallenge(record);
    });
    try {
      const ticket = await this.transport.send({
        token: request.pushToken,
        title: 'SignalDock device verification',
        body: 'Complete the enrollment you started in SignalDock.',
        expiresAt: record.expiresAt,
        data: {
          kind: 'enrollment-challenge',
          challengeId: record.challengeId,
          installationId: request.installationId,
          challenge,
          clientNonce: request.clientNonce,
        },
      });
      if (ticket.status !== 'ok')
        throw new RelayError(
          'UNAVAILABLE',
          'Device verification could not be delivered.',
        );
    } catch {
      await this.store.transaction((tx) =>
        tx.deleteChallenge(record.challengeId),
      );
      throw new RelayError(
        'UNAVAILABLE',
        'Device verification could not be delivered.',
      );
    }
    // The challenge is intentionally absent. Possession must be proved from the receiving installation.
    return { challengeId: record.challengeId, expiresAt: record.expiresAt };
  }

  async acknowledgeChallenge(
    input: SignedRequest<unknown>,
  ): Promise<{ installationId: string; verified: true }> {
    const request = ChallengeAckSchema.parse(input.payload);
    const signature = SignatureSchema.parse(input.signature);
    return this.store.transaction(async (tx) => {
      const pending = await tx.getChallenge(request.challengeId);
      if (
        !pending ||
        pending.installationId !== request.installationId ||
        pending.clientNonce !== request.clientNonce ||
        !matchesSecret(request.challenge, pending.challengeHash)
      )
        throw new RelayError(
          'UNAUTHORIZED',
          'The enrollment challenge is invalid.',
        );
      this.notExpired(pending.expiresAt);
      verifyRelayPayload(
        'enrollment-ack',
        request,
        signature,
        pending.publicKey,
      );
      const existing = await tx.getInstallation(pending.installationId);
      if (existing && existing.publicKey !== pending.publicKey)
        throw new RelayError(
          'FORBIDDEN',
          'An installation identifier cannot replace an existing key.',
        );
      await tx.saveInstallation({
        installationId: pending.installationId,
        registrationId: randomUUID(),
        publicKey: pending.publicKey,
        projectId: pending.projectId,
        tokenCiphertext: pending.tokenCiphertext,
        verifiedAt: this.iso(),
        revokedAt: null,
      });
      await tx.deleteChallenge(pending.challengeId);
      return {
        installationId: pending.installationId,
        verified: true as const,
      };
    });
  }

  async authorizeGrant(input: SignedRequest<unknown>): Promise<RelayGrant> {
    const request = GrantRequestSchema.parse(input.payload);
    SignatureSchema.parse(input.signature);
    this.fresh(request.sentAt);
    this.notExpired(request.expiresAt);
    if (Date.parse(request.expiresAt) > this.now() + 30 * 86400000)
      throw new RelayError(
        'INVALID_REQUEST',
        'The grant exceeds the 30-day limit.',
      );
    assertPublicKey(request.instancePublicKey);
    return this.store.transaction(async (tx) => {
      const installation = await tx.getInstallation(request.installationId);
      if (!installation || installation.revokedAt)
        throw new RelayError(
          'UNAUTHORIZED',
          'The receiving installation is not active.',
        );
      verifyRelayPayload(
        'grant',
        request,
        input.signature,
        installation.publicKey,
      );
      if (
        !(await tx.consumeNonce(
          `installation:${request.installationId}`,
          request.nonce,
          this.iso(120000),
        ))
      )
        throw new RelayError(
          'REPLAY',
          'This installation request has already been used.',
        );
      const grant: RelayGrant = {
        grantId: request.requestId,
        installationId: request.installationId,
        instanceId: request.instanceId,
        instancePublicKey: request.instancePublicKey,
        subscriptionRef: request.subscriptionRef,
        categories: [...new Set(request.categories)],
        radioIds: [...new Set(request.radioIds)],
        expiresAt: request.expiresAt,
        revokedAt: null,
      };
      if (await tx.getGrant(grant.grantId))
        throw new RelayError(
          'REPLAY',
          'The grant identifier has already been used.',
        );
      await tx.saveGrant(grant);
      return grant;
    });
  }

  async inspectGrant(input: SignedRequest<unknown>): Promise<RelayGrant> {
    const request = InspectRequestSchema.parse(input.payload);
    this.fresh(request.sentAt);
    SignatureSchema.parse(input.signature);
    return this.store.transaction(async (tx) => {
      let grant = await tx.getGrant(request.grantId);
      if (!grant || grant.instanceId !== request.instanceId)
        throw new RelayError('UNAUTHORIZED', 'The grant is not available.');
      const installation = await tx.getInstallation(grant.installationId);
      // Revokers serialize on the installation. The grant read before this lock may be stale.
      grant = await tx.getGrant(request.grantId);
      if (!grant || grant.instanceId !== request.instanceId)
        throw new RelayError('UNAUTHORIZED', 'The grant is not available.');
      this.active(grant, installation?.revokedAt ?? null, !!installation);
      verifyRelayPayload(
        'inspect',
        request,
        input.signature,
        grant.instancePublicKey,
      );
      if (
        !(await tx.consumeNonce(
          `instance:${grant.instanceId}`,
          request.nonce,
          this.iso(120000),
        ))
      )
        throw new RelayError('REPLAY', 'This request has already been used.');
      return grant;
    });
  }

  async send(input: SignedRequest<unknown>): Promise<DeliveryResult> {
    const request = RelaySendSchema.parse(input.payload);
    SignatureSchema.parse(input.signature);
    this.fresh(request.sentAt);
    this.notExpired(request.expiresAt);
    if (Date.parse(request.expiresAt) > this.now() + 300000)
      throw new RelayError(
        'INVALID_REQUEST',
        'Notification TTL exceeds five minutes.',
      );
    const fingerprint = hashSecret(JSON.stringify(request));
    const prepared = await this.store.transaction(async (tx) => {
      let grant = await tx.getGrant(request.grantId);
      if (!grant || grant.instanceId !== request.instanceId)
        throw new RelayError('UNAUTHORIZED', 'The grant is not available.');
      const installation = await tx.getInstallation(grant.installationId);
      grant = await tx.getGrant(request.grantId);
      if (!grant || grant.instanceId !== request.instanceId)
        throw new RelayError('UNAUTHORIZED', 'The grant is not available.');
      this.active(grant, installation?.revokedAt ?? null, !!installation);
      verifyRelayPayload(
        'send',
        request,
        input.signature,
        grant.instancePublicKey,
      );
      if (
        !grant.categories.includes(request.category) ||
        (request.radioId && !grant.radioIds.includes(request.radioId))
      )
        throw new RelayError(
          'FORBIDDEN',
          'The event is outside this subscription.',
        );
      const previous = await tx.getDelivery(request.requestId);
      if (previous) {
        if (
          previous.fingerprint !== fingerprint ||
          previous.grantId !== grant.grantId
        )
          throw new RelayError(
            'REPLAY',
            'An idempotency identifier cannot be replaced.',
          );
        return { previous };
      }
      if (
        !(await tx.consumeNonce(
          `instance:${grant.instanceId}`,
          request.nonce,
          this.iso(120000),
        ))
      )
        throw new RelayError('REPLAY', 'This request has already been used.');
      const counts = await tx.countDeliveries(
        grant.installationId,
        grant.grantId,
        new Date(this.now() - 60000).toISOString(),
      );
      if (
        counts.installation >=
          (this.options.maxInstallationSendsPerMinute ?? 60) ||
        counts.grant >= (this.options.maxGrantSendsPerMinute ?? 30)
      )
        throw new RelayError(
          'RATE_LIMITED',
          'The delivery quota has been reached.',
        );
      const delivery: StoredDelivery = {
        requestId: request.requestId,
        grantId: grant.grantId,
        installationId: grant.installationId,
        registrationId: installation!.registrationId,
        fingerprint,
        createdAt: this.iso(),
        expiresAt: request.expiresAt,
        state: 'relay_accepted',
        receiptChecked: false,
      };
      await tx.saveDelivery(delivery);
      return { delivery, installation: installation! };
    });
    if ('previous' in prepared) return publicResult(prepared.previous);
    const delivery = prepared.delivery;
    if (Date.parse(delivery.expiresAt) <= this.now()) {
      delivery.state = 'expired';
      await this.store.transaction((tx) => tx.saveDelivery(delivery));
      return publicResult(delivery);
    }
    // Never retry this reservation after a crash/ambiguous provider response: the instance history remains authoritative.
    try {
      const ticket = await this.transport.send({
        token: this.vault.decrypt(
          prepared.installation.installationId,
          prepared.installation.tokenCiphertext,
        ),
        title: 'SignalDock',
        body: genericBody(request.category),
        expiresAt: delivery.expiresAt,
        data: {
          instanceId: request.instanceId,
          eventId: request.eventId,
          notificationId: request.notificationId,
          ...(request.radioId ? { radioId: request.radioId } : {}),
        },
      });
      delivery.state = ticket.status === 'ok' ? 'provider_accepted' : 'failed';
      if (ticket.id) delivery.ticketId = ticket.id;
      if (ticket.error) delivery.errorCode = ticket.error;
      if (ticket.error === 'DeviceNotRegistered')
        await this.disableInstallation(
          delivery.installationId,
          delivery.registrationId,
        );
    } catch {
      delivery.state = 'failed';
      delivery.errorCode = 'ProviderUnavailable';
    }
    await this.store.transaction((tx) => tx.saveDelivery(delivery));
    return publicResult(delivery);
  }

  async revoke(input: SignedRequest<unknown>): Promise<void> {
    const request = RevokeRequestSchema.parse(input.payload);
    SignatureSchema.parse(input.signature);
    this.fresh(request.sentAt);
    await this.store.transaction(async (tx) => {
      const installation = await tx.getInstallation(request.installationId);
      if (!installation)
        throw new RelayError(
          'UNAUTHORIZED',
          'The installation is not available.',
        );
      verifyRelayPayload(
        'revoke',
        request,
        input.signature,
        installation.publicKey,
      );
      if (
        !(await tx.consumeNonce(
          `installation:${request.installationId}`,
          request.nonce,
          this.iso(120000),
        ))
      )
        throw new RelayError(
          'REPLAY',
          'This revocation has already been used.',
        );
      if (
        request.grantId &&
        (await tx.getGrant(request.grantId))?.installationId !==
          request.installationId
      )
        throw new RelayError(
          'FORBIDDEN',
          'The grant belongs to another installation.',
        );
      await tx.revokeGrants(
        request.installationId,
        this.iso(),
        request.grantId,
      );
      if (!request.grantId)
        await tx.saveInstallation({
          ...installation,
          tokenCiphertext: '',
          revokedAt: this.iso(),
        });
    });
  }
  async revokeFromInstance(input: SignedRequest<unknown>): Promise<void> {
    const request = InspectRequestSchema.parse(input.payload);
    this.fresh(request.sentAt);
    SignatureSchema.parse(input.signature);
    await this.store.transaction(async (tx) => {
      let grant = await tx.getGrant(request.grantId);
      if (!grant || grant.instanceId !== request.instanceId)
        throw new RelayError('UNAUTHORIZED', 'The grant is not available.');
      const installation = await tx.getInstallation(grant.installationId);
      grant = await tx.getGrant(request.grantId);
      if (!grant || grant.instanceId !== request.instanceId)
        throw new RelayError('UNAUTHORIZED', 'The grant is not available.');
      if (!installation)
        throw new RelayError(
          'UNAUTHORIZED',
          'The installation is not available.',
        );
      verifyRelayPayload(
        'instance-revoke',
        request,
        input.signature,
        grant.instancePublicKey,
      );
      if (
        !(await tx.consumeNonce(
          `instance:${grant.instanceId}`,
          request.nonce,
          this.iso(120000),
        ))
      )
        throw new RelayError('REPLAY', 'This request has already been used.');
      await tx.revokeGrants(grant.installationId, this.iso(), grant.grantId);
    });
  }

  async pollReceipts(): Promise<number> {
    const deliveries = await this.store.transaction((tx) =>
      tx.pendingReceipts(),
    );
    if (!deliveries.length) return 0;
    const receipts = await this.transport.receipts(
      deliveries.flatMap((delivery) =>
        delivery.ticketId ? [delivery.ticketId] : [],
      ),
    );
    let count = 0;
    for (const delivery of deliveries) {
      const receipt = delivery.ticketId
        ? receipts[delivery.ticketId]
        : undefined;
      if (!receipt) continue;
      delivery.receiptChecked = true;
      if (receipt.status === 'error') {
        delivery.state = 'failed';
        delivery.errorCode = receipt.error ?? 'ProviderRejected';
      }
      await this.store.transaction((tx) => tx.saveDelivery(delivery));
      if (receipt.error === 'DeviceNotRegistered')
        await this.disableInstallation(
          delivery.installationId,
          delivery.registrationId,
        );
      count++;
    }
    return count;
  }
  private async disableInstallation(
    id: string,
    registrationId: string | null,
  ): Promise<void> {
    // Legacy receipts have no provable registration binding and may never clear a current token.
    if (!registrationId) return;
    await this.store.transaction(async (tx) => {
      const installation = await tx.getInstallation(id);
      if (installation && installation.registrationId === registrationId) {
        await tx.saveInstallation({
          ...installation,
          tokenCiphertext: '',
          revokedAt: this.iso(),
        });
        await tx.revokeGrants(id, this.iso());
      }
    });
  }
  private active(
    grant: RelayGrant,
    revokedAt: string | null,
    exists: boolean,
  ): void {
    if (!exists || revokedAt || grant.revokedAt)
      throw new RelayError(
        'UNAUTHORIZED',
        'This subscription has been revoked.',
      );
    this.notExpired(grant.expiresAt);
  }
  private iso(offset = 0): string {
    return new Date(this.now() + offset).toISOString();
  }
  private notExpired(time: string): void {
    if (Date.parse(time) <= this.now())
      throw new RelayError('EXPIRED', 'The request or grant expired.');
  }
  private fresh(time: string): void {
    if (Math.abs(this.now() - Date.parse(time)) > 60000)
      throw new RelayError(
        'EXPIRED',
        'The signed request timestamp is outside the allowed window.',
      );
  }
  private limitChallenge(key: string): void {
    for (const [id, value] of this.challengeAttempts)
      if (this.now() - value.started > 60000) this.challengeAttempts.delete(id);
    if (this.challengeAttempts.size >= 1000 && !this.challengeAttempts.has(key))
      throw new RelayError(
        'RATE_LIMITED',
        'Enrollment is temporarily unavailable.',
      );
    const value = this.challengeAttempts.get(key) ?? {
      started: this.now(),
      count: 0,
    };
    if (++value.count > (this.options.maxChallengeRequestsPerMinute ?? 3))
      throw new RelayError(
        'RATE_LIMITED',
        'Too many device-verification attempts.',
      );
    this.challengeAttempts.set(key, value);
  }
}
function publicResult(delivery: StoredDelivery): DeliveryResult {
  return {
    requestId: delivery.requestId,
    state: delivery.state,
    ...(delivery.ticketId ? { ticketId: delivery.ticketId } : {}),
    ...(delivery.errorCode ? { errorCode: delivery.errorCode } : {}),
  };
}
function genericBody(category: string): string {
  return category === 'incident'
    ? 'An incident needs your attention.'
    : category === 'communication'
      ? 'New radio communication is available.'
      : 'A station update is available.';
}
