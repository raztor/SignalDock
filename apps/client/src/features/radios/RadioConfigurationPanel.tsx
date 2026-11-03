import { apiRequest } from '@signaldock/client-sdk';
import type {
  FeatureScreenProps,
  RadioConfiguration,
} from '@signaldock/contracts';
import {
  Button,
  SettingToggle,
  Text,
  TextInput,
  useFeatureStyles,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { operationId } from './radio-input';

/** Administrator connector configuration (replaced by the setup wizard in Stage 3). */
export function RadioConfigurationPanel({
  session,
}: Pick<FeatureScreenProps, 'session'>) {
  const styles = useFeatureStyles('radios');
  const [configurations, setConfigurations] = useState<RadioConfiguration[]>(
    [],
  );
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [driver, setDriver] = useState('simulator.tunable');
  const [endpoint, setEndpoint] = useState('');
  const [groups, setGroups] = useState('');
  const [config, setConfig] = useState('{}');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    ++version.current;
    setConfigurations([]);
    setId('');
    setName('');
    setDriver('simulator.tunable');
    setGroups('');
    setEnabled(true);
    setSaving(false);
    setEndpoint('');
    setConfig('{}');
    setError('');
    void apiRequest<RadioConfiguration[]>(session, 'radios/configurations', {
      signal: controller.signal,
    })
      .then((items) => {
        if (!controller.signal.aborted) setConfigurations(items);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(message(failure));
      });
    return () => {
      ++version.current;
      controller.abort();
    };
  }, [session.baseUrl, session.instanceId, session.accessToken]);
  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>
        Radio configuration
      </Text>
      <Text style={styles.muted}>
        Install a driver connector before configuring it. Configuring a radio
        does not grant operational access.
      </Text>
      {configurations.map((item) => (
        <Button
          key={item.radioId}
          title={`Edit ${item.displayName}`}
          onPress={() => {
            setId(item.radioId);
            setName(item.displayName);
            setDriver(item.driverId);
            setEndpoint(item.endpoint ?? '');
            setGroups(item.resourceGroupIds.join(', '));
            setConfig(JSON.stringify(item.config, null, 2));
            setEnabled(item.enabled);
          }}
        />
      ))}
      <Text style={styles.label}>Radio ID (blank creates a new radio)</Text>
      <TextInput
        style={styles.input}
        value={id}
        onChangeText={setId}
        autoCapitalize="none"
        accessibilityLabel="Radio ID"
      />
      <Text style={styles.label}>Display name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        accessibilityLabel="Radio display name"
      />
      <Text style={styles.label}>Driver ID</Text>
      <TextInput
        style={styles.input}
        value={driver}
        onChangeText={setDriver}
        autoCapitalize="none"
        accessibilityLabel="Driver ID"
      />
      <Text style={styles.label}>Private driver endpoint</Text>
      <TextInput
        style={styles.input}
        value={endpoint}
        onChangeText={setEndpoint}
        autoCapitalize="none"
        accessibilityLabel="Private driver endpoint"
      />
      <Text style={styles.label}>Shared resource groups (comma separated)</Text>
      <TextInput
        style={styles.input}
        value={groups}
        onChangeText={setGroups}
        autoCapitalize="none"
        accessibilityLabel="Resource groups"
      />
      <Text style={styles.label}>
        Connector configuration (JSON, credential references only)
      </Text>
      <TextInput
        style={styles.input}
        value={config}
        onChangeText={setConfig}
        multiline
        autoCapitalize="none"
        accessibilityLabel="Connector configuration"
      />
      <SettingToggle
        label="Radio enabled"
        value={enabled}
        onValueChange={setEnabled}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Button
        title={saving ? 'Saving…' : 'Save configuration'}
        disabled={saving || !name.trim() || !driver.trim()}
        onPress={() =>
          void (async () => {
            const current = version.current;
            setSaving(true);
            setError('');
            try {
              const saved = await apiRequest<RadioConfiguration>(
                session,
                'radios',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    radioId: id.trim() || operationId(),
                    displayName: name.trim(),
                    driverId: driver.trim(),
                    ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
                    resourceGroupIds: groups
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
                    enabled,
                    config: JSON.parse(config),
                  }),
                },
              );
              if (version.current === current) {
                setId(saved.radioId);
                const items = await apiRequest<RadioConfiguration[]>(
                  session,
                  'radios/configurations',
                );
                if (version.current === current) setConfigurations(items);
              }
            } catch (failure) {
              if (version.current === current) setError(message(failure));
            } finally {
              if (version.current === current) setSaving(false);
            }
          })()
        }
      />
    </View>
  );
}
function message(failure: unknown): string {
  return failure instanceof Error
    ? failure.message
    : 'The radio request failed.';
}
