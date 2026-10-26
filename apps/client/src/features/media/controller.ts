import { apiRequest } from '@signaldock/client-sdk';
import type {
  ClientSession,
  ControlLease,
  MediaSession,
  RadioSnapshot,
  TxGrant,
  TxState,
} from '@signaldock/contracts';

export interface ClientTxStatus {
  grant: TxGrant;
  state: TxState;
  reason?: string;
}
export interface Microphone {
  stop(): void;
}
export interface MediaConnection {
  disconnect(): Promise<void>;
  publish(microphone: Microphone): Promise<void>;
}
export interface BrowserMediaPort {
  microphone(onInterrupted: () => void): Promise<Microphone>;
  connect(
    session: MediaSession,
    onInterrupted: () => void,
  ): Promise<MediaConnection>;
}
export interface MediaUiState {
  listening: boolean;
  transmitting: boolean;
  pending: boolean;
  message: string;
}
type Api = <T>(
  session: ClientSession,
  path: string,
  init?: RequestInit,
) => Promise<T>;
const active = new Set<RadioMediaController>();

/** Called before accepting a new server, radio, account, or application route. */
export async function stopActiveMedia(
  reason: string,
  scope?: { instanceId?: string; radioId?: string },
): Promise<void> {
  const matching = [...active].filter(
    (item) =>
      (!scope?.instanceId || item.instanceId === scope.instanceId) &&
      (!scope?.radioId || item.radioId === scope.radioId),
  );
  // stop() invalidates pending operations and stops microphone tracks synchronously.
  await Promise.all(matching.map((controller) => controller.stop(reason)));
}

export class RadioMediaController {
  readonly instanceId: string;
  private txEpoch = 0;
  private listenEpoch = 0;
  private closed = false;
  private microphone: Microphone | undefined;
  private txConnection: MediaConnection | undefined;
  private listener: MediaConnection | undefined;
  private txSession: MediaSession | undefined;
  private listenSession: MediaSession | undefined;
  private grant: TxGrant | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private listenerRenewal: ReturnType<typeof setInterval> | undefined;
  private renewing = false;
  private readonly initialSession: ClientSession;
  private state: MediaUiState = {
    listening: false,
    transmitting: false,
    pending: false,
    message: 'Ready. Press Listen to enable audio.',
  };
  constructor(
    private readonly options: {
      session: () => ClientSession;
      radioId: string;
      port: BrowserMediaPort;
      onState: (state: MediaUiState) => void;
      request?: Api;
    },
  ) {
    this.initialSession = options.session();
    this.instanceId = this.initialSession.instanceId;
    active.add(this);
  }
  get radioId(): string {
    return this.options.radioId;
  }
  private session(): ClientSession {
    const latest = this.options.session();
    return latest.baseUrl === this.initialSession.baseUrl &&
      latest.instanceId === this.instanceId &&
      latest.user.id === this.initialSession.user.id
      ? latest
      : this.initialSession;
  }
  private request<T>(
    session: ClientSession,
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    return (this.options.request ?? apiRequest)<T>(session, path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(5000),
    });
  }
  private update(patch: Partial<MediaUiState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
  }
  private current(epoch: number): boolean {
    return !this.closed && epoch === this.txEpoch;
  }
  private ensure(epoch: number): void {
    if (!this.current(epoch)) throw new Error('Media operation was cancelled.');
  }
  async listen(): Promise<void> {
    if (this.closed || this.listener) return;
    const epoch = ++this.listenEpoch;
    const session = this.session();
    let admitted: MediaSession | undefined;
    let connection: MediaConnection | undefined;
    try {
      admitted = await this.request<MediaSession>(session, 'media/sessions', {
        method: 'POST',
        body: JSON.stringify({ radioId: this.radioId, mode: 'listen' }),
      });
      if (this.closed || epoch !== this.listenEpoch)
        throw new Error('Listening was cancelled.');
      connection = await this.options.port.connect(admitted, () => {
        void this.stop('Listening connection interrupted.');
      });
      if (this.closed || epoch !== this.listenEpoch)
        throw new Error('Listening was cancelled.');
      this.listener = connection;
      this.listenSession = admitted;
      this.update({ listening: true, message: 'Listening to radio audio.' });
      this.listenerRenewal = setInterval(() => {
        void this.request<MediaSession>(
          this.session(),
          `media/sessions/${admitted!.id}/renew`,
          { method: 'POST' },
        ).catch(() => this.stop('Listening authorization expired.'));
      }, 20000);
    } catch (error) {
      await connection?.disconnect().catch(() => undefined);
      if (admitted) await this.removeSession(session, admitted.id);
      if (epoch === this.listenEpoch)
        this.update({
          listening: false,
          message: error instanceof Error ? error.message : 'Listening failed.',
        });
    }
  }
  async startTransmit(): Promise<void> {
    if (this.closed || this.state.pending || this.grant) return;
    const epoch = ++this.txEpoch;
    const session = this.session();
    let mic: Microphone | undefined;
    let grant: TxGrant | undefined;
    let admitted: MediaSession | undefined;
    let connection: MediaConnection | undefined;
    this.update({ pending: true, message: 'Preparing microphone…' });
    try {
      // Request microphone permission before starting the short radio lease.
      mic = await this.options.port.microphone(() => {
        if (this.current(epoch))
          void this.stopTransmit('Microphone interrupted.');
      });
      if (!this.current(epoch)) {
        mic.stop();
        return;
      }
      this.microphone = mic;
      const snapshot = await this.request<RadioSnapshot | null>(
        session,
        `radios/${this.radioId}/state`,
      );
      this.ensure(epoch);
      if (!snapshot) throw new Error('Radio state is unavailable.');
      const control = await this.request<ControlLease>(
        session,
        `radios/${this.radioId}/control`,
        { method: 'POST' },
      );
      this.ensure(epoch);
      const result = await this.request<ClientTxStatus>(
        session,
        `radios/${this.radioId}/tx-sessions`,
        {
          method: 'POST',
          body: JSON.stringify({
            generation: snapshot.generation,
            expectedRevision: snapshot.revision,
            controlGrant: control.grantId,
          }),
        },
      );
      grant = result.grant;
      if (!this.current(epoch)) {
        await this.release(session, grant);
        return;
      }
      this.grant = grant;
      this.heartbeat = setInterval(() => {
        if (this.renewing || !this.current(epoch)) return;
        this.renewing = true;
        void this.request<ControlLease>(
          this.session(),
          `radios/${this.radioId}/control/renew`,
          {
            method: 'POST',
            body: JSON.stringify({
              controlGrant: control.grantId,
              generation: control.generation,
            }),
          },
        )
          .then(() =>
            this.request<ClientTxStatus>(
              this.session(),
              `radios/${this.radioId}/tx-sessions/${grant!.txGrantId}/renew`,
              { method: 'POST' },
            ),
          )
          .then((status) => {
            if (this.current(epoch))
              this.update({
                message:
                  status.state === 'transmitting'
                    ? 'Transmitting — release to stop.'
                    : 'TX audio active; carrier confirmation pending.',
              });
          })
          .catch(() => {
            if (this.current(epoch))
              return this.stopTransmit('Transmission authorization lost.');
            return undefined;
          })
          .finally(() => {
            this.renewing = false;
          });
      }, 250);
      admitted = await this.request<MediaSession>(session, 'media/sessions', {
        method: 'POST',
        body: JSON.stringify({
          radioId: this.radioId,
          mode: 'transmit',
          txGrantId: grant.txGrantId,
        }),
      });
      this.ensure(epoch);
      this.txSession = admitted;
      connection = await this.options.port.connect(admitted, () => {
        void this.stopTransmit('Media connection interrupted.');
      });
      this.ensure(epoch);
      this.txConnection = connection;
      await connection.publish(mic);
      this.ensure(epoch);
      this.update({
        pending: false,
        transmitting: true,
        message: 'TX audio active; carrier confirmation pending.',
      });
    } catch (error) {
      if (this.current(epoch))
        await this.stopTransmit(
          error instanceof Error ? error.message : 'Transmission failed.',
        );
    } finally {
      if (!this.current(epoch)) {
        mic?.stop();
        await connection?.disconnect().catch(() => undefined);
        if (grant) await this.release(session, grant);
        if (admitted) await this.removeSession(session, admitted.id);
      }
    }
  }
  stopTransmit(reason = 'Released.'): Promise<void> {
    ++this.txEpoch;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.renewing = false;
    // These calls run before the first await, including during navigation or blur.
    this.microphone?.stop();
    this.microphone = undefined;
    const connection = this.txConnection,
      grant = this.grant,
      admitted = this.txSession,
      session = this.session();
    this.txConnection = undefined;
    this.grant = undefined;
    this.txSession = undefined;
    this.update({ transmitting: false, pending: false, message: reason });
    return Promise.all([
      connection?.disconnect().catch(() => undefined),
      grant ? this.release(session, grant) : undefined,
      admitted ? this.removeSession(session, admitted.id) : undefined,
    ]).then(() => undefined);
  }
  stop(reason = 'Media stopped.'): Promise<void> {
    ++this.listenEpoch;
    clearInterval(this.listenerRenewal);
    this.listenerRenewal = undefined;
    const listener = this.listener,
      admitted = this.listenSession,
      session = this.session();
    this.listener = undefined;
    this.listenSession = undefined;
    const stopping = this.stopTransmit(reason);
    this.update({ listening: false });
    return Promise.all([
      stopping,
      listener?.disconnect().catch(() => undefined),
      admitted ? this.removeSession(session, admitted.id) : undefined,
    ]).then(() => undefined);
  }
  dispose(): Promise<void> {
    this.closed = true;
    active.delete(this);
    return this.stop('Media context closed.');
  }
  private async release(session: ClientSession, grant: TxGrant): Promise<void> {
    await this.request(
      session,
      `radios/${grant.radioId}/tx-sessions/${grant.txGrantId}`,
      { method: 'DELETE' },
    ).catch(() => undefined);
  }
  private async removeSession(
    session: ClientSession,
    id: string,
  ): Promise<void> {
    await this.request(session, `media/sessions/${id}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
}
