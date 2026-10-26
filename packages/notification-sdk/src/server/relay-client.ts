import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  RelayGrantSchema,
  RelayError,
  type DeliveryResult,
  type RelaySend,
  type RelayGrant,
} from '../protocol.js';
import { signRelayPayload } from './crypto.js';

export type RelayGrantInspection = RelayGrant;
const DeliverySchema = z.strictObject({
  requestId: z.uuid(),
  state: z.enum(['relay_accepted', 'provider_accepted', 'failed', 'expired']),
  ticketId: z.string().optional(),
  errorCode: z.string().optional(),
});
export interface RelayDeliveryPort {
  readonly publicUrl?: string;
  inspect(grantId: string): Promise<RelayGrantInspection>;
  send(payload: RelaySend): Promise<DeliveryResult>;
  revoke?(grantId: string): Promise<void>;
}

export class SignedRelayClient implements RelayDeliveryPort {
  private readonly baseUrl: URL;
  constructor(
    baseUrl: string,
    private readonly instanceId: string,
    private readonly privateKey: string,
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
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        ))
    ) {
      throw new RelayError(
        'INVALID_REQUEST',
        'Configure a trusted HTTPS relay, or loopback for private development.',
      );
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    this.baseUrl = url;
  }
  async inspect(grantId: string): Promise<RelayGrantInspection> {
    const payload = {
      grantId,
      instanceId: this.instanceId,
      nonce: randomUUID(),
      sentAt: new Date(this.now()).toISOString(),
    };
    return RelayGrantSchema.parse(
      await this.request('v1/grants/inspect', 'inspect', payload),
    );
  }
  get publicUrl(): string {
    return this.baseUrl.href;
  }
  async revoke(grantId: string): Promise<void> {
    await this.request('v1/grants/revoke', 'instance-revoke', {
      grantId,
      instanceId: this.instanceId,
      nonce: randomUUID(),
      sentAt: new Date(this.now()).toISOString(),
    });
  }
  async send(payload: RelaySend): Promise<DeliveryResult> {
    const result = DeliverySchema.parse(
      await this.request('v1/deliveries', 'send', payload),
    );
    return {
      requestId: result.requestId,
      state: result.state,
      ...(result.ticketId ? { ticketId: result.ticketId } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    };
  }
  private async request(
    path: string,
    domain: string,
    payload: unknown,
  ): Promise<unknown> {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        payload,
        signature: signRelayPayload(domain, payload, this.privateKey),
      }),
    });
    if (!response.ok)
      throw new RelayError(
        'UNAVAILABLE',
        `The configured relay rejected delivery (HTTP ${response.status}).`,
      );
    return response.status === 204 ? undefined : response.json();
  }
}
