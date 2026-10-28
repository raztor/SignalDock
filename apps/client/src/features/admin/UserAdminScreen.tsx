import { Checkbox } from '@signaldock/ui';
import { apiRequest } from '@signaldock/client-sdk';
import {
  PublicUserSchema,
  RadioConfigurationSchema,
  SignalDockError,
  type FeatureScreenProps,
  type Permission,
  type PublicUser,
  type RadioConfiguration,
  type Role,
} from '@signaldock/contracts';
import {
  ConfirmButton,
  Disclosure,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useFeatureStyles,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

type RoleTemplates = Record<Role, Permission[]>;
const roles: Role[] = ['listener', 'operator', 'administrator'];
export function UserAdminScreen({ session }: FeatureScreenProps) {
  const styles = useFeatureStyles('admin');
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
      <Text accessibilityRole="header" style={styles.title}>
        Users and radio permissions
      </Text>
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
      <Disclosure title="Create a user">
        <TextInput
          accessibilityLabel="New username"
          placeholder="Username"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <TextInput
          accessibilityLabel="New user password"
          placeholder="Password (12+ characters)"
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
              accessibilityState={{ checked: role === value }}
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
      </Disclosure>
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
  const styles = useFeatureStyles('admin');
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
      <Text accessibilityRole="header" style={styles.heading}>
        {user.username}
        {user.id === currentUserId ? ' (you)' : ''}
      </Text>
      <Text style={styles.muted}>{user.enabled ? 'Enabled' : 'Disabled'}</Text>
      <View style={styles.row}>
        {roles.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked: role === value }}
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
        <Checkbox
          key={radio.radioId}
          label={radio.displayName}
          value={grants.some((grant) => grant.radioId === radio.radioId)}
          disabled={disabled || !templates}
          onValueChange={() => setRadio(radio.radioId)}
        />
      ))}
      {(role === 'operator' || role === 'administrator') && (
        <Text style={styles.muted}>
          Changing role applies that role’s permission template to assigned
          radios.
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
        <ConfirmButton
          label={user.enabled ? 'Disable account' : 'Enable account'}
          disabled={disabled}
          confirmation={{
            title: user.enabled
              ? 'Disable this account?'
              : 'Enable this account?',
            message: user.enabled
              ? 'This stops the account’s access until it is enabled again.'
              : 'This allows the account to sign in with its assigned permissions.',
          }}
          onPress={() => {
            void onToggle();
          }}
        />
        <ConfirmButton
          label="Revoke sessions"
          variant="danger"
          disabled={disabled}
          confirmation={{
            title: 'Revoke this user’s sessions?',
            message:
              'The user will need to sign in again on every connected device.',
          }}
          onPress={() => {
            void onRevoke();
          }}
        />
      </View>
      <TextInput
        accessibilityLabel={`New password for ${user.username}`}
        placeholder="Replacement password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        style={styles.input}
      />
      <ConfirmButton
        label="Reset password"
        disabled={disabled || password.length < 12}
        confirmation={{
          title: 'Replace this user’s password?',
          message:
            'The new password will replace the current password for this station account.',
        }}
        onPress={() => {
          void onPassword(password).then(() => setPassword(''));
        }}
      />
    </View>
  );
}
