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
  Button,
  Disclosure,
  LoadingState,
  ScrollView,
  SegmentedControl,
  Text,
  TextInput,
  useFeatureStyles,
  useScreenActive,
  useToast,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { PasswordStrength } from './PasswordStrength';
import {
  PermissionMatrix,
  type MatrixRadio,
  type PermissionMatrixActions,
} from './PermissionMatrix';
import { passwordStrength } from './password-strength';
import { ROLES, ROLE_LABELS, type RoleTemplates } from './permission-model';

/**
 * Administrator-only users and radio access: a users × radios permission
 * matrix with per-user staged saves, role and secondary permissions in each
 * user's expandable row, account status, session revocation and password
 * reset. Backend authorization is authoritative.
 */
export function UserAdminScreen({ session }: FeatureScreenProps) {
  const styles = useFeatureStyles('admin');
  const toast = useToast();
  // Token refreshes keep the same account, so staged work is not reset.
  const contextKey = `${session.baseUrl}:${session.instanceId}:${session.user.id}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [radios, setRadios] = useState<RadioConfiguration[]>([]);
  const [templates, setTemplates] = useState<RoleTemplates | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('listener');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [error, setError] = useState('');
  const [focusUserId, setFocusUserId] = useState<string>();

  const load = async (signal?: AbortSignal) => {
    const key = contextKey;
    const [result, config, permissions] = await Promise.all([
      apiRequest<{ users: PublicUser[] }>(session, 'admin/users', {
        ...(signal ? { signal } : {}),
      }),
      apiRequest<RadioConfiguration[]>(session, 'radios/configurations', {
        ...(signal ? { signal } : {}),
      }).catch((failure) => {
        if (failure instanceof SignalDockError && failure.code === 'NOT_FOUND')
          return [];
        throw failure;
      }),
      apiRequest<{ roles: Record<Role, Permission[]> }>(
        session,
        'admin/role-permissions',
        { ...(signal ? { signal } : {}) },
      ),
    ]);
    if (signal?.aborted || currentContext.current !== key) return;
    setUsers(PublicUserSchema.array().parse(result.users));
    setRadios(RadioConfigurationSchema.array().parse(config));
    setTemplates(permissions.roles);
    setLoaded(true);
    setError('');
  };

  useEffect(() => {
    currentContext.current = contextKey;
    setUsers([]);
    setRadios([]);
    setTemplates(null);
    setLoaded(false);
    setUsername('');
    setPassword('');
    setRole('listener');
    setCreating(false);
    setCreateError('');
    setError('');
    setFocusUserId(undefined);
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
    // `contextKey` identifies the session every request runs against.
  }, [contextKey]);

  // Returning to this section (for example from the radio setup wizard's
  // Access step) reloads, so newly configured radios appear as columns.
  // Staged drafts survive a reload unless that user changed on the server.
  const active = useScreenActive();
  const wasActive = useRef(active);
  useEffect(() => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (!returned) return;
    const key = contextKey;
    const abort = new AbortController();
    void load(abort.signal).catch((failure) => {
      if (!abort.signal.aborted && currentContext.current === key)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Users could not be loaded.',
        );
    });
    return () => abort.abort();
    // Only the inactive → active transition triggers a reload.
  }, [active]);

  /**
   * Runs one account mutation. Errors propagate to the caller, which shows
   * them next to the control. Self-edits end the current session; otherwise
   * the list reloads so staged drafts can be reconciled.
   */
  const mutate = async (
    user: PublicUser,
    request: () => Promise<unknown>,
    success: string,
  ) => {
    const key = contextKey;
    await request();
    if (currentContext.current !== key) return;
    toast.show({ tone: 'success', message: success });
    if (user.id === session.user.id) {
      session.onUnauthorized?.();
      return;
    }
    await load().catch((failure) => {
      if (currentContext.current === key)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Users could not be reloaded.',
        );
    });
  };

  const actions: PermissionMatrixActions = {
    saveAccess: (user, patch) =>
      mutate(
        user,
        () =>
          apiRequest(session, `admin/users/${user.id}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
          }),
        `Access saved for ${user.username}. Existing sessions were revoked.`,
      ),
    setEnabled: (user, enabled) =>
      mutate(
        user,
        () =>
          apiRequest(session, `admin/users/${user.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled }),
          }),
        enabled
          ? `${user.username} can sign in again.`
          : `${user.username} was disabled.`,
      ),
    revokeSessions: (user) =>
      mutate(
        user,
        () =>
          apiRequest(session, `admin/users/${user.id}/revoke-sessions`, {
            method: 'POST',
            body: '{}',
          }),
        `Sessions revoked for ${user.username}.`,
      ),
    resetPassword: (user, next) =>
      mutate(
        user,
        () =>
          apiRequest(session, `admin/users/${user.id}/password`, {
            method: 'POST',
            body: JSON.stringify({ password: next }),
          }),
        `Password reset for ${user.username}; sessions revoked.`,
      ),
  };

  const strength = passwordStrength(password, [username]);
  const canCreate =
    !creating && username.trim().length > 0 && strength.acceptable;
  const create = async () => {
    const key = contextKey;
    setCreating(true);
    setCreateError('');
    try {
      const created = PublicUserSchema.parse(
        await apiRequest<unknown>(session, 'admin/users', {
          method: 'POST',
          body: JSON.stringify({ username, password, role }),
        }),
      );
      if (currentContext.current !== key) return;
      setUsername('');
      setPassword('');
      toast.show({
        tone: 'success',
        message: `User ${created.username} created. Assign radio access in the matrix.`,
      });
      setFocusUserId(created.id);
      await load();
    } catch (failure) {
      if (currentContext.current === key)
        setCreateError(
          failure instanceof Error
            ? failure.message
            : 'The user was not created.',
        );
    } finally {
      if (currentContext.current === key) setCreating(false);
    }
  };

  if (session.user.role !== 'administrator')
    return (
      <View style={styles.page}>
        <Text style={styles.error}>Administrator access is required.</Text>
      </View>
    );

  const columns: MatrixRadio[] = radios.map((radio) => ({
    radioId: radio.radioId,
    displayName: radio.displayName,
  }));

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={styles.title}>
        Users & access
      </Text>
      <Text style={styles.muted}>
        Set what each person can do on each radio. Administrator status manages
        the station; radio operation is assigned explicitly, including for your
        own account.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Disclosure title="Create a user">
        <Text style={styles.label}>Username</Text>
        <TextInput
          accessibilityLabel="New username"
          placeholder="e.g. operador1"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          style={styles.input}
        />
        <Text style={styles.label}>Password</Text>
        <TextInput
          accessibilityLabel="New user password"
          placeholder="At least 12 characters"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="newPassword"
          autoComplete="new-password"
          style={styles.input}
        />
        <PasswordStrength password={password} context={[username]} />
        <Text style={styles.label}>Role</Text>
        <SegmentedControl
          accessibilityLabel="Role for the new user"
          options={ROLES.map((value) => ({
            value,
            label: ROLE_LABELS[value],
          }))}
          value={role}
          onChange={setRole}
        />
        <Text style={styles.small}>
          New users have no radio access until you assign it in the matrix.
        </Text>
        <Button
          label="Create user"
          variant="primary"
          loading={creating}
          disabled={!canCreate}
          onPress={() => {
            void create();
          }}
        />
        {createError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {createError}
          </Text>
        ) : null}
      </Disclosure>
      {!loaded && !error ? <LoadingState label="Loading users…" /> : null}
      {loaded ? (
        <PermissionMatrix
          key={contextKey}
          users={users}
          radios={columns}
          templates={templates}
          currentUserId={session.user.id}
          actions={actions}
          focusUserId={focusUserId}
        />
      ) : null}
    </ScrollView>
  );
}
