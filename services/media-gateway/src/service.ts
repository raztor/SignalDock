import {
  SignalDockError,
  type AudioFormat,
  type AuthenticationPort,
  type MediaSession,
  type PcmAudioFrame,
  type Principal,
  type TxGrant,
} from '@signaldock/contracts';
import {
  TxSupervisor,
  bounded,
  type TxStartInput,
  type TxStatus,
} from '@signaldock/radio-runtime/tx';
import {
  LiveKitCredentials,
  LiveKitRadioBridge,
  type MediaFrameContext,
  type TuningContextResolver,
} from './livekit.js';
import { decodePreparedAudio, preparedPcmFrames } from './decode-audio.js';

interface EnrolledSession {
  session: MediaSession;
  principal: Principal;
  accessToken: string;
  txGrantId?: string;
}
export interface RadioAudioSource {
  generation: string;
  format: AudioFormat;
  frames(signal: AbortSignal): AsyncIterable<PcmAudioFrame>;
}

export class MediaService {
  readonly bridge: LiveKitRadioBridge;
  private readonly sessions = new Map<string, EnrolledSession>();
  private readonly timer: ReturnType<typeof setInterval>;
  private checking = false;
  private closed = false;
  private readonly pendingAdmissions = new Set<string>();
  private readonly pendingTxParticipants = new Set<string>();
  private readonly preparedSources = new Map<
    string,
    { controller: AbortController; sessionId: string }
  >();
  constructor(
    private readonly options: {
      instanceId: string;
      auth: AuthenticationPort;
      credentials: LiveKitCredentials;
      supervisor: TxSupervisor;
      rxSource: (radioId: string) => RadioAudioSource;
      onFrame?: (frame: PcmAudioFrame, context: MediaFrameContext) => void;
      onError?: (radioId: string, error: unknown) => void;
      resolveTuning?: TuningContextResolver;
    },
  ) {
    this.bridge = new LiveKitRadioBridge({
      instanceId: options.instanceId,
      credentials: options.credentials,
      authorizeParticipant: (radioId, identity) =>
        this.authorizeParticipant(radioId, identity),
      sendTx: (grantId, frame) => options.supervisor.push(grantId, frame),
      stopTx: (grantId, reason) => options.supervisor.stop(grantId, reason),
      invalidateRadio: (radioId, reason) =>
        options.supervisor.invalidateControl(radioId, reason),
      ...(options.onFrame ? { onFrame: options.onFrame } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.resolveTuning
        ? { resolveTuning: options.resolveTuning }
        : {}),
    });
    this.timer = setInterval(() => {
      void this.revalidate();
    }, 2000);
    this.timer.unref?.();
  }

  async createSession(
    principal: Principal,
    accessToken: string,
    input: {
      radioId: string;
      mode: 'listen' | 'transmit';
      txGrantId?: string | undefined;
    },
  ): Promise<MediaSession> {
    if (this.closed)
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        'Media service is shutting down.',
      );
    if (principal.instanceId !== this.options.instanceId)
      throw new SignalDockError(
        'FORBIDDEN',
        'Principal belongs to another instance.',
      );
    if (this.sessions.size + this.pendingAdmissions.size >= 512)
      throw new SignalDockError(
        'TX_LIMIT_REACHED',
        'The media session limit has been reached.',
      );
    await this.options.auth.authorize(
      principal,
      input.mode === 'listen' ? 'radio.listen' : 'radio.transmit',
      input.radioId,
    );
    if (input.mode === 'transmit') {
      if (!input.txGrantId)
        throw new SignalDockError(
          'CONTROL_REQUIRED',
          'Create a TX grant before requesting microphone credentials.',
        );
      const status = this.options.supervisor.get(
        input.txGrantId,
        principal.userId,
        principal.sessionId,
      );
      if (
        status.grant.radioId !== input.radioId ||
        !['granted', 'transmitting', 'tx_unconfirmed'].includes(status.state) ||
        status.grant.expiresAt <= Date.now()
      )
        throw new SignalDockError(
          'CONTROL_REQUIRED',
          'A current matching TX grant is required.',
        );
      if (
        this.pendingTxParticipants.has(input.txGrantId) ||
        [...this.sessions.values()].some(
          (entry) => entry.txGrantId === input.txGrantId,
        )
      )
        throw new SignalDockError(
          'CONTROL_BUSY',
          'This TX grant already has a media participant.',
        );
    }
    const admissionId = crypto.randomUUID();
    this.pendingAdmissions.add(admissionId);
    if (input.mode === 'transmit' && input.txGrantId)
      this.pendingTxParticipants.add(input.txGrantId);
    try {
      await this.attachRadio(input.radioId);
      if (input.mode === 'transmit' && input.txGrantId) {
        const current = this.options.supervisor.get(
          input.txGrantId,
          principal.userId,
          principal.sessionId,
        );
        if (
          !['granted', 'transmitting', 'tx_unconfirmed'].includes(
            current.state,
          ) ||
          current.grant.expiresAt <= Date.now()
        )
          throw new SignalDockError(
            'DEADLINE_EXCEEDED',
            'TX admission expired while opening the radio bridge.',
          );
      }
      const session = await this.options.credentials.issue({
        id: admissionId,
        instanceId: principal.instanceId,
        radioId: input.radioId,
        sessionId: principal.sessionId,
        mode: input.mode,
      });
      this.sessions.set(session.id, {
        session,
        principal,
        accessToken,
        ...(input.txGrantId ? { txGrantId: input.txGrantId } : {}),
      });
      return session;
    } finally {
      this.pendingAdmissions.delete(admissionId);
      if (input.txGrantId) this.pendingTxParticipants.delete(input.txGrantId);
    }
  }

  async renewSession(
    id: string,
    principal: Principal,
    accessToken: string,
  ): Promise<MediaSession> {
    const entry = this.requireSession(id, principal);
    await this.options.auth.authorize(
      principal,
      entry.session.mode === 'listen' ? 'radio.listen' : 'radio.transmit',
      entry.session.radioId,
    );
    const session = await this.options.credentials.issue({
      id: entry.session.id,
      instanceId: principal.instanceId,
      radioId: entry.session.radioId,
      sessionId: principal.sessionId,
      mode: entry.session.mode,
    });
    entry.session = session;
    entry.principal = principal;
    entry.accessToken = accessToken;
    return session;
  }

  async removeSession(id: string, principal: Principal): Promise<void> {
    const entry = this.requireSession(id, principal);
    await this.remove(entry);
  }
  async attachRadio(radioId: string): Promise<void> {
    const source = this.options.rxSource(radioId);
    await this.bridge.attachRadio({
      radioId,
      generation: source.generation,
      format: source.format,
      frames: (signal) => source.frames(signal),
    });
  }
  startTx(
    principal: Principal,
    input: Omit<TxStartInput, 'ownerId' | 'sessionId' | 'instanceId'>,
  ): Promise<TxStatus> {
    if (principal.instanceId !== this.options.instanceId)
      return Promise.reject(
        new SignalDockError(
          'FORBIDDEN',
          'Principal belongs to another instance.',
        ),
      );
    return this.options.auth
      .authorize(principal, 'radio.transmit', input.radioId)
      .then(() =>
        this.options.supervisor.start(
          {
            ...input,
            ownerId: principal.userId,
            sessionId: principal.sessionId,
            instanceId: principal.instanceId,
          },
          { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
        ),
      );
  }
  async renewTx(id: string, principal: Principal): Promise<TxStatus> {
    const status = this.options.supervisor.get(
      id,
      principal.userId,
      principal.sessionId,
    );
    await this.options.auth.authorize(
      principal,
      'radio.transmit',
      status.grant.radioId,
    );
    return this.options.supervisor.renew(
      id,
      principal.userId,
      principal.sessionId,
    );
  }
  async stopTx(
    id: string,
    principal: Principal,
    reason = 'released',
  ): Promise<TxStatus> {
    this.options.supervisor.get(id, principal.userId, principal.sessionId);
    this.preparedSources.get(id)?.controller.abort(new Error(reason));
    return this.options.supervisor.stop(id, reason);
  }
  txStatus(id: string, principal: Principal): TxStatus {
    return this.options.supervisor.get(
      id,
      principal.userId,
      principal.sessionId,
    );
  }
  async revokeSession(sessionId: string): Promise<void> {
    for (const source of this.preparedSources.values()) {
      if (source.sessionId === sessionId)
        source.controller.abort(new Error('Session revoked.'));
    }
    await this.options.supervisor.revokeSession(sessionId);
    await Promise.all(
      [...this.sessions.values()]
        .filter((entry) => entry.principal.sessionId === sessionId)
        .map((entry) => this.remove(entry)),
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const source of this.preparedSources.values())
      source.controller.abort(new Error('Media shutdown.'));
    await this.options.supervisor.close();
    await Promise.all(
      [...this.sessions.values()].map((entry) => this.remove(entry)),
    );
    await this.bridge.close();
  }
  async transmitEncodedAudio(
    principal: Principal,
    input: Omit<
      TxStartInput,
      'ownerId' | 'sessionId' | 'instanceId' | 'source'
    >,
    artifact: { bytes: Uint8Array; contentType: string },
    signal: AbortSignal,
    validateBeforeTransmit?: () => Promise<void>,
  ): Promise<TxStatus> {
    if (principal.instanceId !== this.options.instanceId)
      throw new SignalDockError(
        'FORBIDDEN',
        'Principal belongs to another instance.',
      );
    await this.options.auth.authorize(
      principal,
      'radio.transmit',
      input.radioId,
    );
    const pcm = await decodePreparedAudio(artifact, signal);
    return this.transmitAudio(
      principal,
      input,
      (transmitSignal) =>
        preparedPcmFrames(pcm, input.expectedRevision, transmitSignal),
      signal,
      validateBeforeTransmit,
    );
  }
  async transmitAudio(
    principal: Principal,
    input: Omit<
      TxStartInput,
      'ownerId' | 'sessionId' | 'instanceId' | 'source'
    >,
    frames: (signal: AbortSignal) => AsyncIterable<PcmAudioFrame>,
    signal: AbortSignal,
    validateBeforeTransmit?: () => Promise<void>,
  ): Promise<TxStatus> {
    if (principal.instanceId !== this.options.instanceId)
      throw new SignalDockError(
        'FORBIDDEN',
        'Principal belongs to another instance.',
      );
    await this.options.auth.authorize(
      principal,
      'radio.transmit',
      input.radioId,
    );
    signal.throwIfAborted();
    await validateBeforeTransmit?.();
    signal.throwIfAborted();
    const tx = await this.options.supervisor.start(
      {
        ...input,
        ownerId: principal.userId,
        sessionId: principal.sessionId,
        instanceId: principal.instanceId,
        source: 'tts',
      },
      { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
    );
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.preparedSources.set(tx.grant.txGrantId, {
      controller,
      sessionId: principal.sessionId,
    });
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.renewTx(tx.grant.txGrantId, principal)
        .catch((error: unknown) => controller.abort(error))
        .finally(() => {
          renewing = false;
        });
    }, 250);
    let iterator: AsyncIterator<PcmAudioFrame> | undefined;
    try {
      iterator = frames(combined)[Symbol.asyncIterator]();
      while (true) {
        const remaining = tx.grant.maxUntil - Date.now();
        if (remaining <= 0)
          throw new SignalDockError(
            'DEADLINE_EXCEEDED',
            'Prepared TX reached its deadline.',
          );
        const next = await bounded(
          Promise.resolve(iterator.next()),
          combined,
          Math.min(remaining, 1500),
        );
        if (next.done) break;
        await this.options.supervisor.push(tx.grant.txGrantId, next.value);
      }
      return await this.options.supervisor.stop(
        tx.grant.txGrantId,
        'prepared_audio_complete',
      );
    } finally {
      clearInterval(renewal);
      controller.abort();
      this.preparedSources.delete(tx.grant.txGrantId);
      void Promise.resolve(iterator?.return?.()).catch(() => undefined);
      await this.options.supervisor.stop(
        tx.grant.txGrantId,
        'prepared_audio_finished',
      );
    }
  }

  private authorizeParticipant(
    radioId: string,
    identity: string,
  ): TxGrant | undefined {
    const entry = [...this.sessions.values()].find(
      (item) =>
        item.session.radioId === radioId &&
        item.session.participantIdentity === identity,
    );
    if (!entry?.txGrantId || Date.parse(entry.session.expiresAt) <= Date.now())
      return undefined;
    try {
      const status = this.options.supervisor.get(
        entry.txGrantId,
        entry.principal.userId,
        entry.principal.sessionId,
      );
      return ['granted', 'transmitting', 'tx_unconfirmed'].includes(
        status.state,
      ) && status.grant.expiresAt > Date.now()
        ? status.grant
        : undefined;
    } catch {
      return undefined;
    }
  }
  private requireSession(id: string, principal: Principal): EnrolledSession {
    const entry = this.sessions.get(id);
    if (!entry)
      throw new SignalDockError('NOT_FOUND', 'Unknown media session.');
    if (
      entry.principal.instanceId !== principal.instanceId ||
      entry.principal.sessionId !== principal.sessionId ||
      entry.principal.userId !== principal.userId
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'Media session belongs to another account/session.',
      );
    return entry;
  }
  private async remove(entry: EnrolledSession): Promise<void> {
    this.sessions.delete(entry.session.id);
    if (entry.txGrantId)
      await this.options.supervisor.stop(
        entry.txGrantId,
        'media_session_closed',
      );
    await bounded(
      this.options.credentials.revoke(entry.session),
      undefined,
      2500,
    ).catch(() => undefined);
  }
  private async revalidate(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await Promise.all(
        [...this.sessions.values()].map(async (entry) => {
          try {
            const principal = await bounded(
              this.options.auth.authenticate(entry.accessToken),
              undefined,
              2000,
            );
            if (
              principal.instanceId !== entry.principal.instanceId ||
              principal.sessionId !== entry.principal.sessionId ||
              principal.userId !== entry.principal.userId
            )
              throw new SignalDockError(
                'UNAUTHORIZED',
                'Media identity changed.',
              );
            await bounded(
              this.options.auth.authorize(
                principal,
                entry.session.mode === 'listen'
                  ? 'radio.listen'
                  : 'radio.transmit',
                entry.session.radioId,
              ),
              undefined,
              2000,
            );
            if (Date.parse(entry.session.expiresAt) <= Date.now())
              await this.remove(entry);
          } catch {
            await this.remove(entry);
          }
        }),
      );
    } finally {
      this.checking = false;
    }
  }
}
