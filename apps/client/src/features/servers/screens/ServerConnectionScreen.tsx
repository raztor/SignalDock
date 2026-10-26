import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SignalDockClient, normalizeServerUrl } from '@signaldock/client-sdk';
import type { RecentServer, ServerInfo } from '@signaldock/contracts';
import { recentServerStore as store } from '../data/recent-server-store';
import { DEFAULT_SERVER_URL } from '../../../shared/config/defaults';

export default function ServerConnectionScreen() {
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
    } catch (failure) {
      if (request.current.generation === current.generation) {
        setError(
          current.controller.signal.aborted
            ? 'The connection timed out. Check the URL and network access.'
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
      await store.remove(server.baseUrl);
      setRecent(await store.list());
    } catch {
      setError('The saved server could not be removed.');
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
    >
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.brand}>
          SignalDock<Text style={styles.dot}> ●</Text>
        </Text>
        <Text style={styles.badge}>DEVELOPMENT PREVIEW</Text>
      </View>
      <View style={styles.intro}>
        <Text style={styles.eyebrow}>YOUR STATION. YOUR SERVER.</Text>
        <Text style={styles.title}>Connect to your{'\n'}radio workspace.</Text>
        <Text style={styles.description}>
          Choose a self-hosted SignalDock server. Your accounts and station data
          belong to that instance.
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>Server connection</Text>
        <Text style={styles.muted}>
          Enter the backend URL, including any deployment prefix.
        </Text>
        <Text style={styles.label}>SERVER URL</Text>
        <TextInput
          accessibilityLabel="Server URL"
          style={styles.input}
          value={url}
          onChangeText={(value) => {
            resetConnection();
            setUrl(value);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://radio.example.com"
          placeholderTextColor="#6d829c"
          onSubmitEditing={() => {
            void connect();
          }}
        />
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          style={[styles.button, busy && styles.disabled]}
          onPress={() => {
            void connect();
          }}
        >
          {busy ? (
            <ActivityIndicator color="#06131b" />
          ) : (
            <Text style={styles.buttonText}>Check server →</Text>
          )}
        </Pressable>
        <Text style={styles.hint}>
          HTTPS is required. HTTP loopback is available for local development.
        </Text>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
      </View>
      {result && (
        <View style={[styles.card, styles.connected]}>
          <Text style={styles.eyebrow}>SERVER REACHED</Text>
          <Text style={styles.heading}>{result.displayName}</Text>
          <Text style={styles.muted}>
            Version {result.version} · Protocol {result.protocol.min}–
            {result.protocol.max}
          </Text>
          <Text selectable style={styles.fingerprint}>
            {result.identity.keyId}
          </Text>
          <Text style={styles.muted}>
            Discovery is available. Sign-in, the radio dashboard, and live audio
            are coming in the next implementation stages.
          </Text>
        </View>
      )}
      <View style={styles.section}>
        <Text style={styles.heading}>Recent servers</Text>
        <Text style={styles.muted}>
          Saved on this device. No passwords are stored here.
        </Text>
        {!recent.length && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              Your stations will appear here
            </Text>
            <Text style={styles.muted}>
              Check a server to add it to your recent connections.
            </Text>
          </View>
        )}
        {recent.map((server) => (
          <View key={server.baseUrl} style={styles.recent}>
            <Pressable
              accessibilityRole="button"
              style={styles.recentMain}
              onPress={() => {
                void connect(server.baseUrl);
              }}
            >
              <Text style={styles.serverName}>{server.alias}</Text>
              <Text style={styles.muted}>{server.baseUrl}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${server.alias}`}
              style={styles.remove}
              onPress={() => {
                void remove(server);
              }}
            >
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>
        ))}
      </View>
      <Text style={styles.footer}>Open source · Self-hosted · GNU AGPL v3</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  page: {
    width: '100%',
    maxWidth: 900,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 56,
    paddingBottom: 40,
    gap: 28,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
  },
  brand: {
    color: '#eef5ff',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  dot: { color: '#50dfc2', fontSize: 14 },
  badge: {
    color: '#93a8c5',
    fontSize: 10,
    letterSpacing: 1.5,
    borderWidth: 1,
    borderColor: '#2b3c54',
    borderRadius: 6,
    padding: 8,
  },
  intro: { paddingVertical: 12, gap: 16 },
  eyebrow: {
    color: '#50dfc2',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  title: {
    fontSize: 42,
    lineHeight: 49,
    fontWeight: '700',
    letterSpacing: -1.5,
    color: '#eef5ff',
  },
  description: {
    color: '#9fb0c9',
    fontSize: 17,
    lineHeight: 26,
    maxWidth: 630,
  },
  card: {
    backgroundColor: '#131f32',
    borderWidth: 1,
    borderColor: '#263951',
    borderRadius: 18,
    padding: 24,
    gap: 12,
  },
  heading: { color: '#eef5ff', fontSize: 20, fontWeight: '600' },
  muted: { color: '#a0b2ca', fontSize: 14, lineHeight: 21 },
  label: {
    color: '#a0b2ca',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.5,
    marginTop: 12,
  },
  input: {
    backgroundColor: '#0b1525',
    borderWidth: 1,
    borderColor: '#3b526e',
    borderRadius: 10,
    padding: 16,
    color: '#eef5ff',
    fontSize: 16,
  },
  button: {
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    backgroundColor: '#50dfc2',
    minHeight: 52,
  },
  buttonText: { color: '#06131b', fontWeight: '700', fontSize: 16 },
  disabled: { opacity: 0.65 },
  hint: { color: '#8195b0', fontSize: 12, lineHeight: 18 },
  error: { color: '#ffb4a9', lineHeight: 22, marginTop: 6 },
  connected: { borderColor: '#287d70' },
  fingerprint: { color: '#88b5ad', fontSize: 12, lineHeight: 19 },
  section: { gap: 12 },
  empty: {
    padding: 24,
    borderWidth: 1,
    borderColor: '#263951',
    borderStyle: 'dashed',
    borderRadius: 14,
    gap: 8,
  },
  emptyTitle: { color: '#c8d6e9', fontSize: 15, fontWeight: '500' },
  recent: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#131f32',
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  recentMain: { flex: 1, gap: 4 },
  serverName: { color: '#eef5ff', fontSize: 16, fontWeight: '600' },
  remove: { padding: 8 },
  removeText: { color: '#93a8c5', fontSize: 13 },
  footer: { color: '#6d829c', fontSize: 12, textAlign: 'center', marginTop: 8 },
});
