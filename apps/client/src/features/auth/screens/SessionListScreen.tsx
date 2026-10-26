import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { apiRequest } from '@signaldock/client-sdk';
import {
  SessionSummarySchema,
  type FeatureScreenProps,
  type SessionSummary,
} from '@signaldock/contracts';
import { authStyles as styles } from '../auth.styles';

export function SessionListScreen({ session }: FeatureScreenProps) {
  const contextKey = JSON.stringify([
    session.baseUrl,
    session.instanceId,
    session.user.id,
    session.accessToken,
  ]);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (signal?: AbortSignal) => {
    const result = await apiRequest<{ sessions: unknown[] }>(
      session,
      'auth/sessions',
      { ...(signal ? { signal } : {}) },
    );
    if (signal?.aborted || currentContext.current !== contextKey) return;
    setSessions(SessionSummarySchema.array().parse(result.sessions));
  };
  useEffect(() => {
    setSessions([]);
    setError('');
    setBusy(false);
    const abort = new AbortController();
    void load(abort.signal).catch((failure) => {
      if (!abort.signal.aborted && currentContext.current === contextKey)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Sessions could not be loaded.',
        );
    });
    return () => {
      currentContext.current = '';
      abort.abort();
    };
  }, [contextKey]);
  const revoke = async (item: SessionSummary) => {
    setBusy(true);
    setError('');
    try {
      await apiRequest(session, `auth/sessions/${item.id}`, {
        method: 'DELETE',
      });
      if (currentContext.current !== contextKey) return;
      if (item.current) {
        session.onUnauthorized?.();
        return;
      }
      await load();
    } catch (failure) {
      if (currentContext.current === contextKey)
        setError(
          failure instanceof Error
            ? failure.message
            : 'The session could not be revoked.',
        );
    } finally {
      if (currentContext.current === contextKey) setBusy(false);
    }
  };
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Your sessions</Text>
      <Text style={styles.muted}>
        {session.user.username} · {session.baseUrl}
      </Text>
      <Text style={styles.muted}>
        Revoking a session stops its access and refresh credentials. Other
        SignalDock servers have separate sessions.
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!sessions.length && !error && (
        <Text style={styles.muted}>No sessions to show.</Text>
      )}
      {sessions.map((item) => (
        <View key={item.id} style={styles.card}>
          <Text style={styles.label}>
            {item.label || 'SignalDock client'}
            {item.current ? ' (this session)' : ''}
          </Text>
          <Text style={styles.muted}>
            Started {new Date(item.createdAt).toLocaleString()}
          </Text>
          <Text style={styles.muted}>
            Last refreshed {new Date(item.lastSeenAt).toLocaleString()}
          </Text>
          <Text style={styles.muted}>
            {item.revokedAt
              ? `Revoked ${new Date(item.revokedAt).toLocaleString()}`
              : `Expires ${new Date(item.refreshExpiresAt).toLocaleString()}`}
          </Text>
          {!item.revokedAt && (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.secondary, busy && styles.disabled]}
              onPress={() => {
                void revoke(item);
              }}
            >
              <Text style={styles.secondaryText}>
                {item.current ? 'Revoke this session' : 'Revoke session'}
              </Text>
            </Pressable>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
