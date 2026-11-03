import {
  Button,
  Icon,
  layout,
  Pressable,
  radius,
  ScrollView,
  space,
  StatusIndicator,
  Text,
  TextInput,
  type,
  useFeatureStyles,
  useTheme,
} from '@signaldock/ui';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

import {
  displayAddress,
  healthFromInfo,
  healthPresentation,
} from '../../servers/server-model';
import type { SessionController } from '../session-controller';
import { useAuthSession } from '../use-auth-session';
import { BootstrapScreen } from './BootstrapScreen';

const MONOSPACE = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export function LoginScreen({ controller }: { controller: SessionController }) {
  const styles = useFeatureStyles('auth');
  const { colors } = useTheme();
  const snapshot = useAuthSession(controller);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setUsername('');
    setPassword('');
    setReveal(false);
    setError('');
  }, [snapshot.server?.baseUrl, snapshot.server?.info.instanceId]);
  if (snapshot.bootstrapRequired)
    return <BootstrapScreen controller={controller} />;
  const busy = snapshot.status === 'signing_in';
  const ready = Boolean(snapshot.server && username.trim() && password);
  const submit = async () => {
    if (busy || !ready) return;
    setError('');
    try {
      await controller.signIn(username, password);
      setPassword('');
      setReveal(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in failed.');
    }
  };
  const server = snapshot.server;
  const status = server
    ? healthPresentation(healthFromInfo(server.info))
    : undefined;
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={styles.title}>
        Sign in to your station
      </Text>
      {server && status && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            padding: space.md,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.lg,
            backgroundColor: colors.surface,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.surfaceElevated,
            }}
          >
            <Icon name="server" color={colors.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text numberOfLines={1} style={styles.label}>
              {server.info.displayName}
            </Text>
            <Text
              selectable
              numberOfLines={1}
              style={[
                type.caption,
                { color: colors.textSecondary, fontFamily: MONOSPACE },
              ]}
            >
              {displayAddress(server.baseUrl)}
            </Text>
            <StatusIndicator
              tone={status.tone}
              label={status.label}
              size="compact"
            />
          </View>
        </View>
      )}
      <View style={styles.card}>
        <Text style={styles.label}>Username</Text>
        <TextInput
          accessibilityLabel="Username"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          style={styles.input}
        />
        <Text style={styles.label}>Password</Text>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
        >
          <TextInput
            accessibilityLabel="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!reveal}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            style={[styles.input, { flex: 1 }]}
            onSubmitEditing={() => {
              void submit();
            }}
          />
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Show password"
            accessibilityState={{ checked: reveal }}
            onPress={() => setReveal(!reveal)}
            // React Native Web only activates buttons with Space; a switch
            // must toggle with it too.
            {...(Platform.OS === 'web'
              ? {
                  onKeyDown: (event: {
                    nativeEvent: { key: string };
                    preventDefault(): void;
                  }) => {
                    const key = event.nativeEvent.key;
                    if (key !== ' ' && key !== 'Spacebar') return;
                    event.preventDefault();
                    setReveal((current) => !current);
                  },
                }
              : {})}
            style={{
              minWidth: layout.touch,
              paddingHorizontal: space.sm,
              alignItems: 'center',
            }}
          >
            <Text style={[type.label, { color: colors.primary }]}>
              {reveal ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
        </View>
        <Button
          label="Sign in"
          variant="primary"
          loading={busy}
          disabled={busy || !ready}
          onPress={() => {
            void submit();
          }}
        />
        {!!(error || snapshot.error) && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error || snapshot.error}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Icon name="lock" size={16} color={colors.textSecondary} />
          <Text style={[styles.muted, { flex: 1 }]}>
            This account belongs to the selected server. Passwords are never
            saved on this device.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
