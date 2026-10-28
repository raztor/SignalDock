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

export function BootstrapScreen({
  controller,
}: {
  controller: SessionController;
}) {
  const styles = useFeatureStyles('auth');
  const snapshot = useAuthSession(controller);
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [repeated, setRepeated] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setSetupToken('');
    setUsername('admin');
    setPassword('');
    setRepeated('');
    setError('');
  }, [snapshot.server?.baseUrl, snapshot.server?.info.instanceId]);
  const submit = async () => {
    if (password !== repeated) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await controller.bootstrap(setupToken, username, password);
      setSetupToken('');
      setPassword('');
      setRepeated('');
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Administrator setup failed.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={styles.title}>
        Set up your station
      </Text>
      <Text style={styles.muted}>{snapshot.server?.info.displayName}</Text>
      <View style={styles.card}>
        <Text style={styles.muted}>
          Create the first administrator using the setup token provided by your
          server installation.
        </Text>
        <Text style={styles.label}>Setup token</Text>
        <TextInput
          accessibilityLabel="Setup token"
          value={setupToken}
          onChangeText={setSetupToken}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Text style={styles.label}>Administrator username</Text>
        <TextInput
          accessibilityLabel="Administrator username"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Text style={styles.label}>Password</Text>
        <TextInput
          accessibilityLabel="Administrator password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="newPassword"
          style={styles.input}
        />
        <Text style={styles.label}>Repeat password</Text>
        <TextInput
          accessibilityLabel="Repeat administrator password"
          value={repeated}
          onChangeText={setRepeated}
          secureTextEntry
          textContentType="newPassword"
          style={styles.input}
        />
        <Text style={styles.muted}>
          Use at least 12 characters. After setup, explicitly assign radio
          permissions in Users to operate a radio.
        </Text>
        <Button
          label="Create administrator"
          variant="primary"
          loading={busy}
          disabled={busy}
          onPress={() => {
            void submit();
          }}
        />
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}
