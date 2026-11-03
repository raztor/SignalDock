import { describe, expect, it } from 'vitest';
import type { IncidentRecord, IncidentState } from '@signaldock/contracts';
import {
  ANY_FREQUENCY,
  CLOSE_REASONS,
  DECISION_NOTE_MAX,
  INCIDENT_COLUMNS,
  INCIDENT_STATES,
  INCIDENT_TRANSITIONS,
  PHRASES_MAX,
  canTransition,
  closeReasonsFor,
  columnCountLabel,
  columnOf,
  composeCloseNote,
  createRangeScale,
  dragStepHz,
  formatIncidentAge,
  groupIncidents,
  hzToMhz,
  attributionSuffix,
  incidentCardLabel,
  initialRange,
  initialsOf,
  mhzToHz,
  moveRangeHandle,
  nearestHandle,
  ownerPresentation,
  parsePhrases,
  phrasesError,
  pickerDomain,
  primaryTransition,
  priorityPresentation,
  rangeKeyAction,
  rangeLabel,
  rangeResult,
  requiresDecisionNote,
  ruleBody,
  serializePhrases,
  stepRangeHandle,
  transitionActions,
  transitionMessage,
  validatePhrase,
} from './incident-model';

const RADIO = '00000000-0000-4000-8000-000000000001';
const ME = '00000000-0000-4000-8000-0000000000aa';
const OTHER = 'abcdef12-0000-4000-8000-0000000000bb';

let counter = 0;
const incident = (overrides: Partial<IncidentRecord> = {}): IncidentRecord => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    instanceId: '00000000-0000-4000-8000-00000000ffff',
    radioId: RADIO,
    state: 'new',
    priority: 'medium',
    title: 'Distress phrase',
    retentionHold: true,
    evidence: [],
    revision: 1,
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    ...overrides,
  };
};

describe('board columns', () => {
  it('maps states to four columns, closed holding resolved and dismissed', () => {
    expect(INCIDENT_COLUMNS.map((column) => column.key)).toEqual([
      'new',
      'acknowledged',
      'in_progress',
      'closed',
    ]);
    expect(columnOf('new')).toBe('new');
    expect(columnOf('acknowledged')).toBe('acknowledged');
    expect(columnOf('in_progress')).toBe('in_progress');
    expect(columnOf('resolved')).toBe('closed');
    expect(columnOf('dismissed')).toBe('closed');
    expect(INCIDENT_COLUMNS.flatMap((column) => column.states).sort()).toEqual(
      [...INCIDENT_STATES].sort(),
    );
  });

  it('groups by column, most urgent then newest first in open columns', () => {
    const low = incident({ priority: 'low' });
    const critical = incident({ priority: 'critical' });
    const highOld = incident({
      priority: 'high',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    const highNew = incident({
      priority: 'high',
      createdAt: '2026-11-03T09:30:00.000Z',
    });
    const groups = groupIncidents([low, highOld, critical, highNew]);
    expect(groups.new.map((record) => record.id)).toEqual([
      critical.id,
      highNew.id,
      highOld.id,
      low.id,
    ]);
    expect(groups.closed).toEqual([]);
  });

  it('orders closed cards by most recent update and merges both close states', () => {
    const resolved = incident({
      state: 'resolved',
      priority: 'critical',
      updatedAt: '2026-11-03T08:00:00.000Z',
    });
    const dismissed = incident({
      state: 'dismissed',
      priority: 'low',
      updatedAt: '2026-11-03T11:00:00.000Z',
    });
    expect(
      groupIncidents([resolved, dismissed]).closed.map((record) => record.id),
    ).toEqual([dismissed.id, resolved.id]);
  });

  it('keeps only the newest revision of a duplicated incident', () => {
    const before = incident({ state: 'new', revision: 1 });
    const after = { ...before, state: 'acknowledged' as const, revision: 2 };
    const groups = groupIncidents([after, before]);
    expect(groups.new).toEqual([]);
    expect(groups.acknowledged).toEqual([after]);
  });

  it('marks columns with more pages', () => {
    expect(columnCountLabel(3, false)).toBe('3');
    expect(columnCountLabel(50, true)).toBe('50+');
  });
});

describe('transitions', () => {
  it('mirrors the API transition table', () => {
    expect(INCIDENT_TRANSITIONS).toEqual({
      new: ['acknowledged', 'in_progress', 'resolved', 'dismissed'],
      acknowledged: ['in_progress', 'resolved', 'dismissed'],
      in_progress: ['resolved', 'dismissed'],
      resolved: ['acknowledged'],
      dismissed: ['acknowledged'],
    });
    expect(canTransition('in_progress', 'acknowledged')).toBe(false);
    expect(canTransition('resolved', 'dismissed')).toBe(false);
    expect(canTransition('new', 'new')).toBe(false);
    expect(canTransition('dismissed', 'acknowledged')).toBe(true);
  });

  it('requires a decision note only when resolving or dismissing', () => {
    for (const from of INCIDENT_STATES)
      for (const to of INCIDENT_STATES)
        expect(requiresDecisionNote(from, to)).toBe(
          from !== to && (to === 'resolved' || to === 'dismissed'),
        );
  });

  it('labels the explicit buttons and only offers allowed moves', () => {
    const labels = (state: IncidentState) =>
      transitionActions(state).map((action) => action.label);
    expect(labels('new')).toEqual([
      'Acknowledge',
      'Start',
      'Resolve',
      'Dismiss',
    ]);
    expect(labels('acknowledged')).toEqual(['Start', 'Resolve', 'Dismiss']);
    expect(labels('in_progress')).toEqual(['Resolve', 'Dismiss']);
    expect(labels('resolved')).toEqual(['Reopen']);
    expect(labels('dismissed')).toEqual(['Reopen']);
    for (const state of INCIDENT_STATES)
      for (const action of transitionActions(state)) {
        expect(canTransition(state, action.target)).toBe(true);
        expect(action.needsNote).toBe(
          requiresDecisionNote(state, action.target),
        );
      }
    expect(transitionActions('resolved')[0]?.reopen).toBe(true);
    expect(
      transitionActions('new').find((a) => a.target === 'dismissed'),
    ).toMatchObject({ variant: 'danger' });
  });

  it('picks the next step for a card and phrases the result', () => {
    expect(primaryTransition('new')?.target).toBe('acknowledged');
    expect(primaryTransition('acknowledged')?.target).toBe('in_progress');
    expect(primaryTransition('in_progress')?.target).toBe('resolved');
    expect(primaryTransition('dismissed')?.label).toBe('Reopen');
    expect(transitionMessage('acknowledged', true)).toBe('Incident reopened.');
    expect(transitionMessage('in_progress', false)).toBe('Incident started.');
  });
});

describe('card presentation', () => {
  it('pairs every priority with a shape and text', () => {
    expect(priorityPresentation('critical')).toEqual({
      glyph: '▲▲',
      label: 'Critical',
      tone: 'error',
    });
    expect(priorityPresentation('high')).toMatchObject({
      glyph: '▲',
      label: 'High',
    });
    expect(priorityPresentation('medium')).toMatchObject({
      glyph: '●',
      label: 'Medium',
    });
    expect(priorityPresentation('low')).toMatchObject({
      glyph: '○',
      label: 'Low',
    });
  });

  it('formats ages', () => {
    const now = Date.parse('2026-11-03T12:00:00.000Z');
    expect(formatIncidentAge('2026-11-03T11:59:30.000Z', now)).toBe('just now');
    expect(formatIncidentAge('2026-11-03T11:58:00.000Z', now)).toBe('2 min');
    expect(formatIncidentAge('2026-11-03T09:00:00.000Z', now)).toBe('3 h');
    expect(formatIncidentAge('2026-10-30T12:00:00.000Z', now)).toBe('4 d');
    expect(formatIncidentAge('2026-11-03T12:05:00.000Z', now)).toBe('just now');
    expect(formatIncidentAge('not a date', now)).toBe('—');
  });

  it('derives owner initials', () => {
    expect(initialsOf('Ben Munoz')).toBe('BM');
    expect(initialsOf('benjamin.munoz')).toBe('BM');
    expect(initialsOf('ops')).toBe('OP');
    expect(initialsOf('')).toBe('?');
    const user = { id: ME, username: 'benjamin.munoz' };
    expect(ownerPresentation(undefined, user)).toBeUndefined();
    expect(ownerPresentation(ME, user)).toEqual({
      initials: 'BM',
      label: 'Assigned to you (benjamin.munoz)',
      mine: true,
    });
    expect(ownerPresentation(OTHER, user)).toEqual({
      initials: 'AB',
      label: 'Assigned to another operator (ABCD)',
      mine: false,
    });
  });

  it('builds a spoken card summary', () => {
    const record = incident({
      priority: 'critical',
      title: '"Mayday" detected',
      createdAt: '2026-11-03T11:58:00.000Z',
      evidence: [{ communicationId: '00000000-0000-4000-8000-0000000000c1' }],
    });
    expect(
      incidentCardLabel({
        incident: record,
        radioName: 'Base VHF',
        frequencyHz: 146_520_000,
        now: Date.parse('2026-11-03T12:00:00.000Z'),
      }),
    ).toBe(
      'Critical priority, "Mayday" detected, New, Base VHF, 146.520 MHz, opened 2 min ago, Unassigned, 1 clip',
    );
    expect(
      incidentCardLabel({
        incident: record,
        radioName: 'Base VHF',
        frequencyHz: 146_520_000,
        frequencyAttribution: 'inferred',
        now: Date.parse('2026-11-03T12:00:00.000Z'),
      }),
    ).toContain('146.520 MHz (inferred), opened');
    expect(
      incidentCardLabel({
        incident: record,
        radioName: 'Base VHF',
        frequencyHz: 146_520_000,
        frequencyAttribution: 'unknown',
        now: Date.parse('2026-11-03T12:00:00.000Z'),
      }),
    ).toContain('146.520 MHz (unknown source), opened');
  });

  it('labels frequency attribution without merging inferred and unknown', () => {
    expect(attributionSuffix(undefined)).toBe('');
    expect(attributionSuffix('confirmed')).toBe('');
    expect(attributionSuffix('inferred')).toBe(' (inferred)');
    expect(attributionSuffix('unknown')).toBe(' (unknown source)');
  });
});

describe('close note', () => {
  it('offers the five reasons, usual ones first', () => {
    expect(CLOSE_REASONS.map((reason) => reason.label)).toEqual([
      'Handled on air',
      'False alarm',
      'Escalated',
      'Duplicate',
      'Other',
    ]);
    expect(closeReasonsFor('dismissed').map((reason) => reason.key)).toEqual([
      'false_alarm',
      'duplicate',
      'handled_on_air',
      'escalated',
      'other',
    ]);
  });

  it('composes "<reason>: <note>" and lets the reason stand alone', () => {
    expect(composeCloseNote('handled_on_air', '')).toEqual({
      ok: true,
      note: 'Handled on air',
    });
    expect(composeCloseNote('escalated', '  Passed to SAR  ')).toEqual({
      ok: true,
      note: 'Escalated: Passed to SAR',
    });
    // The API rejects an empty note when resolving or dismissing.
    const composed = composeCloseNote('false_alarm', '   ');
    expect(composed.ok && composed.note.trim().length > 0).toBe(true);
  });

  it('needs a reason, a note for Other, and stays within the API limit', () => {
    expect(composeCloseNote(undefined, 'note')).toEqual({
      ok: false,
      error: 'Choose a reason.',
    });
    expect(composeCloseNote('other', '').ok).toBe(false);
    expect(composeCloseNote('other', 'Test transmission')).toEqual({
      ok: true,
      note: 'Other: Test transmission',
    });
    const room = DECISION_NOTE_MAX - 'Duplicate: '.length;
    expect(composeCloseNote('duplicate', 'x'.repeat(room)).ok).toBe(true);
    expect(composeCloseNote('duplicate', 'x'.repeat(room + 1)).ok).toBe(false);
  });
});

describe('phrases', () => {
  it('serializes chips to the API array', () => {
    expect(
      serializePhrases([' mayday ', 'Help  me', 'MAYDAY', '', 'a; b ;auxilio']),
    ).toEqual(['mayday', 'Help me', 'a', 'b', 'auxilio']);
  });

  it('parses stored arrays and legacy semicolon text', () => {
    expect(parsePhrases(['mayday', 'emergencia'])).toEqual([
      'mayday',
      'emergencia',
    ]);
    expect(parsePhrases('mayday; emergencia;; auxilio\nsos')).toEqual([
      'mayday',
      'emergencia',
      'auxilio',
      'sos',
    ]);
    expect(parsePhrases(serializePhrases(['x y', 'z']))).toEqual(['x y', 'z']);
  });

  it('validates like the rule schema', () => {
    expect(validatePhrase('a')).toBeDefined();
    expect(validatePhrase('ok')).toBeUndefined();
    expect(validatePhrase('x'.repeat(101))).toBeDefined();
    expect(phrasesError([])).toBe('Add at least one phrase.');
    expect(
      phrasesError(Array.from({ length: PHRASES_MAX + 1 }, (_, i) => `p${i}`)),
    ).toContain(`${PHRASES_MAX}`);
    expect(phrasesError(['mayday', 'x'])).toContain('“x”');
    expect(phrasesError(['mayday'])).toBeUndefined();
  });
});

describe('frequency range', () => {
  it('converts between MHz and integer Hz', () => {
    expect(mhzToHz(146.52)).toBe(146_520_000);
    expect(mhzToHz(446.00625)).toBe(446_006_250);
    expect(mhzToHz(0)).toBeUndefined();
    expect(mhzToHz(undefined)).toBeUndefined();
    expect(mhzToHz(Number.NaN)).toBeUndefined();
    expect(hzToMhz(146_520_000)).toBe(146.52);
    expect(hzToMhz(undefined)).toBeUndefined();
  });

  it('turns a draft into optional API bounds', () => {
    expect(rangeResult(ANY_FREQUENCY)).toEqual({ ok: true });
    expect(
      rangeResult({ any: false, minHz: 144_000_000, maxHz: 148_000_000 }),
    ).toEqual({ ok: true, minHz: 144_000_000, maxHz: 148_000_000 });
    expect(rangeResult({ any: false, minHz: undefined, maxHz: 1 }).ok).toBe(
      false,
    );
    expect(
      rangeResult({ any: false, minHz: 148_000_000, maxHz: 144_000_000 }),
    ).toEqual({
      ok: false,
      error: 'The lowest frequency is above the highest one.',
    });
  });

  it('labels ranges', () => {
    expect(rangeLabel({})).toBe('Any frequency');
    expect(rangeLabel({ minHz: 144_000_000, maxHz: 148_000_000 })).toBe(
      '144–148 MHz',
    );
    expect(rangeLabel({ minHz: 146_520_000, maxHz: 146_520_000 })).toBe(
      '146.52 MHz',
    );
    expect(rangeLabel({ minHz: 430_000_000 })).toBe('From 430 MHz');
    expect(rangeLabel({ maxHz: 148_000_000 })).toBe('Up to 148 MHz');
  });

  it('frames the bar with the radio ranges and widens it for the bounds', () => {
    const ranges = [
      { minHz: 144_000_000, maxHz: 148_000_000 },
      { minHz: 430_000_000, maxHz: 440_000_000 },
    ];
    expect(
      pickerDomain(ranges, { minHz: undefined, maxHz: undefined }),
    ).toEqual({ minHz: 144_000_000, maxHz: 440_000_000 });
    expect(
      pickerDomain(undefined, { minHz: 100_000_000, maxHz: 150_000_000 }),
    ).toEqual({ minHz: 100_000_000, maxHz: 174_000_000 });
    expect(initialRange(undefined)).toEqual({
      minHz: 144_000_000,
      maxHz: 148_000_000,
    });
    expect(initialRange([{ minHz: 430_000_000, maxHz: 440_000_000 }])).toEqual({
      minHz: 430_000_000,
      maxHz: 440_000_000,
    });
  });

  it('maps Hz to pixels and back', () => {
    const scale = createRangeScale(
      { minHz: 100_000_000, maxHz: 200_000_000 },
      224,
      12,
    );
    expect(scale.x(100_000_000)).toBe(12);
    expect(scale.x(200_000_000)).toBe(212);
    expect(scale.x(150_000_000)).toBe(112);
    expect(scale.x(50_000_000)).toBe(12);
    expect(scale.hzAt(112)).toBe(150_000_000);
    expect(scale.hzAt(-40)).toBe(100_000_000);
    expect(scale.hzAt(1000)).toBe(200_000_000);
  });

  it('moves handles with snapping and without crossing', () => {
    const domain = { minHz: 136_000_000, maxHz: 174_000_000 };
    const range = { minHz: 144_000_000, maxHz: 148_000_000 };
    expect(dragStepHz(domain)).toBe(100_000);
    expect(nearestHandle(range, 145_000_000)).toBe('min');
    expect(nearestHandle(range, 150_000_000)).toBe('max');
    expect(moveRangeHandle(range, 'min', 145_040_000, domain, 100_000)).toEqual(
      { minHz: 145_000_000, maxHz: 148_000_000 },
    );
    expect(moveRangeHandle(range, 'min', 160_000_000, domain, 100_000)).toEqual(
      { minHz: 148_000_000, maxHz: 148_000_000 },
    );
    expect(moveRangeHandle(range, 'max', 100_000_000, domain, 100_000)).toEqual(
      { minHz: 144_000_000, maxHz: 144_000_000 },
    );
    expect(moveRangeHandle(range, 'max', 900_000_000, domain, 100_000)).toEqual(
      { minHz: 144_000_000, maxHz: 174_000_000 },
    );
    expect(stepRangeHandle(range, 'max', -100_000, domain)).toEqual({
      minHz: 144_000_000,
      maxHz: 147_900_000,
    });
  });

  it('maps slider keys', () => {
    expect(rangeKeyAction('ArrowRight')).toEqual({
      kind: 'step',
      direction: 1,
      large: false,
    });
    expect(rangeKeyAction('ArrowDown')).toEqual({
      kind: 'step',
      direction: -1,
      large: false,
    });
    expect(rangeKeyAction('PageUp')).toEqual({
      kind: 'step',
      direction: 1,
      large: true,
    });
    expect(rangeKeyAction('Home')).toEqual({ kind: 'edge', edge: 'start' });
    expect(rangeKeyAction('End')).toEqual({ kind: 'edge', edge: 'end' });
    expect(rangeKeyAction('a')).toBeUndefined();
  });
});

describe('rule body', () => {
  it('keeps the high-priority, enabled, radio-scoped semantics', () => {
    expect(
      ruleBody({
        name: '  Distress  ',
        phrases: ['mayday', 'Mayday', 'auxilio'],
        range: { any: false, minHz: 144_000_000, maxHz: 148_000_000 },
        radioId: RADIO,
      }),
    ).toEqual({
      ok: true,
      body: {
        name: 'Distress',
        phrases: ['mayday', 'auxilio'],
        priority: 'high',
        enabled: true,
        radioIds: [RADIO],
        minHz: 144_000_000,
        maxHz: 148_000_000,
      },
    });
    expect(
      ruleBody({ name: 'Any', phrases: ['sos'], range: ANY_FREQUENCY }),
    ).toEqual({
      ok: true,
      body: { name: 'Any', phrases: ['sos'], priority: 'high', enabled: true },
    });
  });

  it('reports the first problem', () => {
    expect(
      ruleBody({ name: ' ', phrases: ['sos'], range: ANY_FREQUENCY }),
    ).toEqual({ ok: false, error: 'Name the rule.' });
    expect(ruleBody({ name: 'n', phrases: [], range: ANY_FREQUENCY })).toEqual({
      ok: false,
      error: 'Add at least one phrase.',
    });
    expect(
      ruleBody({
        name: 'n',
        phrases: ['sos'],
        range: { any: false, minHz: 2, maxHz: 1 },
      }).ok,
    ).toBe(false);
  });
});
