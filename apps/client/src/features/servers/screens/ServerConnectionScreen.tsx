import { normalizeServerUrl, SignalDockClient } from '@signaldock/client-sdk';
import type { RecentServer, ServerInfo } from '@signaldock/contracts';
import {
  Button,
  ConfirmDialog,
  createStyles,
  FormLayout,
  Heading,
  Icon,
  layout,
  Pressable,
  ScrollView,
  space,
  StatusIndicator,
  Text,
  TextInput,
  radius as uiRadius,
  type as uiType,
  useTheme,
} from '@signaldock/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { DEFAULT_SERVER_URL } from '../../../shared/config/defaults';
import { QrScanButton } from '../components/QrScanButton';
import { RecentStationCard } from '../components/RecentStationCard';
import { recentServerStore as store } from '../data/recent-server-store';
import {
  CONNECT_TIMEOUT_MS,
  healthFromInfo,
  healthPresentation,
  normalizeStationInput,
  sortRecentStations,
} from '../server-model';
import { useStationHealth } from '../use-station-health';

export interface ServerConnectionScreenProps {
  onServerSelected?: (
    baseUrl: string,
    info: ServerInfo,
  ) => void | Promise<void>;
  onServerRemoved?: (server: RecentServer) => void | Promise<void>;
}
export default function ServerConnectionScreen({
  onServerSelected,
  onServerRemoved,
}: ServerConnectionScreenProps = {}) {
  const { width } = useWindowDimensions();
  const compact = width < layout.compact;
  const styles = useConnectionStyles();
  const { mode, setPreference, colors } = useTheme();
  const [removing, setRemoving] = useState<RecentServer | null>(null);
  const [url, setUrl] = useState(DEFAULT_SERVER_URL);
  /** Show validation once the field was left or a connection was attempted. */
  const [touched, setTouched] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [recent, setRecent] = useState<RecentServer[]>([]);
  const [result, setResult] = useState<ServerInfo | null>(null);
  const [busy, setBusy] = useState(false);
  /** Canonical URL of the connection attempt in progress. */
  const [connecting, setConnecting] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const request = useRef({ generation: 0, controller: new AbortController() });
  const stations = useMemo(() => sortRecentStations(recent), [recent]);
  const { health, refresh, markOnline } = useStationHealth(stations);
  const check = normalizeStationInput(url);
  const inputError = !check.ok && touched ? check.error : '';

  useEffect(() => {
    let active = true;
    void store
      .list()
      .then((servers) => {
        if (active) setRecent(servers);
      })
      .catch(() => {
        if (active) setError('Recent servers could not be loaded.');
      });
    // "Last used" labels stay current while the screen is open.
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      active = false;
      clearInterval(clock);
      request.current.controller.abort();
      request.current.generation++;
    };
  }, []);

  function resetConnection() {
    request.current.controller.abort();
    request.current = {
      generation: request.current.generation + 1,
      controller: new AbortController(),
    };
    setResult(null);
    setError('');
    setBusy(false);
    setConnecting('');
  }

  async function connect(target = url) {
    resetConnection();
    setUrl(target);
    const address = normalizeStationInput(target);
    if (!address.ok) {
      setTouched(true);
      return;
    }
    const current = request.current;
    setBusy(true);
    setConnecting(address.url);
    const timer = setTimeout(
      () => current.controller.abort(),
      CONNECT_TIMEOUT_MS,
    );
    let saved: RecentServer | undefined;
    try {
      const client = new SignalDockClient(address.url);
      saved = (await store.list()).find(
        (server) => server.baseUrl === client.baseUrl,
      );
      const info = await client.discover({
        signal: current.controller.signal,
        ...(saved ? { expected: saved } : {}),
      });
      if (request.current.generation !== current.generation) return;
      await store.remember(client.baseUrl, info);
      if (request.current.generation !== current.generation) return;
      setResult(info);
      setRecent(await store.list());
      markOnline(client.baseUrl, info);
      if (
        request.current.generation === current.generation &&
        onServerSelected &&
        info.features.authentication === 'local'
      )
        await onServerSelected(client.baseUrl, info);
    } catch (failure) {
      if (request.current.generation === current.generation) {
        setError(
          current.controller.signal.aborted
            ? 'The connection timed out. Check the URL and network access.'
            : failure instanceof TypeError
              ? 'The station could not be reached.'
              : failure instanceof Error
                ? failure.message
                : 'The server could not be reached.',
        );
        // Keep the saved card's status in step with what just happened.
        if (saved) refresh(saved.baseUrl);
      }
    } finally {
      clearTimeout(timer);
      if (request.current.generation === current.generation) {
        setBusy(false);
        setConnecting('');
      }
    }
  }

  async function remove(server: RecentServer) {
    try {
      if (normalizeServerUrl(url) === server.baseUrl) resetConnection();
    } catch {
      /* An incomplete input cannot identify an active server. */
    }
    try {
      let removalError = '';
      try {
        await onServerRemoved?.(server);
      } catch {
        removalError =
          'Forgot this server locally. Its session revocation could not be confirmed.';
      }
      await store.remove(server.baseUrl);
      setRecent(await store.list());
      if (removalError) setError(removalError);
    } catch {
      setError('The saved server could not be removed.');
    }
  }

  /** Only worth saying when a scheme was added for the person. */
  const preview =
    check.ok && check.schemeAdded ? `Connects to ${check.url}` : '';
  const resultStatus = result
    ? healthPresentation(healthFromInfo(result))
    : undefined;

  return (
    <FormLayout>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <Icon name="radio" color={colors.primary} size={24} />
            <Heading>SignalDock</Heading>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch color theme"
            onPress={() => setPreference(mode === 'dark' ? 'light' : 'dark')}
            style={styles.theme}
          >
            <Icon name={mode === 'dark' ? 'sun' : 'moon'} />
          </Pressable>
        </View>
        <View
          style={[
            styles.layout,
            compact && {
              flexDirection: 'column',
              gap: space.xl,
              paddingVertical: space.lg,
              alignItems: 'stretch',
            },
          ]}
        >
          <View
            style={[
              styles.intro,
              compact && { flexBasis: 'auto', flexGrow: 0 },
            ]}
          >
            <Text style={styles.kicker}>Your station, connected.</Text>
            <Text accessibilityRole="header" style={styles.title}>
              A clear connection{'\n'}to your radio.
            </Text>
            <Text style={styles.description}>
              Listen, operate and keep track of your station from one workspace.
            </Text>
            <View style={styles.note}>
              <Icon name="server" />
              <Text style={styles.muted}>
                Connect to your own server. Your station data stays with that
                instance.
              </Text>
            </View>
          </View>
          <View
            style={[
              styles.form,
              compact && {
                flexBasis: 'auto',
                width: '100%',
                maxWidth: '100%',
                flexGrow: 0,
                padding: space.lg,
              },
            ]}
          >
            <View style={styles.formHeader}>
              <Heading>Connect to a station</Heading>
              <Text style={styles.muted}>
                Use the address provided by your station administrator.
              </Text>
            </View>
            {stations.length > 0 && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View style={styles.grow}>
                    <Text accessibilityRole="header" style={styles.label}>
                      Recent stations
                    </Text>
                    <Text style={styles.hint}>Saved on this device</Text>
                  </View>
                  <Button
                    label="Check again"
                    variant="quiet"
                    onPress={() => refresh()}
                  />
                </View>
                {stations.map((server) => (
                  <RecentStationCard
                    key={server.baseUrl}
                    server={server}
                    health={health[server.baseUrl]}
                    now={now}
                    connecting={connecting === server.baseUrl}
                    disabled={busy}
                    onConnect={() => {
                      setScanned(false);
                      setTouched(false);
                      void connect(server.baseUrl);
                    }}
                    onForget={() => setRemoving(server)}
                  />
                ))}
              </View>
            )}
            <View
              style={[styles.section, stations.length > 0 && styles.divided]}
            >
              <Text style={styles.label}>
                {stations.length ? 'Another station' : 'Station address'}
              </Text>
              <TextInput
                accessibilityLabel="Server URL"
                accessibilityHint="For example radio.example.com. https:// is added when missing."
                value={url}
                onChangeText={(value) => {
                  resetConnection();
                  setScanned(false);
                  setTouched(false);
                  setUrl(value);
                }}
                onBlur={() => {
                  if (url.trim()) setTouched(true);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                textContentType="URL"
                placeholder="radio.example.com"
                returnKeyType="go"
                onSubmitEditing={() => {
                  if (!busy) void connect();
                }}
                style={inputError ? { borderColor: colors.error } : undefined}
              />
              {inputError ? (
                <Text accessibilityRole="alert" style={styles.inlineError}>
                  {inputError}
                </Text>
              ) : scanned ? (
                <Text accessibilityLiveRegion="polite" style={styles.hint}>
                  Address read from a QR code. Check it, then connect.
                </Text>
              ) : preview ? (
                <Text style={styles.hint}>{preview}</Text>
              ) : (
                <Text style={styles.hint}>
                  Include any deployment prefix. https:// is added when missing.
                </Text>
              )}
              <View style={styles.actions}>
                <Button
                  label="Connect"
                  loading={busy && connecting === (check.ok ? check.url : '')}
                  disabled={busy}
                  variant="primary"
                  onPress={() => {
                    void connect();
                  }}
                />
                <QrScanButton
                  disabled={busy}
                  onScanned={(scannedUrl) => {
                    resetConnection();
                    setTouched(false);
                    setUrl(scannedUrl);
                    setScanned(true);
                  }}
                />
              </View>
            </View>
            {!!error && (
              <View style={[styles.feedback, { borderColor: colors.error }]}>
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
                <Text style={styles.muted}>
                  Check the address and network connection, then try again.
                </Text>
              </View>
            )}
            {result && resultStatus && (
              <View style={styles.feedback}>
                <Heading>{result.displayName}</Heading>
                <StatusIndicator
                  tone={resultStatus.tone}
                  label={`${resultStatus.label} · Protocol ${result.protocol.min}–${result.protocol.max}`}
                />
                <Text selectable style={styles.hint}>
                  {result.identity.keyId}
                </Text>
                <Text style={styles.muted}>
                  {result.features.authentication === 'local'
                    ? 'Server reached. Continue with your station account.'
                    : 'Server reached. Sign-in is not available on this instance.'}
                </Text>
              </View>
            )}
            {!stations.length && (
              <View style={[styles.empty, styles.divided]}>
                <Icon name="clock" color={colors.textSecondary} />
                <View style={styles.grow}>
                  <Text style={styles.label}>
                    Your next connection starts here
                  </Text>
                  <Text style={styles.hint}>
                    Stations you connect to appear here with their live status
                    for one-tap access.
                  </Text>
                </View>
              </View>
            )}
          </View>
        </View>
        <Text style={styles.footer}>
          Self-hosted radio operations · Open source
        </Text>
        <ConfirmDialog
          visible={Boolean(removing)}
          title="Forget this station?"
          message="This removes its saved connection and signs out its session on this device."
          confirmLabel="Forget station"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            if (removing) void remove(removing);
            setRemoving(null);
          }}
        />
      </ScrollView>
    </FormLayout>
  );
}
const useConnectionStyles = createStyles((c) => ({
  page: {
    flexGrow: 1,
    width: '100%',
    maxWidth: layout.content,
    alignSelf: 'center',
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.lg,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  theme: { width: layout.touch, alignItems: 'center' },
  layout: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xxxl,
    paddingVertical: space.xxl,
    flex: 1,
    alignItems: 'center',
  },
  intro: { flexBasis: 300, flexGrow: 1, gap: space.lg },
  kicker: {
    color: c.primary,
    fontSize: uiType.label.fontSize,
    fontWeight: '600',
  },
  title: {
    color: c.textPrimary,
    fontSize: uiType.display.fontSize,
    lineHeight: 44,
    fontWeight: '700',
    letterSpacing: -1.2,
  },
  description: {
    color: c.textSecondary,
    fontSize: uiType.body.fontSize,
    lineHeight: 26,
    maxWidth: 360,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    marginTop: space.lg,
    maxWidth: 360,
  },
  form: {
    flexBasis: 360,
    flexGrow: 1,
    maxWidth: layout.form,
    gap: space.lg,
    backgroundColor: c.surface,
    borderRadius: uiRadius.lg,
    padding: space.xl,
  },
  formHeader: { gap: space.sm },
  section: { gap: space.sm },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  divided: {
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  grow: { flex: 1, minWidth: 0, gap: space.xs },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xs,
  },
  label: {
    color: c.textPrimary,
    fontSize: uiType.label.fontSize,
    fontWeight: '600',
  },
  muted: {
    color: c.textSecondary,
    fontSize: uiType.body.fontSize,
    lineHeight: 23,
  },
  hint: {
    color: c.textSecondary,
    fontSize: uiType.caption.fontSize,
    lineHeight: 18,
  },
  inlineError: {
    color: c.error,
    fontSize: uiType.caption.fontSize,
    lineHeight: 18,
  },
  feedback: {
    borderLeftWidth: 2,
    borderColor: c.primary,
    paddingLeft: space.lg,
    gap: space.sm,
  },
  empty: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  error: { color: c.error },
  footer: {
    fontSize: uiType.caption.fontSize,
    color: c.textSecondary,
    paddingVertical: space.md,
  },
}));
