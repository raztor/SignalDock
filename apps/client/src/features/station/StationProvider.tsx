import { apiRequest, subscribeStationEvents } from '@signaldock/client-sdk';
import {
  ControlLeaseSchema,
  RadioMemorySchema,
  RadioSnapshotSchema,
  RadioViewSchema,
  type ClientSession,
  type ControlLease,
  type DomainEvent,
  type OperationContext,
  type RadioMemory,
  type RadioSnapshot,
  type RadioView,
  type Tuning,
} from '@signaldock/contracts';
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
import { Platform } from 'react-native';
import { operationId } from '../radios/radio-input';
import {
  controlPresentation,
  formatFrequency,
  formatRange,
  formatTuning,
  isInRanges,
  memoriesFetchKey,
  mergeRadioList,
  mergeRadioSnapshot,
  preserveIdentity,
  sameLease,
  sameTuning,
  withOwnLease,
  type ControlPresentation,
  type ControlState,
} from './station-model';

export type { ControlState };
export type StationOperationResult =
  { ok: true; message: string } | { ok: false; error: string };

export interface StationContextValue {
  session: ClientSession;
  radioId: string | undefined;
  /** Radios visible to this account, validated with `RadioViewSchema`. */
  radios: RadioView[];
  loaded: boolean;
  /** Radio list error (cleared by the next successful refresh). */
  error: string;
  /**
   * The last radio list refresh failed or timed out, so `radios` (and
   * `selected`) may be stale. Live audio treats the radio as unavailable.
   */
  listStale: boolean;
  selected: RadioView | undefined;
  /** True while the station event stream is connected (web only). */
  liveUpdates: boolean;
  /**
   * Asks the workspace to select a radio. Selection never retunes it.
   * Resolves false when the workspace skipped the request (busy).
   */
  selectRadio(radioId: string): Promise<boolean>;
  refresh(): void;

  lease: ControlLease | null;
  /** Who holds control of the selected radio (label, tone and icon). */
  control: ControlPresentation;
  controlState: ControlState;
  controlOwnerLabel: string;
  /** The account has `radio.control` for the selected radio. */
  canControl: boolean;
  takeControl(): Promise<StationOperationResult>;
  releaseControl(): Promise<StationOperationResult>;
  /**
   * Records a control grant this client obtained outside `takeControl` (for
   * example the short lease live audio takes for a transmission), so a lease
   * left on the server is not shown as another session's.
   */
  noteControlGrant(grantId: string): void;
  /** Recent control grant IDs this client obtained (newest last). */
  ownControlGrants: readonly string[];

  memories: RadioMemory[];
  memoriesLoaded: boolean;
  memoriesError: string;
  tune(tuning: Tuning): Promise<StationOperationResult>;
  recallMemory(memoryId: string): Promise<StationOperationResult>;
  storeMemory(
    memoryId: string,
    tuning: Tuning,
  ): Promise<StationOperationResult>;
  busy: boolean;
  operationError: string;
  clearOperationError(): void;
  /** Lease held, radio ready and idle, and no operation in flight. */
  editable: boolean;
}

export interface StationProviderProps {
  session: ClientSession;
  radioId?: string;
  /**
   * Workspace radio selection (it stops media before switching). Resolves
   * false when the request was skipped.
   */
  onSelectRadio?: (radioId: string) => Promise<boolean>;
  children: ReactNode;
}

const StationContext = createContext<StationContextValue | null>(null);

/** Station state for the workspace. Must be used inside `StationProvider`. */
export function useStation(): StationContextValue {
  const value = useContext(StationContext);
  if (!value)
    throw new Error('useStation must be used inside StationProvider.');
  return value;
}

const LIST_TIMEOUT_MS = 10_000;
const POLL_MS = 2_000;
const STREAM_REFRESH_MS = 10_000;
const RENEW_MS = 5_000;
const EVENT_REFRESH_DELAY_MS = 300;
/**
 * The server sends `: heartbeat` every 2 s. A stream with no frame for this
 * long is treated as stalled and reconnected.
 */
const STREAM_STALL_MS = 7_000;
const STREAM_WATCHDOG_MS = 1_000;
const STREAM_BACKOFF_MIN_MS = 1_000;
const STREAM_BACKOFF_MAX_MS = 30_000;
const STREAM_UNSUPPORTED = 'This client cannot stream station events.';
/** How many recent own grant IDs are remembered. */
const OWN_GRANTS_MAX = 16;
/** Shared empty list, so clearing memories does not change identity. */
const NO_MEMORIES: RadioMemory[] = [];

/**
 * Owns the radio list, live updates, the selected radio's control lease and
 * radio operations for one workspace (server + instance + account). The lease
 * survives section navigation; it is released when the radio changes or the
 * provider unmounts.
 */
export function StationProvider({
  session,
  radioId,
  onSelectRadio,
  children,
}: StationProviderProps) {
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const radioIdRef = useRef(radioId);
  radioIdRef.current = radioId;
  const onSelectRef = useRef(onSelectRadio);
  onSelectRef.current = onSelectRadio;
  const sessionKey = `${session.baseUrl}\0${session.instanceId}\0${session.user.id}`;

  const [radios, setRadios] = useState<RadioView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [listStale, setListStale] = useState(false);
  const [liveUpdates, setLiveUpdates] = useState(false);
  const [lease, setLease] = useState<ControlLease | null>(null);
  const [memories, setMemories] = useState<RadioMemory[]>(NO_MEMORIES);
  const [memoriesLoaded, setMemoriesLoaded] = useState(false);
  const [memoriesError, setMemoriesError] = useState('');
  const [busy, setBusyState] = useState(false);
  const [operationError, setOperationError] = useState('');
  /**
   * Control grants this client obtained recently (station leases and live
   * audio's own). Grant IDs, not session or owner IDs: two tabs share a
   * session and must still see each other's live lease as someone else's.
   */
  const [ownControlGrants, setOwnControlGrants] = useState<string[]>([]);
  const noteControlGrant = useCallback((grantId: string) => {
    setOwnControlGrants((previous) =>
      previous.includes(grantId)
        ? previous
        : [...previous, grantId].slice(-OWN_GRANTS_MAX),
    );
  }, []);

  const leaseRef = useRef<ControlLease | null>(null);
  const busyRef = useRef(false);
  const memoriesRef = useRef<RadioMemory[]>([]);
  memoriesRef.current = memories;
  const radiosRef = useRef<RadioView[]>([]);
  radiosRef.current = radios;
  /** Radio list + event stream epoch (per workspace). */
  const listEpoch = useRef(0);
  /** Lease + operation epoch (per selected radio). */
  const epoch = useRef(0);
  const refreshRef = useRef<() => void>(() => undefined);

  const selected = radios.find((radio) => radio.radioId === radioId);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  }, []);
  const rememberLease = useCallback(
    (value: ControlLease | null) => {
      leaseRef.current = value;
      setLease(value);
      if (value) noteControlGrant(value.grantId);
      // Keep the radio's control view in step with our own lease.
      if (value) setRadios((previous) => withOwnLease(previous, value));
    },
    [noteControlGrant],
  );
  const applySnapshot = useCallback((snapshot: RadioSnapshot) => {
    setRadios((previous) => mergeRadioSnapshot(previous, snapshot));
    const held = leaseRef.current;
    if (
      held &&
      held.radioId === snapshot.radioId &&
      held.generation !== snapshot.generation
    ) {
      leaseRef.current = null;
      setLease(null);
    }
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Radio list, live events and polling                                    */
  /* ---------------------------------------------------------------------- */
  useEffect(() => {
    const version = ++listEpoch.current;
    const controller = new AbortController();
    const { signal } = controller;
    setRadios([]);
    setLoaded(false);
    setError('');
    setListStale(false);
    setLiveUpdates(false);
    let loading = false;
    let queued = false;
    let lastRefresh = 0;
    let streamHealthy = false;
    let coalesce: ReturnType<typeof setTimeout> | undefined;
    const current = () => listEpoch.current === version && !signal.aborted;

    async function refresh(): Promise<void> {
      if (!current()) return;
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      lastRefresh = Date.now();
      // A lease taken after this request started must not be judged by it.
      const leaseAtStart = leaseRef.current?.grantId;
      const request = childSignal(signal, LIST_TIMEOUT_MS);
      try {
        const result = await apiRequest<unknown>(sessionRef.current, 'radios', {
          signal: request.signal,
        });
        if (!current()) return;
        const parsed = parseRadioList(result);
        const ownGrant = leaseRef.current?.grantId;
        setRadios((previous) =>
          mergeRadioList(previous, parsed.radios, ownGrant),
        );
        setLoaded(true);
        setError(parsed.error);
        setListStale(false);
        const held = leaseRef.current;
        if (held && held.grantId === leaseAtStart) {
          const radio = parsed.radios.find(
            (item) => item.radioId === held.radioId,
          );
          if (
            held.generation !== radio?.snapshot?.generation ||
            radio?.control?.grantId !== held.grantId
          ) {
            leaseRef.current = null;
            setLease(null);
          }
        }
      } catch (failure) {
        if (current()) {
          setError(
            request.signal.aborted
              ? 'The station did not respond in time.'
              : message(failure, 'Station radios are unavailable.'),
          );
          // The kept list may no longer match the radios: fail safe.
          setListStale(true);
        }
      } finally {
        request.done();
        loading = false;
        if (queued && current()) {
          queued = false;
          void refresh();
        }
      }
    }
    const scheduleRefresh = () => {
      if (coalesce || !current()) return;
      coalesce = setTimeout(() => {
        coalesce = undefined;
        void refresh();
      }, EVENT_REFRESH_DELAY_MS);
    };
    refreshRef.current = () => void refresh();
    void refresh();
    const timer = setInterval(() => {
      if (!streamHealthy || Date.now() - lastRefresh >= STREAM_REFRESH_MS)
        void refresh();
    }, POLL_MS);

    const markHealthy = () => {
      if (streamHealthy || !current()) return;
      streamHealthy = true;
      setLiveUpdates(true);
      // Catch up on anything missed while the stream was down.
      scheduleRefresh();
    };
    const markUnhealthy = () => {
      if (!streamHealthy) return;
      streamHealthy = false;
      if (current()) setLiveUpdates(false);
    };
    const onEvent = (event: DomainEvent) => {
      if (!current()) return;
      markHealthy();
      if (event.type === 'radio.snapshot') {
        const parsed = RadioSnapshotSchema.safeParse(event.payload);
        if (
          !parsed.success ||
          (event.radioId !== undefined && event.radioId !== parsed.data.radioId)
        ) {
          scheduleRefresh();
          return;
        }
        applySnapshot(parsed.data);
        if (
          !radiosRef.current.some(
            (radio) => radio.radioId === parsed.data.radioId,
          )
        )
          scheduleRefresh();
        return;
      }
      // Control and health are not part of snapshots.
      if (event.type.startsWith('radio.') || event.type.startsWith('control.'))
        scheduleRefresh();
    };
    async function stream(): Promise<void> {
      let delay = STREAM_BACKOFF_MIN_MS;
      while (current()) {
        // Healthy only once frames (the server's `: connected` comment and
        // heartbeats) actually arrive; a silent stream is aborted and retried.
        const attempt = childSignal(signal);
        let lastFrame = Date.now();
        let framed = false;
        const watchdog = setInterval(() => {
          if (Date.now() - lastFrame < STREAM_STALL_MS) return;
          markUnhealthy();
          attempt.abort();
        }, STREAM_WATCHDOG_MS);
        try {
          await subscribeStationEvents(
            sessionRef.current,
            onEvent,
            attempt.signal,
            {
              onOpen: () => {
                lastFrame = Date.now();
              },
              onFrame: () => {
                lastFrame = Date.now();
                framed = true;
                markHealthy();
              },
            },
          );
        } catch (failure) {
          if (!current()) return;
          if (
            failure instanceof Error &&
            failure.message === STREAM_UNSUPPORTED
          ) {
            markUnhealthy();
            return;
          }
        } finally {
          clearInterval(watchdog);
          attempt.done();
        }
        if (!current()) return;
        // A stream that delivered frames resets the backoff.
        if (framed) delay = STREAM_BACKOFF_MIN_MS;
        markUnhealthy();
        await wait(delay, signal);
        delay = Math.min(delay * 2, STREAM_BACKOFF_MAX_MS);
      }
    }
    // Native fetch buffers whole responses, so native clients keep polling.
    if (Platform.OS === 'web') void stream();

    return () => {
      ++listEpoch.current;
      controller.abort();
      clearInterval(timer);
      clearTimeout(coalesce);
      refreshRef.current = () => undefined;
    };
  }, [sessionKey, applySnapshot]);

  /* ---------------------------------------------------------------------- */
  /* Control lease for the selected radio                                   */
  /* ---------------------------------------------------------------------- */
  useEffect(() => {
    const version = ++epoch.current;
    const controller = new AbortController();
    leaseRef.current = null;
    setLease(null);
    setBusy(false);
    setOperationError('');
    const renewal = setInterval(() => {
      const held = leaseRef.current;
      if (!held || !radioId) return;
      void apiRequest<unknown>(
        sessionRef.current,
        `radios/${radioId}/control/renew`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            controlGrant: held.grantId,
            generation: held.generation,
          }),
        },
      )
        .then((value) => {
          if (
            epoch.current !== version ||
            leaseRef.current?.grantId !== held.grantId
          )
            return;
          const renewed = ControlLeaseSchema.safeParse(value);
          if (renewed.success && renewed.data.radioId === held.radioId) {
            // A plain renewal only moves `expiresAt`, which nothing renders:
            // keep it out of React state so consumers do not re-render.
            if (sameLease(renewed.data, held)) leaseRef.current = renewed.data;
            else rememberLease(renewed.data);
          } else {
            leaseRef.current = null;
            setLease(null);
            setOperationError('The server returned an invalid control lease.');
            // Keep server and client in agreement about the dropped lease.
            void releaseLease(sessionRef.current, held).then(() =>
              refreshRef.current(),
            );
          }
        })
        .catch((failure) => {
          if (
            !controller.signal.aborted &&
            epoch.current === version &&
            leaseRef.current?.grantId === held.grantId
          ) {
            leaseRef.current = null;
            setLease(null);
            setOperationError(message(failure, 'Radio control was lost.'));
            void releaseLease(sessionRef.current, held).then(() =>
              refreshRef.current(),
            );
          }
        });
    }, RENEW_MS);
    return () => {
      ++epoch.current;
      controller.abort();
      clearInterval(renewal);
      const held = leaseRef.current;
      leaseRef.current = null;
      if (held) {
        // Show the released radio as available now; the refresh after the
        // release confirms it (or restores the server's view if it failed).
        setRadios((previous) =>
          previous.map((radio) =>
            radio.radioId === held.radioId &&
            radio.control?.grantId === held.grantId
              ? { ...radio, control: null }
              : radio,
          ),
        );
        void releaseLease(sessionRef.current, held).then(() =>
          refreshRef.current(),
        );
      }
    };
  }, [sessionKey, radioId, rememberLease, setBusy]);

  /* ---------------------------------------------------------------------- */
  /* Channel memories                                                       */
  /* ---------------------------------------------------------------------- */
  const memoriesReadable = Boolean(
    selected?.descriptor?.capabilities.memories?.read,
  );
  // Only what can change the list refetches it (not TX or connection revisions).
  const memoriesKey = memoriesFetchKey(selected?.snapshot);
  useEffect(() => {
    setMemories(NO_MEMORIES);
    setMemoriesLoaded(false);
    setMemoriesError('');
  }, [sessionKey, radioId]);
  useEffect(() => {
    const controller = new AbortController();
    if (!radioId || !memoriesReadable) {
      setMemories(NO_MEMORIES);
      setMemoriesLoaded(Boolean(radioId && selectedRef.current));
      return () => controller.abort();
    }
    void apiRequest<unknown>(sessionRef.current, `radios/${radioId}/memories`, {
      signal: controller.signal,
    })
      .then((items) => {
        if (controller.signal.aborted) return;
        const parsed = RadioMemorySchema.array().safeParse(items);
        if (parsed.success) {
          setMemories((previous) => preserveIdentity(previous, parsed.data));
          setMemoriesError('');
        } else
          setMemoriesError(
            'The radio returned memories this client cannot read.',
          );
        setMemoriesLoaded(true);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setMemoriesError(message(failure, 'Radio memories are unavailable.'));
        setMemoriesLoaded(true);
      });
    return () => controller.abort();
  }, [sessionKey, radioId, memoriesReadable, memoriesKey]);

  /* ---------------------------------------------------------------------- */
  /* Operations                                                             */
  /* ---------------------------------------------------------------------- */
  const run = useCallback(
    async (work: () => Promise<string>): Promise<StationOperationResult> => {
      if (busyRef.current)
        return { ok: false, error: 'Another radio operation is in progress.' };
      const version = epoch.current;
      setBusy(true);
      setOperationError('');
      try {
        return { ok: true, message: await work() };
      } catch (failure) {
        const text = message(failure, 'The radio request failed.');
        if (epoch.current === version) setOperationError(text);
        return { ok: false, error: text };
      } finally {
        if (epoch.current === version) setBusy(false);
      }
    },
    [setBusy],
  );
  /** Same shape and checks as the original dashboard `context()`. */
  const context = useCallback((): OperationContext => {
    const current = selectedRef.current?.snapshot;
    const held = leaseRef.current;
    if (
      !current ||
      !held ||
      held.radioId !== current.radioId ||
      current.generation !== held.generation
    )
      throw new Error('Take control before changing the radio.');
    return {
      operationId: operationId(),
      radioId: current.radioId,
      generation: current.generation,
      expectedRevision: current.revision,
      controlGrant: held.grantId,
      fencing: held.fencing,
      deadline: new Date(Date.now() + 5000).toISOString(),
    };
  }, []);
  const readyRadio = useCallback((): RadioView => {
    const radio = selectedRef.current;
    if (!radio) throw new Error('Select a radio first.');
    if (radio.snapshot?.connection !== 'ready')
      throw new Error('The radio must be connected and ready.');
    if (radio.snapshot.txState !== 'idle')
      throw new Error('Wait until the radio has stopped transmitting.');
    return radio;
  }, []);
  /** Applies an operation's returned snapshot, or refreshes when it is unreadable. */
  const acceptSnapshot = useCallback(
    (value: unknown, version: number): RadioSnapshot | undefined => {
      const parsed = RadioSnapshotSchema.safeParse(value);
      if (!parsed.success) {
        refreshRef.current();
        return undefined;
      }
      if (epoch.current === version) applySnapshot(parsed.data);
      return parsed.data;
    },
    [applySnapshot],
  );

  const takeControl = useCallback(
    () =>
      run(async () => {
        const radio = selectedRef.current;
        if (!radio) throw new Error('Select a radio first.');
        if (leaseRef.current)
          return `You already control ${radio.displayName}.`;
        if (!hasPermission(sessionRef.current, radio.radioId, 'radio.control'))
          throw new Error('You do not have control permission for this radio.');
        if (radio.snapshot?.connection !== 'ready')
          throw new Error('The radio must be ready before taking control.');
        const session = sessionRef.current;
        const version = epoch.current;
        const value = await apiRequest<unknown>(
          session,
          `radios/${radio.radioId}/control`,
          { method: 'POST' },
        );
        const granted = ControlLeaseSchema.safeParse(value);
        if (!granted.success)
          throw new Error('The server returned an invalid control lease.');
        if (
          epoch.current === version &&
          radioIdRef.current === granted.data.radioId
        ) {
          rememberLease(granted.data);
          return `You have control of ${radio.displayName}.`;
        }
        void releaseLease(session, granted.data);
        throw new Error(
          'The selected radio changed before control was granted.',
        );
      }),
    [run, rememberLease],
  );
  const releaseControl = useCallback(
    () =>
      run(async () => {
        const held = leaseRef.current;
        const name = selectedRef.current?.displayName ?? 'the radio';
        if (!held) return 'Control is already released.';
        const version = epoch.current;
        await apiRequest(sessionRef.current, `radios/${held.radioId}/control`, {
          method: 'DELETE',
          body: JSON.stringify({
            controlGrant: held.grantId,
            generation: held.generation,
          }),
        });
        if (
          epoch.current === version &&
          leaseRef.current?.grantId === held.grantId
        ) {
          leaseRef.current = null;
          setLease(null);
          setRadios((previous) =>
            previous.map((radio) =>
              radio.radioId === held.radioId &&
              radio.control?.grantId === held.grantId
                ? { ...radio, control: null }
                : radio,
            ),
          );
        }
        return `Released control of ${name}.`;
      }),
    [run],
  );

  const tune = useCallback(
    (requested: Tuning) =>
      run(async () => {
        const radio = readyRadio();
        const capabilities = radio.descriptor?.capabilities;
        if (!capabilities?.tuning.writable)
          throw new Error(
            'This driver does not support free tuning — use channel memories.',
          );
        if (!capabilities.tuning.modes.includes(requested.mode))
          throw new Error(`${requested.mode} is not supported by this radio.`);
        if (!isInRanges(requested.rxHz, capabilities.tuning.ranges))
          throw new Error(
            `${formatFrequency(requested.rxHz)} MHz is outside this radio's ranges (${capabilities.tuning.ranges.map(formatRange).join(', ')}).`,
          );
        const tuning: Tuning = {
          rxHz: requested.rxHz,
          ...(requested.txHz === undefined ? {} : { txHz: requested.txHz }),
          mode: requested.mode,
        };
        const requestContext = context();
        const version = epoch.current;
        const result = await apiRequest<unknown>(
          sessionRef.current,
          `radios/${radio.radioId}/operations`,
          {
            method: 'POST',
            body: JSON.stringify({ context: requestContext, tuning }),
          },
        );
        const snapshot = acceptSnapshot(result, version);
        return snapshot?.tuningConfidence === 'confirmed' &&
          sameTuning(snapshot.observedTuning, tuning)
          ? `Radio confirmed ${formatTuning(tuning)}.`
          : `Requested ${formatTuning(tuning)} · waiting for radio confirmation.`;
      }),
    [run, readyRadio, context, acceptSnapshot],
  );
  const recallMemory = useCallback(
    (memoryId: string) =>
      run(async () => {
        const radio = readyRadio();
        if (!radio.descriptor?.capabilities.memories?.select)
          throw new Error('This radio does not support recalling memories.');
        const memory = memoriesRef.current.find(
          (item) => item.memoryId === memoryId,
        );
        const requestContext = context();
        const version = epoch.current;
        const result = await apiRequest<unknown>(
          sessionRef.current,
          `radios/${radio.radioId}/memories/${encodeURIComponent(memoryId)}/select`,
          { method: 'POST', body: JSON.stringify(requestContext) },
        );
        acceptSnapshot(result, version);
        return `Recalled ${memory?.name || 'memory'}.`;
      }),
    [run, readyRadio, context, acceptSnapshot],
  );
  const storeMemory = useCallback(
    (memoryId: string, requested: Tuning) =>
      run(async () => {
        const radio = readyRadio();
        if (!radio.descriptor?.capabilities.memories?.write)
          throw new Error('This radio does not support storing memories.');
        const memory = memoriesRef.current.find(
          (item) => item.memoryId === memoryId,
        );
        if (!memory) throw new Error('That memory is no longer available.');
        const tuning: Tuning = {
          rxHz: requested.rxHz,
          ...(requested.txHz === undefined ? {} : { txHz: requested.txHz }),
          mode: requested.mode,
        };
        const session = sessionRef.current;
        const version = epoch.current;
        const saved = await apiRequest<unknown>(
          session,
          `radios/${radio.radioId}/memories/${encodeURIComponent(memoryId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              context: context(),
              memory: { ...memory, tuning },
            }),
          },
        );
        const snapshot = await apiRequest<unknown>(
          session,
          `radios/${radio.radioId}/state`,
        );
        if (epoch.current === version) {
          const parsed = RadioMemorySchema.safeParse(saved);
          if (parsed.success)
            setMemories((items) =>
              items.map((item) =>
                item.memoryId === parsed.data.memoryId ? parsed.data : item,
              ),
            );
          acceptSnapshot(snapshot, version);
        }
        return `Stored ${formatTuning(tuning)} in ${memory.name || 'memory'}.`;
      }),
    [run, readyRadio, context, acceptSnapshot],
  );
  const refresh = useCallback(() => refreshRef.current(), []);
  const selectRadio = useCallback(
    (id: string): Promise<boolean> =>
      onSelectRef.current?.(id) ?? Promise.resolve(false),
    [],
  );
  const clearOperationError = useCallback(() => setOperationError(''), []);

  /* ---------------------------------------------------------------------- */
  /* Derived state                                                          */
  /* ---------------------------------------------------------------------- */
  const canControl = Boolean(
    radioId &&
    session.user.enabled &&
    hasPermission(session, radioId, 'radio.control'),
  );
  const mine = Boolean(lease && selected && lease.radioId === selected.radioId);
  const control = controlPresentation(selected, {
    userId: session.user.id,
    userEnabled: session.user.enabled,
    leaseGrantId: mine ? lease?.grantId : undefined,
    ownGrantIds: ownControlGrants,
    radioPermissions: session.user.radioPermissions,
    // Compared at render time; the list refreshes every few seconds.
    now: Date.now(),
  });
  // Stable identity while the presentation is unchanged.
  const controlRef = useRef(control);
  if (!sameControl(controlRef.current, control)) controlRef.current = control;
  const stableControl = controlRef.current;
  const editable = Boolean(
    mine &&
    lease?.generation === selected?.snapshot?.generation &&
    selected?.snapshot?.connection === 'ready' &&
    selected.snapshot.txState === 'idle' &&
    !busy,
  );

  const value = useMemo<StationContextValue>(
    () => ({
      session,
      radioId,
      radios,
      loaded,
      error,
      listStale,
      selected,
      liveUpdates,
      selectRadio,
      refresh,
      lease,
      control: stableControl,
      controlState: stableControl.state,
      controlOwnerLabel: stableControl.label,
      canControl,
      takeControl,
      releaseControl,
      noteControlGrant,
      ownControlGrants,
      memories,
      memoriesLoaded,
      memoriesError,
      tune,
      recallMemory,
      storeMemory,
      busy,
      operationError,
      clearOperationError,
      editable,
    }),
    [
      session,
      radioId,
      radios,
      loaded,
      error,
      listStale,
      selected,
      liveUpdates,
      selectRadio,
      refresh,
      lease,
      stableControl,
      canControl,
      takeControl,
      releaseControl,
      noteControlGrant,
      ownControlGrants,
      memories,
      memoriesLoaded,
      memoriesError,
      tune,
      recallMemory,
      storeMemory,
      busy,
      operationError,
      clearOperationError,
      editable,
    ],
  );
  return (
    <StationContext.Provider value={value}>{children}</StationContext.Provider>
  );
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function hasPermission(
  session: ClientSession,
  radioId: string,
  permission: string,
): boolean {
  return session.user.radioPermissions.some(
    (entry) =>
      entry.radioId === radioId &&
      (entry.permissions as readonly string[]).includes(permission),
  );
}
function releaseLease(
  session: ClientSession,
  held: ControlLease,
): Promise<void> {
  return apiRequest(
    { ...session, onUnauthorized: () => undefined },
    `radios/${held.radioId}/control`,
    {
      method: 'DELETE',
      body: JSON.stringify({
        controlGrant: held.grantId,
        generation: held.generation,
      }),
    },
  ).then(
    () => undefined,
    () => undefined,
  );
}
function parseRadioList(value: unknown): {
  radios: RadioView[];
  error: string;
} {
  if (!Array.isArray(value))
    return { radios: [], error: 'The server returned an invalid radio list.' };
  const radios: RadioView[] = [];
  let invalid = 0;
  for (const item of value) {
    const parsed = RadioViewSchema.safeParse(item);
    if (parsed.success) radios.push(parsed.data);
    else invalid++;
  }
  return {
    radios,
    error: invalid
      ? `${invalid === 1 ? 'One radio' : `${invalid} radios`} could not be read by this client.`
      : '',
  };
}
function sameControl(a: ControlPresentation, b: ControlPresentation) {
  return (
    a.state === b.state &&
    a.label === b.label &&
    a.tone === b.tone &&
    a.icon === b.icon
  );
}
/** An abort signal that follows `parent` and, with `ms`, also times out. */
function childSignal(parent: AbortSignal, ms?: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  const timer = ms === undefined ? undefined : setTimeout(abort, ms);
  return {
    signal: controller.signal,
    abort,
    done: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    },
  };
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
function message(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message
    ? failure.message
    : fallback;
}
