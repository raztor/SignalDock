import type { Permission, PublicUser, Role } from '@signaldock/contracts';
import {
  Badge,
  Button,
  Chip,
  ChipGroup,
  ConfirmButton,
  ConfirmDialog,
  Icon,
  Pressable,
  SegmentedControl,
  Text,
  TextInput,
  createStyles,
  radius,
  space,
  type,
  useTheme,
  useToast,
  type IconName,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { PasswordStrength } from './PasswordStrength';
import { passwordStrength } from './password-strength';
import {
  LEVEL_LABELS,
  RADIO_LEVELS,
  ROLES,
  ROLE_LABELS,
  accessPatch,
  allowedLevels,
  applyLevel,
  applyRole,
  cellAccessibilityLabel,
  changeCount,
  changeCountLabel,
  changedRadios,
  clearRadio,
  draftOf,
  findGrant,
  grantLevel,
  initialsOf,
  isOperational,
  levelFromPermissions,
  needsDemotionConfirmation,
  otherPermissionCount,
  permissionLabel,
  reconcileDrafts,
  roleChangeMessage,
  sameAccess,
  secondaryPermissions,
  setSecondaryPermission,
  type AccessDraft,
  type LevelReading,
  type RadioLevel,
  type RoleTemplates,
} from './permission-model';

/** A radio column. */
export interface MatrixRadio {
  radioId: string;
  displayName: string;
}

/** Account actions; each rejects with an Error to show inline. */
export interface PermissionMatrixActions {
  saveAccess(user: PublicUser, patch: AccessDraft): Promise<void>;
  setEnabled(user: PublicUser, enabled: boolean): Promise<void>;
  revokeSessions(user: PublicUser): Promise<void>;
  resetPassword(user: PublicUser, password: string): Promise<void>;
}

export interface PermissionMatrixProps {
  users: readonly PublicUser[];
  radios: readonly MatrixRadio[];
  /** Role templates from `admin/role-permissions`; editing waits for them. */
  templates: RoleTemplates | null;
  currentUserId: string;
  actions: PermissionMatrixActions;
  /** Expands this user's row (e.g. right after creating the account). */
  focusUserId?: string | undefined;
}

interface Staged {
  base: AccessDraft;
  draft: AccessDraft;
}

interface PendingRole {
  user: PublicUser;
  to: Role;
  message: string;
}

const USER_COLUMN = 236;
const CELL_COLUMN = 176;
const LEVEL_ICONS: Record<RadioLevel, IconName> = {
  none: 'close',
  listen: 'headphones',
  control: 'knob',
  transmit: 'mic',
};
const LEVEL_RANK: Record<RadioLevel, number> = {
  none: 0,
  listen: 1,
  control: 2,
  transmit: 3,
};

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message
    ? failure.message
    : fallback;
}

/**
 * Users × radios access matrix. Each cell sets one cumulative level (None /
 * Listen / Control / Transmit). Changes are staged per user and saved with
 * that user's "Save changes" bar; the PATCH keeps the existing
 * `radioPermissions` contract and every permission the matrix does not edit.
 * Role, secondary permissions and account actions live in each user's
 * expandable row.
 */
export function PermissionMatrix({
  users,
  radios,
  templates,
  currentUserId,
  actions,
  focusUserId,
}: PermissionMatrixProps) {
  const styles = useStyles();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [width, setWidth] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Staged>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // Users whose save is in flight: their controls are disabled so nothing is
  // edited (and then silently dropped) while the PATCH and reload run. The ref
  // is read synchronously by the reconcile effect.
  const saving = useRef(new Set<string>());
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const setSaving = (userId: string, active: boolean) => {
    if (active) saving.current.add(userId);
    else saving.current.delete(userId);
    setSavingIds(new Set(saving.current));
  };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [pendingRole, setPendingRole] = useState<PendingRole | null>(null);
  const [roleNotes, setRoleNotes] = useState<Record<string, string>>({});

  // Keep drafts only while their base still matches the saved account.
  useEffect(() => {
    const result = reconcileDrafts(draftsRef.current, users);
    if (
      Object.keys(result.drafts).length ===
      Object.keys(draftsRef.current).length
    )
      return;
    setDrafts(result.drafts);
    const names = result.discarded
      .filter((id) => !saving.current.has(id))
      .map((id) => users.find((user) => user.id === id)?.username)
      .filter((name): name is string => Boolean(name));
    if (names.length)
      toastRef.current.show({
        tone: 'warning',
        message: `Unsaved changes for ${names.join(', ')} were discarded because the account changed.`,
      });
  }, [users]);

  useEffect(() => {
    if (focusUserId) setExpanded((old) => new Set(old).add(focusUserId));
  }, [focusUserId]);

  const radioName = (radioId: string) =>
    radios.find((radio) => radio.radioId === radioId)?.displayName ??
    'an unlisted radio';

  const staged = (user: PublicUser): Staged => {
    const entry = drafts[user.id];
    if (entry) return entry;
    const base = draftOf(user);
    return { base, draft: base };
  };

  const edit = (
    user: PublicUser,
    update: (draft: AccessDraft) => AccessDraft,
  ) =>
    setDrafts((old) => {
      const entry = old[user.id] ?? {
        base: draftOf(user),
        draft: draftOf(user),
      };
      const draft = update(entry.draft);
      const next = { ...old };
      if (sameAccess(entry.base, draft)) delete next[user.id];
      else next[user.id] = { base: entry.base, draft };
      return next;
    });

  const discard = (user: PublicUser) => {
    setDrafts((old) => {
      const next = { ...old };
      delete next[user.id];
      return next;
    });
    setRoleNotes((old) => {
      const next = { ...old };
      delete next[user.id];
      return next;
    });
  };

  const applyRoleChange = (user: PublicUser, to: Role) => {
    if (!templates) return;
    const { removed } = applyRole(
      staged(user).draft.radioPermissions,
      templates[to],
    );
    edit(user, (draft) => ({
      role: to,
      radioPermissions: applyRole(draft.radioPermissions, templates[to]).grants,
    }));
    const operational = removed.filter((entry) =>
      entry.permissions.some(isOperational),
    ).length;
    setRoleNotes((old) => ({
      ...old,
      [user.id]: removed.length
        ? `The ${ROLE_LABELS[to].toLowerCase()} role does not allow some permissions; they were removed from ${removed.length} radio${
            removed.length === 1 ? '' : 's'
          }${operational ? ' (including operation levels)' : ''}. Nothing is saved until you select Save changes.`
        : '',
    }));
  };

  const requestRole = (user: PublicUser, to: Role) => {
    if (!templates) return;
    const { draft } = staged(user);
    if (draft.role === to) return;
    if (needsDemotionConfirmation(draft.role, to)) {
      const preview = applyRole(draft.radioPermissions, templates[to]);
      setPendingRole({
        user,
        to,
        message: roleChangeMessage({
          username: user.username,
          from: draft.role,
          to,
          removed: preview.removed,
          radioName,
          self: user.id === currentUserId,
        }),
      });
      return;
    }
    applyRoleChange(user, to);
  };

  const save = async (user: PublicUser) => {
    const entry = draftsRef.current[user.id];
    if (!entry) return;
    setSaving(user.id, true);
    try {
      await actions.saveAccess(user, accessPatch(entry.draft));
      // Drop the draft only if it is still the one that was saved.
      setDrafts((old) => {
        if (old[user.id]?.draft !== entry.draft) return old;
        const next = { ...old };
        delete next[user.id];
        return next;
      });
      setRoleNotes((old) => {
        const next = { ...old };
        delete next[user.id];
        return next;
      });
    } finally {
      setSaving(user.id, false);
    }
  };

  const toggle = (userId: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const tableWidth = USER_COLUMN + radios.length * CELL_COLUMN;
  const table =
    width > 0 && radios.length > 0 && width >= tableWidth + space.md * 2;
  const stagedUsers = Object.keys(drafts).length;

  return (
    <View
      style={styles.container}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View style={styles.legendRow}>
        <View accessibilityRole="text" style={styles.legend}>
          {RADIO_LEVELS.slice(1).map((level) => (
            <View key={level} style={styles.legendItem}>
              <LevelIcon level={level} size={14} />
              <Text style={styles.caption}>{LEVEL_LABELS[level]}</Text>
            </View>
          ))}
          <Text style={styles.caption}>
            Each level includes the ones before it.
          </Text>
        </View>
        {stagedUsers ? (
          <Badge
            tone="warning"
            icon="clock"
            label={`${stagedUsers} user${stagedUsers === 1 ? '' : 's'} with unsaved changes`}
          />
        ) : null}
      </View>
      {!radios.length ? (
        <Text style={styles.muted}>
          Configure a radio before assigning operational access.
        </Text>
      ) : null}
      {!templates ? (
        <Text style={styles.muted}>Loading role permissions…</Text>
      ) : null}
      {table ? (
        <View accessibilityRole="none" style={styles.headerRow}>
          <Text style={[styles.columnHeader, { width: USER_COLUMN }]}>
            User
          </Text>
          {radios.map((radio) => (
            <Text
              key={radio.radioId}
              numberOfLines={2}
              style={[styles.columnHeader, { width: CELL_COLUMN }]}
            >
              {radio.displayName}
            </Text>
          ))}
        </View>
      ) : null}
      {users.map((user) => {
        const entry = staged(user);
        return (
          <UserBlock
            key={user.id}
            layout={table ? 'table' : 'cards'}
            user={user}
            self={user.id === currentUserId}
            entry={entry}
            radios={radios}
            templates={templates}
            saving={savingIds.has(user.id)}
            expanded={expanded.has(user.id)}
            roleNote={roleNotes[user.id] ?? ''}
            radioName={radioName}
            onToggle={() => toggle(user.id)}
            onLevel={(radioId, level) => {
              if (!templates) return;
              edit(user, (draft) => ({
                ...draft,
                radioPermissions: applyLevel(
                  draft.radioPermissions,
                  radioId,
                  level,
                  templates[draft.role],
                ),
              }));
            }}
            onSecondary={(radioId, permission, enabled) =>
              edit(user, (draft) => ({
                ...draft,
                radioPermissions: setSecondaryPermission(
                  draft.radioPermissions,
                  radioId,
                  permission,
                  enabled,
                ),
              }))
            }
            onClearRadio={(radioId) =>
              edit(user, (draft) => ({
                ...draft,
                radioPermissions: clearRadio(draft.radioPermissions, radioId),
              }))
            }
            onRole={(role) => requestRole(user, role)}
            onDiscard={() => discard(user)}
            onSave={() => save(user)}
            actions={actions}
          />
        );
      })}
      <ConfirmDialog
        visible={pendingRole !== null}
        title={
          pendingRole
            ? `Change ${pendingRole.user.username} to ${ROLE_LABELS[pendingRole.to]}?`
            : ''
        }
        message={pendingRole?.message ?? ''}
        confirmLabel={
          pendingRole ? `Change to ${ROLE_LABELS[pendingRole.to]}` : 'Change'
        }
        onCancel={() => setPendingRole(null)}
        onConfirm={() => {
          if (pendingRole) applyRoleChange(pendingRole.user, pendingRole.to);
          setPendingRole(null);
        }}
      />
    </View>
  );
}

// ─── One user (table row or card) ──────────────────────────────────────────

interface UserBlockProps {
  layout: 'table' | 'cards';
  user: PublicUser;
  self: boolean;
  entry: Staged;
  radios: readonly MatrixRadio[];
  templates: RoleTemplates | null;
  /** A save for this user is in flight; edits are locked until it ends. */
  saving: boolean;
  expanded: boolean;
  roleNote: string;
  radioName(radioId: string): string;
  onToggle(): void;
  onLevel(radioId: string, level: RadioLevel): void;
  onSecondary(radioId: string, permission: Permission, enabled: boolean): void;
  onClearRadio(radioId: string): void;
  onRole(role: Role): void;
  onDiscard(): void;
  onSave(): Promise<void>;
  actions: PermissionMatrixActions;
}

function UserBlock(props: UserBlockProps) {
  const { layout, user, entry, radios, templates } = props;
  const styles = useStyles();
  const { draft, base } = entry;
  const changed = new Set(
    changedRadios(base.radioPermissions, draft.radioPermissions),
  );
  const levels = templates ? allowedLevels(templates[draft.role]) : [];
  const cell = (radio: MatrixRadio) => (
    <LevelControl
      key={radio.radioId}
      username={user.username}
      radioName={radio.displayName}
      reading={grantLevel(draft.radioPermissions, radio.radioId)}
      others={otherPermissionCount(draft.radioPermissions, radio.radioId)}
      changed={changed.has(radio.radioId)}
      allowed={levels}
      role={draft.role}
      disabled={!templates || props.saving}
      onChange={(level) => props.onLevel(radio.radioId, level)}
    />
  );
  return (
    <View
      style={[
        layout === 'table' ? styles.tableBlock : styles.card,
        !user.enabled && styles.disabledBlock,
      ]}
    >
      {layout === 'table' ? (
        <View style={styles.tableRow}>
          <View style={{ width: USER_COLUMN }}>
            <UserHeader {...props} />
          </View>
          {radios.map((radio) => (
            <View key={radio.radioId} style={{ width: CELL_COLUMN }}>
              {cell(radio)}
            </View>
          ))}
        </View>
      ) : (
        <>
          <UserHeader {...props} />
          {radios.map((radio) => (
            <View key={radio.radioId} style={styles.cardRadio}>
              <Text style={styles.cardRadioName} numberOfLines={2}>
                {radio.displayName}
              </Text>
              {cell(radio)}
            </View>
          ))}
        </>
      )}
      <SaveBar
        count={changeCount(base, draft)}
        self={props.self}
        onDiscard={props.onDiscard}
        onSave={props.onSave}
      />
      {props.expanded ? <UserDetails {...props} /> : null}
    </View>
  );
}

function UserHeader({ user, self, entry, expanded, onToggle }: UserBlockProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const roleChanged = entry.base.role !== entry.draft.role;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${user.username}${self ? ' (you)' : ''}, ${
        ROLE_LABELS[entry.draft.role]
      }${roleChanged ? ', role change not saved' : ''}${
        user.enabled ? '' : ', disabled'
      }. Role, permissions and account details`}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={styles.userHeader}
    >
      <Icon
        name={expanded ? 'chevron-down' : 'chevron-right'}
        size={18}
        color={colors.textSecondary}
      />
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initialsOf(user.username)}</Text>
      </View>
      <View style={styles.userText}>
        <Text style={styles.username} numberOfLines={1}>
          {user.username}
          {self ? ' (you)' : ''}
        </Text>
        <View style={styles.badges}>
          <Badge
            label={
              roleChanged
                ? `${ROLE_LABELS[entry.base.role]} → ${ROLE_LABELS[entry.draft.role]}`
                : ROLE_LABELS[entry.draft.role]
            }
            tone={
              roleChanged
                ? 'warning'
                : entry.draft.role === 'administrator'
                  ? 'primary'
                  : 'neutral'
            }
          />
          {!user.enabled ? (
            <Badge label="Disabled" tone="error" icon="lock" />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

// ─── Level control (one cell) ──────────────────────────────────────────────

function LevelIcon({
  level,
  size,
  color,
}: {
  level: RadioLevel;
  size: number;
  color?: string;
}) {
  const { colors } = useTheme();
  return (
    <Icon
      name={LEVEL_ICONS[level]}
      size={size}
      color={color ?? colors.textSecondary}
    />
  );
}

function LevelControl({
  username,
  radioName,
  reading,
  others,
  changed,
  allowed,
  role,
  disabled,
  onChange,
}: {
  username: string;
  radioName: string;
  reading: LevelReading;
  others: number;
  changed: boolean;
  allowed: readonly RadioLevel[];
  role: Role;
  disabled: boolean;
  onChange(level: RadioLevel): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const web = Platform.OS === 'web';
  const nodes = useRef<({ focus?: () => void } | null)[]>([]);
  const focused = useRef<number | undefined>(undefined);
  const current = RADIO_LEVELS.indexOf(reading.level);
  const enabled = RADIO_LEVELS.map(
    (level) => !disabled && allowed.includes(level),
  );
  const onKeyDown = (event: {
    nativeEvent: { key: string };
    preventDefault(): void;
  }) => {
    const key = event.nativeEvent.key;
    if (key === ' ' || key === 'Spacebar') {
      // Space selects the focused level, or re-applies a non-standard one.
      const index = focused.current ?? current;
      const level = RADIO_LEVELS[index];
      if (!level || !enabled[index]) return;
      event.preventDefault();
      if (index !== current || !reading.exact) onChange(level);
      return;
    }
    const step =
      key === 'ArrowRight' || key === 'ArrowUp'
        ? 1
        : key === 'ArrowLeft' || key === 'ArrowDown'
          ? -1
          : 0;
    if (!step) return;
    let index = current + step;
    while (index >= 0 && index < RADIO_LEVELS.length && !enabled[index])
      index += step;
    const level = RADIO_LEVELS[index];
    if (!level) return;
    event.preventDefault();
    nodes.current[index]?.focus?.();
    onChange(level);
  };
  const caption = `${LEVEL_LABELS[reading.level]}${
    reading.exact ? '' : ' · non-standard'
  }${others ? ` · +${others} other` : ''}`;
  return (
    <View style={styles.cell}>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={cellAccessibilityLabel(
          username,
          radioName,
          reading,
        )}
        {...(web ? { onKeyDown } : {})}
        style={[styles.levels, changed && styles.levelsChanged]}
      >
        {RADIO_LEVELS.map((level, index) => {
          const checked = level === reading.level;
          const filled =
            level === 'none'
              ? checked
              : LEVEL_RANK[level] <= LEVEL_RANK[reading.level];
          const inactive = !enabled[index];
          const blockedByRole = !disabled && !allowed.includes(level);
          return (
            <Pressable
              key={level}
              ref={(node: { focus?: () => void } | null) => {
                nodes.current[index] = node;
              }}
              {...(web
                ? {
                    tabIndex:
                      index ===
                      (enabled[current] ? current : enabled.indexOf(true))
                        ? 0
                        : -1,
                  }
                : {})}
              accessibilityRole="radio"
              accessibilityLabel={`${LEVEL_LABELS[level]}${
                blockedByRole
                  ? ` (not allowed for the ${ROLE_LABELS[role].toLowerCase()} role)`
                  : ''
              }`}
              accessibilityState={{ checked }}
              disabled={inactive}
              hitSlop={4}
              onFocus={() => {
                focused.current = index;
              }}
              onPress={() => {
                // A non-standard reading is normalised by tapping its level.
                if (!checked || !reading.exact) onChange(level);
              }}
              style={[
                styles.level,
                filled &&
                  (level === 'none' ? styles.levelNone : styles.levelFilled),
              ]}
            >
              <LevelIcon
                level={level}
                size={16}
                color={
                  filled && level !== 'none'
                    ? colors.onPrimary
                    : colors.textSecondary
                }
              />
            </Pressable>
          );
        })}
      </View>
      <Text
        numberOfLines={1}
        style={[styles.caption, !reading.exact && styles.warningText]}
      >
        {caption}
        {changed ? <Text style={styles.warningText}> · unsaved</Text> : null}
      </Text>
    </View>
  );
}

// ─── Save bar ──────────────────────────────────────────────────────────────

function SaveBar({
  count,
  self,
  onDiscard,
  onSave,
}: {
  count: number;
  self: boolean;
  onDiscard(): void;
  onSave(): Promise<void>;
}) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!count) setError('');
  }, [count]);
  if (!count) return null;
  return (
    <View style={styles.saveBar}>
      <View style={styles.saveRow}>
        <View style={styles.saveText}>
          <View style={styles.inlineIcon}>
            <Icon name="clock" size={16} />
            <Text style={styles.label}>{changeCountLabel(count)}</Text>
          </View>
          <Text style={styles.caption}>
            {self
              ? 'Saving changes to your own account signs you out of every session.'
              : 'Saving revokes this user’s existing sessions.'}
          </Text>
        </View>
        <View style={styles.saveActions}>
          <Button
            label="Discard"
            variant="quiet"
            disabled={busy}
            onPress={onDiscard}
          />
          <Button
            label="Save changes"
            variant="primary"
            loading={busy}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              setError('');
              onSave()
                .catch((failure: unknown) =>
                  setError(
                    failureMessage(failure, 'Changes could not be saved.'),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          />
        </View>
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// ─── Expanded details ──────────────────────────────────────────────────────

function UserDetails(props: UserBlockProps) {
  const { user, entry, templates, radios, roleNote } = props;
  const styles = useStyles();
  const { draft } = entry;
  const template = templates?.[draft.role] ?? [];
  const secondary = secondaryPermissions(template);
  const listed = new Set(radios.map((radio) => radio.radioId));
  const assigned = radios.filter((radio) =>
    findGrant(draft.radioPermissions, radio.radioId),
  );
  const unlisted = draft.radioPermissions.filter(
    (grant) => !listed.has(grant.radioId),
  );
  return (
    <View style={styles.details}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Role</Text>
        <SegmentedControl
          accessibilityLabel={`Role for ${user.username}`}
          options={ROLES.map((role) => ({
            value: role,
            label: ROLE_LABELS[role],
          }))}
          value={draft.role}
          disabled={!templates || props.saving}
          onChange={props.onRole}
        />
        <Text style={styles.caption}>
          Administrators manage the station. Radio operation is always assigned
          per radio, including for administrators. Listeners can only listen.
        </Text>
        {roleNote ? <Text style={styles.warningText}>{roleNote}</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Other permissions per radio</Text>
        {!assigned.length && !unlisted.length ? (
          <Text style={styles.muted}>
            No radio access yet. Set a level in the matrix; new assignments
            start with the {ROLE_LABELS[draft.role].toLowerCase()} role’s
            default permissions.
          </Text>
        ) : null}
        {assigned.map((radio) => {
          const grant = findGrant(draft.radioPermissions, radio.radioId);
          const held = grant?.permissions ?? [];
          const extra = held.filter(
            (p) => !isOperational(p) && !secondary.includes(p),
          );
          return (
            <View key={radio.radioId} style={styles.radioPermissions}>
              <View style={styles.radioPermissionsHeader}>
                <Text style={styles.label}>{radio.displayName}</Text>
                <Text style={styles.caption}>
                  {LEVEL_LABELS[levelFromPermissions(held).level]}
                </Text>
              </View>
              <ChipGroup
                accessibilityLabel={`Other permissions for ${user.username} on ${radio.displayName}`}
              >
                {[...secondary, ...extra].map((permission) => (
                  <Chip
                    key={permission}
                    label={permissionLabel(permission)}
                    selected={held.includes(permission)}
                    disabled={!templates || props.saving}
                    accessibilityLabel={`${permissionLabel(permission)} on ${radio.displayName}`}
                    onPress={() =>
                      props.onSecondary(
                        radio.radioId,
                        permission,
                        !held.includes(permission),
                      )
                    }
                  />
                ))}
              </ChipGroup>
              <Button
                label="Remove all access to this radio"
                variant="quiet"
                disabled={props.saving}
                onPress={() => props.onClearRadio(radio.radioId)}
              />
            </View>
          );
        })}
        {unlisted.length ? (
          <Text style={styles.caption}>
            Also holds access to {unlisted.length} radio
            {unlisted.length === 1 ? '' : 's'} not in the configuration list (
            {unlisted.map((grant) => grant.permissions.length).join(', ')}{' '}
            permissions). It is kept unchanged when you save.
          </Text>
        ) : null}
      </View>

      <AccountActions {...props} />
    </View>
  );
}

function AccountActions({ user, self, actions }: UserBlockProps) {
  const styles = useStyles();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const strength = passwordStrength(password, [user.username]);
  const run = (action: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    setError('');
    action()
      .then(() => after?.())
      .catch((failure: unknown) =>
        setError(failureMessage(failure, 'The operation failed.')),
      )
      .finally(() => setBusy(false));
  };
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Account</Text>
      <Text style={styles.muted}>
        {user.enabled
          ? 'Enabled · can sign in with the permissions above.'
          : 'Disabled · cannot sign in until enabled again.'}
      </Text>
      <View style={styles.actions}>
        <ConfirmButton
          label={user.enabled ? 'Disable account' : 'Enable account'}
          variant={user.enabled ? 'danger' : 'secondary'}
          disabled={busy}
          confirmation={{
            title: user.enabled
              ? 'Disable this account?'
              : 'Enable this account?',
            message: user.enabled
              ? 'This stops the account’s access until it is enabled again.'
              : 'This allows the account to sign in with its assigned permissions.',
          }}
          onPress={() => run(() => actions.setEnabled(user, !user.enabled))}
        />
        <ConfirmButton
          label="Revoke sessions"
          variant="danger"
          disabled={busy}
          confirmation={{
            title: 'Revoke this user’s sessions?',
            message:
              'The user will need to sign in again on every connected device.',
          }}
          onPress={() => run(() => actions.revokeSessions(user))}
        />
      </View>
      <Text style={styles.label}>Reset password</Text>
      <TextInput
        accessibilityLabel={`New password for ${user.username}`}
        placeholder="Replacement password (12+ characters)"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="newPassword"
        autoComplete="new-password"
        style={styles.input}
      />
      <PasswordStrength password={password} context={[user.username]} />
      <ConfirmButton
        label="Reset password"
        disabled={busy || !strength.acceptable}
        confirmation={{
          title: 'Replace this user’s password?',
          message: self
            ? 'The new password replaces your current password and signs you out of every session.'
            : 'The new password will replace the current password for this station account and revoke its sessions.',
        }}
        onPress={() =>
          run(
            () => actions.resetPassword(user, password),
            // UserAdminScreen already confirms the reset with a toast.
            () => setPassword(''),
          )
        }
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────

const useStyles = createStyles((colors) => ({
  container: { gap: space.sm },
  legendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.md,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: space.md,
    paddingBottom: space.xs,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  columnHeader: {
    ...type.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    paddingRight: space.sm,
  },
  tableBlock: {
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  tableRow: { flexDirection: 'row', alignItems: 'center' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  disabledBlock: { backgroundColor: colors.background },
  cardRadio: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  cardRadioName: {
    ...type.label,
    color: colors.textPrimary,
    flex: 1,
    minWidth: 120,
  },
  userHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingRight: space.sm,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  avatarText: { ...type.caption, fontWeight: '700', color: colors.textPrimary },
  userText: { flex: 1, minWidth: 0, gap: 2 },
  username: { ...type.label, color: colors.textPrimary },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  cell: { gap: 2, alignItems: 'flex-start' },
  levels: {
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  levelsChanged: { borderColor: colors.warning, borderStyle: 'dashed' },
  level: {
    minHeight: 36,
    width: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceElevated,
  },
  levelFilled: { backgroundColor: colors.primary },
  levelNone: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.textSecondary,
  },
  caption: { ...type.caption, color: colors.textSecondary },
  warningText: { ...type.caption, color: colors.warning },
  muted: { ...type.body, color: colors.textSecondary },
  label: { ...type.label, color: colors.textPrimary },
  error: { ...type.body, color: colors.error },
  saveBar: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.warning,
    backgroundColor: colors.surface,
  },
  saveRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  saveText: { flex: 1, minWidth: 200, gap: 2 },
  inlineIcon: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  saveActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  details: {
    gap: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  section: { gap: space.sm },
  sectionTitle: { ...type.heading, color: colors.textPrimary },
  radioPermissions: {
    gap: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  radioPermissionsHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: space.sm,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  input: { maxWidth: 420 },
}));
