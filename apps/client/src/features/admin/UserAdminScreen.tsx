import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { apiRequest } from '@signaldock/client-sdk';
import {
  PublicUserSchema,
  RadioConfigurationSchema,
  SignalDockError,
  type FeatureScreenProps,
  type PublicUser,
  type Role,
  type Permission,
  type RadioConfiguration,
} from '@signaldock/contracts';

type RoleTemplates = Record<Role, Permission[]>;
const roles: Role[] = ['listener', 'operator', 'administrator'];
export function UserAdminScreen({ session }: FeatureScreenProps) {
  const contextKey = `${session.baseUrl}:${session.instanceId}:${session.user.id}:${session.accessToken}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [radios, setRadios] = useState<RadioConfiguration[]>([]);
  const [templates, setTemplates] = useState<RoleTemplates | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('listener');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (signal?: AbortSignal) => {
    const [result, config, permissions] = await Promise.all([
      apiRequest<{ users: PublicUser[] }>(session, 'admin/users', {
        ...(signal ? { signal } : {}),
      }),
      apiRequest<RadioConfiguration[]>(session, 'radios/configurations', {
        ...(signal ? { signal } : {}),
      }).catch((error) => {
        if (error instanceof SignalDockError && error.code === 'NOT_FOUND')
          return [];
        throw error;
      }),
      apiRequest<{ roles: RoleTemplates }>(session, 'admin/role-permissions', {
        ...(signal ? { signal } : {}),
      }),
    ]);
    if (signal?.aborted || currentContext.current !== contextKey) return;
    setUsers(PublicUserSchema.array().parse(result.users));
    setRadios(RadioConfigurationSchema.array().parse(config));
    setTemplates(permissions.roles);
  };
  useEffect(() => {
    currentContext.current = contextKey;
    setUsers([]);
    setRadios([]);
    setTemplates(null);
    setUsername('');
    setPassword('');
    setRole('listener');
    setBusy(false);
    setError('');
    setMessage('');
    const abort = new AbortController();
    void load(abort.signal).catch((failure) => {
      if (!abort.signal.aborted && currentContext.current === contextKey)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Users could not be loaded.',
        );
    });
    return () => {
      currentContext.current = '';
      abort.abort();
    };
  }, [contextKey]);
  const act = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      if (currentContext.current !== contextKey) return;
      setMessage(success);
      await load();
    } catch (failure) {
      if (currentContext.current === contextKey)
        setError(
          failure instanceof Error ? failure.message : 'The operation failed.',
        );
    } finally {
      if (currentContext.current === contextKey) setBusy(false);
    }
  };
  if (session.user.role !== 'administrator')
    return (
      <View style={styles.page}>
        <Text style={styles.error}>Administrator access is required.</Text>
      </View>
    );
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Users and radio permissions</Text>
      <Text style={styles.muted}>
        Administrator status manages the station. Radio operation is assigned
        explicitly, including for your own account.
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!!message && <Text style={styles.success}>{message}</Text>}
      <View style={styles.card}>
        <Text style={styles.heading}>Create user</Text>
        <TextInput
          accessibilityLabel="New username"
          placeholder="Username"
          placeholderTextColor="#8295b0"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <TextInput
          accessibilityLabel="New user password"
          placeholder="Password (12+ characters)"
          placeholderTextColor="#8295b0"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          style={styles.input}
        />
        <View style={styles.row}>
          {roles.map((value) => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ selected: role === value }}
              style={[styles.choice, role === value && styles.chosen]}
              onPress={() => setRole(value)}
            >
              <Text style={styles.text}>{value}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          style={styles.button}
          onPress={() => {
            void act(async () => {
              await apiRequest(session, 'admin/users', {
                method: 'POST',
                body: JSON.stringify({ username, password, role }),
              });
              setUsername('');
              setPassword('');
            }, 'User created. Assign radio access below.');
          }}
        >
          <Text style={styles.buttonText}>Create user</Text>
        </Pressable>
      </View>
      {users.map((user) => (
        <UserCard
          key={`${session.instanceId}:${session.baseUrl}:${user.id}`}
          user={user}
          currentUserId={session.user.id}
          radios={radios}
          templates={templates}
          disabled={busy}
          onSave={(patch) =>
            act(async () => {
              await apiRequest(session, `admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify(patch),
              });
              if (user.id === session.user.id) session.onUnauthorized?.();
            }, 'Permissions saved. Existing sessions were revoked.')
          }
          onToggle={() =>
            act(async () => {
              await apiRequest(session, `admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: !user.enabled }),
              });
            }, 'Account status updated.')
          }
          onRevoke={() =>
            act(async () => {
              await apiRequest(
                session,
                `admin/users/${user.id}/revoke-sessions`,
                { method: 'POST', body: '{}' },
              );
              if (user.id === session.user.id) session.onUnauthorized?.();
            }, 'Sessions revoked.')
          }
          onPassword={(next) =>
            act(async () => {
              await apiRequest(session, `admin/users/${user.id}/password`, {
                method: 'POST',
                body: JSON.stringify({ password: next }),
              });
              if (user.id === session.user.id) session.onUnauthorized?.();
            }, 'Password reset; sessions revoked.')
          }
        />
      ))}
    </ScrollView>
  );
}
function UserCard({
  user,
  currentUserId,
  radios,
  templates,
  disabled,
  onSave,
  onToggle,
  onRevoke,
  onPassword,
}: {
  user: PublicUser;
  currentUserId: string;
  radios: RadioConfiguration[];
  templates: RoleTemplates | null;
  disabled: boolean;
  onSave: (patch: {
    role: Role;
    radioPermissions: PublicUser['radioPermissions'];
  }) => Promise<void>;
  onToggle: () => Promise<void>;
  onRevoke: () => Promise<void>;
  onPassword: (password: string) => Promise<void>;
}) {
  const [role, setRole] = useState(user.role);
  const [grants, setGrants] = useState(user.radioPermissions);
  const [password, setPassword] = useState('');
  useEffect(() => {
    setRole(user.role);
    setGrants(user.radioPermissions);
  }, [user]);
  const setRadio = (radioId: string) =>
    setGrants((old) =>
      old.some((grant) => grant.radioId === radioId)
        ? old.filter((grant) => grant.radioId !== radioId)
        : [...old, { radioId, permissions: templates?.[role] ?? [] }],
    );
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>
        {user.username}
        {user.id === currentUserId ? ' (you)' : ''}
      </Text>
      <Text style={styles.muted}>{user.enabled ? 'Enabled' : 'Disabled'}</Text>
      <View style={styles.row}>
        {roles.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ selected: role === value }}
            disabled={disabled}
            style={[styles.choice, role === value && styles.chosen]}
            onPress={() => {
              setRole(value);
              setGrants((old) =>
                old.map((grant) => ({
                  ...grant,
                  permissions: templates?.[value] ?? [],
                })),
              );
            }}
          >
            <Text style={styles.text}>{value}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.text}>Assigned radios</Text>
      {!radios.length && (
        <Text style={styles.muted}>
          Configure a radio before assigning operational access.
        </Text>
      )}
      {radios.map((radio) => (
        <Pressable
          key={radio.radioId}
          accessibilityRole="checkbox"
          accessibilityState={{
            checked: grants.some((grant) => grant.radioId === radio.radioId),
          }}
          disabled={disabled || !templates}
          style={styles.choice}
          onPress={() => setRadio(radio.radioId)}
        >
          <Text style={styles.text}>
            {grants.some((grant) => grant.radioId === radio.radioId)
              ? '✓ '
              : ''}
            {radio.displayName}
          </Text>
        </Pressable>
      ))}
      {(role === 'operator' || role === 'administrator') && (
        <Text style={styles.muted}>
          The selected role's radio template includes transmit permission on
          assigned radios.
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        disabled={disabled || !templates}
        style={styles.button}
        onPress={() => {
          void onSave({ role, radioPermissions: grants });
        }}
      >
        <Text style={styles.buttonText}>Save role and radio access</Text>
      </Pressable>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          style={styles.choice}
          onPress={() => {
            void onToggle();
          }}
        >
          <Text style={styles.text}>
            {user.enabled ? 'Disable account' : 'Enable account'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          style={styles.choice}
          onPress={() => {
            void onRevoke();
          }}
        >
          <Text style={styles.text}>Revoke sessions</Text>
        </Pressable>
      </View>
      <TextInput
        accessibilityLabel={`New password for ${user.username}`}
        placeholder="Replacement password"
        placeholderTextColor="#8295b0"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        style={styles.input}
      />
      <Pressable
        accessibilityRole="button"
        disabled={disabled || password.length < 12}
        style={styles.choice}
        onPress={() => {
          void onPassword(password).then(() => setPassword(''));
        }}
      >
        <Text style={styles.text}>Reset password</Text>
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0b1220' },
  content: {
    padding: 24,
    gap: 16,
    maxWidth: 900,
    width: '100%',
    alignSelf: 'center',
  },
  title: { color: '#eef5ff', fontSize: 26, fontWeight: '700' },
  heading: { color: '#eef5ff', fontSize: 18, fontWeight: '600' },
  text: { color: '#dbe8f8', fontSize: 14 },
  muted: { color: '#9fb0c9', fontSize: 14, lineHeight: 21 },
  card: {
    backgroundColor: '#131f32',
    borderColor: '#263951',
    borderWidth: 1,
    borderRadius: 14,
    padding: 20,
    gap: 12,
  },
  input: {
    backgroundColor: '#0b1525',
    borderColor: '#3b526e',
    borderWidth: 1,
    borderRadius: 9,
    padding: 14,
    color: '#eef5ff',
    fontSize: 15,
  },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  choice: {
    borderColor: '#3b526e',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  chosen: { borderColor: '#50dfc2', backgroundColor: '#163a39' },
  button: {
    backgroundColor: '#50dfc2',
    borderRadius: 9,
    padding: 14,
    alignItems: 'center',
  },
  buttonText: { color: '#06131b', fontWeight: '700' },
  error: { color: '#ffb4a9', lineHeight: 21 },
  success: { color: '#50dfc2', lineHeight: 21 },
});
