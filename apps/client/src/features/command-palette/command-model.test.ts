import { describe, expect, it } from 'vitest';
import type {
  IncidentRecord,
  RadioMemory,
  RadioView,
} from '@signaldock/contracts';
import {
  blockedToast,
  buildCommands,
  commandLabel,
  commandScore,
  controlCommands,
  frequencyCommand,
  fuzzyScore,
  incidentCommands,
  isTypingTarget,
  listeningCommands,
  looksLikeFrequency,
  memoryCommands,
  mergeOpenIncidents,
  moveHighlight,
  normalizeSearch,
  operationToast,
  paletteOffset,
  paletteResults,
  paletteShortcut,
  radioCommands,
  rankCommands,
  sectionCommands,
  shortcutLabel,
  type PaletteCommand,
  type PaletteContext,
} from './command-model';

const radio = (
  overrides: {
    radioId?: string;
    displayName?: string;
    writable?: boolean;
    txAudio?: boolean;
    memories?: { read: boolean; write: boolean; select: boolean };
  } = {},
  snapshot: Partial<NonNullable<RadioView['snapshot']>> = {},
): RadioView => {
  const radioId = overrides.radioId ?? 'r1';
  const displayName = overrides.displayName ?? 'Base station';
  return {
    radioId,
    displayName,
    driverId: 'sim',
    resourceGroupIds: [],
    enabled: true,
    descriptor: {
      radioId,
      displayName,
      driverId: 'sim',
      resourceGroupIds: [],
      capabilities: {
        memories: overrides.memories ?? {
          read: true,
          write: true,
          select: true,
        },
        tuning: {
          writable: overrides.writable ?? true,
          ranges: [
            { minHz: 136_000_000, maxHz: 174_000_000 },
            { minHz: 400_000_000, maxHz: 480_000_000 },
          ],
          modes: ['FM', 'AM'],
        },
        rxAudio: true,
        txAudio: overrides.txAudio ?? true,
        ptt: 'explicit',
        physicalTxObservation: false,
        independentlyReceivableChannels: 1,
        verification: 'simulated',
      },
    },
    snapshot: {
      radioId,
      generation: 'g1',
      revision: 1,
      connection: 'ready',
      tuningConfidence: 'confirmed',
      txState: 'idle',
      observedTuning: { rxHz: 146_520_000, mode: 'FM' },
      ...snapshot,
    },
    control: null,
    health: { state: 'connected' },
  };
};

const memory = (
  memoryId: string,
  rxHz: number,
  name: string,
  txHz?: number,
): RadioMemory => ({
  memoryId,
  name,
  tuning: { rxHz, mode: 'FM', ...(txHz === undefined ? {} : { txHz }) },
});

const incident = (
  id: string,
  title: string,
  overrides: Partial<IncidentRecord> = {},
): IncidentRecord => ({
  id,
  instanceId: 'i1',
  radioId: 'r1',
  state: 'new',
  priority: 'high',
  title,
  retentionHold: false,
  evidence: [],
  revision: 1,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...overrides,
});

const base = radio();
const other = radio({ radioId: 'r2', displayName: 'Repeater site' });
const context = (overrides: Partial<PaletteContext> = {}): PaletteContext => ({
  radios: [base, other],
  selected: base,
  memories: [
    memory('1', 146_520_000, 'Simplex llamada'),
    memory('2', 145_430_000, 'Repetidor norte', 144_830_000),
  ],
  controlState: 'mine',
  controlOwnerLabel: 'You have control',
  canControl: true,
  busy: false,
  editable: true,
  leaseGeneration: 'g1',
  media: {
    supported: true,
    configured: true,
    listening: false,
    canListen: true,
    listenReason: '',
  },
  sections: [
    { key: 'Radios', label: 'Radios', icon: 'radio' },
    { key: 'History', label: 'History', icon: 'history' },
    { key: 'Incidents', label: 'Incidents', icon: 'alert' },
  ],
  currentSection: 'Radios',
  incidents: [],
  ...overrides,
});

describe('fuzzy matching', () => {
  it('normalises case, accents and spacing', () => {
    expect(normalizeSearch('  Repetidor   NÓRTE ')).toBe('repetidor norte');
  });
  it('ranks exact > prefix > word prefix > tokens > substring > subsequence', () => {
    const exact = fuzzyScore('history', 'History')!;
    const prefix = fuzzyScore('hist', 'History')!;
    const word = fuzzyScore('hist', 'Go to History')!;
    const tokens = fuzzyScore('go hist', 'Go to History')!;
    const substring = fuzzyScore('istor', 'Go to History')!;
    const subsequence = fuzzyScore('gth', 'Go to History')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(substring);
    expect(prefix).toBeGreaterThan(tokens);
    expect(tokens).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });
  it('returns undefined when characters are missing or out of order', () => {
    expect(fuzzyScore('xyz', 'History')).toBeUndefined();
    expect(fuzzyScore('yh', 'History')).toBeUndefined();
  });
  it('matches everything with an empty query', () => {
    expect(fuzzyScore('', 'Anything')).toBe(0);
  });
  it('ranks blocked commands below enabled ones of the same quality', () => {
    const command: PaletteCommand = {
      id: 'a',
      group: 'Go to',
      icon: 'history',
      title: 'Go to History',
      keywords: [],
    };
    const blocked = { ...command, blocked: { reason: 'No.' } };
    expect(commandScore(command, 'history')!).toBeGreaterThan(
      commandScore(blocked, 'history')!,
    );
  });
  it('keeps the original order for equal scores and applies the limit', () => {
    const commands = ['Alpha one', 'Alpha two', 'Alpha three'].map(
      (title, index): PaletteCommand => ({
        id: String(index),
        group: 'Go to',
        icon: 'history',
        title,
        keywords: [],
      }),
    );
    expect(rankCommands(commands, 'alpha', 2).map((c) => c.id)).toEqual([
      '0',
      '1',
    ]);
  });
});

describe('frequency command', () => {
  it('recognises frequency-like text only', () => {
    expect(looksLikeFrequency('146.52')).toBe(true);
    expect(looksLikeFrequency('146,52')).toBe(true);
    expect(looksLikeFrequency('146520 kHz')).toBe(true);
    expect(looksLikeFrequency('146.520.000')).toBe(true);
    expect(looksLikeFrequency('history')).toBe(false);
    expect(looksLikeFrequency('2 m band')).toBe(false);
  });
  it('builds a runnable tune command when the radio is editable', () => {
    const command = frequencyCommand('146.55', context())!;
    expect(command.title).toBe('Tune Base station to');
    expect(command.value).toBe('146.550 FM');
    expect(command.subtitle).toBe('Simplex · 2 m');
    expect(command.blocked).toBeUndefined();
    expect(command.pinned).toBe(true);
    expect(command.action).toEqual({
      type: 'tune',
      radioId: 'r1',
      radioName: 'Base station',
      tuning: { rxHz: 146_550_000, mode: 'FM' },
    });
  });
  it('keeps the current mode', () => {
    const selected = radio(
      {},
      { observedTuning: { rxHz: 146_520_000, mode: 'AM' } },
    );
    const command = frequencyCommand('146.55', context({ selected }))!;
    expect(command.value).toBe('146.550 AM');
  });
  it('explains "Take control first" with a take-control fix when control is available', () => {
    const command = frequencyCommand(
      '146.55',
      context({
        controlState: 'available',
        controlOwnerLabel: 'Control available',
        editable: false,
        leaseGeneration: undefined,
      }),
    )!;
    expect(command.blocked).toEqual({
      reason: 'Take control first.',
      fix: 'take-control',
    });
    // The action is kept so the command is described, but it never runs blocked.
    expect(command.action?.type).toBe('tune');
    expect(blockedToast(command)).toEqual({
      message: 'Take control first.',
      tone: 'warning',
      fix: 'take-control',
      radioId: 'r1',
    });
  });
  it('blocks without a fix when another operator has control', () => {
    const command = frequencyCommand(
      '146.55',
      context({ controlState: 'other', editable: false }),
    )!;
    expect(command.blocked?.reason).toBe(
      'Another session has control of this radio.',
    );
    expect(command.blocked?.fix).toBeUndefined();
  });
  it('blocks listener-only accounts', () => {
    const command = frequencyCommand(
      '146.55',
      context({
        canControl: false,
        controlState: 'available',
        editable: false,
      }),
    )!;
    expect(command.blocked?.reason).toBe(
      'You can listen to this radio but not control it.',
    );
    expect(command.blocked?.fix).toBeUndefined();
  });
  it('blocks while the radio is transmitting', () => {
    const selected = radio({}, { txState: 'transmitting' });
    const command = frequencyCommand(
      '146.55',
      context({ selected, editable: false }),
    )!;
    expect(command.blocked?.reason).toBe(
      'Wait until the radio stops transmitting.',
    );
  });
  it('blocks a stale lease', () => {
    const command = frequencyCommand(
      '146.55',
      context({ leaseGeneration: 'g0', editable: false }),
    )!;
    expect(command.blocked?.reason).toBe(
      'The radio restarted. Take control again to tune.',
    );
  });
  it('reports out-of-range frequencies without pinning them', () => {
    const command = frequencyCommand('2', context())!;
    expect(command.blocked?.reason).toMatch(/outside this radio's ranges/);
    expect(command.pinned).toBeUndefined();
    expect(command.action).toBeUndefined();
  });
  it('says when the radio is already on that frequency', () => {
    const command = frequencyCommand('146.52', context())!;
    expect(command.blocked?.reason).toBe(
      'Base station is already on 146.520 FM.',
    );
  });
  it('explains drivers without free tuning', () => {
    const command = frequencyCommand(
      '146.55',
      context({ selected: radio({ writable: false }) }),
    )!;
    expect(command.blocked?.reason).toMatch(/use channel memories/);
  });
  it('asks for a radio when none is selected', () => {
    const command = frequencyCommand(
      '146.55',
      context({ selected: undefined }),
    )!;
    expect(command.blocked?.reason).toBe('Select a radio first.');
  });
  it('is absent for non-frequency text', () => {
    expect(frequencyCommand('history', context())).toBeUndefined();
  });
  it('keeps a standard repeater offset within the band, simplex elsewhere', () => {
    const selected = radio(
      {},
      {
        observedTuning: { rxHz: 145_430_000, txHz: 144_830_000, mode: 'FM' },
      },
    );
    const inBand = frequencyCommand('146.55', context({ selected }))!;
    expect(inBand.action).toMatchObject({
      tuning: { rxHz: 146_550_000, txHz: 145_950_000, mode: 'FM' },
    });
    expect(inBand.subtitle).toBe('TX −600 kHz · 2 m');
    const otherBand = frequencyCommand('446.5', context({ selected }))!;
    expect(otherBand.action).toMatchObject({
      tuning: { rxHz: 446_500_000, mode: 'FM' },
    });
    expect(otherBand.subtitle).toMatch(/^Simplex/);
  });
  it('drops offsets on receive-only radios and outside the ranges', () => {
    expect(
      paletteOffset({
        currentOffsetHz: 600_000,
        rxHz: 146_000_000,
        txAudio: false,
        ranges: [{ minHz: 136_000_000, maxHz: 174_000_000 }],
      }),
    ).toBe(0);
    expect(
      paletteOffset({
        currentOffsetHz: 600_000,
        rxHz: 146_000_000,
        txAudio: true,
        ranges: [{ minHz: 136_000_000, maxHz: 146_200_000 }],
      }),
    ).toBe(0);
    expect(
      paletteOffset({
        currentOffsetHz: 12_500,
        rxHz: 146_000_000,
        txAudio: true,
        ranges: [{ minHz: 136_000_000, maxHz: 174_000_000 }],
      }),
    ).toBe(0);
  });
});

describe('providers', () => {
  it('recalls memories when editable and marks the active one', () => {
    const selected = radio({}, { selectedMemoryId: '1' });
    const commands = memoryCommands(context({ selected }));
    expect(commands.map((c) => c.title)).toEqual([
      'Recall Simplex llamada',
      'Recall Repetidor norte',
    ]);
    expect(commands[0]).toMatchObject({
      value: '146.520 FM',
      hint: 'Active',
      action: { type: 'recall', radioId: 'r1', memoryId: '1' },
    });
    expect(commands[0]?.blocked).toBeUndefined();
  });
  it('blocks memory recall with a take-control fix', () => {
    const commands = memoryCommands(
      context({ controlState: 'available', editable: false }),
    );
    expect(commands[0]?.blocked).toEqual({
      reason: 'Take control first.',
      fix: 'take-control',
    });
  });
  it('explains radios that cannot recall memories', () => {
    const selected = radio({
      memories: { read: true, write: false, select: false },
    });
    const commands = memoryCommands(context({ selected }));
    expect(commands[0]?.blocked).toEqual({
      reason: 'This radio cannot recall memories remotely.',
    });
  });
  it('lists no memories when the radio cannot read them', () => {
    const selected = radio({
      memories: { read: false, write: false, select: false },
    });
    expect(memoryCommands(context({ selected }))).toEqual([]);
  });
  it('selects other radios and never offers a tune', () => {
    const commands = radioCommands(context());
    expect(commands[0]?.blocked?.reason).toBe(
      'Base station is already selected.',
    );
    expect(commands[1]).toMatchObject({
      title: 'Select Repeater site',
      action: { type: 'select-radio', radioId: 'r2' },
    });
    expect(commands[1]?.blocked).toBeUndefined();
  });
  it('navigates to sections and marks the current one', () => {
    const commands = sectionCommands(context());
    expect(commands.map((c) => c.title)).toEqual([
      'Go to Radios',
      'Go to History',
      'Go to Incidents',
    ]);
    expect(commands[0]?.hint).toBe('Current');
    expect(commands[1]?.action).toEqual({
      type: 'navigate',
      section: 'History',
      label: 'History',
    });
  });
  it('offers release when control is mine and take when available', () => {
    expect(controlCommands(context())[0]?.action?.type).toBe('release-control');
    const take = controlCommands(
      context({
        controlState: 'available',
        controlOwnerLabel: 'Control available',
      }),
    )[0];
    expect(take?.action?.type).toBe('take-control');
    expect(take?.blocked).toBeUndefined();
  });
  it('explains why control cannot be taken', () => {
    const other = controlCommands(
      context({
        controlState: 'other',
        controlOwnerLabel: 'Controlled by another operator',
      }),
    )[0];
    expect(other?.blocked?.reason).toBe('Controlled by another operator');
    const listener = controlCommands(
      context({ canControl: false, controlState: 'available' }),
    )[0];
    expect(listener?.blocked?.reason).toBe(
      'You can listen to this radio but not control it.',
    );
    const busy = controlCommands(context({ busy: true }))[0];
    expect(busy?.blocked?.reason).toBe('Another operation is in progress.');
  });
  it('toggles listening and explains when it is unavailable', () => {
    expect(listeningCommands(context())[0]?.action?.type).toBe('listen');
    const media = context().media!;
    expect(
      listeningCommands(context({ media: { ...media, listening: true } }))[0]
        ?.action?.type,
    ).toBe('stop-listening');
    expect(
      listeningCommands(context({ media: { ...media, supported: false } }))[0]
        ?.blocked?.reason,
    ).toBe('Live audio is available in the web app for now.');
    expect(
      listeningCommands(
        context({
          media: { ...media, canListen: false, listenReason: 'No permission.' },
        }),
      )[0]?.blocked?.reason,
    ).toBe('No permission.');
  });
  it('lists incidents by title with priority, state and radio', () => {
    const commands = incidentCommands(
      context({ incidents: [incident('a', 'Mayday on 2 m')] }),
    );
    expect(commands[0]).toMatchObject({
      title: 'Mayday on 2 m',
      subtitle: 'High priority · New · Base station',
      action: { type: 'open-incident', incidentId: 'a' },
    });
  });
});

describe('palette results', () => {
  it('pins a typed frequency above matching memories', () => {
    const results = paletteResults('146.52', context({ editable: true }));
    expect(results[0]?.id).toBe('tune');
    expect(results[1]?.id).toBe('memory:1');
  });
  it('finds memories, radios, sections and incidents by name', () => {
    const ctx = context({ incidents: [incident('a', 'Fire report north')] });
    expect(paletteResults('llamada', ctx)[0]?.id).toBe('memory:1');
    expect(paletteResults('repeater', ctx)[0]?.id).toBe('radio:r2');
    expect(paletteResults('hist', ctx)[0]?.id).toBe('section:History');
    expect(paletteResults('fire', ctx)[0]?.id).toBe('incident:a');
    expect(paletteResults('listen', ctx)[0]?.id).toBe('listen');
    expect(paletteResults('release', ctx)[0]?.id).toBe('release-control');
  });
  it('shows runnable quick actions for an empty query', () => {
    const ctx = context({ incidents: [incident('a', 'Fire report')] });
    const ids = paletteResults('', ctx).map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual(['release-control', 'listen']);
    expect(ids).toContain('section:History');
    expect(ids).toContain('radio:r2');
    expect(ids).not.toContain('radio:r1');
    expect(ids).not.toContain('incident:a');
  });
  it('builds every provider', () => {
    const ids = buildCommands('146.55', context()).map((c) => c.id);
    expect(ids[0]).toBe('tune');
    expect(ids).toEqual(
      expect.arrayContaining([
        'release-control',
        'listen',
        'memory:1',
        'radio:r2',
        'section:History',
      ]),
    );
  });
  it('wraps the highlight', () => {
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, 1, 0)).toBe(0);
  });
  it('labels rows for screen readers', () => {
    const command = frequencyCommand(
      '146.55',
      context({ controlState: 'available', editable: false }),
    )!;
    expect(commandLabel(command)).toBe(
      'Tune Base station to 146.550 FM. Simplex · 2 m. Unavailable: Take control first.',
    );
  });
});

describe('result toasts', () => {
  it('maps station results', () => {
    expect(
      operationToast({ ok: true, message: 'Radio confirmed 146.550 FM.' }),
    ).toEqual({ message: 'Radio confirmed 146.550 FM.', tone: 'success' });
    expect(
      operationToast({
        ok: true,
        message: 'Requested 146.550 FM · waiting for radio confirmation.',
      }).tone,
    ).toBe('neutral');
    expect(operationToast({ ok: false, error: 'Nope.' })).toEqual({
      message: 'Nope.',
      tone: 'error',
    });
  });
});

describe('open incidents', () => {
  it('keeps open states, dedupes by newest revision, sorts and limits', () => {
    const merged = mergeOpenIncidents(
      [
        [
          incident('a', 'A', { updatedAt: '2026-11-01T10:00:00.000Z' }),
          incident('b', 'B', {
            state: 'resolved',
            updatedAt: '2026-11-03T10:00:00.000Z',
          }),
        ],
        [
          incident('c', 'C', {
            state: 'in_progress',
            updatedAt: '2026-11-02T10:00:00.000Z',
          }),
          incident('a', 'A2', {
            state: 'acknowledged',
            revision: 2,
            updatedAt: '2026-11-01T11:00:00.000Z',
          }),
        ],
      ],
      20,
    );
    expect(merged.map((item) => [item.id, item.title])).toEqual([
      ['c', 'C'],
      ['a', 'A2'],
    ]);
    expect(
      mergeOpenIncidents(
        [[incident('a', 'A'), incident('b', 'B'), incident('c', 'C')]],
        2,
      ),
    ).toHaveLength(2);
  });
});

describe('keyboard shortcut', () => {
  const key = (overrides: Partial<Parameters<typeof paletteShortcut>[0]>) => ({
    key: 'k',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  });
  it('opens with ⌘K or Ctrl+K', () => {
    expect(
      paletteShortcut(key({ metaKey: true }), { open: false, target: null }),
    ).toBe('open');
    expect(
      paletteShortcut(key({ ctrlKey: true, key: 'K' }), {
        open: false,
        target: { tagName: 'DIV' },
      }),
    ).toBe('open');
  });
  it('ignores other keys and modifiers', () => {
    expect(paletteShortcut(key({}), { open: false, target: null })).toBe(
      undefined,
    );
    expect(
      paletteShortcut(key({ ctrlKey: true, shiftKey: true }), {
        open: false,
        target: null,
      }),
    ).toBeUndefined();
    expect(
      paletteShortcut(key({ ctrlKey: true, key: 'j' }), {
        open: false,
        target: null,
      }),
    ).toBeUndefined();
  });
  it('is ignored while typing in another field unless the palette is open', () => {
    const input = { tagName: 'INPUT', type: 'text' };
    expect(
      paletteShortcut(key({ metaKey: true }), { open: false, target: input }),
    ).toBeUndefined();
    expect(
      paletteShortcut(key({ metaKey: true }), { open: true, target: input }),
    ).toBe('close');
  });
  it('ignores keydown events without a key', () => {
    expect(
      paletteShortcut(key({ metaKey: true, key: undefined }), {
        open: true,
        target: null,
      }),
    ).toBeUndefined();
  });
  it('detects typing targets', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(
      true,
    );
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
  it('labels the shortcut per platform', () => {
    expect(shortcutLabel('MacIntel')).toBe('⌘K');
    expect(shortcutLabel('macOS')).toBe('⌘K');
    expect(shortcutLabel('Win32')).toBe('Ctrl K');
    expect(shortcutLabel(undefined)).toBe('Ctrl K');
  });
});
