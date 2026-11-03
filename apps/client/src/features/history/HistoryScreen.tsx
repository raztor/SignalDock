import { apiRequest } from '@signaldock/client-sdk';
import type {
  Conversation,
  CoverageInterval,
  FeatureScreenProps,
} from '@signaldock/contracts';
import {
  Button,
  Disclosure,
  Text,
  TextInput,
  space as uiSpace,
  useFeatureStyles,
  useReducedMotion,
  useTheme,
  useToast,
  visuallyHidden,
} from '@signaldock/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  Platform,
  View,
} from 'react-native';
import { useStation } from '../station';
import { ActivityHeatmap } from './ActivityHeatmap';
import { CommunicationRow, type HistoryMutation } from './CommunicationRow';
import { CoverageGapRow } from './CoverageGapRow';
import { HistoryFilterBar } from './HistoryFilterBar';
import {
  WaveformLoader,
  fetchActivity,
  fetchCommunications,
  fetchConversations,
  fetchCoverage,
  type CommunicationPage,
  type OptionalResult,
} from './history-api';
import {
  ACTIVITY_DAYS,
  DEFAULT_HISTORY_FILTERS,
  SEARCH_DEBOUNCE_MS,
  activityPath,
  buildHeatmap,
  buildTimeline,
  communicationCount,
  communicationsPath,
  coverageGaps,
  createDebouncer,
  deviceTimeZone,
  errorMessage,
  historyRowsState,
  matchesFilters,
  mergePage,
  normalizeSearch,
  rangeForBefore,
  reachedRangeStart,
  showCoverageGaps,
  type ActivityData,
  type DateRangeFilter,
  type DirectionFilter,
  type HeatmapCell,
  type HistoryFilters,
  type TimelineEntry,
} from './history-model';

type ActivityState = OptionalResult<ActivityData> | { status: 'loading' };
const NO_ITEMS: CommunicationPage['items'] = [];

export function HistoryScreen(props: FeatureScreenProps) {
  return (
    <HistoryWorkspace
      key={`${props.session.baseUrl}:${props.session.instanceId}:${props.session.user.id}:${props.session.accessToken}`}
      {...props}
    />
  );
}

/**
 * Stays mounted while other sections are visited (the shell keeps visited
 * screens), so filters, search text, loaded pages and scroll position survive
 * navigation. Only a new session remounts it.
 */
function HistoryWorkspace({ session, radioId }: FeatureScreenProps) {
  const { colors } = useTheme();
  const styles = useFeatureStyles('history');
  const toast = useToast();
  const station = useStation();
  const reducedMotion = useReducedMotion();
  const timeZone = useMemo(deviceTimeZone, []);

  const [page, setPage] = useState<CommunicationPage>({ items: [] }),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [conversation, setConversation] = useState<Conversation | null>(null);
  const [direction, setDirection] = useState<DirectionFilter>(
      DEFAULT_HISTORY_FILTERS.direction,
    ),
    [range, setRange] = useState<DateRangeFilter>(
      DEFAULT_HISTORY_FILTERS.range,
    ),
    [before, setBefore] = useState<string>(),
    [searchText, setSearchText] = useState(''),
    [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false),
    [appending, setAppending] = useState(false),
    [error, setError] = useState(''),
    [newNote, setNewNote] = useState(''),
    [now, setNow] = useState(() => Date.now()),
    [reloadKey, setReloadKey] = useState(0),
    [activity, setActivity] = useState<ActivityState>({ status: 'loading' }),
    [coverage, setCoverage] = useState<CoverageInterval[]>([]),
    /** First-page request the loaded `page` answers (set on success). */
    [pageQuery, setPageQuery] = useState<string>(),
    /** First-page request whose latest load failed. */
    [failedQuery, setFailedQuery] = useState<string>();

  const filters = useMemo<HistoryFilters>(
    () => ({ direction, range, search, ...(before ? { before } : {}) }),
    [direction, range, search, before],
  );
  const scopedRadio = conversation?.radioId ?? radioId;
  const scope = useMemo(
    () => ({
      ...(radioId ? { radioId } : {}),
      ...(conversation ? { conversation } : {}),
      timeZone,
      now,
    }),
    [radioId, conversation, timeZone, now],
  );

  // Latest query inputs for load(), which must not change identity per keystroke.
  const query = useRef({ filters, scope });
  query.current = { filters, scope };
  const pageRef = useRef(page);
  pageRef.current = page;
  const pageQueryRef = useRef(pageQuery);
  pageQueryRef.current = pageQuery;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const waveforms = useMemo(() => new WaveformLoader(session), [session]);
  useEffect(() => () => waveforms.dispose(), [waveforms]);

  const debouncer = useMemo(
    () =>
      createDebouncer(
        (value: string) => setSearch(normalizeSearch(value)),
        SEARCH_DEBOUNCE_MS,
      ),
    [],
  );
  useEffect(() => () => debouncer.cancel(), [debouncer]);
  const changeSearch = useCallback(
    (text: string) => {
      setSearchText(text);
      debouncer.schedule(text);
      if (!text) debouncer.flush();
    },
    [debouncer],
  );

  const request = useRef({ generation: 0, controller: new AbortController() });
  const load = useCallback(
    async (append = false) => {
      const cursor = append ? pageRef.current.nextCursor : undefined;
      if (append && !cursor) return;
      request.current.controller.abort();
      const current = {
        generation: request.current.generation + 1,
        controller: new AbortController(),
      };
      request.current = current;
      setBusy(true);
      setAppending(append);
      setError('');
      setNow(Date.now());
      const { filters: activeFilters, scope: activeScope } = query.current;
      try {
        const [data, groups] = await Promise.all([
          fetchCommunications(
            session,
            communicationsPath(activeFilters, activeScope, cursor),
            current.controller.signal,
          ),
          fetchConversations(session, current.controller.signal),
        ]);
        if (request.current.generation !== current.generation) return;
        setPage((prior) => ({
          items: mergePage(prior.items, data.items, append),
          ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
        }));
        if (!append) {
          setPageQuery(communicationsPath(activeFilters, activeScope));
          setFailedQuery(undefined);
        }
        setConversations(groups);
      } catch (failure) {
        if (!current.controller.signal.aborted) {
          setError(errorMessage(failure, 'History could not be loaded.'));
          if (!append) {
            const failed = communicationsPath(activeFilters, activeScope);
            setFailedQuery(failed);
            // Rows answering another radio, conversation, or search are
            // dropped (as before the redesign) so they never resurface,
            // dimmed, under this scope while it is retried or changed.
            if (pageQueryRef.current !== failed) {
              setPage({ items: [] });
              setPageQuery(undefined);
            }
          }
        }
      } finally {
        if (request.current.generation === current.generation) {
          setBusy(false);
          setAppending(false);
        }
      }
    },
    [session],
  );

  // Page cursors never restart first-page loading; only source/filter
  // changes that alter the request do (Digital and date ranges filter
  // loaded pages on the client).
  const firstPage = communicationsPath(filters, scope);
  useEffect(() => {
    setPage((prior) => ({ items: prior.items }));
    void load();
    return () => {
      request.current.controller.abort();
      request.current.generation++;
    };
  }, [load, firstPage]);

  // A frequency group from another radio no longer applies once the
  // workspace radio changes.
  useEffect(() => {
    if (radioId && conversation && conversation.radioId !== radioId)
      setConversation(null);
  }, [radioId, conversation]);

  const activityRequest = activityPath({ direction }, scope);
  useEffect(() => {
    const controller = new AbortController();
    setActivity((prior) =>
      prior.status === 'ready' ? prior : { status: 'loading' },
    );
    fetchActivity(session, activityRequest, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setActivity(result);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [session, activityRequest, reloadKey]);

  useEffect(() => {
    if (!scopedRadio) {
      setCoverage([]);
      return;
    }
    const controller = new AbortController();
    fetchCoverage(session, scopedRadio, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setCoverage(result.status === 'ready' ? result.data : []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [session, scopedRadio, reloadKey]);

  const refresh = useCallback(() => {
    void load();
    setReloadKey((key) => key + 1);
  }, [load]);

  function canWrite(radio: string) {
    return (
      session.user.role === 'administrator' ||
      session.user.radioPermissions.some(
        (grant) =>
          grant.radioId === radio &&
          grant.permissions.includes('history.write'),
      )
    );
  }
  const isAdministrator = session.user.role === 'administrator';

  const mutate = useCallback<HistoryMutation>(
    async (path, method, body, success) => {
      setError('');
      try {
        await apiRequest(session, path, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (success)
          toastRef.current.show({ message: success, tone: 'success' });
        await load();
        return true;
      } catch (failure) {
        const message = errorMessage(failure, 'The change could not be saved.');
        setError(message);
        toastRef.current.show({ message, tone: 'error' });
        return false;
      }
    },
    [session, load],
  );

  async function saveNote() {
    const selected = conversation?.radioId ?? radioId;
    if (!selected || !newNote.trim()) return;
    const saved = await mutate(
      'communications/notes',
      'POST',
      {
        radioId: selected,
        text: newNote.trim(),
        ...(conversation?.frequencyHz
          ? { frequencyHz: conversation.frequencyHz }
          : {}),
      },
      'Note added.',
    );
    if (saved) setNewNote('');
  }

  // Heatmap jump: show what happened up to the end of that hour.
  const list = useRef<FlatList<TimelineEntry>>(null);
  const timelineOffset = useRef(0);
  const selectHour = useCallback(
    (cell: HeatmapCell) => {
      if (before === cell.endsAt) {
        setBefore(undefined);
        return;
      }
      setBefore(cell.endsAt);
      setRange((current) =>
        rangeForBefore(current, cell.endsAt, { now: Date.now(), timeZone }),
      );
      list.current?.scrollToOffset({
        offset: timelineOffset.current,
        animated: !reducedMotion,
      });
    },
    [before, timeZone, reducedMotion],
  );

  const heatmap = useMemo(
    () =>
      activity.status === 'ready'
        ? buildHeatmap(activity.data, { timeZone, now, days: ACTIVITY_DAYS })
        : undefined,
    [activity, timeZone, now],
  );
  const gaps = useMemo(() => coverageGaps(coverage), [coverage]);
  const visibleConversations = conversations.filter(
    (group) => !radioId || group.radioId === radioId,
  );
  const radioName = useCallback(
    (id: string) =>
      station.radios.find((radio) => radio.radioId === id)?.displayName ??
      `Radio ${id.slice(0, 6)}`,
    [station.radios],
  );
  const singleRadio =
    Boolean(scopedRadio) ||
    new Set(visibleConversations.map((group) => group.radioId)).size <= 1;

  const rows = historyRowsState({
    pageQuery,
    failedQuery,
    currentQuery: firstPage,
    busy,
    appending,
  });
  // Rows from another radio, conversation, or search are never shown as the
  // answer to a query that failed to load: `matchesFilters` cannot tell.
  const loadedItems = rows === 'failed' ? NO_ITEMS : page.items;
  const visibleItems = useMemo(
    () => loadedItems.filter((item) => matchesFilters(item, filters, scope)),
    [loadedItems, filters, scope],
  );
  const stale = rows !== 'current';
  // While a new first page loads the rows on screen answer an older query:
  // never treat them as complete, so coverage gaps are not extended past
  // what was actually loaded.
  const complete =
    rows === 'current' &&
    (!page.nextCursor || reachedRangeStart(page.items, filters, scope));
  const timeline = useMemo(
    () =>
      buildTimeline({
        items: visibleItems,
        gaps: showCoverageGaps(filters) ? gaps : [],
        complete,
        filters,
        scope,
        ...(loadedItems.length
          ? { oldestLoaded: loadedItems.at(-1)!.startedAt }
          : {}),
      }),
    [visibleItems, gaps, complete, filters, scope, loadedItems],
  );
  const filtered =
    direction !== 'all' ||
    range !== 'all' ||
    Boolean(before) ||
    Boolean(search) ||
    Boolean(conversation);

  // Search runs as the operator types: tell screen readers what it found.
  const resultStatus =
    rows !== 'current'
      ? ''
      : visibleItems.length === 0
        ? filtered
          ? 'No matching communications'
          : 'No communications'
        : `${communicationCount(visibleItems.length)}${complete ? '' : ' loaded'}`;
  useEffect(() => {
    if (resultStatus && Platform.OS === 'ios')
      AccessibilityInfo.announceForAccessibility(resultStatus);
  }, [resultStatus]);

  function clearFilters() {
    setDirection('all');
    setRange('all');
    setBefore(undefined);
    setConversation(null);
    changeSearch('');
  }

  const renderItem = ({ item }: { item: TimelineEntry }) => (
    // Rows from the previous query stay visible, dimmed, while a new one loads.
    <View style={stale ? { opacity: 0.6 } : undefined}>
      {renderEntry(item)}
    </View>
  );
  const renderEntry = (item: TimelineEntry) => {
    switch (item.type) {
      case 'day':
        return (
          <Text accessibilityRole="header" style={dayStyle(colors)}>
            {item.label}
          </Text>
        );
      case 'gap':
        return <CoverageGapRow gap={item.gap} timeZone={timeZone} />;
      default:
        return (
          <CommunicationRow
            item={item.communication}
            session={session}
            timeZone={timeZone}
            canWrite={canWrite(item.communication.radioId)}
            isAdministrator={isAdministrator}
            waveforms={waveforms}
            onMutate={mutate}
            {...(singleRadio
              ? {}
              : { radioLabel: radioName(item.communication.radioId) })}
          />
        );
    }
  };

  return (
    <FlatList
      ref={list}
      data={timeline}
      keyExtractor={(entry) => `${session.instanceId}:${entry.key}`}
      renderItem={renderItem}
      style={styles.screen}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      onScrollToIndexFailed={() => {}}
      ListHeaderComponent={
        <View style={styles.section}>
          <View style={styles.row}>
            <View style={{ flex: 1, gap: uiSpace.sm, minWidth: 200 }}>
              <Text style={styles.eyebrow}>Station archive</Text>
              <Text accessibilityRole="header" style={styles.title}>
                Communications
              </Text>
              <Text style={styles.muted}>
                Audio, transcripts, and notes grouped by their recorded source.
              </Text>
            </View>
            <Button label="Refresh" onPress={refresh} disabled={busy} />
          </View>

          <ActivitySection
            activity={activity}
            heatmap={heatmap}
            selectedEndsAt={before}
            onSelect={selectHour}
          />

          <HistoryFilterBar
            searchText={searchText}
            onSearchText={changeSearch}
            onSearchSubmit={() => debouncer.flush()}
            direction={direction}
            onDirection={setDirection}
            range={range}
            onRange={setRange}
            {...(before ? { before } : {})}
            onClearBefore={() => setBefore(undefined)}
            timeZone={timeZone}
            conversations={visibleConversations}
            {...(conversation ? { conversationId: conversation.id } : {})}
            onConversation={setConversation}
            radioName={radioName}
            singleRadio={singleRadio}
          />
          <Text
            role="status"
            aria-live="polite"
            accessibilityLiveRegion="polite"
            style={visuallyHidden}
          >
            {resultStatus}
          </Text>

          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {busy && (
            <ActivityIndicator
              accessibilityLabel="Loading communications"
              color={colors.primary}
            />
          )}
          {scopedRadio && canWrite(scopedRadio) && (
            <Disclosure title="Add station note">
              <TextInput
                accessibilityLabel="New station note"
                placeholder="Add a note for this radio and frequency"
                multiline
                value={newNote}
                onChangeText={setNewNote}
                style={styles.input}
              />
              <Text style={styles.small}>
                Notes are stored in the archive only; they are never
                transmitted.
              </Text>
              <Button
                label="Add note"
                onPress={() => void saveNote()}
                disabled={!newNote.trim()}
              />
            </Disclosure>
          )}
          {rows === 'current' && !visibleItems.length && (
            <View style={styles.empty}>
              {filtered ? (
                <>
                  <Text accessibilityRole="header" style={styles.heading}>
                    No matching communications
                  </Text>
                  <Text style={styles.muted}>
                    {page.nextCursor && !complete
                      ? 'Nothing matches in the loaded communications. Load earlier ones or change the filters.'
                      : 'Nothing matches these filters.'}
                  </Text>
                  <Button label="Clear filters" onPress={clearFilters} />
                </>
              ) : (
                <>
                  <Text accessibilityRole="header" style={styles.heading}>
                    No communications yet
                  </Text>
                  <Text style={styles.muted}>
                    Recordings appear when the connected radio receives or
                    transmits. Only the tuned frequency is monitored.
                  </Text>
                </>
              )}
            </View>
          )}
          <View
            onLayout={(event) => {
              timelineOffset.current = Math.max(
                0,
                event.nativeEvent.layout.y + uiSpace.lg,
              );
            }}
          />
        </View>
      }
      ListFooterComponent={
        <>
          {rows !== 'failed' && !!page.nextCursor && !complete && (
            <View style={{ paddingTop: uiSpace.lg }}>
              <Button
                label="Load earlier communications"
                onPress={() => void load(true)}
                loading={busy && appending}
                disabled={busy}
              />
            </View>
          )}
        </>
      }
    />
  );
}
export default HistoryScreen;

function ActivitySection({
  activity,
  heatmap,
  selectedEndsAt,
  onSelect,
}: {
  activity: ActivityState;
  heatmap: ReturnType<typeof buildHeatmap> | undefined;
  selectedEndsAt: string | undefined;
  onSelect(cell: HeatmapCell): void;
}) {
  const styles = useFeatureStyles('history');
  return (
    <View style={{ gap: uiSpace.sm }}>
      <Text accessibilityRole="header" style={styles.label}>
        Activity · last {ACTIVITY_DAYS} days
      </Text>
      {activity.status === 'ready' && heatmap ? (
        <ActivityHeatmap
          heatmap={heatmap}
          {...(selectedEndsAt ? { selectedEndsAt } : {})}
          onSelect={onSelect}
        />
      ) : activity.status === 'unsupported' ? (
        <Text style={styles.small}>
          The activity overview is not available on this server.
        </Text>
      ) : activity.status === 'error' ? (
        <Text style={styles.small}>{activity.message}</Text>
      ) : (
        <Text style={styles.small}>Loading activity…</Text>
      )}
    </View>
  );
}

function dayStyle(colors: ReturnType<typeof useTheme>['colors']) {
  return {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '700' as const,
    color: colors.textSecondary,
    paddingTop: uiSpace.lg,
    paddingBottom: uiSpace.xs,
  };
}
