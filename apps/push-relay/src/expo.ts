import { RelayError } from '@signaldock/notification-sdk';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  expiresAt: string;
  data: Record<string, string>;
}
export interface PushTicket {
  id?: string;
  status: 'ok' | 'error';
  error?: string;
}
export interface PushReceipt {
  status: 'ok' | 'error';
  error?: string;
}
export interface PushTransport {
  send(message: PushMessage): Promise<PushTicket>;
  receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>>;
}

/** The only network destination is Expo; it is never supplied by a sender. */
export class ExpoPushTransport implements PushTransport {
  constructor(
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}
  async send(message: PushMessage): Promise<PushTicket> {
    const expiration = Math.floor(Date.parse(message.expiresAt) / 1000);
    if (!Number.isSafeInteger(expiration))
      throw new RelayError(
        'INVALID_REQUEST',
        'A valid push expiration is required.',
      );
    const data = await this.request('send', {
      to: message.token,
      title: message.title,
      body: message.body,
      data: message.data,
      expiration,
    });
    const ticket = Array.isArray(data) ? data[0] : data;
    return parseResult(ticket, true);
  }
  async receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
    if (!ticketIds.length || ticketIds.length > 100)
      throw new RelayError(
        'INVALID_REQUEST',
        'Receipt requests require 1–100 stored tickets.',
      );
    const data = await this.request('getReceipts', { ids: ticketIds });
    if (typeof data !== 'object' || data === null || Array.isArray(data))
      throw new RelayError(
        'UNAVAILABLE',
        'The push provider returned an invalid receipt response.',
      );
    const parsed: Record<string, PushReceipt> = {};
    for (const id of ticketIds) {
      if (id in data)
        parsed[id] = parseResult((data as Record<string, unknown>)[id], false);
    }
    return parsed;
  }
  private async request(action: string, body: unknown): Promise<unknown> {
    const result = await this.fetcher(
      `https://exp.host/--/api/v2/push/${action}`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!result.ok)
      throw new RelayError(
        'UNAVAILABLE',
        'The push provider did not accept the request.',
      );
    const envelope: unknown = await result.json();
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      !('data' in envelope)
    )
      throw new RelayError(
        'UNAVAILABLE',
        'The push provider returned an invalid response.',
      );
    return envelope.data;
  }
}
function parseResult(value: unknown, ticket: boolean): PushTicket {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    !['ok', 'error'].includes(String(value.status))
  ) {
    throw new RelayError(
      'UNAVAILABLE',
      'The push provider returned an invalid delivery result.',
    );
  }
  const record = value as Record<string, unknown>;
  const details =
    typeof record['details'] === 'object' && record['details'] !== null
      ? (record['details'] as Record<string, unknown>)
      : {};
  const error =
    typeof details['error'] === 'string' ? details['error'] : undefined;
  const allowed = new Set([
    'DeviceNotRegistered',
    'InvalidCredentials',
    'MessageTooBig',
    'MessageRateExceeded',
    'MismatchSenderId',
  ]);
  const id = typeof record['id'] === 'string' ? record['id'] : undefined;
  if (ticket && value.status === 'ok' && !id)
    throw new RelayError(
      'UNAVAILABLE',
      'The push provider omitted its ticket.',
    );
  return {
    status: value.status as 'ok' | 'error',
    ...(id ? { id } : {}),
    ...(error
      ? { error: allowed.has(error) ? error : 'ProviderRejected' }
      : {}),
  };
}
