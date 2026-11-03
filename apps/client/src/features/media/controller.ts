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
  /** Received audio level in 0..1, when the port can measure it (web only). */
  level?(): number;
}
export interface BrowserMediaPort {
  microphone(onInterrupted: () => void): Promise<Microphone>;
  connect(
    session: MediaSession,
    onInterrupted: () => void,
    signal: AbortSignal,
  ): Promise<MediaConnection>;
}
export interface MediaUiState {
  listening: boolean;
  transmitting: boolean;
  pending: boolean;
  message: string;
}
/**
 * Coordination with the workspace's own control lease (StationProvider). When
 * given, the controller reports every control grant it obtains and releases a
 * lease it created for a transmission (one the station did not hold) when that
 * transmission stops.
 */
export interface MediaControlLink {
  /** Grant ID of the station's current lease for this radio, if any. */
  held(): string | undefined;
  /** Called with every control grant this controller obtains. */
  acquired?(grantId: string): void;
}
type Api = <T>(
  session: ClientSession,
  path: string,
  init?: RequestInit,
) => Promise<T>;
/** Message of a transmission ended by the operator's own release. */
export const TX_RELEASED_MESSAGE = 'Released.';
const active = new Set<RadioMediaController>();
export interface MediaScope {
  instanceId?: string;
  radioId?: string;
}
function inScope(controller: RadioMediaController, scope?: MediaScope) {
  return (
    (!scope?.instanceId || controller.instanceId === scope.instanceId) &&
    (!scope?.radioId || controller.radioId === scope.radioId)
  );
}

/** Called before accepting a new server, radio, account, or application route. */
export async function stopActiveMedia(
  reason: string,
  scope?: MediaScope,
): Promise<void> {
  const matching = [...active].filter((item) => inScope(item, scope));
  // stop() invalidates pending operations and stops microphone tracks synchronously.
  await Promise.all(matching.map((controller) => controller.stop(reason)));
}

/**
 * Stops transmission (pending or active) on matching controllers while keeping
 * listening sessions open. Used for in-workspace navigation.
 */
export async function stopActiveTransmit(
  reason: string,
  scope?: MediaScope,
): Promise<void> {
  const matching = [...active].filter((item) => inScope(item, scope));
  // stopTransmit() stops microphone tracks before its first await.
  await Promise.all(
    matching.map((controller) => controller.stopTransmit(reason)),
  );
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
  private txAbort: AbortController | undefined;
  private listenAbort: AbortController | undefined;
  /** Control lease this controller created for the current transmission. */
  private ownedControl: ControlLease | undefined;
  /** Release of a previous transmission's control lease, still in flight. */
  private controlRelease: Promise<void> = Promise.resolve();
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
      control?: MediaControlLink;
    },
  ) {
    this.initialSession = options.session();
    this.instanceId = this.initialSession.instanceId;
    active.add(this);
  }
  get radioId(): string {
    return this.options.radioId;
  }
  /** True while listening through a connection that can measure audio level. */
  get rxLevelSupported(): boolean {
    return typeof this.listener?.level === 'function';
  }
  /** Received audio level in 0..1; 0 when not listening or unmeasurable. */
  rxLevel(): number {
    const listener = this.listener;
    if (this.closed || !listener?.level) return 0;
    try {
      const value = listener.level();
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    } catch {
      return 0;
    }
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
  /** Applies a state patch; emits only when a field actually changes. */
  private update(patch: Partial<MediaUiState>): void {
    const keys = Object.keys(patch) as (keyof MediaUiState)[];
    if (keys.every((key) => patch[key] === this.state[key])) return;
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
    if (this.closed || this.listener || this.listenAbort) return;
    const cancellation = new AbortController();
    this.listenAbort = cancellation;
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
      connection = await this.options.port.connect(
        admitted,
        () => {
          void this.stop('Listening connection interrupted.');
        },
        cancellation.signal,
      );
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
      if (epoch === this.listenEpoch) this.listenAbort = undefined;
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
    const cancellation = new AbortController();
    this.txAbort = cancellation;
    const session = this.session();
    let mic: Microphone | undefined;
    let grant: TxGrant | undefined;
    let admitted: MediaSession | undefined;
    let connection: MediaConnection | undefined;
    let ownedControl: ControlLease | undefined;
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
      // The server returns the same grant to the same session: never let a
      // previous press's release race this press's acquisition.
      await this.controlRelease;
      this.ensure(epoch);
      const link = this.options.control;
      const heldBefore = link?.held();
      const control = await this.request<ControlLease>(
        session,
        `radios/${this.radioId}/control`,
        { method: 'POST' },
      );
      link?.acquired?.(control.grantId);
      if (link && control.grantId !== heldBefore) {
        ownedControl = control;
        this.ownedControl = control;
      }
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
      connection = await this.options.port.connect(
        admitted,
        () => {
          void this.stopTransmit('Media connection interrupted.');
        },
        cancellation.signal,
      );
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
        // A lease obtained after this press was cancelled: release it unless a
        // newer press is already using the same grant.
        if (
          ownedControl &&
          this.ownedControl === ownedControl &&
          !this.state.pending &&
          !this.state.transmitting
        ) {
          this.ownedControl = undefined;
          await this.releaseOwnedControl(session, ownedControl);
        }
      }
    }
  }
  stopTransmit(reason = TX_RELEASED_MESSAGE): Promise<void> {
    // Idle calls (blur, navigation, unmount) must not hide an earlier message.
    const wasActive =
      this.state.pending ||
      this.state.transmitting ||
      Boolean(
        this.txAbort ||
        this.grant ||
        this.microphone ||
        this.txConnection ||
        this.txSession,
      );
    ++this.txEpoch;
    this.txAbort?.abort();
    this.txAbort = undefined;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.renewing = false;
    // These calls run before the first await, including during navigation or blur.
    this.microphone?.stop();
    this.microphone = undefined;
    const connection = this.txConnection,
      grant = this.grant,
      admitted = this.txSession,
      owned = this.ownedControl,
      session = this.session();
    this.txConnection = undefined;
    this.grant = undefined;
    this.txSession = undefined;
    this.ownedControl = undefined;
    this.update({
      transmitting: false,
      pending: false,
      ...(wasActive ? { message: reason } : {}),
    });
    const releasing = Promise.all([
      connection?.disconnect().catch(() => undefined),
      grant ? this.release(session, grant) : undefined,
      admitted ? this.removeSession(session, admitted.id) : undefined,
    ]).then(() =>
      owned ? this.releaseOwnedControl(session, owned) : undefined,
    );
    if (owned) this.controlRelease = releasing.catch(() => undefined);
    return releasing;
  }
  stop(reason = 'Media stopped.'): Promise<void> {
    ++this.listenEpoch;
    this.listenAbort?.abort();
    this.listenAbort = undefined;
    clearInterval(this.listenerRenewal);
    this.listenerRenewal = undefined;
    const listener = this.listener,
      admitted = this.listenSession,
      session = this.session();
    this.listener = undefined;
    this.listenSession = undefined;
    const stopping = this.stopTransmit(reason);
    this.update({ listening: false, message: reason });
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
      { ...session, onUnauthorized: () => undefined },
      `radios/${grant.radioId}/tx-sessions/${grant.txGrantId}`,
      { method: 'DELETE' },
    ).catch(() => undefined);
  }
  /** Releases a lease this controller created, unless the station adopted it. */
  private async releaseOwnedControl(
    session: ClientSession,
    lease: ControlLease,
  ): Promise<void> {
    if (this.options.control?.held() === lease.grantId) return;
    await this.request(
      { ...session, onUnauthorized: () => undefined },
      `radios/${this.radioId}/control`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          controlGrant: lease.grantId,
          generation: lease.generation,
        }),
      },
    ).catch(() => undefined);
  }
  private async removeSession(
    session: ClientSession,
    id: string,
  ): Promise<void> {
    await this.request(
      { ...session, onUnauthorized: () => undefined },
      `media/sessions/${id}`,
      {
        method: 'DELETE',
      },
    ).catch(() => undefined);
  }
}
