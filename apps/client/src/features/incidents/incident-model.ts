/**
 * Pure incident board, close-flow, rule-builder and frequency-range helpers.
 *
 * Plain TypeScript only (no React / React Native) so it can be unit tested in
 * node. The API stays authoritative: transitions and the required decision
 * note mirror `apps/api/src/modules/incidents/service.ts`, and the phrase and
 * frequency limits mirror `EmergencyRuleSchema` in
 * `services/processing-tasks/src/schemas.ts`.
 */
import type {
  Communication,
  IncidentRecord,
  IncidentState,
  PublicUser,
} from '@signaldock/contracts';
import { attributionLabel } from '../history/history-model';
import {
  formatFrequency,
  formatMegahertzShort,
  type FrequencyRange,
} from '../station/station-model';

/* -------------------------------------------------------------------------- */
/* Board columns                                                              */
/* -------------------------------------------------------------------------- */

export type IncidentPriority = IncidentRecord['priority'];
export type IncidentColumn = 'new' | 'acknowledged' | 'in_progress' | 'closed';

export interface IncidentColumnDefinition {
  key: IncidentColumn;
  label: string;
  /** API states listed in this column (Closed = resolved + dismissed). */
  states: readonly IncidentState[];
}

export const INCIDENT_STATES: readonly IncidentState[] = [
  'new',
  'acknowledged',
  'in_progress',
  'resolved',
  'dismissed',
];

export const INCIDENT_COLUMNS: readonly IncidentColumnDefinition[] = [
  { key: 'new', label: 'New', states: ['new'] },
  { key: 'acknowledged', label: 'Acknowledged', states: ['acknowledged'] },
  { key: 'in_progress', label: 'In progress', states: ['in_progress'] },
  { key: 'closed', label: 'Closed', states: ['resolved', 'dismissed'] },
];

export function columnOf(state: IncidentState): IncidentColumn {
  return state === 'resolved' || state === 'dismissed' ? 'closed' : state;
}

export function columnDefinition(
  column: IncidentColumn,
): IncidentColumnDefinition {
  return INCIDENT_COLUMNS.find((entry) => entry.key === column)!;
}

export const STATE_LABELS: Record<IncidentState, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const PRIORITY_RANK: Record<IncidentPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Open columns: most urgent first, then newest. Closed: most recently closed
 * first. Ties fall back to the ID so the order is stable.
 */
export function compareIncidents(
  column: IncidentColumn,
  a: IncidentRecord,
  b: IncidentRecord,
): number {
  if (column !== 'closed') {
    const rank = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (rank) return rank;
    const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (created) return created;
  } else {
    const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (updated) return updated;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Groups records into board columns. Duplicates (the same ID loaded from two
 * pages) keep the highest revision, so a moved card shows up only once.
 */
export function groupIncidents(
  records: readonly IncidentRecord[],
): Record<IncidentColumn, IncidentRecord[]> {
  const latest = new Map<string, IncidentRecord>();
  for (const record of records) {
    const existing = latest.get(record.id);
    if (!existing || record.revision >= existing.revision)
      latest.set(record.id, record);
  }
  const groups: Record<IncidentColumn, IncidentRecord[]> = {
    new: [],
    acknowledged: [],
    in_progress: [],
    closed: [],
  };
  for (const record of latest.values())
    groups[columnOf(record.state)].push(record);
  for (const column of INCIDENT_COLUMNS)
    groups[column.key].sort((a, b) => compareIncidents(column.key, a, b));
  return groups;
}

/** '3', or '50+' while more pages exist for the column. */
export function columnCountLabel(count: number, hasMore: boolean): string {
  return hasMore ? `${count}+` : String(count);
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

/** Same table as the API's `transitions` in the incident service. */
export const INCIDENT_TRANSITIONS: Record<
  IncidentState,
  readonly IncidentState[]
> = {
  new: ['acknowledged', 'in_progress', 'resolved', 'dismissed'],
  acknowledged: ['in_progress', 'resolved', 'dismissed'],
  in_progress: ['resolved', 'dismissed'],
  resolved: ['acknowledged'],
  dismissed: ['acknowledged'],
};

export function canTransition(from: IncidentState, to: IncidentState) {
  return from !== to && INCIDENT_TRANSITIONS[from].includes(to);
}

/** The API rejects resolving or dismissing without a decision note. */
export function requiresDecisionNote(from: IncidentState, to: IncidentState) {
  return from !== to && (to === 'resolved' || to === 'dismissed');
}

export type CloseState = 'resolved' | 'dismissed';
export const isCloseState = (state: IncidentState): state is CloseState =>
  state === 'resolved' || state === 'dismissed';

export interface TransitionAction {
  target: IncidentState;
  /** Button text: Acknowledge, Start, Resolve, Dismiss or Reopen. */
  label: string;
  /** Opens the close sheet (reason + optional note) instead of acting directly. */
  needsNote: boolean;
  /** Back from a closed state. */
  reopen: boolean;
  variant: 'primary' | 'secondary' | 'danger';
}

/** Allowed moves from `state`, in board order. */
export function transitionActions(state: IncidentState): TransitionAction[] {
  const closed = isCloseState(state);
  return INCIDENT_TRANSITIONS[state].map((target, index) => ({
    target,
    label:
      target === 'acknowledged'
        ? closed
          ? 'Reopen'
          : 'Acknowledge'
        : target === 'in_progress'
          ? 'Start'
          : target === 'resolved'
            ? 'Resolve'
            : 'Dismiss',
    needsNote: requiresDecisionNote(state, target),
    reopen: closed,
    variant:
      index === 0 ? 'primary' : target === 'dismissed' ? 'danger' : 'secondary',
  }));
}

/** The single next step shown on a board card (the detail shows them all). */
export function primaryTransition(
  state: IncidentState,
): TransitionAction | undefined {
  return transitionActions(state)[0];
}

/** Toast text after a successful move. */
export function transitionMessage(target: IncidentState, reopen: boolean) {
  if (reopen) return 'Incident reopened.';
  switch (target) {
    case 'acknowledged':
      return 'Incident acknowledged.';
    case 'in_progress':
      return 'Incident started.';
    case 'resolved':
      return 'Incident resolved.';
    case 'dismissed':
      return 'Incident dismissed.';
    default:
      return 'Incident updated.';
  }
}

/* -------------------------------------------------------------------------- */
/* Card presentation                                                          */
/* -------------------------------------------------------------------------- */

export interface PriorityPresentation {
  /** Shape that carries the level without colour: ▲▲ ▲ ● ○. */
  glyph: string;
  label: string;
  tone: 'error' | 'warning' | 'neutral';
}

export function priorityPresentation(
  priority: IncidentPriority,
): PriorityPresentation {
  switch (priority) {
    case 'critical':
      return { glyph: '▲▲', label: 'Critical', tone: 'error' };
    case 'high':
      return { glyph: '▲', label: 'High', tone: 'warning' };
    case 'medium':
      return { glyph: '●', label: 'Medium', tone: 'neutral' };
    default:
      return { glyph: '○', label: 'Low', tone: 'neutral' };
  }
}

/** 'just now', '4 min', '3 h', '2 d' (or '—' for an unreadable timestamp). */
export function formatIncidentAge(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** Up to two letters: 'Ben Munoz' → 'BM', 'benjamin.munoz' → 'BM', 'ops' → 'OP'. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const letters =
    words.length >= 2
      ? `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`
      : (words[0] ?? '').slice(0, 2);
  return letters.toLocaleUpperCase() || '?';
}

export interface OwnerPresentation {
  initials: string;
  label: string;
  mine: boolean;
}

/**
 * Only the signed-in user's name is known to the client; other owners are
 * shown as an anonymous operator with a short ID suffix.
 */
export function ownerPresentation(
  ownerUserId: string | undefined,
  user: Pick<PublicUser, 'id' | 'username'>,
): OwnerPresentation | undefined {
  if (!ownerUserId) return undefined;
  if (ownerUserId === user.id)
    return {
      initials: initialsOf(user.username),
      label: `Assigned to you (${user.username})`,
      mine: true,
    };
  const short = ownerUserId.replace(/-/g, '').slice(0, 4).toUpperCase();
  return {
    initials: short.slice(0, 2) || '?',
    label: `Assigned to another operator (${short})`,
    mine: false,
  };
}

export function evidenceCountLabel(count: number): string {
  return count === 1 ? '1 clip' : `${count} clips`;
}

/** Spoken summary for a board card. */
export type FrequencyAttribution = Communication['frequencyAttribution'];

/**
 * Text after an evidence frequency: nothing when confirmed (or not known
 * yet), ' (inferred)' or ' (unknown source)' otherwise.
 */
export function attributionSuffix(
  attribution: FrequencyAttribution | undefined,
): string {
  if (attribution === undefined || attribution === 'confirmed') return '';
  return attribution === 'inferred'
    ? ' (inferred)'
    : ` (${attributionLabel(attribution)})`;
}

export function incidentCardLabel(input: {
  incident: IncidentRecord;
  radioName: string;
  frequencyHz?: number | undefined;
  frequencyAttribution?: FrequencyAttribution | undefined;
  now: number;
  owner?: OwnerPresentation | undefined;
}): string {
  const { incident } = input;
  const age = formatIncidentAge(incident.createdAt, input.now);
  const parts = [
    `${priorityPresentation(incident.priority).label} priority`,
    incident.title,
    STATE_LABELS[incident.state],
    input.radioName,
    ...(input.frequencyHz !== undefined
      ? [
          `${formatFrequency(input.frequencyHz)} MHz${attributionSuffix(input.frequencyAttribution)}`,
        ]
      : []),
    age === 'just now' ? 'opened just now' : `opened ${age} ago`,
    input.owner ? input.owner.label : 'Unassigned',
    evidenceCountLabel(incident.evidence.length),
  ];
  return parts.join(', ');
}

/* -------------------------------------------------------------------------- */
/* Close flow                                                                 */
/* -------------------------------------------------------------------------- */

export type CloseReason =
  'handled_on_air' | 'false_alarm' | 'escalated' | 'duplicate' | 'other';

export interface CloseReasonDefinition {
  key: CloseReason;
  label: string;
  /** Whether this reason usually resolves or dismisses (used for ordering). */
  usual: CloseState;
  /** 'Other' alone says nothing; it needs a note. */
  noteRequired: boolean;
}

export const CLOSE_REASONS: readonly CloseReasonDefinition[] = [
  {
    key: 'handled_on_air',
    label: 'Handled on air',
    usual: 'resolved',
    noteRequired: false,
  },
  {
    key: 'false_alarm',
    label: 'False alarm',
    usual: 'dismissed',
    noteRequired: false,
  },
  {
    key: 'escalated',
    label: 'Escalated',
    usual: 'resolved',
    noteRequired: false,
  },
  {
    key: 'duplicate',
    label: 'Duplicate',
    usual: 'dismissed',
    noteRequired: false,
  },
  { key: 'other', label: 'Other', usual: 'resolved', noteRequired: true },
];

/** Reasons that usually fit `state` first; the rest keep their order. */
export function closeReasonsFor(state: CloseState): CloseReasonDefinition[] {
  return [
    ...CLOSE_REASONS.filter((reason) => reason.usual === state),
    ...CLOSE_REASONS.filter((reason) => reason.usual !== state),
  ];
}

/** The API's `note` limit. */
export const DECISION_NOTE_MAX = 2000;

export type CloseNoteResult =
  { ok: true; note: string } | { ok: false; error: string };

/**
 * `"<reason>: <note>"`, or just the reason label when the note is empty. The
 * reason always makes the note non-empty, which satisfies the API rule that
 * resolving or dismissing needs a decision note.
 */
export function composeCloseNote(
  reason: CloseReason | undefined,
  note: string,
): CloseNoteResult {
  const definition = CLOSE_REASONS.find((entry) => entry.key === reason);
  if (!definition) return { ok: false, error: 'Choose a reason.' };
  const text = note.trim();
  if (!text && definition.noteRequired)
    return { ok: false, error: 'Add a short note for “Other”.' };
  const composed = text ? `${definition.label}: ${text}` : definition.label;
  if (composed.length > DECISION_NOTE_MAX)
    return {
      ok: false,
      error: `Keep the note under ${DECISION_NOTE_MAX - definition.label.length - 2} characters.`,
    };
  return { ok: true, note: composed };
}

/* -------------------------------------------------------------------------- */
/* Rule phrases                                                               */
/* -------------------------------------------------------------------------- */

export const PHRASE_MIN_LENGTH = 2;
export const PHRASE_MAX_LENGTH = 100;
export const PHRASES_MAX = 30;
export const RULE_NAME_MAX = 100;

export function validatePhrase(value: string): string | undefined {
  const text = value.trim();
  if (text.length < PHRASE_MIN_LENGTH)
    return `Phrases need at least ${PHRASE_MIN_LENGTH} characters.`;
  if (text.length > PHRASE_MAX_LENGTH)
    return `Phrases can have up to ${PHRASE_MAX_LENGTH} characters.`;
  return undefined;
}

/**
 * Chip values → the API's `phrases` array: each chip is trimmed, legacy
 * semicolon lists are split, blanks dropped and case-insensitive duplicates
 * removed (first spelling wins).
 */
export function serializePhrases(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const value of values)
    for (const part of value.split(';')) {
      const phrase = part.trim().replace(/\s+/g, ' ');
      const key = phrase.toLocaleLowerCase();
      if (!phrase || seen.has(key)) continue;
      seen.add(key);
      phrases.push(phrase);
    }
  return phrases;
}

/**
 * Stored phrases (array) or legacy text (`"mayday; help"`, commas or new
 * lines) → chip values.
 */
export function parsePhrases(input: string | readonly string[]): string[] {
  return serializePhrases(
    typeof input === 'string' ? input.split(/[;,\n]/) : input,
  );
}

/** First problem with a phrase list, if any. */
export function phrasesError(values: readonly string[]): string | undefined {
  const phrases = serializePhrases(values);
  if (!phrases.length) return 'Add at least one phrase.';
  if (phrases.length > PHRASES_MAX)
    return `A rule can have up to ${PHRASES_MAX} phrases.`;
  for (const phrase of phrases) {
    const error = validatePhrase(phrase);
    if (error) return `“${phrase}”: ${error}`;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Frequency range                                                            */
/* -------------------------------------------------------------------------- */

export const MHZ = 1_000_000;

/** What the range picker edits. `any` = the rule matches every frequency. */
export interface FrequencyRangeDraft {
  any: boolean;
  minHz: number | undefined;
  maxHz: number | undefined;
}

/** Default band when nothing frames the picker: 2 m amateur. */
export const DEFAULT_RULE_RANGE: FrequencyRange = {
  minHz: 144_000_000,
  maxHz: 148_000_000,
};
/** Default bar span without radio ranges: VHF high band. */
export const DEFAULT_PICKER_DOMAIN: FrequencyRange = {
  minHz: 136_000_000,
  maxHz: 174_000_000,
};

export const ANY_FREQUENCY: FrequencyRangeDraft = {
  any: true,
  minHz: undefined,
  maxHz: undefined,
};

/** MHz (from a stepper) → integer Hz, or undefined when not a positive number. */
export function mhzToHz(mhz: number | undefined): number | undefined {
  if (mhz === undefined || !Number.isFinite(mhz)) return undefined;
  const hz = Math.round(mhz * MHZ);
  return hz > 0 && Number.isSafeInteger(hz) ? hz : undefined;
}

/** Integer Hz → MHz number for a stepper (at most 6 decimals). */
export function hzToMhz(hz: number | undefined): number | undefined {
  if (hz === undefined || !Number.isFinite(hz)) return undefined;
  return Number((hz / MHZ).toFixed(6));
}

export type RangeResult =
  { ok: true; minHz?: number; maxHz?: number } | { ok: false; error: string };

/** Draft → the API's optional `minHz` / `maxHz` (both omitted for any frequency). */
export function rangeResult(draft: FrequencyRangeDraft): RangeResult {
  if (draft.any) return { ok: true };
  const { minHz, maxHz } = draft;
  if (minHz === undefined || !Number.isSafeInteger(minHz) || minHz <= 0)
    return { ok: false, error: 'Enter a lowest frequency.' };
  if (maxHz === undefined || !Number.isSafeInteger(maxHz) || maxHz <= 0)
    return { ok: false, error: 'Enter a highest frequency.' };
  if (minHz > maxHz)
    return {
      ok: false,
      error: 'The lowest frequency is above the highest one.',
    };
  return { ok: true, minHz, maxHz };
}

/** 'Any frequency', '144–148 MHz', 'From 144 MHz' or 'Up to 148 MHz'. */
export function rangeLabel(range: { minHz?: number; maxHz?: number }): string {
  const { minHz, maxHz } = range;
  if (minHz !== undefined && maxHz !== undefined)
    return minHz === maxHz
      ? `${formatMegahertzShort(minHz)} MHz`
      : `${formatMegahertzShort(minHz)}–${formatMegahertzShort(maxHz)} MHz`;
  if (minHz !== undefined) return `From ${formatMegahertzShort(minHz)} MHz`;
  if (maxHz !== undefined) return `Up to ${formatMegahertzShort(maxHz)} MHz`;
  return 'Any frequency';
}

export function draftLabel(draft: FrequencyRangeDraft): string {
  if (draft.any) return 'Any frequency';
  return rangeLabel({
    ...(draft.minHz !== undefined ? { minHz: draft.minHz } : {}),
    ...(draft.maxHz !== undefined ? { maxHz: draft.maxHz } : {}),
  });
}

/**
 * Span shown by the bar: the hull of the radio's tuning ranges (or the VHF
 * default), widened to include the current bounds.
 */
export function pickerDomain(
  scale: readonly FrequencyRange[] | undefined,
  draft: Pick<FrequencyRangeDraft, 'minHz' | 'maxHz'>,
): FrequencyRange {
  const base = scale?.length
    ? {
        minHz: Math.min(...scale.map((range) => range.minHz)),
        maxHz: Math.max(...scale.map((range) => range.maxHz)),
      }
    : DEFAULT_PICKER_DOMAIN;
  let { minHz, maxHz } = base;
  for (const hz of [draft.minHz, draft.maxHz])
    if (hz !== undefined && Number.isFinite(hz) && hz > 0) {
      minHz = Math.min(minHz, hz);
      maxHz = Math.max(maxHz, hz);
    }
  if (maxHz <= minHz) maxHz = minHz + MHZ;
  return { minHz, maxHz };
}

/** Initial bounds when the "Any frequency" toggle is switched off. */
export function initialRange(
  scale: readonly FrequencyRange[] | undefined,
): FrequencyRange {
  const domain = pickerDomain(scale, { minHz: undefined, maxHz: undefined });
  if (
    DEFAULT_RULE_RANGE.minHz >= domain.minHz &&
    DEFAULT_RULE_RANGE.maxHz <= domain.maxHz
  )
    return DEFAULT_RULE_RANGE;
  return domain;
}

const NICE_STEPS_HZ = [
  1_000, 5_000, 12_500, 25_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000,
  10_000_000,
];

/** Drag snapping: the smallest nice step that gives at most ~400 positions. */
export function dragStepHz(domain: FrequencyRange): number {
  const span = Math.max(1, domain.maxHz - domain.minHz);
  return (
    NICE_STEPS_HZ.find((step) => span / step <= 400) ??
    NICE_STEPS_HZ[NICE_STEPS_HZ.length - 1]!
  );
}

/** Keyboard / screen-reader steps for a handle. */
export function keyboardStepHz(domain: FrequencyRange, large = false): number {
  const step = dragStepHz(domain);
  return large ? step * 10 : step;
}

export interface RangeScale {
  domain: FrequencyRange;
  width: number;
  /** Pixels reserved at each end so handles are never clipped. */
  inset: number;
  x(hz: number): number;
  hzAt(x: number): number;
}

/** Linear Hz ↔ px mapping across the bar. */
export function createRangeScale(
  domain: FrequencyRange,
  width: number,
  inset = 12,
): RangeScale {
  const usable = Math.max(1, width - inset * 2);
  const span = Math.max(1, domain.maxHz - domain.minHz);
  return {
    domain,
    width,
    inset,
    x: (hz) =>
      inset +
      (Math.min(Math.max(hz, domain.minHz), domain.maxHz) - domain.minHz) *
        (usable / span),
    hzAt: (x) =>
      Math.round(
        domain.minHz +
          (Math.min(Math.max(x - inset, 0), usable) / usable) * span,
      ),
  };
}

export type RangeHandle = 'min' | 'max';

/** Which handle a press at `hz` should grab (the closer one; ties pick by side). */
export function nearestHandle(range: FrequencyRange, hz: number): RangeHandle {
  const toMin = Math.abs(hz - range.minHz);
  const toMax = Math.abs(hz - range.maxHz);
  if (toMin === toMax) return hz > range.maxHz ? 'max' : 'min';
  return toMin < toMax ? 'min' : 'max';
}

/**
 * Moves one handle to `hz`: snapped to `stepHz`, kept inside the domain and
 * never past the other handle.
 */
export function moveRangeHandle(
  range: FrequencyRange,
  handle: RangeHandle,
  hz: number,
  domain: FrequencyRange,
  stepHz: number,
): FrequencyRange {
  const step = stepHz > 0 ? stepHz : 1;
  let next = Math.round(hz / step) * step;
  next = Math.min(Math.max(next, domain.minHz), domain.maxHz);
  if (handle === 'min')
    return { minHz: Math.min(next, range.maxHz), maxHz: range.maxHz };
  return { minHz: range.minHz, maxHz: Math.max(next, range.minHz) };
}

/** Steps one handle by `deltaHz` (keyboard, screen-reader increment). */
export function stepRangeHandle(
  range: FrequencyRange,
  handle: RangeHandle,
  deltaHz: number,
  domain: FrequencyRange,
): FrequencyRange {
  const current = handle === 'min' ? range.minHz : range.maxHz;
  return moveRangeHandle(
    range,
    handle,
    current + deltaHz,
    domain,
    Math.abs(deltaHz),
  );
}

export type RangeKeyAction =
  | { kind: 'step'; direction: 1 | -1; large: boolean }
  | { kind: 'edge'; edge: 'start' | 'end' };

/** Slider keys (ARIA pattern): arrows, Page Up/Down for ×10, Home/End. */
export function rangeKeyAction(key: string): RangeKeyAction | undefined {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return { kind: 'step', direction: 1, large: false };
    case 'ArrowLeft':
    case 'ArrowDown':
      return { kind: 'step', direction: -1, large: false };
    case 'PageUp':
      return { kind: 'step', direction: 1, large: true };
    case 'PageDown':
      return { kind: 'step', direction: -1, large: true };
    case 'Home':
      return { kind: 'edge', edge: 'start' };
    case 'End':
      return { kind: 'edge', edge: 'end' };
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Rule body                                                                  */
/* -------------------------------------------------------------------------- */

export interface RuleDraft {
  name: string;
  phrases: readonly string[];
  range: FrequencyRangeDraft;
  /** Selected radio: new rules are scoped to it (as before). */
  radioId?: string | undefined;
}

export interface RuleBody {
  name: string;
  phrases: string[];
  priority: 'high';
  enabled: true;
  radioIds?: string[];
  minHz?: number;
  maxHz?: number;
}

export type RuleBodyResult =
  { ok: true; body: RuleBody } | { ok: false; error: string };

/**
 * The POST body for `incidents/rules`. Rules made here keep the existing
 * semantics: enabled, high priority, scoped to the selected radio if any.
 */
export function ruleBody(draft: RuleDraft): RuleBodyResult {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: 'Name the rule.' };
  if (name.length > RULE_NAME_MAX)
    return {
      ok: false,
      error: `Rule names can have up to ${RULE_NAME_MAX} characters.`,
    };
  const phraseProblem = phrasesError(draft.phrases);
  if (phraseProblem) return { ok: false, error: phraseProblem };
  const range = rangeResult(draft.range);
  if (!range.ok) return range;
  return {
    ok: true,
    body: {
      name,
      phrases: serializePhrases(draft.phrases),
      priority: 'high',
      enabled: true,
      ...(draft.radioId ? { radioIds: [draft.radioId] } : {}),
      ...(range.minHz !== undefined ? { minHz: range.minHz } : {}),
      ...(range.maxHz !== undefined ? { maxHz: range.maxHz } : {}),
    },
  };
}
