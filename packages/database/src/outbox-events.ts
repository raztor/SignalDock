import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { IdSchema, type DatabasePort } from '@signaldock/contracts';
import {
  outboxEvent,
  type OutboxEvent,
  type OutboxEventRow,
} from './outbox-event.js';

export interface PostgresOutboxEventsOptions {
  connectionString: string;
  instanceId: string;
  maxPendingEvents?: number;
  reconnectDelayMs?: number;
  onError?: (error: Error) => void;
  /** LISTEN/NOTIFY cannot replay a disconnected interval; refresh consumers here. */
  onReconnect?: () => void | Promise<void>;
}

/** Live refresh fanout; durable domain writes and outbox acknowledgement stay in the caller transaction. */
export class PostgresOutboxEvents {
  private readonly instanceId: string;
  private readonly channel: string;
  private readonly capacity: number;
  private readonly reconnectDelay: number;
  private client: Client | undefined;
  private desired = false;
  private established = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private pumping: Promise<void> | undefined;
  private closing = new AbortController();
  private connectionAbort = new AbortController();
  private callback:
    | ((event: OutboxEvent, signal: AbortSignal) => void | Promise<void>)
    | undefined;
  private readonly pending: string[] = [];
  private readonly pendingIds = new Set<string>();

  constructor(private readonly options: PostgresOutboxEventsOptions) {
    this.instanceId = IdSchema.parse(options.instanceId).toLowerCase();
    this.channel = `sd_outbox_${createHash('sha256').update(this.instanceId).digest('hex').slice(0, 40)}`;
    this.capacity = options.maxPendingEvents ?? 256;
    this.reconnectDelay = options.reconnectDelayMs ?? 500;
    if (
      !Number.isInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 10000
    )
      throw new Error('Outbox event capacity must be from 1 to 10000.');
    if (
      !Number.isInteger(this.reconnectDelay) ||
      this.reconnectDelay < 10 ||
      this.reconnectDelay > 30000
    )
      throw new Error(
        'Outbox reconnect delay must be from 10 to 30000 milliseconds.',
      );
  }

  async start(
    onEvent: (event: OutboxEvent, signal: AbortSignal) => void | Promise<void>,
  ): Promise<void> {
    if (this.desired) {
      if (this.callback !== onEvent)
        throw new Error('The outbox listener is already started.');
      await this.connecting;
      return;
    }
    this.desired = true;
    this.callback = onEvent;
    this.closing = new AbortController();
    try {
      await this.connect();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** A publisher does not need to start a listener. PostgreSQL emits only after this transaction commits. */
  async publish(eventId: string, transaction: DatabasePort): Promise<void> {
    const id = IdSchema.parse(eventId).toLowerCase();
    await transaction.query('SELECT pg_notify($1,$2)', [
      this.channel,
      JSON.stringify({ instanceId: this.instanceId, id }),
    ]);
  }

  async close(): Promise<void> {
    this.desired = false;
    this.closing.abort(new Error('Outbox listener closed.'));
    this.connectionAbort.abort(new Error('Outbox listener closed.'));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.pending.length = 0;
    this.pendingIds.clear();
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
    await this.connecting?.catch(() => undefined);
    await this.pumping?.catch(() => undefined);
    this.callback = undefined;
    this.established = false;
    this.reconnectAttempt = 0;
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const attempt = this.open();
    this.connecting = attempt;
    void attempt
      .finally(() => {
        if (this.connecting === attempt) this.connecting = undefined;
      })
      .catch(() => undefined);
    return attempt;
  }

  private async open(): Promise<void> {
    if (!this.desired) return;
    this.connectionAbort = new AbortController();
    const client = new Client({
      connectionString: this.options.connectionString,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      keepAlive: true,
      application_name: `sd-outbox:${this.instanceId}`,
    });
    this.client = client;
    client.on('notification', (message) => {
      if (this.client === client && message.channel === this.channel)
        this.receive(message.payload);
    });
    client.on('error', () => this.disconnected(client));
    client.on('end', () => this.disconnected(client));
    try {
      await client.connect();
      if (!this.desired || this.client !== client)
        throw new Error('Outbox listener was closed while connecting.');
      // Channel is a fixed prefix and a SHA-256 hexadecimal digest, never caller SQL.
      await client.query(`LISTEN "${this.channel}"`);
      if (!this.desired || this.client !== client)
        throw new Error('Outbox listener was closed while connecting.');
      const reconnected = this.established;
      this.established = true;
      this.reconnectAttempt = 0;
      if (reconnected)
        void this.interruptible(
          Promise.resolve().then(() => this.options.onReconnect?.()),
        ).catch(() => {
          if (this.desired)
            this.report('Outbox consumer resynchronization failed.');
        });
      this.pump();
    } catch (error) {
      if (this.client === client) this.client = undefined;
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  private disconnected(client: Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.connectionAbort.abort(new Error('Outbox listener disconnected.'));
    void client.end().catch(() => undefined);
    if (!this.desired) return;
    this.report(
      'The outbox listener disconnected; consumer refresh is required after reconnection.',
    );
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (!this.desired || this.reconnectTimer) return;
    const delay = Math.min(
      30000,
      this.reconnectDelay * 2 ** Math.min(this.reconnectAttempt++, 8),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        this.report('The outbox listener could not reconnect.');
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }
  private receive(payload: string | undefined): void {
    if (!this.desired || !payload || Buffer.byteLength(payload) > 512) return;
    let id: string;
    try {
      const reference = JSON.parse(payload) as {
        instanceId?: unknown;
        id?: unknown;
      };
      if (reference.instanceId !== this.instanceId) return;
      id = IdSchema.parse(reference.id).toLowerCase();
    } catch {
      return;
    }
    if (this.pendingIds.has(id)) return;
    if (this.pendingIds.size >= this.capacity) {
      this.report(
        'The outbox event queue is full; consumer refresh is required.',
      );
      return;
    }
    this.pendingIds.add(id);
    this.pending.push(id);
    this.pump();
  }
  private pump(): void {
    if (this.pumping || !this.desired || !this.client) return;
    const work = this.drain();
    this.pumping = work;
    void work
      .finally(() => {
        if (this.pumping === work) this.pumping = undefined;
        if (this.desired && this.client && this.pending.length) this.pump();
      })
      .catch(() => undefined);
  }
  private async drain(): Promise<void> {
    while (this.desired && this.client && this.pending.length) {
      const client = this.client,
        id = this.pending.shift()!,
        signal = this.connectionAbort.signal;
      let retry = false;
      try {
        const row = (
          await client.query<OutboxEventRow>(
            'SELECT instance_id,id,type,radio_id,payload,occurred_at FROM sd_event_outbox WHERE instance_id=$1 AND id=$2',
            [this.instanceId, id],
          )
        ).rows[0];
        if (!this.desired) return;
        if (this.client !== client) {
          retry = true;
          return;
        }
        if (row)
          await this.interruptible(
            Promise.resolve().then(() => {
              signal.throwIfAborted();
              return this.callback?.(outboxEvent(row), signal);
            }),
            signal,
          );
      } catch {
        if (this.desired) {
          if (this.client !== client) {
            retry = true;
          } else
            this.report(
              'An outbox event could not be delivered; consumer refresh is required.',
            );
        }
      } finally {
        if (retry && this.desired) this.pending.unshift(id);
        else this.pendingIds.delete(id);
      }
      if (retry) return;
    }
  }
  private interruptible<T>(
    work: Promise<T>,
    connectionSignal?: AbortSignal,
  ): Promise<T> {
    const signals = [
      this.closing.signal,
      ...(connectionSignal ? [connectionSignal] : []),
    ];
    return new Promise<T>((resolve, reject) => {
      const abort = () =>
        reject(signals.find((signal) => signal.aborted)?.reason);
      for (const signal of signals) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
      void work.then(resolve, reject).finally(() => {
        for (const signal of signals)
          signal.removeEventListener('abort', abort);
      });
    });
  }
  private report(message: string): void {
    try {
      this.options.onError?.(new Error(message));
    } catch {
      /* Diagnostics cannot terminate the listener. */
    }
  }
}
