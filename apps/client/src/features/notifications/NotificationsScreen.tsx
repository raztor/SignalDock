import { apiRequest } from '@signaldock/client-sdk';
import type {
  FeatureScreenProps,
  NotificationCategory,
  NotificationPreference,
  NotificationRecord,
} from '@signaldock/contracts';
import {
  Disclosure,
  Pressable,
  SettingToggle,
  Text,
  TextInput,
  useFeatureStyles,
} from '@signaldock/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { BrowserNotificationAdapter } from './browser-notifications';

const categories: NotificationCategory[] = [
  'communication',
  'transcript',
  'incident',
  'control',
  'radio',
  'storage',
  'processing',
];
interface NotificationPage {
  items: NotificationRecord[];
  nextCursor: string | null;
}
export function NotificationsScreen({
  session,
  onSelectRadio,
}: FeatureScreenProps) {
  const styles = useFeatureStyles('notifications');
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [preference, setPreference] = useState<NotificationPreference | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [relay, setRelay] = useState(false);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [browserStatus, setBrowserStatus] = useState('');
  const [frequency, setFrequency] = useState('');
  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  const [timeZone, setTimeZone] = useState('UTC');
  const browser = useRef(new BrowserNotificationAdapter());
  const seen = useRef(new Set<string>());
  const generation = useRef(0);
  const loadedOlder = useRef(false);
  const selectRadio = useRef(onSelectRadio);
  selectRadio.current = onSelectRadio;

  const open = useCallback(
    async (record: NotificationRecord) => {
      const current = generation.current;
      try {
        const updated = await apiRequest<NotificationRecord>(
          session,
          `notifications/${encodeURIComponent(record.id)}/read`,
          { method: 'POST' },
        );
        if (generation.current !== current) return;
        setItems((values) =>
          values.map((item) => (item.id === updated.id ? updated : item)),
        );
        if (record.radioId) selectRadio.current?.(record.radioId);
      } catch (failure) {
        if (current === generation.current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'The notification could not be opened.',
          );
      }
    },
    [session],
  );

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let initial = true;
    seen.current = new Set();
    loadedOlder.current = false;
    setItems([]);
    setPreference(null);
    setError('');
    setCursor(null);
    setBusy(false);
    async function load() {
      try {
        const page = await apiRequest<NotificationPage>(
          session,
          'notifications',
          { signal: controller.signal },
        );
        if (current !== generation.current) return;
        for (const item of page.items) {
          if (!initial && browserEnabled && !seen.current.has(item.id)) {
            try {
              const admitted = await apiRequest<NotificationRecord | null>(
                session,
                `notifications/${encodeURIComponent(item.id)}/foreground`,
                { method: 'POST', signal: controller.signal },
              );
              if (current !== generation.current) return;
              if (admitted)
                browser.current.show(admitted, () => {
                  if (current === generation.current) void open(admitted);
                });
            } catch (failure) {
              if (controller.signal.aborted) return;
              setError(
                failure instanceof Error
                  ? failure.message
                  : 'Browser alert admission is unavailable.',
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
          loadedOlder.current
            ? [
                ...page.items,
                ...values.filter(
                  (item) => !page.items.some((recent) => recent.id === item.id),
                ),
              ]
            : page.items,
        );
        if (!loadedOlder.current) setCursor(page.nextCursor);
      } catch (failure) {
        if (!controller.signal.aborted && current === generation.current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Notifications could not be loaded.',
          );
      }
    }
    void load();
    void Promise.all([
      apiRequest<NotificationPreference>(session, 'notification-preferences', {
        signal: controller.signal,
      }),
      apiRequest<{ relayConfigured: boolean }>(session, 'push/configuration', {
        signal: controller.signal,
      }),
    ])
      .then(([value, configuration]) => {
        if (current !== generation.current) return;
        setPreference(value);
        setRelay(configuration.relayConfigured);
        setFrequency(
          value.frequencyHz === undefined ? '' : String(value.frequencyHz),
        );
        setQuietStart(value.quietHours?.start ?? '');
        setQuietEnd(value.quietHours?.end ?? '');
        setTimeZone(value.quietHours?.timeZone ?? 'UTC');
      })
      .catch((failure) => {
        if (!controller.signal.aborted && current === generation.current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Preferences could not be loaded.',
          );
      });
    const timer = setInterval(() => {
      void load();
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
      generation.current++;
      browser.current.dispose();
    };
  }, [
    session.instanceId,
    session.baseUrl,
    session.accessToken,
    session.user.id,
    browserEnabled,
    open,
  ]);

  async function save() {
    if (!preference) return;
    setBusy(true);
    setError('');
    const current = generation.current;
    try {
      const parsedFrequency = frequency.trim() ? Number(frequency) : undefined;
      if (
        parsedFrequency !== undefined &&
        (!Number.isSafeInteger(parsedFrequency) || parsedFrequency <= 0)
      )
        throw new Error('Frequency must be a positive integer in Hz.');
      if ((quietStart && !quietEnd) || (!quietStart && quietEnd))
        throw new Error('Provide both quiet-hour times, or leave both empty.');
      const {
        frequencyHz: _oldFrequency,
        quietHours: _oldQuiet,
        ...rest
      } = preference;
      const value = {
        ...rest,
        ...(parsedFrequency === undefined
          ? {}
          : { frequencyHz: parsedFrequency }),
        ...(quietStart && quietEnd
          ? { quietHours: { start: quietStart, end: quietEnd, timeZone } }
          : {}),
      };
      const updated = await apiRequest<NotificationPreference>(
        session,
        'notification-preferences',
        { method: 'PUT', body: JSON.stringify(value) },
      );
      if (current === generation.current) setPreference(updated);
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Preferences could not be saved.',
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function more() {
    if (!cursor) return;
    const current = generation.current;
    try {
      const page = await apiRequest<NotificationPage>(
        session,
        `notifications?cursor=${encodeURIComponent(cursor)}`,
      );
      if (current === generation.current) {
        loadedOlder.current = true;
        setItems((values) => [
          ...values,
          ...page.items.filter(
            (item) => !values.some((existing) => existing.id === item.id),
          ),
        ]);
        setCursor(page.nextCursor);
      }
    } catch (failure) {
      if (current === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Older notifications could not be loaded.',
        );
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
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          key={item.id}
          style={styles.card}
          onPress={() => {
            void open(item);
          }}
        >
          <Text accessibilityRole="header" style={styles.heading}>
            {item.category}
            {item.readAt ? '' : ' · unread'}
          </Text>
          <Text style={styles.muted}>
            {new Date(item.createdAt).toLocaleString()}
          </Text>
          <Text style={styles.muted}>
            {!relay && item.deliveryState === 'queued'
              ? 'Stored in station history'
              : item.deliveryState.replaceAll('_', ' ')}
          </Text>
          {item.radioId && (
            <Text style={styles.muted}>Radio {item.radioId}</Text>
          )}
        </Pressable>
      )}
      style={styles.screen}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.title}>
            Notifications
          </Text>
          <Text style={styles.muted}>
            Updates from this station. Radio content is fetched only after you
            open an item.
          </Text>
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <Text accessibilityRole="header" style={styles.heading}>
            Station history
          </Text>
          {!items.length && (
            <Text style={styles.muted}>No notifications yet.</Text>
          )}
        </View>
      }
      ListFooterComponent={
        <View style={styles.section}>
          {!!cursor && (
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => {
                void more();
              }}
            >
              <Text style={styles.buttonText}>Load older updates</Text>
            </Pressable>
          )}
          <Disclosure title="Delivery & notification preferences">
            <View style={styles.card}>
              <Text accessibilityRole="header" style={styles.heading}>
                Delivery
              </Text>
              <Text style={styles.muted}>
                {relay
                  ? 'A relay is configured for enrolled devices.'
                  : 'In-app history is available. Mobile delivery has no configured relay.'}
              </Text>
              <Text style={styles.muted}>
                Browser alerts appear while this app is open. Device
                notifications depend on your station’s delivery settings.
              </Text>
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => {
                  void enableBrowser();
                }}
              >
                <Text style={styles.buttonText}>Enable browser alerts</Text>
              </Pressable>
              {!!browserStatus && (
                <Text style={styles.muted}>{browserStatus}</Text>
              )}
            </View>
            {preference ? (
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.heading}>
                  Preferences
                </Text>
                <SettingToggle
                  label="Notifications enabled"
                  value={preference.enabled}
                  onValueChange={(enabled) =>
                    setPreference({ ...preference, enabled })
                  }
                />
                {categories.map((category) => (
                  <SettingToggle
                    key={category}
                    label={`${category} notifications`}
                    value={preference.categories.includes(category)}
                    onValueChange={(enabled) =>
                      setPreference({
                        ...preference,
                        categories: enabled
                          ? [...preference.categories, category]
                          : preference.categories.filter(
                              (value) => value !== category,
                            ),
                      })
                    }
                  />
                ))}
                <SettingToggle
                  label="Suppress ordinary pushes while listening"
                  value={preference.suppressWhileListening}
                  onValueChange={(suppressWhileListening) =>
                    setPreference({ ...preference, suppressWhileListening })
                  }
                />
                <Text style={styles.label}>
                  Frequency filter (Hz, optional)
                </Text>
                <TextInput
                  accessibilityLabel="Frequency filter in Hz"
                  style={styles.input}
                  value={frequency}
                  onChangeText={setFrequency}
                  keyboardType="numeric"
                />
                <Text style={styles.label}>Cooldown (seconds)</Text>
                <TextInput
                  accessibilityLabel="Cooldown seconds"
                  style={styles.input}
                  value={String(preference.cooldownSeconds)}
                  onChangeText={(text) => {
                    if (/^\d*$/.test(text))
                      setPreference({
                        ...preference,
                        cooldownSeconds: Number(text),
                      });
                  }}
                  keyboardType="numeric"
                />
                <Text style={styles.label}>Quiet hours (HH:MM, optional)</Text>
                <View style={styles.row}>
                  <TextInput
                    accessibilityLabel="Quiet hours start"
                    style={[styles.input, styles.grow]}
                    value={quietStart}
                    onChangeText={setQuietStart}
                    placeholder="22:00"
                  />
                  <TextInput
                    accessibilityLabel="Quiet hours end"
                    style={[styles.input, styles.grow]}
                    value={quietEnd}
                    onChangeText={setQuietEnd}
                    placeholder="07:00"
                  />
                </View>
                <TextInput
                  accessibilityLabel="Quiet hours time zone"
                  style={styles.input}
                  value={timeZone}
                  onChangeText={setTimeZone}
                  autoCapitalize="none"
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  style={styles.button}
                  onPress={() => {
                    void save();
                  }}
                >
                  {busy ? (
                    <ActivityIndicator />
                  ) : (
                    <Text style={styles.buttonText}>Save preferences</Text>
                  )}
                </Pressable>
              </View>
            ) : (
              <ActivityIndicator />
            )}
          </Disclosure>
        </View>
      }
    />
  );
}
export default NotificationsScreen;
