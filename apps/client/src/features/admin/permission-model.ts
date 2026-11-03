import type {
  Permission,
  PublicUser,
  RadioPermissionGrant,
  Role,
} from '@signaldock/contracts';

/**
 * Pure model behind the users × radios permission matrix. Node-safe: imports
 * only contract types so it can be unit tested without React Native.
 *
 * The matrix edits exactly three operational permissions per radio
 * (`radio.listen`, `radio.control`, `radio.transmit`) as one cumulative level.
 * Every other permission already present in a grant is preserved unless the
 * administrator changes it explicitly (secondary permissions) or a role change
 * makes it invalid for the backend (which rejects permissions outside the
 * role's template).
 */

export type RadioLevel = 'none' | 'listen' | 'control' | 'transmit';
export type RoleTemplates = Record<Role, readonly Permission[]>;

export const ROLES: readonly Role[] = ['listener', 'operator', 'administrator'];
export const RADIO_LEVELS: readonly RadioLevel[] = [
  'none',
  'listen',
  'control',
  'transmit',
];
export const OPERATIONAL_PERMISSIONS: readonly Permission[] = [
  'radio.listen',
  'radio.control',
  'radio.transmit',
];
/** Cumulative permission set for each level. */
export const LEVEL_PERMISSIONS: Record<RadioLevel, readonly Permission[]> = {
  none: [],
  listen: ['radio.listen'],
  control: ['radio.listen', 'radio.control'],
  transmit: ['radio.listen', 'radio.control', 'radio.transmit'],
};
export const LEVEL_LABELS: Record<RadioLevel, string> = {
  none: 'None',
  listen: 'Listen',
  control: 'Control',
  transmit: 'Transmit',
};
export const ROLE_LABELS: Record<Role, string> = {
  listener: 'Listener',
  operator: 'Operator',
  administrator: 'Administrator',
};
const ROLE_RANK: Record<Role, number> = {
  listener: 0,
  operator: 1,
  administrator: 2,
};
const PERMISSION_LABELS: Record<Permission, string> = {
  'radio.listen': 'Listen',
  'radio.control': 'Control',
  'radio.transmit': 'Transmit',
  'radio.configure': 'Configure radio',
  'history.read': 'Read history',
  'history.write': 'Edit history',
  'recording.export': 'Export recordings',
  'incident.read': 'Read incidents',
  'incident.manage': 'Manage incidents',
  'aprs.read': 'Read APRS',
  'processing.manage': 'Manage processing',
  'notifications.read': 'Read notifications',
  'notifications.manage': 'Manage notifications',
  'instance.admin': 'Station administration',
};

/**
 * Fallback templates mirroring the identity service, used only for display
 * before `admin/role-permissions` loads. Editing waits for the real templates.
 */
export const DEFAULT_ROLE_TEMPLATES: RoleTemplates = {
  listener: [
    'radio.listen',
    'history.read',
    'incident.read',
    'aprs.read',
    'notifications.read',
  ],
  operator: [
    'radio.listen',
    'radio.control',
    'radio.transmit',
    'history.read',
    'history.write',
    'recording.export',
    'incident.read',
    'incident.manage',
    'aprs.read',
    'notifications.read',
  ],
  administrator: [
    'radio.listen',
    'radio.control',
    'radio.transmit',
    'radio.configure',
    'history.read',
    'history.write',
    'recording.export',
    'incident.read',
    'incident.manage',
    'aprs.read',
    'notifications.read',
  ],
};

export function permissionLabel(permission: Permission): string {
  return PERMISSION_LABELS[permission];
}

export function isOperational(permission: Permission): boolean {
  return OPERATIONAL_PERMISSIONS.includes(permission);
}

// ─── Levels ────────────────────────────────────────────────────────────────

export interface LevelReading {
  /** Highest cumulative level fully contained in the permission set. */
  level: RadioLevel;
  /**
   * False when the set holds an operational permission above `level` that
   * does not form a cumulative level (e.g. transmit without control).
   */
  exact: boolean;
}

/** Reads the cumulative level of a permission set. */
export function levelFromPermissions(
  permissions: readonly Permission[],
): LevelReading {
  const held = new Set(permissions);
  let level: RadioLevel = 'none';
  for (const candidate of RADIO_LEVELS)
    if (LEVEL_PERMISSIONS[candidate].every((p) => held.has(p)))
      level = candidate;
    else break;
  const operational = OPERATIONAL_PERMISSIONS.filter((p) => held.has(p));
  return {
    level,
    exact: operational.length === LEVEL_PERMISSIONS[level].length,
  };
}

export function findGrant(
  grants: readonly RadioPermissionGrant[],
  radioId: string,
): RadioPermissionGrant | undefined {
  return grants.find((grant) => grant.radioId === radioId);
}

export function grantLevel(
  grants: readonly RadioPermissionGrant[],
  radioId: string,
): LevelReading {
  return levelFromPermissions(findGrant(grants, radioId)?.permissions ?? []);
}

/** Levels a role may hold: every permission of the level is in the template. */
export function allowedLevels(
  template: readonly Permission[],
): readonly RadioLevel[] {
  return RADIO_LEVELS.filter((level) =>
    LEVEL_PERMISSIONS[level].every((p) => template.includes(p)),
  );
}

export function isLevelAllowed(
  level: RadioLevel,
  template: readonly Permission[],
): boolean {
  return allowedLevels(template).includes(level);
}

/** Secondary (non-operational) permissions a role template allows per radio. */
export function secondaryPermissions(
  template: readonly Permission[],
): Permission[] {
  return template.filter((p) => !isOperational(p));
}

function unique(permissions: readonly Permission[]): Permission[] {
  return [...new Set(permissions)];
}

function replaceGrant(
  grants: readonly RadioPermissionGrant[],
  radioId: string,
  permissions: Permission[],
): RadioPermissionGrant[] {
  const index = grants.findIndex((grant) => grant.radioId === radioId);
  if (!permissions.length)
    return index < 0
      ? [...grants]
      : grants.filter((grant) => grant.radioId !== radioId);
  const next = { radioId, permissions };
  if (index < 0) return [...grants, next];
  return grants.map((grant, i) => (i === index ? next : grant));
}

/**
 * Applies a cumulative level to one radio. Only the three operational
 * permissions are replaced; every other permission already in the grant is
 * kept, as are grants for every other radio (including radios the matrix does
 * not display). A new grant (no previous assignment) receives the level plus
 * `defaults` — the role's secondary permissions, matching the previous
 * assignment behaviour. A grant left with no permissions is removed.
 */
export function applyLevel(
  grants: readonly RadioPermissionGrant[],
  radioId: string,
  level: RadioLevel,
  defaults: readonly Permission[] = [],
): RadioPermissionGrant[] {
  const existing = findGrant(grants, radioId);
  if (!existing && level === 'none') return [...grants];
  const kept = existing
    ? existing.permissions.filter((p) => !isOperational(p))
    : secondaryPermissions(defaults);
  return replaceGrant(
    grants,
    radioId,
    unique([...LEVEL_PERMISSIONS[level], ...kept]),
  );
}

/** Adds or removes one secondary permission on an existing radio grant. */
export function setSecondaryPermission(
  grants: readonly RadioPermissionGrant[],
  radioId: string,
  permission: Permission,
  enabled: boolean,
): RadioPermissionGrant[] {
  if (isOperational(permission)) return [...grants];
  const existing = findGrant(grants, radioId);
  if (!existing) return [...grants];
  const has = existing.permissions.includes(permission);
  if (has === enabled) return [...grants];
  return replaceGrant(
    grants,
    radioId,
    enabled
      ? [...existing.permissions, permission]
      : existing.permissions.filter((p) => p !== permission),
  );
}

/** Removes every permission for one radio (explicit "remove all access"). */
export function clearRadio(
  grants: readonly RadioPermissionGrant[],
  radioId: string,
): RadioPermissionGrant[] {
  return grants.filter((grant) => grant.radioId !== radioId);
}

// ─── Roles ─────────────────────────────────────────────────────────────────

export interface RoleRemoval {
  radioId: string;
  permissions: Permission[];
}

export interface RoleApplication {
  grants: RadioPermissionGrant[];
  /** Permissions the new role does not allow, removed per radio. */
  removed: RoleRemoval[];
}

/**
 * Keeps each grant's permissions that the new role allows. The backend
 * rejects grants holding permissions outside the role template, so these must
 * go; nothing is added on promotion (levels are adjusted explicitly).
 */
export function applyRole(
  grants: readonly RadioPermissionGrant[],
  template: readonly Permission[],
): RoleApplication {
  const removed: RoleRemoval[] = [];
  const next: RadioPermissionGrant[] = [];
  for (const grant of grants) {
    const kept = grant.permissions.filter((p) => template.includes(p));
    const dropped = grant.permissions.filter((p) => !template.includes(p));
    if (dropped.length)
      removed.push({ radioId: grant.radioId, permissions: unique(dropped) });
    if (kept.length) next.push({ radioId: grant.radioId, permissions: kept });
  }
  return { grants: next, removed };
}

export function isDemotion(from: Role, to: Role): boolean {
  return ROLE_RANK[to] < ROLE_RANK[from];
}

/** Administrators demoted to a lower role need an explicit confirmation. */
export function needsDemotionConfirmation(from: Role, to: Role): boolean {
  return from === 'administrator' && isDemotion(from, to);
}

// ─── Drafts and diffs ──────────────────────────────────────────────────────

export interface AccessDraft {
  role: Role;
  radioPermissions: RadioPermissionGrant[];
}

export function draftOf(user: Pick<PublicUser, 'role' | 'radioPermissions'>) {
  return {
    role: user.role,
    radioPermissions: user.radioPermissions.map((grant) => ({
      radioId: grant.radioId,
      permissions: [...grant.permissions],
    })),
  } satisfies AccessDraft;
}

function samePermissions(
  a: readonly Permission[],
  b: readonly Permission[],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((p) => right.has(p));
}

/** Radio IDs whose permission set differs between the two grant lists. */
export function changedRadios(
  before: readonly RadioPermissionGrant[],
  after: readonly RadioPermissionGrant[],
): string[] {
  const ids = uniqueIds([
    ...before.map((g) => g.radioId),
    ...after.map((g) => g.radioId),
  ]);
  return ids.filter(
    (id) =>
      !samePermissions(
        findGrant(before, id)?.permissions ?? [],
        findGrant(after, id)?.permissions ?? [],
      ),
  );
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Number of staged changes: one for the role, one per changed radio. */
export function changeCount(base: AccessDraft, draft: AccessDraft): number {
  return (
    (base.role === draft.role ? 0 : 1) +
    changedRadios(base.radioPermissions, draft.radioPermissions).length
  );
}

export function sameAccess(a: AccessDraft, b: AccessDraft): boolean {
  return changeCount(a, b) === 0;
}

export function changeCountLabel(count: number): string {
  return count === 1 ? '1 unsaved change' : `${count} unsaved changes`;
}

/**
 * Keeps staged drafts only for users whose saved access is still the base the
 * draft was made from. Returns the user IDs whose drafts were discarded
 * because the account changed on the server (or disappeared).
 */
export function reconcileDrafts(
  drafts: Readonly<Record<string, { base: AccessDraft; draft: AccessDraft }>>,
  users: readonly PublicUser[],
): {
  drafts: Record<string, { base: AccessDraft; draft: AccessDraft }>;
  discarded: string[];
} {
  const next: Record<string, { base: AccessDraft; draft: AccessDraft }> = {};
  const discarded: string[] = [];
  for (const [userId, entry] of Object.entries(drafts)) {
    const user = users.find((candidate) => candidate.id === userId);
    if (user && sameAccess(entry.base, draftOf(user))) next[userId] = entry;
    else if (!sameAccess(entry.base, entry.draft)) discarded.push(userId);
  }
  return { drafts: next, discarded };
}

/** The PATCH body for a user, preserving the existing API contract. */
export function accessPatch(draft: AccessDraft): AccessDraft {
  return {
    role: draft.role,
    radioPermissions: draft.radioPermissions.map((grant) => ({
      radioId: grant.radioId,
      permissions: unique(grant.permissions),
    })),
  };
}

// ─── Presentation ──────────────────────────────────────────────────────────

export function cellAccessibilityLabel(
  username: string,
  radioName: string,
  reading: LevelReading,
): string {
  return `${username} on ${radioName}: ${LEVEL_LABELS[reading.level]}${
    reading.exact ? '' : ' (non-standard permissions)'
  }`;
}

/** Secondary permissions held on a radio, for the "+N other" caption. */
export function otherPermissionCount(
  grants: readonly RadioPermissionGrant[],
  radioId: string,
): number {
  return (findGrant(grants, radioId)?.permissions ?? []).filter(
    (p) => !isOperational(p),
  ).length;
}

export function initialsOf(username: string): string {
  const parts = username
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2);
  const letters =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`
      : username.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2);
  return (letters || '?').toUpperCase();
}

export function roleChangeMessage(input: {
  username: string;
  from: Role;
  to: Role;
  removed: readonly RoleRemoval[];
  radioName: (radioId: string) => string;
  self: boolean;
}): string {
  const lines = [
    `${input.username} will change from ${ROLE_LABELS[input.from]} to ${
      ROLE_LABELS[input.to]
    } when you save.`,
  ];
  if (input.removed.length)
    lines.push(
      `The ${ROLE_LABELS[input.to].toLowerCase()} role does not allow: ${input.removed
        .map(
          (entry) =>
            `${entry.permissions.map(permissionLabel).join(', ')} on ${input.radioName(
              entry.radioId,
            )}`,
        )
        .join('; ')}.`,
    );
  if (input.from === 'administrator')
    lines.push(
      `${
        input.self ? 'You lose' : 'They lose'
      } station administration. The last enabled administrator cannot be demoted.`,
    );
  lines.push(
    input.self
      ? 'Saving signs you out of every session.'
      : 'Saving revokes their existing sessions.',
  );
  return lines.join(' ');
}

/** Non-admin users that hold any radio grant (setup checklist, step 2). */
export function hasNonAdminAssignment(users: readonly PublicUser[]): boolean {
  return users.some(
    (user) =>
      user.role !== 'administrator' &&
      user.radioPermissions.some((grant) => grant.permissions.length > 0),
  );
}
