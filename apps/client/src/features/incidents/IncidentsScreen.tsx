import {
  SignalDockError,
  type FeatureScreenProps,
  type IncidentRecord,
  type IncidentState,
} from '@signaldock/contracts';
import {
  Button,
  Text,
  space,
  useFeatureStyles,
  useTheme,
  useToast,
} from '@signaldock/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from 'react';
import {
  ActivityIndicator,
  ScrollView as NativeScrollView,
  View,
} from 'react-native';
import { moveFocus } from '../../shared/accessibility';
import { useStation } from '../station';
import { CloseIncidentSheet } from './CloseIncidentSheet';
import {
  IncidentBoard,
  type FocusableCard,
  type IncidentCardInfo,
} from './IncidentBoard';
import { IncidentDetail, type EvidenceSourceState } from './IncidentDetail';
import { RuleBuilder } from './RuleBuilder';
import {
  IncidentClient,
  type IncidentDetailView,
} from './data/incident-client';
import {
  INCIDENT_COLUMNS,
  INCIDENT_STATES,
  columnDefinition,
  columnOf,
  groupIncidents,
  ownerPresentation,
  transitionMessage,
  type CloseState,
  type IncidentColumn,
  type TransitionAction,
} from './incident-model';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The request failed.';

/** Container width from which the detail sits beside the board. */
const SIDE_DETAIL_MIN = 1040;
const DETAIL_WIDTH = 400;
const SOURCE_CONCURRENCY = 3;
const CLOCK_MS = 30_000;

type IncidentUpdate = {
  state?: IncidentState;
  note?: string;
  retentionHold?: boolean;
  ownerUserId?: string | null;
};
type UpdateResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** The server holds a newer revision than the one acted on. */
      conflict: boolean;
    };
const CANCELLED: UpdateResult = {
  ok: false,
  error: 'Cancelled.',
  conflict: false,
};

/** Keeps the newest revision of each incident. */
function mergeRecords(
  previous: Readonly<Record<string, IncidentRecord>>,
  incoming: readonly IncidentRecord[],
): Record<string, IncidentRecord> {
  const next = { ...previous };
  for (const record of incoming) {
    const existing = next[record.id];
    if (!existing || record.revision >= existing.revision)
      next[record.id] = record;
  }
  return next;
}

/**
 * Asks the screen to open one incident (e.g. from the command palette).
 * A new `requestId` opens it again even when the id is unchanged.
 */
export interface IncidentFocusRequest {
  incidentId: string;
  requestId: number;
}
export type IncidentsScreenProps = FeatureScreenProps & {
  focusIncident?: IncidentFocusRequest | undefined;
};

export function IncidentsScreen({
  session,
  radioId,
  onSelectRadio,
  focusIncident,
}: IncidentsScreenProps) {
  const { colors } = useTheme();
  const styles = useFeatureStyles('incidents');
  const toast = useToast();
  const station = useStation();
  const client = useMemo(
    () => new IncidentClient(session),
    [
      session.baseUrl,
      session.instanceId,
      session.accessToken,
      session.onUnauthorized,
    ],
  );
  const [records, setRecords] = useState<Record<string, IncidentRecord>>({});
  const [cursors, setCursors] = useState<
    Partial<Record<IncidentState, string>>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [column, setColumn] = useState<IncidentColumn>('new');
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<IncidentDetailView | null>(null);
  const [detailError, setDetailError] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const [closing, setClosing] = useState<{
    incident: IncidentRecord;
    target: CloseState;
  } | null>(null);
  const [closeError, setCloseError] = useState('');
  const [sources, setSources] = useState<Record<string, EvidenceSourceState>>(
    {},
  );
  const [now, setNow] = useState(() => Date.now());
  const [width, setWidth] = useState(0);

  const generation = useRef(0);
  const selected = useRef<string | undefined>(undefined);
  selected.current = selectedId;
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const sourceRequest = useRef(new AbortController());
  const sourceQueue = useRef<string[]>([]);
  const sourceActive = useRef(0);
  const sourceRequested = useRef(new Set<string>());
  /** Generation whose board `records` currently holds (guards stale renders). */
  const loadedGeneration = useRef(-1);
  const scroller = useRef<ComponentRef<typeof NativeScrollView>>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const loadBoard = useCallback(async () => {
    const current = generation.current;
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    setError('');
    const results = await Promise.allSettled(
      INCIDENT_STATES.map((state) =>
        client.list(
          { ...(radioId ? { radioId } : {}), state },
          controller.signal,
        ),
      ),
    );
    if (current !== generation.current || controller.signal.aborted) return;
    loadedGeneration.current = current;
    const items: IncidentRecord[] = [];
    const nextCursors: Partial<Record<IncidentState, string>> = {};
    let failure: unknown;
    results.forEach((result, index) => {
      const state = INCIDENT_STATES[index]!;
      if (result.status === 'fulfilled') {
        items.push(...result.value.items);
        if (result.value.nextCursor)
          nextCursors[state] = result.value.nextCursor;
      } else failure ??= result.reason;
    });
    setRecords(mergeRecords({}, items));
    setCursors(nextCursors);
    if (failure !== undefined) setError(message(failure));
    setLoading(false);
  }, [client, radioId]);

  const loadDetail = useCallback(
    async (id: string) => {
      const current = generation.current;
      const controller = new AbortController();
      // Only the open incident's load replaces (and cancels) the previous
      // one; refreshing another card's revision runs on its own.
      if (selected.current === id) {
        detailRequest.current?.abort();
        detailRequest.current = controller;
      }
      try {
        const response = await client.detail(id, controller.signal);
        if (current !== generation.current || controller.signal.aborted) return;
        setRecords((previous) => mergeRecords(previous, [response.incident]));
        if (selected.current === id) setDetail(response);
      } catch (failure) {
        if (
          current === generation.current &&
          !controller.signal.aborted &&
          selected.current === id
        )
          setDetailError(message(failure));
      }
    },
    [client],
  );

  // A new server, account or radio scope starts from scratch.
  useEffect(() => {
    generation.current++;
    listRequest.current?.abort();
    detailRequest.current?.abort();
    mutation.current?.abort();
    sourceRequest.current.abort();
    sourceRequest.current = new AbortController();
    sourceQueue.current = [];
    sourceActive.current = 0;
    sourceRequested.current = new Set();
    setRecords({});
    setCursors({});
    setSelectedId(undefined);
    setDetail(null);
    setDetailError('');
    setBusyId(undefined);
    setClosing(null);
    setSources({});
    void loadBoard();
    return () => {
      generation.current++;
      listRequest.current?.abort();
      detailRequest.current?.abort();
      mutation.current?.abort();
      sourceRequest.current.abort();
    };
  }, [loadBoard]);

  const pumpSources = useCallback(() => {
    const current = generation.current;
    const controller = sourceRequest.current;
    while (
      sourceActive.current < SOURCE_CONCURRENCY &&
      sourceQueue.current.length
    ) {
      const id = sourceQueue.current.shift()!;
      sourceActive.current++;
      void client
        .source(id, controller.signal)
        .then(
          (source) => {
            if (current === generation.current)
              setSources((previous) => ({
                ...previous,
                [id]: { status: 'ready', source },
              }));
          },
          (failure: unknown) => {
            if (current === generation.current && !controller.signal.aborted)
              setSources((previous) => ({
                ...previous,
                [id]: { status: 'error', error: message(failure) },
              }));
          },
        )
        .finally(() => {
          if (current !== generation.current) return;
          sourceActive.current--;
          pumpSources();
        });
    }
  }, [client]);

  // Evidence sources: the open incident's clips first, then the first clip of
  // every card (for its frequency). Each communication is fetched once.
  useEffect(() => {
    // Right after a scope change this render still holds the previous
    // server's or radio's records: wait for the new board.
    if (loadedGeneration.current !== generation.current) return;
    const urgent = (detail?.incident.evidence ?? []).map(
      (entry) => entry.communicationId,
    );
    const cards = Object.values(records).flatMap((record) =>
      record.evidence[0] ? [record.evidence[0].communicationId] : [],
    );
    const fresh = (ids: string[]) =>
      [...new Set(ids)].filter((id) => !sourceRequested.current.has(id));
    const first = fresh(urgent);
    const rest = fresh(cards).filter((id) => !first.includes(id));
    for (const id of [...first, ...rest]) sourceRequested.current.add(id);
    // Move already-queued urgent clips to the front too.
    const promoted = urgent.filter((id) => sourceQueue.current.includes(id));
    sourceQueue.current = [
      ...first,
      ...promoted,
      ...sourceQueue.current.filter((id) => !promoted.includes(id)),
      ...rest,
    ];
    if (first.length)
      setSources((previous) => {
        const next = { ...previous };
        for (const id of first) next[id] = { status: 'loading' };
        return next;
      });
    pumpSources();
  }, [records, detail, pumpSources]);

  const canManage = useCallback(
    (radio: string) =>
      session.user.radioPermissions.some(
        (grant) =>
          grant.radioId === radio &&
          grant.permissions.includes('incident.manage'),
      ),
    [session.user],
  );
  const radioName = useCallback(
    (radio: string) =>
      station.radios.find((entry) => entry.radioId === radio)?.displayName ??
      `Radio ${radio.slice(0, 8)}`,
    [station.radios],
  );
  const info = useCallback(
    (incident: IncidentRecord): IncidentCardInfo => {
      const first = incident.evidence[0];
      const state = first ? sources[first.communicationId] : undefined;
      const source = state?.status === 'ready' ? state.source : undefined;
      return {
        radioName: radioName(incident.radioId),
        frequencyHz: source?.frequencyHz,
        frequencyAttribution: source?.frequencyAttribution,
        owner: ownerPresentation(incident.ownerUserId, session.user),
        canManage: canManage(incident.radioId),
      };
    },
    [sources, radioName, session.user, canManage],
  );

  /**
   * `incident` must be the record the operator saw and acted on: its revision
   * is the one sent, so a concurrent change is reported as a conflict instead
   * of being overridden.
   */
  async function update(
    incident: IncidentRecord,
    input: IncidentUpdate,
    success: string,
  ): Promise<UpdateResult> {
    const current = generation.current;
    mutation.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    setBusyId(incident.id);
    setError('');
    setDetailError('');
    try {
      const result = await client.update(
        incident.id,
        { expectedRevision: incident.revision, ...input },
        controller.signal,
      );
      if (current !== generation.current || controller.signal.aborted)
        return CANCELLED;
      setRecords((previous) => mergeRecords(previous, [result]));
      toast.show({ message: success, tone: 'success' });
      if (selected.current === incident.id) void loadDetail(incident.id);
      return { ok: true };
    } catch (failure) {
      if (current !== generation.current || controller.signal.aborted)
        return CANCELLED;
      // Reload so the operator sees the current state before deciding again.
      void loadDetail(incident.id);
      const conflict =
        failure instanceof SignalDockError && failure.code === 'STALE_REVISION';
      return {
        ok: false,
        conflict,
        error: conflict
          ? 'Someone else changed this incident. Review its current state and try again.'
          : message(failure),
      };
    } finally {
      if (current === generation.current && mutation.current === controller)
        setBusyId(undefined);
    }
  }

  function report(incident: IncidentRecord, result: UpdateResult) {
    if (result.ok || result === CANCELLED) return;
    if (selected.current === incident.id) setDetailError(result.error);
    else setError(result.error);
  }

  function transition(incident: IncidentRecord, action: TransitionAction) {
    if (action.needsNote) {
      if (action.target !== 'resolved' && action.target !== 'dismissed') return;
      setCloseError('');
      setClosing({ incident, target: action.target });
      return;
    }
    void update(
      incident,
      { state: action.target },
      transitionMessage(action.target, action.reopen),
    ).then((result) => report(incident, result));
  }

  function openById(id: string) {
    if (selected.current === id) return;
    // The compact board (also used beside a side detail) shows one column:
    // show the opened card's.
    const known = records[id];
    if (known) setColumn(columnOf(known.state));
    setSelectedId(id);
    selected.current = id;
    // Narrow layouts replace the board with the detail: start at its top.
    if (!side) scroller.current?.scrollTo({ y: 0, animated: false });
    setDetail(null);
    setDetailError('');
    void loadDetail(id);
  }
  const open = (incident: IncidentRecord) => openById(incident.id);

  // Focus requests (command palette): open that incident's detail and show
  // its column. Runs after the scope reset above so a first mount keeps it.
  const handledFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!focusIncident || handledFocus.current === focusIncident.requestId)
      return;
    handledFocus.current = focusIncident.requestId;
    openById(focusIncident.incidentId);
  }, [focusIncident]);

  // Keep the compact board on the open card's column, including when the
  // record arrives after opening or the card moves to another column.
  const selectedState = selectedId ? records[selectedId]?.state : undefined;
  useEffect(() => {
    if (selectedState) setColumn(columnOf(selectedState));
  }, [selectedId, selectedState]);

  // Card open buttons, so closing the detail can return focus to its opener.
  const cardNodes = useRef(new Map<string, FocusableCard>());
  const registerCard = useCallback((id: string, node: FocusableCard | null) => {
    if (node) cardNodes.current.set(id, node);
    else cardNodes.current.delete(id);
  }, []);
  const returnFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = returnFocus.current;
    if (!id || selectedId) return;
    returnFocus.current = undefined;
    moveFocus(cardNodes.current.get(id));
  });

  function closeDetail() {
    detailRequest.current?.abort();
    returnFocus.current = selected.current;
    setSelectedId(undefined);
    selected.current = undefined;
    setDetail(null);
    setDetailError('');
  }

  async function loadMore(target: IncidentColumn) {
    const definition = columnDefinition(target);
    const pending = definition.states.filter((state) => cursors[state]);
    if (!pending.length) return;
    const current = generation.current;
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    setError('');
    try {
      const pages = await Promise.all(
        pending.map((state) =>
          client.list(
            {
              ...(radioId ? { radioId } : {}),
              state,
              cursor: cursors[state]!,
            },
            controller.signal,
          ),
        ),
      );
      if (current !== generation.current || controller.signal.aborted) return;
      setRecords((previous) =>
        mergeRecords(
          previous,
          pages.flatMap((page) => page.items),
        ),
      );
      setCursors((previous) => {
        const next = { ...previous };
        pending.forEach((state, index) => {
          const cursor = pages[index]?.nextCursor;
          if (cursor) next[state] = cursor;
          else delete next[state];
        });
        return next;
      });
    } catch (failure) {
      if (current === generation.current && !controller.signal.aborted)
        setError(message(failure));
    } finally {
      if (current === generation.current && listRequest.current === controller)
        setLoading(false);
    }
  }

  const groups = useMemo(
    () => groupIncidents(Object.values(records)),
    [records],
  );
  const hasMore = useMemo(
    () =>
      Object.fromEntries(
        INCIDENT_COLUMNS.map((entry) => [
          entry.key,
          entry.states.some((state) => cursors[state] !== undefined),
        ]),
      ) as Record<IncidentColumn, boolean>,
    [cursors],
  );
  const busy = busyId !== undefined;
  const side = width >= SIDE_DETAIL_MIN;
  const selectedRecord = selectedId ? records[selectedId] : undefined;
  const scale =
    station.selected?.radioId === radioId
      ? station.selected?.descriptor?.capabilities.tuning.ranges
      : undefined;

  // The board may hold a newer revision than the last detail fetch. The
  // record shown is the one every detail action is checked against.
  const shown =
    detail && detail.incident.id === selectedId
      ? selectedRecord && selectedRecord.revision > detail.incident.revision
        ? selectedRecord
        : detail.incident
      : undefined;
  const detailPanel = selectedId ? (
    detail && shown ? (
      <IncidentDetail
        session={session}
        detail={{ ...detail, incident: shown }}
        info={info(shown)}
        sources={sources}
        now={now}
        busy={busy}
        error={detailError}
        onClose={closeDetail}
        onTransition={(action) => transition(shown, action)}
        onAssignToMe={() => {
          void update(
            shown,
            { ownerUserId: session.user.id },
            'Incident assigned to you.',
          ).then((result) => report(shown, result));
        }}
        onRetentionHold={(hold) => {
          void update(
            shown,
            { retentionHold: hold },
            hold ? 'Evidence held.' : 'Evidence hold released.',
          ).then((result) => report(shown, result));
        }}
        onSaveNote={async (note) => {
          const result = await update(shown, { note }, 'Note saved.');
          report(shown, result);
          return result.ok;
        }}
        onSelectRadio={
          onSelectRadio && shown.radioId !== radioId
            ? () => onSelectRadio(shown.radioId)
            : undefined
        }
      />
    ) : (
      <View style={styles.card}>
        {detailError ? (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {detailError}
            </Text>
            <View style={styles.row}>
              <Button
                label="Try again"
                onPress={() => void loadDetail(selectedId)}
              />
              <Button
                label="Back to board"
                variant="quiet"
                onPress={closeDetail}
              />
            </View>
          </>
        ) : (
          <ActivityIndicator
            accessibilityLabel="Loading incident"
            color={colors.primary}
          />
        )}
      </View>
    )
  ) : null;

  const board = (
    <IncidentBoard
      groups={groups}
      hasMore={hasMore}
      column={column}
      onColumnChange={setColumn}
      info={info}
      now={now}
      selectedId={selectedId}
      busyId={busyId}
      busy={busy}
      loading={loading}
      onOpen={open}
      onTransition={transition}
      onLoadMore={(target) => {
        void loadMore(target);
      }}
      registerCard={registerCard}
    />
  );

  return (
    <NativeScrollView
      ref={scroller}
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          Incidents
        </Text>
        <Button
          label="Refresh"
          variant="quiet"
          disabled={loading || busy}
          onPress={() => {
            // Retry clips that failed; loaded ones stay cached.
            const failed = Object.entries(sources)
              .filter(([, state]) => state.status === 'error')
              .map(([id]) => id);
            for (const id of failed) sourceRequested.current.delete(id);
            if (failed.length)
              setSources((previous) => {
                const next = { ...previous };
                for (const id of failed) delete next[id];
                return next;
              });
            void loadBoard();
            if (selectedId) void loadDetail(selectedId);
          }}
        />
      </View>
      <Text style={styles.muted}>
        Review source evidence and record operator decisions. Detection does not
        provide complete emergency coverage.
      </Text>
      <Text style={styles.small}>
        {radioId
          ? `Showing incidents from ${radioName(radioId)}.`
          : 'Showing incidents from every radio you can review.'}
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {loading && (
        <ActivityIndicator
          accessibilityLabel="Loading incidents"
          color={colors.primary}
        />
      )}
      <View
        onLayout={(event) =>
          setWidth(Math.floor(event.nativeEvent.layout.width))
        }
        style={
          side
            ? { flexDirection: 'row', gap: space.lg, alignItems: 'flex-start' }
            : { gap: space.lg }
        }
      >
        {side ? (
          <>
            <View style={{ flex: 1, minWidth: 0 }}>{board}</View>
            {detailPanel && (
              <View style={{ width: DETAIL_WIDTH }}>{detailPanel}</View>
            )}
          </>
        ) : (
          (detailPanel ?? board)
        )}
      </View>
      {session.user.role === 'administrator' && (
        <RuleBuilder
          key={`${session.baseUrl}|${session.instanceId}|${radioId ?? ''}`}
          client={client}
          radioId={radioId}
          radioName={radioId ? radioName(radioId) : undefined}
          scale={scale}
        />
      )}
      <CloseIncidentSheet
        incident={closing?.incident ?? null}
        target={closing?.target ?? 'resolved'}
        busy={busy}
        error={closeError}
        onCancel={() => {
          setClosing(null);
          setCloseError('');
        }}
        onConfirm={(note) => {
          if (!closing) return;
          const { incident, target } = closing;
          setCloseError('');
          void update(
            incident,
            { state: target, note },
            transitionMessage(target, false),
          ).then((result) => {
            if (result.ok) setClosing(null);
            else if (result.conflict) {
              // Do not let a second press retry against a revision the
              // operator never saw: close the sheet so they decide again
              // against the refreshed incident.
              setClosing(null);
              setCloseError('');
              report(incident, result);
            } else if (result !== CANCELLED) setCloseError(result.error);
          });
        }}
      />
    </NativeScrollView>
  );
}

export default IncidentsScreen;
