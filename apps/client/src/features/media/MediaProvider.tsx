import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import { useStation } from '../station/StationProvider';
import { browserMediaPort } from './browser-port';
import { RadioMediaController, type MediaUiState } from './controller';
import { mediaAccess, type MediaAccess } from './media-access';

/** Client-side cap for one transmission; the backend enforces its own limit. */
export const TX_LIMIT_MS = 30_000;
const TX_LIMIT_MESSAGE = 'Transmission stopped at the 30-second limit.';

export interface RadioMediaContextValue {
  state: MediaUiState;
  access: MediaAccess;
  /** Live audio is configured on the server and this platform supports it. */
  available: boolean;
  /** The server advertises live audio (`features.liveAudio`). */
  configured: boolean;
  /** This platform can run live audio (web only for now). */
  supported: boolean;
  listen(): void;
  stopListening(): void;
  startTransmit(): void;
  stopTransmit(reason?: string): void;
  /** Epoch ms when the current press started (pending or transmitting). */
  txStartedAt?: number;
  /** Received audio level 0..1; present only while listening on a measurable connection. */
  rxLevel?: () => number;
}

export interface MediaProviderProps {
  /** `serverInfo.features.liveAudio`. */
  mediaAvailable: boolean;
  children: ReactNode;
}

const idleMediaState: MediaUiState = {
  listening: false,
  transmitting: false,
  pending: false,
  message: 'Ready. Select Listen to enable audio.',
};

const MediaContext = createContext<RadioMediaContextValue | null>(null);

/** Live audio for the selected radio. Must be used inside `MediaProvider`. */
export function useRadioMedia(): RadioMediaContextValue {
  const value = useContext(MediaContext);
  if (!value)
    throw new Error('useRadioMedia must be used inside MediaProvider.');
  return value;
}

/**
 * One `RadioMediaController` for the workspace's selected radio. It is
 * recreated on radio, server or account change; TX stops on app background,
 * window blur, hidden page, pointer cancel and after 30 seconds. Must be
 * rendered inside `StationProvider`.
 */
export function MediaProvider({
  mediaAvailable,
  children,
}: MediaProviderProps) {
  const { session, radioId, selected, loaded, error, lease, noteControlGrant } =
    useStation();
  const latest = useRef(session);
  latest.current = session;
  /** The station's lease, so TX never releases a lease the station holds. */
  const stationGrant = useRef<string | undefined>(undefined);
  stationGrant.current =
    lease && lease.radioId === radioId ? lease.grantId : undefined;
  const noteGrant = useRef(noteControlGrant);
  noteGrant.current = noteControlGrant;
  const controller = useRef<RadioMediaController | undefined>(undefined);
  const supported = Platform.OS === 'web';
  const enabled = mediaAvailable && supported;
  const contextKey = `${session.baseUrl}\0${session.instanceId}\0${session.user.id}\0${radioId ?? ''}\0${enabled}`;
  const [status, setStatus] = useState({
    key: contextKey,
    value: idleMediaState,
  });
  const state =
    status.key === contextKey && enabled ? status.value : idleMediaState;
  const active = state.pending || state.transmitting;
  const radioError =
    error ||
    (loaded && radioId && !selected
      ? 'The selected radio is unavailable.'
      : '');
  const access = mediaAccess({
    mediaAvailable,
    radio: selected ?? null,
    user: session.user,
    radioId: radioId ?? '',
    activeTx: active,
    radioError: radioError || undefined,
  });
  const accessRef = useRef(access);
  accessRef.current = access;
  /** Latest controller state, updated synchronously from `onState`. */
  const latestState = useRef<MediaUiState>(idleMediaState);
  /** Start of the current press, for the client-side 30 s limit. */
  const pressStartedAt = useRef<number | undefined>(undefined);
  const [txCycle, setTxCycle] = useState(0);
  const [txStartedAt, setTxStartedAt] = useState<number>();

  useEffect(() => {
    if (!radioId || !enabled) return;
    setStatus({ key: contextKey, value: idleMediaState });
    latestState.current = idleMediaState;
    pressStartedAt.current = undefined;
    let mounted = true;
    const media = new RadioMediaController({
      session: () => latest.current,
      radioId,
      port: browserMediaPort,
      onState: (next) => {
        if (!mounted) return;
        latestState.current = next;
        setStatus({ key: contextKey, value: next });
      },
      control: {
        held: () => stationGrant.current,
        acquired: (grantId) => noteGrant.current(grantId),
      },
    });
    controller.current = media;
    const stop = () => {
      void media.stopTransmit('Transmission interrupted.');
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') stop();
    });
    if (Platform.OS === 'web') {
      window.addEventListener('blur', stop);
      document.addEventListener('visibilitychange', hidden);
      window.addEventListener('pointercancel', stop);
    }
    return () => {
      mounted = false;
      if (controller.current === media) controller.current = undefined;
      subscription.remove();
      if (Platform.OS === 'web') {
        window.removeEventListener('blur', stop);
        document.removeEventListener('visibilitychange', hidden);
        window.removeEventListener('pointercancel', stop);
      }
      void media.dispose();
    };
    // contextKey covers session identity, radio and availability.
  }, [contextKey]);

  // Stop media the account or radio no longer allows.
  useEffect(() => {
    if (!access.canListen && state.listening)
      void controller.current?.stop(access.listenReason);
    else if (!access.canTransmit && active)
      void controller.current?.stopTransmit(access.transmitReason);
  }, [
    access.canListen,
    access.canTransmit,
    access.listenReason,
    access.transmitReason,
    state.listening,
    active,
  ]);

  // Client-side 30 s limit, counted from the press. Never auto-resumes.
  useEffect(() => {
    if (!active) {
      pressStartedAt.current = undefined;
      setTxStartedAt(undefined);
      return;
    }
    const started = pressStartedAt.current ?? Date.now();
    pressStartedAt.current = started;
    setTxStartedAt(started);
    const timer = setTimeout(
      () => {
        void controller.current?.stopTransmit(TX_LIMIT_MESSAGE);
      },
      Math.max(0, started + TX_LIMIT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [active, txCycle]);

  const listen = useCallback(() => {
    if (accessRef.current.canListen) void controller.current?.listen();
  }, []);
  const stopListening = useCallback(() => {
    void controller.current?.stop('Listening stopped.');
  }, []);
  const startTransmit = useCallback(() => {
    const media = controller.current;
    if (!accessRef.current.canTransmit || !media) return;
    const current = latestState.current;
    // A new press while idle starts a new 30 s window; repeats are ignored.
    if (!current.pending && !current.transmitting) {
      pressStartedAt.current = Date.now();
      setTxCycle((cycle) => cycle + 1);
    }
    void media.startTransmit();
  }, []);
  const stopTransmit = useCallback((reason?: string) => {
    void controller.current?.stopTransmit(reason);
  }, []);
  const media = controller.current;
  const levelSupported = Boolean(state.listening && media?.rxLevelSupported);
  const rxLevel = useMemo(
    () => (levelSupported && media ? () => media.rxLevel() : undefined),
    [levelSupported, media],
  );

  const value = useMemo<RadioMediaContextValue>(
    () => ({
      state,
      access,
      available: enabled,
      configured: mediaAvailable,
      supported,
      listen,
      stopListening,
      startTransmit,
      stopTransmit,
      ...(txStartedAt === undefined ? {} : { txStartedAt }),
      ...(rxLevel ? { rxLevel } : {}),
    }),
    [
      state,
      access.canListen,
      access.canTransmit,
      access.listenReason,
      access.transmitReason,
      enabled,
      mediaAvailable,
      supported,
      listen,
      stopListening,
      startTransmit,
      stopTransmit,
      txStartedAt,
      rxLevel,
    ],
  );
  return (
    <MediaContext.Provider value={value}>{children}</MediaContext.Provider>
  );
}
