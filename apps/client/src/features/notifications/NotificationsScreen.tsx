import { apiRequest } from '@signaldock/client-sdk';
import type {
  FeatureScreenProps,
  NotificationPreference,
  NotificationRecord,
} from '@signaldock/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Heading,
  LoadingState,
  SegmentedControl,
  Text,
  createStyles,
  layout,
  radius,
  space,
  type,
  useToast,
} from '@signaldock/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { deviceTimeZone } from '../history/history-model';
import { memoryDisplayName } from '../radios/components/memory-grid-model';
import { useStation } from '../station';
import { BrowserNotificationAdapter } from './browser-notifications';
import { NotificationInbox } from './NotificationInbox';
import { NotificationPreferences } from './NotificationPreferences';
import {
  appendOlderPage,
  buildFrequencyOptions,
  mergeRecentPage,
  preferenceBody,
  preferenceChanged,
  preferenceDraft,
  recentFrequencies,
  replaceNotification,
  unreadCount,
  type PreferenceDraft,
} from './notification-model';

interface NotificationPage {
  items: NotificationRecord[];
  nextCursor: string | null;
}
type ScreenView = 'inbox' | 'preferences';

/** Width of the screen's own area from which inbox and preferences sit side by side. */
const TWO_COLUMN_WIDTH = 960;
const RECENT_FREQUENCY_PAGE = 'communications?limit=50';

const message = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback;

/**
 * Notification inbox and preferences. Must be inside StationProvider (it reads
 * radio names, memories and current frequencies for the frequency filter);
 * ToastProvider is optional.
 */
export function NotificationsScreen({
  session,
  onSelectRadio,
}: FeatureScreenProps) {
  const styles = useStyles();
  const toast = useToast();
  const station = useStation();
  const deviceZone = useMemo(() => deviceTimeZone(), []);
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preference, setPreference] = useState<NotificationPreference | null>(
    null,
  );
  const [draft, setDraft] = useState<PreferenceDraft | null>(null);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [markingAll, setMarkingAll] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [relay, setRelay] = useState(false);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [browserStatus, setBrowserStatus] = useState('');
  const [recent, setRecent] = useState<number[]>([]);
  const [view, setView] = useState<ScreenView>('inbox');
  const [width, setWidth] = useState(0);
  const browser = useRef(new BrowserNotificationAdapter());
  const browserOn = useRef(false);
  browserOn.current = browserEnabled;
  const seen = useRef(new Set<string>());
  const generation = useRef(0);
  const loadedOlder = useRef(false);
  const selectRadio = useRef(onSelectRadio);
  selectRadio.current = onSelectRadio;

  const setRowBusy = (id: string, value: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });

  const markRead = useCallback(
    async (record: NotificationRecord): Promise<boolean> => {
      const current = generation.current;
      try {
        const updated = await apiRequest<NotificationRecord>(
          session,
          `notifications/${encodeURIComponent(record.id)}/read`,
          { method: 'POST' },
        );
        if (generation.current !== current) return false;
        setItems((values) => replaceNotification(values, updated));
        return true;
      } catch (failure) {
        if (current === generation.current)
          setError(message(failure, 'The notification could not be updated.'));
        return false;
      }
    },
    [session],
  );

  /** Marks the record read, then opens its radio (also used by browser alerts). */
  const open = useCallback(
    async (record: NotificationRecord) => {
      const current = generation.current;
      const marked = record.readAt ? true : await markRead(record);
      if (!marked || generation.current !== current) return;
      if (record.radioId) selectRadio.current?.(record.radioId);
    },
    [markRead],
  );
  const openRef = useRef(open);
  openRef.current = open;
  // Read the latest session inside the effect so a token refresh does not
  // reload the inbox or reset an unsaved preference draft.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let initial = true;
    seen.current = new Set();
    loadedOlder.current = false;
    setItems([]);
    setLoaded(false);
    setPreference(null);
    setDraft(null);
    setError('');
    setSaveError('');
    setCursor(null);
    setBusy(false);
    setBusyIds(new Set());
    setRecent([]);
    async function load() {
      try {
        const page = await apiRequest<NotificationPage>(
          sessionRef.current,
          'notifications',
          { signal: controller.signal },
        );
        if (current !== generation.current) return;
        for (const item of page.items) {
          // Only rows first seen after the initial load may raise a browser
          // alert, and only after the station admits them (quiet hours,
          // cooldown, listening and permissions are server decisions).
          if (!initial && browserOn.current && !seen.current.has(item.id)) {
            try {
              const admitted = await apiRequest<NotificationRecord | null>(
                sessionRef.current,
                `notifications/${encodeURIComponent(item.id)}/foreground`,
                { method: 'POST', signal: controller.signal },
              );
              if (current !== generation.current) return;
              if (admitted)
                browser.current.show(admitted, () => {
                  if (current === generation.current)
                    void openRef.current(admitted);
                });
            } catch (failure) {
              if (controller.signal.aborted) return;
              setError(
                message(failure, 'Browser alert admission is unavailable.'),
              );
            }
          }
          seen.current.add(item.id);
        }
        while (seen.current.size > 512) {
          const oldest = seen.current.values().next().value;
          if (oldest === undefined) break;
          seen.current.delete(oldest);
        }
        initial = false;
        setItems((values) =>
          mergeRecentPage(values, page.items, loadedOlder.current),
        );
        if (!loadedOlder.current) setCursor(page.nextCursor);
        setLoaded(true);
      } catch (failure) {
        if (!controller.signal.aborted && current === generation.current) {
          setError(message(failure, 'Notifications could not be loaded.'));
          setLoaded(true);
        }
      }
    }
    void load();
    void Promise.all([
      apiRequest<NotificationPreference>(
        sessionRef.current,
        'notification-preferences',
        {
          signal: controller.signal,
        },
      ),
      apiRequest<{ relayConfigured: boolean }>(
        sessionRef.current,
        'push/configuration',
        {
          signal: controller.signal,
        },
      ),
    ])
      .then(([value, configuration]) => {
        if (current !== generation.current) return;
        setPreference(value);
        setDraft(preferenceDraft(value, deviceZone));
        setRelay(configuration.relayConfigured);
      })
      .catch((failure) => {
        if (!controller.signal.aborted && current === generation.current)
          setError(message(failure, 'Preferences could not be loaded.'));
      });
    // Recent frequencies only feed the filter chips; accounts without
    // history access simply get no recent chips.
    void apiRequest<unknown>(sessionRef.current, RECENT_FREQUENCY_PAGE, {
      signal: controller.signal,
    })
      .then((page) => {
        if (current === generation.current) setRecent(recentFrequencies(page));
      })
      .catch(() => undefined);
    const timer = setInterval(() => {
      void load();
    }, 15000);
    const adapter = browser.current;
    return () => {
      controller.abort();
      clearInterval(timer);
      generation.current++;
      adapter.dispose();
    };
  }, [session.instanceId, session.baseUrl, session.user.id, deviceZone]);

  const changed = Boolean(
    preference && draft && preferenceChanged(preference, draft, deviceZone),
  );

  async function save() {
    if (!preference || !draft) return;
    const body = preferenceBody(preference, draft);
    if (!body.ok) {
      setSaveError(body.error);
      return;
    }
    setBusy(true);
    setSaveError('');
    const current = generation.current;
    try {
      const updated = await apiRequest<NotificationPreference>(
        session,
        'notification-preferences',
        { method: 'PUT', body: JSON.stringify(body.value) },
      );
      if (current !== generation.current) return;
      setPreference(updated);
      setDraft(preferenceDraft(updated, deviceZone));
      toast.show({
        message: 'Notification preferences saved.',
        tone: 'success',
      });
    } catch (failure) {
      if (current === generation.current)
        setSaveError(message(failure, 'Preferences could not be saved.'));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function revert() {
    if (!preference) return;
    setDraft(preferenceDraft(preference, deviceZone));
    setSaveError('');
  }
  async function more() {
    if (!cursor) return;
    const current = generation.current;
    setLoadingOlder(true);
    try {
      const page = await apiRequest<NotificationPage>(
        session,
        `notifications?cursor=${encodeURIComponent(cursor)}`,
      );
      if (current === generation.current) {
        loadedOlder.current = true;
        setItems((values) => appendOlderPage(values, page.items));
        setCursor(page.nextCursor);
      }
    } catch (failure) {
      if (current === generation.current)
        setError(message(failure, 'Older notifications could not be loaded.'));
    } finally {
      if (current === generation.current) setLoadingOlder(false);
    }
  }
  async function enableBrowser() {
    const result = await browser.current.requestPermission();
    setBrowserStatus(
      result === 'granted'
        ? 'Foreground browser alerts enabled.'
        : result === 'unsupported'
          ? 'Browser alerts are unavailable on this client.'
          : 'Browser notification permission was not granted.',
    );
    setBrowserEnabled(result === 'granted');
  }
  async function markOne(record: NotificationRecord) {
    setRowBusy(record.id, true);
    try {
      await markRead(record);
    } finally {
      setRowBusy(record.id, false);
    }
  }
  async function openRadio(record: NotificationRecord) {
    setRowBusy(record.id, true);
    try {
      await open(record);
    } finally {
      setRowBusy(record.id, false);
    }
  }
  async function markAll() {
    const current = generation.current;
    setMarkingAll(true);
    try {
      for (const record of items.filter((item) => !item.readAt)) {
        if (generation.current !== current) return;
        if (!(await markRead(record))) break;
      }
    } finally {
      if (generation.current === current) setMarkingAll(false);
    }
  }

  const radioNames = useMemo(
    () =>
      new Map(
        station.radios.map((radio) => [radio.radioId, radio.displayName]),
      ),
    [station.radios],
  );
  const radioName = useCallback(
    (radioId: string) => radioNames.get(radioId),
    [radioNames],
  );
  const frequencyOptions = useMemo(
    () =>
      buildFrequencyOptions({
        memories: station.memories.map((memory) => ({
          name: memoryDisplayName(memory),
          hz: memory.tuning.rxHz,
        })),
        radios: station.radios.flatMap((radio) => {
          const tuning = radio.snapshot?.observedTuning;
          return tuning && radio.snapshot?.tuningConfidence !== 'unknown'
            ? [{ name: radio.displayName, hz: tuning.rxHz }]
            : [];
        }),
        recent,
        selectedHz: draft?.frequencyHz,
      }),
    [station.memories, station.radios, recent, draft?.frequencyHz],
  );

  const unread = unreadCount(items);
  const twoColumns = width >= TWO_COLUMN_WIDTH;
  const showInbox = twoColumns || view === 'inbox';
  const showPreferences = twoColumns || view === 'preferences';

  const inbox = (
    <View style={styles.column}>
      <View style={styles.columnHeader}>
        <Heading>Inbox</Heading>
        {unread > 0 ? (
          <View style={styles.headerActions}>
            <Badge label={`${unread} unread`} tone="primary" />
            <Button
              label="Mark all read"
              variant="quiet"
              loading={markingAll}
              onPress={() => {
                void markAll();
              }}
            />
          </View>
        ) : (
          items.length > 0 && <Text style={styles.caption}>All read</Text>
        )}
      </View>
      {!loaded ? (
        <LoadingState label="Loading notifications…" />
      ) : !items.length ? (
        <EmptyState
          title="No notifications yet"
          message="Updates from this station appear here. Radio content is fetched only after you open an item."
        />
      ) : (
        <NotificationInbox
          items={items}
          timeZone={deviceZone}
          now={Date.now()}
          relayConfigured={relay}
          radioName={radioName}
          busyIds={busyIds}
          onMarkRead={(record) => {
            void markOne(record);
          }}
          {...(onSelectRadio
            ? {
                onOpenRadio: (record: NotificationRecord) => {
                  void openRadio(record);
                },
              }
            : {})}
        />
      )}
      {!!cursor && (
        <Button
          label="Load older updates"
          loading={loadingOlder}
          onPress={() => {
            void more();
          }}
        />
      )}
    </View>
  );

  const preferences = (
    <View style={styles.column}>
      <View style={styles.columnHeader}>
        <Heading>Preferences</Heading>
        {changed && <Badge label="Unsaved changes" tone="warning" />}
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Delivery</Text>
        <Text style={styles.caption}>
          {relay
            ? 'A relay is configured for enrolled devices.'
            : 'In-app history is available. Mobile delivery has no configured relay.'}{' '}
          Browser alerts appear while this app is open.
        </Text>
        <Button
          label={browserEnabled ? 'Browser alerts on' : 'Enable browser alerts'}
          active={browserEnabled}
          onPress={() => {
            void enableBrowser();
          }}
        />
        {!!browserStatus && <Text style={styles.caption}>{browserStatus}</Text>}
      </View>
      {draft ? (
        <>
          <NotificationPreferences
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setSaveError('');
            }}
            deviceZone={deviceZone}
            frequencyOptions={frequencyOptions}
            disabled={busy}
          />
          <View style={[styles.saveBar, changed && styles.saveBarChanged]}>
            <Text style={styles.caption}>
              {changed ? 'You have unsaved changes.' : 'All changes saved.'}
            </Text>
            {!!saveError && (
              <Text accessibilityRole="alert" style={styles.error}>
                {saveError}
              </Text>
            )}
            <View style={styles.headerActions}>
              <Button
                label="Revert"
                variant="quiet"
                disabled={!changed || busy}
                onPress={revert}
              />
              <Button
                label="Save preferences"
                variant="primary"
                disabled={!changed}
                loading={busy}
                onPress={() => {
                  void save();
                }}
              />
            </View>
          </View>
        </>
      ) : (
        !error && <LoadingState label="Loading preferences…" />
      )}
    </View>
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={styles.content}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        <View style={styles.intro}>
          <Text accessibilityRole="header" style={styles.title}>
            Notifications
          </Text>
          <Text style={styles.muted}>
            Updates from this station. Radio content is fetched only after you
            open an item.
          </Text>
        </View>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {!twoColumns && (
          <SegmentedControl
            accessibilityLabel="Notifications view"
            value={view}
            onChange={setView}
            options={[
              {
                value: 'inbox',
                label: unread ? `Inbox · ${unread}` : 'Inbox',
                accessibilityLabel: unread
                  ? `Inbox, ${unread} unread`
                  : 'Inbox',
              },
              {
                value: 'preferences',
                label: changed ? 'Preferences · unsaved' : 'Preferences',
                accessibilityLabel: changed
                  ? 'Preferences, unsaved changes'
                  : 'Preferences',
              },
            ]}
          />
        )}
        <View style={twoColumns ? styles.columns : styles.stack}>
          {showInbox && (
            <View style={twoColumns && styles.inboxColumn}>{inbox}</View>
          )}
          {showPreferences && (
            <View style={twoColumns && styles.preferencesColumn}>
              {preferences}
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  );
}
export default NotificationsScreen;

const useStyles = createStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  page: { paddingBottom: space.xxxl },
  content: {
    width: '100%',
    maxWidth: layout.content,
    alignSelf: 'center',
    padding: space.lg,
    gap: space.lg,
  },
  intro: { gap: space.xs },
  title: { ...type.title, color: c.textPrimary },
  muted: { ...type.body, color: c.textSecondary },
  caption: { ...type.caption, color: c.textSecondary },
  label: { ...type.label, color: c.textPrimary },
  error: { ...type.body, color: c.error },
  stack: { gap: space.xl },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xl },
  inboxColumn: { flex: 3, minWidth: 0 },
  preferencesColumn: { flex: 2, minWidth: 0 },
  column: { gap: space.lg },
  columnHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  headerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  card: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: c.surface,
  },
  saveBar: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  saveBarChanged: { borderColor: c.warning },
}));
