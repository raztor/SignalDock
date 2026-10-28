import {
  Button,
  ScrollView,
  Text,
  TextInput,
  useFeatureStyles,
} from '@signaldock/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { SessionController } from '../session-controller';
import { useAuthSession } from '../use-auth-session';
import { BootstrapScreen } from './BootstrapScreen';

export function LoginScreen({ controller }: { controller: SessionController }) {
  const styles = useFeatureStyles('auth');
  const snapshot = useAuthSession(controller);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setUsername('');
    setPassword('');
    setError('');
  }, [snapshot.server?.baseUrl, snapshot.server?.info.instanceId]);
  if (snapshot.bootstrapRequired)
    return <BootstrapScreen controller={controller} />;
  const busy = snapshot.status === 'signing_in';
  const submit = async () => {
    setError('');
    try {
      await controller.signIn(username, password);
      setPassword('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in failed.');
    }
  };
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={styles.title}>
        Sign in to your station
      </Text>
      <Text style={styles.muted}>{snapshot.server?.info.displayName}</Text>
      <Text selectable style={styles.muted}>
        {snapshot.server?.baseUrl}
      </Text>
      <View style={styles.card}>
        <Text style={styles.label}>Username</Text>
        <TextInput
          accessibilityLabel="Username"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="username"
          style={styles.input}
        />
        <Text style={styles.label}>Password</Text>
        <TextInput
          accessibilityLabel="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          style={styles.input}
          onSubmitEditing={() => {
            void submit();
          }}
        />
        <Button
          label="Sign in"
          variant="primary"
          loading={busy}
          disabled={busy || !snapshot.server || !username.trim() || !password}
          onPress={() => {
            void submit();
          }}
        />
        {!!(error || snapshot.error) && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error || snapshot.error}
          </Text>
        )}
        <Text style={styles.muted}>
          This account belongs to the selected server. Passwords are never saved
          on this device.
        </Text>
      </View>
    </ScrollView>
  );
}
