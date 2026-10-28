import { normalizeServerUrl, SignalDockClient } from '@signaldock/client-sdk';
import type { RecentServer, ServerInfo } from '@signaldock/contracts';
import {
  Button,
  ConfirmDialog,
  createStyles,
  EmptyState,
  FormLayout,
  Heading,
  Icon,
  layout,
  Pressable,
  ScrollView,
  space,
  Text,
  TextInput,
  radius as uiRadius,
  type as uiType,
  useTheme,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { DEFAULT_SERVER_URL } from '../../../shared/config/defaults';
import { recentServerStore as store } from '../data/recent-server-store';

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
  const [recent, setRecent] = useState<RecentServer[]>([]);
  const [result, setResult] = useState<ServerInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef({ generation: 0, controller: new AbortController() });

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
    return () => {
      active = false;
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
  }

  async function connect(target = url) {
    resetConnection();
    const current = request.current;
    setUrl(target);
    setBusy(true);
    const timer = setTimeout(() => current.controller.abort(), 10000);
    try {
      const client = new SignalDockClient(target);
      const saved = (await store.list()).find(
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
      }
    } finally {
      clearTimeout(timer);
      if (request.current.generation === current.generation) setBusy(false);
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
              <Heading>Connect to a server</Heading>
              <Text style={styles.muted}>
                Use the address provided by your station administrator.
              </Text>
            </View>
            <Text style={styles.label}>Server address</Text>
            <TextInput
              accessibilityLabel="Server URL"
              value={url}
              onChangeText={(value) => {
                resetConnection();
                setUrl(value);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://radio.example.com"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (!busy) void connect();
              }}
            />
            <Button
              label="Connect to station"
              loading={busy}
              variant="primary"
              onPress={() => {
                void connect();
              }}
            />
            <Text style={styles.hint}>
              Include the full address and any deployment prefix.
            </Text>
            {!!error && (
              <View style={styles.feedback}>
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
                <Text style={styles.muted}>
                  Check the address and network connection, then try again.
                </Text>
              </View>
            )}
            {result && (
              <View style={styles.feedback}>
                <Heading>{result.displayName}</Heading>
                <Text style={styles.muted}>
                  Version {result.version} · Protocol {result.protocol.min}–
                  {result.protocol.max}
                </Text>
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
            <View style={styles.recentHeader}>
              <Heading>Recent stations</Heading>
              <Text style={styles.hint}>Saved on this device</Text>
            </View>
            {!recent.length ? (
              <EmptyState
                title="Your next connection starts here"
                message="Connected stations will appear here for quick access."
              />
            ) : (
              recent.map((server) => (
                <View key={server.baseUrl} style={styles.recent}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    accessibilityLabel={`Connect to ${server.alias}`}
                    onPress={() => {
                      void connect(server.baseUrl);
                    }}
                    style={styles.recentMain}
                  >
                    <Text style={styles.label}>{server.alias}</Text>
                    <Text numberOfLines={2} style={styles.hint}>
                      {server.baseUrl}
                    </Text>
                  </Pressable>
                  <Button
                    label="Forget"
                    variant="quiet"
                    onPress={() => setRemoving(server)}
                  />
                </View>
              ))
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
    gap: space.md,
    backgroundColor: c.surface,
    borderRadius: uiRadius.lg,
    padding: space.xl,
  },
  formHeader: { gap: space.sm, marginBottom: space.md },
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
  recentHeader: {
    gap: space.xs,
    paddingTop: space.xl,
    marginTop: space.md,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  recent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderBottomWidth: 1,
    borderColor: c.border,
    paddingVertical: space.sm,
  },
  recentMain: { flex: 1, minWidth: 0, gap: space.xs },
  feedback: {
    borderLeftWidth: 2,
    borderColor: c.primary,
    paddingLeft: space.lg,
    gap: space.sm,
  },
  error: { color: c.error },
  footer: {
    fontSize: uiType.caption.fontSize,
    color: c.textSecondary,
    paddingVertical: space.md,
  },
}));
