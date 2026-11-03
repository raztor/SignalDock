import { describe, expect, it } from 'vitest';
import type {
  Permission,
  PublicUser,
  RadioPermissionGrant,
} from '@signaldock/contracts';
import {
  DEFAULT_ROLE_TEMPLATES as templates,
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
  grantLevel,
  hasNonAdminAssignment,
  initialsOf,
  isDemotion,
  isLevelAllowed,
  levelFromPermissions,
  needsDemotionConfirmation,
  otherPermissionCount,
  reconcileDrafts,
  roleChangeMessage,
  secondaryPermissions,
  setSecondaryPermission,
} from './permission-model';

const base = '11111111-1111-4111-8111-111111111111';
const mobile = '22222222-2222-4222-8222-222222222222';
const hidden = '33333333-3333-4333-8333-333333333333';

const user = (patch: Partial<PublicUser> = {}): PublicUser => ({
  id: '44444444-4444-4444-8444-444444444444',
  username: 'operador1',
  role: 'operator',
  enabled: true,
  radioPermissions: [],
  ...patch,
});

const perms = (grants: RadioPermissionGrant[], radioId: string) =>
  [...(grants.find((g) => g.radioId === radioId)?.permissions ?? [])].sort();

describe('levelFromPermissions', () => {
  it('reads cumulative levels', () => {
    expect(levelFromPermissions([])).toEqual({ level: 'none', exact: true });
    expect(levelFromPermissions(['radio.listen', 'history.read'])).toEqual({
      level: 'listen',
      exact: true,
    });
    expect(levelFromPermissions(['radio.control', 'radio.listen'])).toEqual({
      level: 'control',
      exact: true,
    });
    expect(
      levelFromPermissions(['radio.transmit', 'radio.listen', 'radio.control']),
    ).toEqual({ level: 'transmit', exact: true });
  });

  it('flags non-cumulative operational sets', () => {
    expect(levelFromPermissions(['radio.listen', 'radio.transmit'])).toEqual({
      level: 'listen',
      exact: false,
    });
    expect(levelFromPermissions(['radio.control'])).toEqual({
      level: 'none',
      exact: false,
    });
  });

  it('ignores duplicates and secondary permissions', () => {
    expect(
      levelFromPermissions(['radio.listen', 'radio.listen', 'incident.read']),
    ).toEqual({ level: 'listen', exact: true });
  });

  it('reads a grant by radio', () => {
    const grants = [{ radioId: base, permissions: ['radio.listen' as const] }];
    expect(grantLevel(grants, base).level).toBe('listen');
    expect(grantLevel(grants, mobile).level).toBe('none');
  });
});

describe('allowedLevels', () => {
  it('limits listeners to Listen', () => {
    expect(allowedLevels(templates.listener)).toEqual(['none', 'listen']);
    expect(isLevelAllowed('control', templates.listener)).toBe(false);
  });
  it('allows every level for operators and administrators', () => {
    expect(allowedLevels(templates.operator)).toEqual([
      'none',
      'listen',
      'control',
      'transmit',
    ]);
    expect(allowedLevels(templates.administrator)).toHaveLength(4);
  });
  it('separates secondary permissions', () => {
    expect(secondaryPermissions(templates.listener)).toEqual([
      'history.read',
      'incident.read',
      'aprs.read',
      'notifications.read',
    ]);
    expect(secondaryPermissions(templates.administrator)).toContain(
      'radio.configure',
    );
  });
});

describe('applyLevel', () => {
  const grants: RadioPermissionGrant[] = [
    {
      radioId: base,
      permissions: [
        'radio.listen',
        'radio.control',
        'history.read',
        'incident.manage',
        'recording.export',
      ],
    },
    { radioId: hidden, permissions: ['radio.listen', 'history.write'] },
  ];

  it('raises a level while preserving every other permission', () => {
    const next = applyLevel(grants, base, 'transmit', templates.operator);
    expect(perms(next, base)).toEqual(
      [
        'history.read',
        'incident.manage',
        'radio.control',
        'radio.listen',
        'radio.transmit',
        'recording.export',
      ].sort(),
    );
  });

  it('lowers a level and keeps secondary permissions', () => {
    const next = applyLevel(grants, base, 'listen', templates.operator);
    expect(perms(next, base)).toEqual(
      [
        'history.read',
        'incident.manage',
        'radio.listen',
        'recording.export',
      ].sort(),
    );
  });

  it('None keeps the grant while secondary permissions remain', () => {
    const next = applyLevel(grants, base, 'none', templates.operator);
    expect(perms(next, base)).toEqual(
      ['history.read', 'incident.manage', 'recording.export'].sort(),
    );
  });

  it('None removes a grant that only held operational permissions', () => {
    const only = [{ radioId: base, permissions: ['radio.listen' as const] }];
    expect(applyLevel(only, base, 'none')).toEqual([]);
  });

  it('never touches grants for other radios, including undisplayed ones', () => {
    const next = applyLevel(grants, base, 'none', templates.operator);
    expect(next.find((g) => g.radioId === hidden)).toEqual(grants[1]);
    expect(next.map((g) => g.radioId)).toEqual([base, hidden]);
  });

  it('creates a new grant with the role defaults and the level', () => {
    const next = applyLevel(grants, mobile, 'control', templates.operator);
    expect(perms(next, mobile)).toEqual(
      [
        'radio.listen',
        'radio.control',
        ...secondaryPermissions(templates.operator),
      ].sort(),
    );
    expect(next).toHaveLength(3);
  });

  it('does not create a grant for None', () => {
    expect(applyLevel(grants, mobile, 'none', templates.operator)).toEqual(
      grants,
    );
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(grants);
    applyLevel(grants, base, 'none');
    applyLevel(grants, mobile, 'transmit', templates.operator);
    expect(grants).toEqual(copy);
  });

  it('normalises non-cumulative sets to the chosen level', () => {
    const odd = [
      {
        radioId: base,
        permissions: ['radio.transmit', 'history.read'] as Permission[],
      },
    ];
    expect(perms(applyLevel(odd, base, 'listen'), base)).toEqual([
      'history.read',
      'radio.listen',
    ]);
  });
});

describe('secondary permissions', () => {
  const grants: RadioPermissionGrant[] = [
    { radioId: base, permissions: ['radio.listen', 'history.read'] },
  ];
  it('adds and removes one permission', () => {
    const added = setSecondaryPermission(grants, base, 'incident.read', true);
    expect(perms(added, base)).toEqual(
      ['history.read', 'incident.read', 'radio.listen'].sort(),
    );
    const removed = setSecondaryPermission(added, base, 'history.read', false);
    expect(perms(removed, base)).toEqual(['incident.read', 'radio.listen']);
  });
  it('ignores operational permissions and missing grants', () => {
    expect(setSecondaryPermission(grants, base, 'radio.control', true)).toEqual(
      grants,
    );
    expect(
      setSecondaryPermission(grants, mobile, 'history.read', true),
    ).toEqual(grants);
  });
  it('drops a grant left empty', () => {
    const only = [{ radioId: base, permissions: ['history.read' as const] }];
    expect(setSecondaryPermission(only, base, 'history.read', false)).toEqual(
      [],
    );
  });
  it('counts other permissions and clears a radio explicitly', () => {
    expect(otherPermissionCount(grants, base)).toBe(1);
    expect(otherPermissionCount(grants, mobile)).toBe(0);
    expect(clearRadio(grants, base)).toEqual([]);
  });
});

describe('applyRole', () => {
  const grants: RadioPermissionGrant[] = [
    {
      radioId: base,
      permissions: [
        'radio.listen',
        'radio.control',
        'radio.transmit',
        'history.read',
        'history.write',
      ],
    },
    { radioId: mobile, permissions: ['radio.control'] },
  ];
  it('removes only what the new role does not allow', () => {
    const result = applyRole(grants, templates.listener);
    expect(result.grants).toEqual([
      { radioId: base, permissions: ['radio.listen', 'history.read'] },
    ]);
    expect(result.removed).toEqual([
      {
        radioId: base,
        permissions: ['radio.control', 'radio.transmit', 'history.write'],
      },
      { radioId: mobile, permissions: ['radio.control'] },
    ]);
  });
  it('adds nothing on promotion', () => {
    const listener = [
      { radioId: base, permissions: ['radio.listen' as const] },
    ];
    expect(applyRole(listener, templates.administrator)).toEqual({
      grants: listener,
      removed: [],
    });
  });
  it('detects demotions', () => {
    expect(isDemotion('administrator', 'operator')).toBe(true);
    expect(isDemotion('listener', 'operator')).toBe(false);
    expect(needsDemotionConfirmation('administrator', 'listener')).toBe(true);
    expect(needsDemotionConfirmation('operator', 'listener')).toBe(false);
    expect(needsDemotionConfirmation('administrator', 'administrator')).toBe(
      false,
    );
  });
});

describe('drafts', () => {
  const saved = user({
    radioPermissions: [
      { radioId: base, permissions: ['radio.listen', 'history.read'] },
    ],
  });

  it('copies a user without sharing arrays', () => {
    const draft = draftOf(saved);
    draft.radioPermissions[0]?.permissions.push('radio.control');
    expect(saved.radioPermissions[0]?.permissions).toEqual([
      'radio.listen',
      'history.read',
    ]);
  });

  it('counts one change for the role and one per changed radio', () => {
    const before = draftOf(saved);
    expect(changeCount(before, before)).toBe(0);
    let grants = applyLevel(
      before.radioPermissions,
      base,
      'control',
      templates.operator,
    );
    grants = applyLevel(grants, mobile, 'listen', templates.operator);
    expect(changedRadios(before.radioPermissions, grants)).toEqual([
      base,
      mobile,
    ]);
    expect(
      changeCount(before, { role: 'listener', radioPermissions: grants }),
    ).toBe(3);
  });

  it('treats permission order and duplicates as unchanged', () => {
    const before = draftOf(saved);
    expect(
      changeCount(before, {
        role: 'operator',
        radioPermissions: [
          {
            radioId: base,
            permissions: ['history.read', 'radio.listen', 'radio.listen'],
          },
        ],
      }),
    ).toBe(0);
  });

  it('a level changed back is no longer counted', () => {
    const before = draftOf(saved);
    const up = applyLevel(before.radioPermissions, base, 'transmit');
    const back = applyLevel(up, base, 'listen');
    expect(changeCount(before, { ...before, radioPermissions: back })).toBe(0);
  });

  it('labels the count', () => {
    expect(changeCountLabel(1)).toBe('1 unsaved change');
    expect(changeCountLabel(3)).toBe('3 unsaved changes');
  });

  it('keeps drafts whose base is unchanged and reports conflicts', () => {
    const other = user({
      id: '55555555-5555-4555-8555-555555555555',
      username: 'escucha',
      role: 'listener',
    });
    const baseA = draftOf(saved);
    const baseB = draftOf(other);
    const drafts = {
      [saved.id]: {
        base: baseA,
        draft: { ...baseA, role: 'listener' as const },
      },
      [other.id]: {
        base: baseB,
        draft: {
          ...baseB,
          radioPermissions: applyLevel([], base, 'listen'),
        },
      },
    };
    const changed = {
      ...other,
      radioPermissions: [
        { radioId: mobile, permissions: ['radio.listen' as const] },
      ],
    };
    const result = reconcileDrafts(drafts, [saved, changed]);
    expect(Object.keys(result.drafts)).toEqual([saved.id]);
    expect(result.discarded).toEqual([other.id]);
    expect(reconcileDrafts(drafts, []).discarded).toEqual([saved.id, other.id]);
  });

  it('builds the existing PATCH shape', () => {
    expect(
      accessPatch({
        role: 'operator',
        radioPermissions: [
          {
            radioId: base,
            permissions: ['radio.listen', 'radio.listen', 'history.read'],
          },
        ],
      }),
    ).toEqual({
      role: 'operator',
      radioPermissions: [
        { radioId: base, permissions: ['radio.listen', 'history.read'] },
      ],
    });
  });
});

describe('presentation', () => {
  it('labels cells for assistive technology', () => {
    expect(
      cellAccessibilityLabel('operador1', 'Base station', {
        level: 'control',
        exact: true,
      }),
    ).toBe('operador1 on Base station: Control');
    expect(
      cellAccessibilityLabel('operador1', 'Base station', {
        level: 'listen',
        exact: false,
      }),
    ).toBe('operador1 on Base station: Listen (non-standard permissions)');
  });

  it('builds initials', () => {
    expect(initialsOf('operador1')).toBe('OP');
    expect(initialsOf('ana.rojas')).toBe('AR');
    expect(initialsOf('---')).toBe('?');
  });

  it('describes a demotion', () => {
    const message = roleChangeMessage({
      username: 'bmunoz',
      from: 'administrator',
      to: 'listener',
      removed: [{ radioId: base, permissions: ['radio.transmit'] }],
      radioName: () => 'Base station',
      self: false,
    });
    expect(message).toContain('from Administrator to Listener');
    expect(message).toContain('Transmit on Base station');
    expect(message).toContain('last enabled administrator');
    expect(message).toContain('revokes their existing sessions');
    expect(message).toContain('They lose station administration');
    expect(
      roleChangeMessage({
        username: 'admin',
        from: 'administrator',
        to: 'operator',
        removed: [],
        radioName: () => '',
        self: true,
      }),
    ).toContain('You lose station administration');
  });

  it('detects assignments to non-administrators', () => {
    expect(hasNonAdminAssignment([user()])).toBe(false);
    expect(
      hasNonAdminAssignment([
        user({
          role: 'administrator',
          radioPermissions: [{ radioId: base, permissions: ['radio.listen'] }],
        }),
      ]),
    ).toBe(false);
    expect(
      hasNonAdminAssignment([
        user({
          radioPermissions: [{ radioId: base, permissions: ['radio.listen'] }],
        }),
      ]),
    ).toBe(true);
  });
});
