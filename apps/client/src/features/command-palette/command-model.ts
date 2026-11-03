/**
 * Pure command building, fuzzy ranking and shortcut handling for the command
 * palette. No React Native imports, so it can be unit tested in node.
 *
 * Safety: a command never does more than its title says. Tuning commands are
 * built only from a parsed frequency and are blocked (with the reason) unless
 * the radio is editable; selecting a radio never retunes it.
 */
import type {
  IncidentRecord,
  RadioMemory,
  RadioView,
  Tuning,
} from '@signaldock/contracts';
import type { IconName } from '@signaldock/ui';
import {
  memoryAccess,
  memoryTileSummary,
} from '../radios/components/memory-grid-model';
import {
  applyState,
  draftSeed,
  tuningBlockReason,
  type TuningDraft,
} from '../radios/components/tuning-model';
import {
  bandLabel,
  connectionPresentation,
  formatOffset,
  formatTuning,
  isInRanges,
  offsetPresets,
  parseFrequencyInput,
  type TuningMode,
} from '../station/station-model';

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

/** Row icon (type-only import, so this module stays free of React Native). */
export type PaletteIcon = IconName;

export type PaletteGroup =
  | 'Tuning'
  | 'Memories'
  | 'Radios'
  | 'Control'
  | 'Audio'
  | 'Go to'
  | 'Incidents';

export type PaletteAction =
  | { type: 'tune'; radioId: string; radioName: string; tuning: Tuning }
  | { type: 'recall'; radioId: string; memoryId: string; name: string }
  | { type: 'select-radio'; radioId: string; radioName: string }
  | { type: 'navigate'; section: string; label: string }
  | { type: 'open-incident'; incidentId: string; title: string }
  | { type: 'take-control'; radioId: string; radioName: string }
  | { type: 'release-control'; radioId: string; radioName: string }
  | { type: 'listen'; radioId: string; radioName: string }
  | { type: 'stop-listening'; radioId: string; radioName: string };

/** Something the operator can do to unblock a command. */
export type PaletteFix = 'take-control';

export interface PaletteBlock {
  reason: string;
  fix?: PaletteFix;
}

export interface PaletteCommand {
  id: string;
  group: PaletteGroup;
  icon: PaletteIcon;
  title: string;
  /** Monospace value shown after the title, like '146.550 FM'. */
  value?: string;
  /** Secondary line under the title. */
  subtitle?: string;
  /** Short hint at the end of the row ('Recall', 'Current'). */
  hint?: string;
  /** Extra text searched besides the title and value. */
  keywords: readonly string[];
  /** What the command does. Absent only on blocked commands. */
  action?: PaletteAction;
  /** Present when the command cannot run now; running it explains why. */
  blocked?: PaletteBlock;
  /** Ranked above every other match (a typed frequency). */
  pinned?: boolean;
}

export interface PaletteSectionOption<S extends string = string> {
  key: S;
  label: string;
  icon: PaletteIcon;
}

export interface PaletteMediaState {
  /** This platform can run live audio. */
  supported: boolean;
  /** The server advertises live audio. */
  configured: boolean;
  listening: boolean;
  canListen: boolean;
  listenReason: string;
}

export type PaletteControlState =
  'mine' | 'other' | 'available' | 'unavailable';

export interface PaletteContext {
  radios: readonly RadioView[];
  selected: RadioView | undefined;
  /** Memories of the selected radio. */
  memories: readonly RadioMemory[];
  controlState: PaletteControlState;
  controlOwnerLabel: string;
  canControl: boolean;
  busy: boolean;
  editable: boolean;
  /** Generation of the station's lease for the selected radio, if any. */
  leaseGeneration: string | undefined;
  media: PaletteMediaState | undefined;
  sections: readonly PaletteSectionOption[];
  currentSection: string | undefined;
  /** Open incidents (see `mergeOpenIncidents`). */
  incidents: readonly IncidentRecord[];
}

const TAKE_CONTROL_FIRST = 'Take control first.';
const BUSY = 'Another operation is in progress.';

/** Text that is clearly meant as a frequency (digits, separators, a unit). */
export function looksLikeFrequency(text: string): boolean {
  return /^\s*\d[\d\s.,_']*(hz|khz|mhz|ghz)?\s*$/i.test(text);
}

/**
 * The TX offset a palette tune keeps: the current one when it is a standard
 * offset for the new frequency's band and still inside the radio's ranges,
 * otherwise simplex. A typed frequency never carries a repeater offset into
 * another band.
 */
export function paletteOffset(input: {
  currentOffsetHz: number;
  rxHz: number;
  txAudio: boolean;
  ranges: readonly { minHz: number; maxHz: number }[];
}): number {
  const { currentOffsetHz, rxHz } = input;
  if (!input.txAudio || currentOffsetHz === 0) return 0;
  const standard = offsetPresets(rxHz).some(
    (preset) => preset.kind === 'preset' && preset.offsetHz === currentOffsetHz,
  );
  if (!standard || !isInRanges(rxHz + currentOffsetHz, input.ranges)) return 0;
  return currentOffsetHz;
}

/** Whether "Take control" would unblock a write on the selected radio. */
function takeControlFixes(context: PaletteContext): boolean {
  return (
    context.canControl &&
    context.controlState === 'available' &&
    context.selected?.snapshot?.connection === 'ready'
  );
}

/** "Tune <radio> to …" for a typed frequency, or undefined when the text is not one. */
export function frequencyCommand(
  query: string,
  context: PaletteContext,
): PaletteCommand | undefined {
  if (!looksLikeFrequency(query)) return undefined;
  const text = query.trim();
  const radio = context.selected;
  // A typed frequency inside the radio's ranges is the top answer, even when
  // blocked; a parse error ranks like any other match (it may be a memory).
  const pinned = parseFrequencyInput(
    text,
    radio?.descriptor?.capabilities.tuning.ranges,
  ).ok;
  const base = {
    id: 'tune',
    group: 'Tuning' as const,
    icon: 'knob' as const,
    keywords: [] as const,
    ...(pinned ? { pinned } : {}),
  };
  if (!radio) {
    const parsed = parseFrequencyInput(text);
    return {
      ...base,
      title: 'Tune to',
      value: text,
      blocked: { reason: parsed.ok ? 'Select a radio first.' : parsed.error },
    };
  }
  const name = radio.displayName;
  const capabilities = radio.descriptor?.capabilities;
  const title = `Tune ${name} to`;
  if (!capabilities)
    return {
      ...base,
      title,
      value: text,
      blocked: { reason: 'This radio has not reported its capabilities yet.' },
    };
  if (!capabilities.tuning.writable)
    return {
      ...base,
      title,
      value: text,
      blocked: {
        reason:
          'This driver does not support free tuning — use channel memories.',
      },
    };
  const ranges = capabilities.tuning.ranges;
  const modes: readonly TuningMode[] = capabilities.tuning.modes;
  const parsed = parseFrequencyInput(text, ranges);
  if (!parsed.ok)
    return { ...base, title, value: text, blocked: { reason: parsed.error } };
  const snapshot = radio.snapshot;
  const seed = draftSeed(snapshot, ranges, modes);
  const mode = seed && modes.includes(seed.mode) ? seed.mode : modes[0];
  if (!mode)
    return {
      ...base,
      title,
      value: text,
      blocked: { reason: 'This radio does not advertise any mode.' },
    };
  const draft: TuningDraft = {
    rxHz: parsed.hz,
    mode,
    offsetHz: paletteOffset({
      currentOffsetHz: seed?.offsetHz ?? 0,
      rxHz: parsed.hz,
      txAudio: capabilities.txAudio,
      ranges,
    }),
  };
  const gate = tuningBlockReason({
    writable: true,
    canControl: context.canControl,
    controlState: context.controlState,
    leaseCurrent:
      context.leaseGeneration !== undefined &&
      context.leaseGeneration === snapshot?.generation,
    connection: snapshot?.connection,
    txState: snapshot?.txState,
    busy: context.busy,
  });
  const fix = gate !== undefined && takeControlFixes(context);
  const blockReason = fix
    ? TAKE_CONTROL_FIRST
    : (gate ??
      (context.editable ? undefined : 'Tuning is not available right now.'));
  const apply = applyState({
    draft,
    snapshot,
    ranges,
    modes,
    txAudio: capabilities.txAudio,
    blockReason,
  });
  const tuning = apply.tuning;
  const subtitle = `${
    draft.offsetHz === 0 ? 'Simplex' : `TX ${formatOffset(draft.offsetHz)}`
  } · ${bandLabel(parsed.hz)}`;
  if (!tuning)
    return {
      ...base,
      title,
      value: text,
      blocked: { reason: apply.reason ?? 'Enter a valid frequency.' },
    };
  const value = formatTuning(tuning);
  const blocked: PaletteBlock | undefined = !apply.changed
    ? { reason: `${name} is already on ${value}.` }
    : apply.reason !== undefined
      ? {
          reason: apply.reason,
          ...(fix && apply.reason === TAKE_CONTROL_FIRST
            ? { fix: 'take-control' as const }
            : {}),
        }
      : undefined;
  return {
    ...base,
    title,
    value,
    subtitle,
    action: { type: 'tune', radioId: radio.radioId, radioName: name, tuning },
    ...(blocked ? { blocked } : {}),
  };
}

/** "Recall <memory>" for each memory of the selected radio. */
export function memoryCommands(context: PaletteContext): PaletteCommand[] {
  const radio = context.selected;
  if (!radio) return [];
  const access = memoryAccess({
    radio,
    editable: context.editable,
    controlState: context.controlState,
    canControl: context.canControl,
    busy: context.busy,
  });
  if (!access.readable) return [];
  const selectable = radio.descriptor?.capabilities.memories?.select === true;
  const fix = selectable && takeControlFixes(context);
  const activeId = radio.snapshot?.selectedMemoryId;
  return context.memories.map((memory) => {
    const summary = memoryTileSummary(memory);
    const blocked: PaletteBlock | undefined = access.canRecall
      ? undefined
      : fix
        ? { reason: TAKE_CONTROL_FIRST, fix: 'take-control' }
        : { reason: access.recallReason ?? 'Memories are not available.' };
    return {
      id: `memory:${memory.memoryId}`,
      group: 'Memories',
      icon: 'pin',
      title: `Recall ${summary.name}`,
      value: `${summary.frequency} ${summary.mode}`,
      subtitle: summary.detail,
      hint: memory.memoryId === activeId ? 'Active' : 'Recall',
      keywords: [summary.name, summary.frequency, summary.band, 'memory'],
      action: {
        type: 'recall',
        radioId: radio.radioId,
        memoryId: memory.memoryId,
        name: summary.name,
      },
      ...(blocked ? { blocked } : {}),
    };
  });
}

/** "Select <radio>" for every radio. Selecting never retunes. */
export function radioCommands(context: PaletteContext): PaletteCommand[] {
  return context.radios.map((radio) => {
    const current = radio.radioId === context.selected?.radioId;
    const status = connectionPresentation(radio).label;
    const tuning = radio.snapshot?.observedTuning;
    return {
      id: `radio:${radio.radioId}`,
      group: 'Radios',
      icon: 'radio',
      title: `Select ${radio.displayName}`,
      subtitle: tuning ? `${status} · ${formatTuning(tuning)}` : status,
      hint: current ? 'Selected' : 'Select',
      keywords: [radio.displayName, 'radio'],
      action: {
        type: 'select-radio',
        radioId: radio.radioId,
        radioName: radio.displayName,
      },
      ...(current
        ? { blocked: { reason: `${radio.displayName} is already selected.` } }
        : {}),
    };
  });
}

/** "Go to <section>" for every workspace section. */
export function sectionCommands(context: PaletteContext): PaletteCommand[] {
  return context.sections.map((section) => ({
    id: `section:${section.key}`,
    group: 'Go to',
    icon: section.icon,
    title: `Go to ${section.label}`,
    ...(section.key === context.currentSection ? { hint: 'Current' } : {}),
    keywords: [section.label, section.key],
    action: { type: 'navigate', section: section.key, label: section.label },
  }));
}

/** Take or release control of the selected radio. */
export function controlCommands(context: PaletteContext): PaletteCommand[] {
  const radio = context.selected;
  if (!radio) return [];
  const radioName = radio.displayName;
  const keywords = ['control', 'lease'];
  if (context.controlState === 'mine')
    return [
      {
        id: 'release-control',
        group: 'Control',
        icon: 'lock',
        title: `Release control of ${radioName}`,
        keywords,
        action: { type: 'release-control', radioId: radio.radioId, radioName },
        ...(context.busy ? { blocked: { reason: BUSY } } : {}),
      },
    ];
  const reason = !context.canControl
    ? 'You can listen to this radio but not control it.'
    : context.controlState === 'available'
      ? context.busy
        ? BUSY
        : undefined
      : context.controlOwnerLabel ||
        (context.controlState === 'other'
          ? 'Another session has control of this radio.'
          : 'Control is not available right now.');
  return [
    {
      id: 'take-control',
      group: 'Control',
      icon: 'lock',
      title: `Take control of ${radioName}`,
      ...(context.controlState === 'available' && context.controlOwnerLabel
        ? { subtitle: context.controlOwnerLabel }
        : {}),
      keywords,
      action: { type: 'take-control', radioId: radio.radioId, radioName },
      ...(reason ? { blocked: { reason } } : {}),
    },
  ];
}

/** Start or stop listening to the selected radio. */
export function listeningCommands(context: PaletteContext): PaletteCommand[] {
  const radio = context.selected;
  const media = context.media;
  if (!radio || !media) return [];
  const radioName = radio.displayName;
  const keywords = ['toggle listening', 'audio', 'headphones', 'receive'];
  if (media.listening)
    return [
      {
        id: 'stop-listening',
        group: 'Audio',
        icon: 'headphones',
        title: `Stop listening to ${radioName}`,
        keywords,
        action: { type: 'stop-listening', radioId: radio.radioId, radioName },
      },
    ];
  const reason = !media.supported
    ? 'Live audio is available in the web app for now.'
    : !media.configured
      ? 'Live audio is not configured on this server.'
      : media.canListen
        ? undefined
        : media.listenReason || 'Listening is not available right now.';
  return [
    {
      id: 'listen',
      group: 'Audio',
      icon: 'headphones',
      title: `Listen to ${radioName}`,
      keywords,
      action: { type: 'listen', radioId: radio.radioId, radioName },
      ...(reason ? { blocked: { reason } } : {}),
    },
  ];
}

const priorityLabels: Record<IncidentRecord['priority'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const stateLabels: Record<IncidentRecord['state'], string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

/** Open incidents by title. */
export function incidentCommands(context: PaletteContext): PaletteCommand[] {
  return context.incidents.map((incident) => {
    const radio = context.radios.find(
      (item) => item.radioId === incident.radioId,
    );
    return {
      id: `incident:${incident.id}`,
      group: 'Incidents',
      icon: 'alert',
      title: incident.title,
      subtitle: [
        `${priorityLabels[incident.priority]} priority`,
        stateLabels[incident.state],
        ...(radio ? [radio.displayName] : []),
      ].join(' · '),
      hint: 'Incident',
      keywords: ['incident'],
      action: {
        type: 'open-incident',
        incidentId: incident.id,
        title: incident.title,
      },
    };
  });
}

/** Every command for the current state, in default (empty query) order. */
export function buildCommands(
  query: string,
  context: PaletteContext,
): PaletteCommand[] {
  const tune = frequencyCommand(query, context);
  return [
    ...(tune ? [tune] : []),
    ...controlCommands(context),
    ...listeningCommands(context),
    ...memoryCommands(context),
    ...radioCommands(context),
    ...sectionCommands(context),
    ...incidentCommands(context),
  ];
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* -------------------------------------------------------------------------- */

/** Lower case, no diacritics, single spaces. */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How well `query` matches `text` (higher is better), or undefined for no
 * match. Exact > prefix > word prefix > every word matches > substring >
 * in-order characters (denser runs score higher).
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = normalizeSearch(query);
  const t = normalizeSearch(text);
  if (!q) return 0;
  if (!t) return undefined;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900;
  const words = t.split(/[\s·,:/()-]+/).filter(Boolean);
  if (words.some((word) => word.startsWith(q))) return 800;
  const tokens = q.split(' ');
  if (
    tokens.length > 1 &&
    tokens.every((token) => words.some((word) => word.startsWith(token)))
  )
    return 700;
  const index = t.indexOf(q);
  if (index >= 0) return 600 - Math.min(index, 100);
  // In-order characters (spaces in the query are ignored).
  const chars = q.replace(/ /g, '');
  let position = -1;
  let gaps = 0;
  for (const char of chars) {
    const next = t.indexOf(char, position + 1);
    if (next < 0) return undefined;
    if (position >= 0) gaps += next - position - 1;
    position = next;
  }
  return Math.max(1, 300 - gaps * 10);
}

/** Below an enabled match of the same quality, above weaker ones. */
const BLOCKED_PENALTY = 60;
/** Keywords count a little less than the visible title. */
const KEYWORD_PENALTY = 40;
const PINNED_BONUS = 10_000;

/** A command's best match for `query`, or undefined. */
export function commandScore(
  command: PaletteCommand,
  query: string,
): number | undefined {
  if (command.pinned) return PINNED_BONUS;
  const visible = command.value
    ? `${command.title} ${command.value}`
    : command.title;
  const scores = [
    fuzzyScore(query, visible),
    command.value === undefined ? undefined : fuzzyScore(query, command.value),
    ...command.keywords.map((keyword) => {
      const score = fuzzyScore(query, keyword);
      return score === undefined ? undefined : score - KEYWORD_PENALTY;
    }),
  ].filter((score): score is number => score !== undefined);
  if (!scores.length) return undefined;
  const best = Math.max(...scores);
  return command.blocked ? best - BLOCKED_PENALTY : best;
}

export const PALETTE_RESULT_LIMIT = 12;
/** Groups shown with an empty query, in order. */
const DEFAULT_GROUPS: readonly PaletteGroup[] = [
  'Control',
  'Audio',
  'Memories',
  'Go to',
  'Radios',
];
/** Memories shown with an empty query. */
const DEFAULT_MEMORIES = 4;

/**
 * Ranked results for `query`. An empty query lists the runnable quick actions
 * (control, audio, a few memories, sections, radios); incidents and blocked
 * commands appear only when they match typed text.
 */
export function rankCommands(
  commands: readonly PaletteCommand[],
  query: string,
  limit = PALETTE_RESULT_LIMIT,
): PaletteCommand[] {
  if (!normalizeSearch(query)) {
    let memories = 0;
    return DEFAULT_GROUPS.flatMap((group) =>
      commands.filter((command) => {
        if (command.group !== group || command.blocked) return false;
        if (group !== 'Memories') return true;
        memories += 1;
        return memories <= DEFAULT_MEMORIES;
      }),
    ).slice(0, limit);
  }
  return commands
    .map((command, index) => ({
      command,
      index,
      score: commandScore(command, query),
    }))
    .filter(
      (
        item,
      ): item is { command: PaletteCommand; index: number; score: number } =>
        item.score !== undefined,
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.command);
}

/** Commands for `query`, ranked. */
export function paletteResults(
  query: string,
  context: PaletteContext,
  limit = PALETTE_RESULT_LIMIT,
): PaletteCommand[] {
  return rankCommands(buildCommands(query, context), query, limit);
}

/** Next highlighted row for ↑/↓ (wraps around). */
export function moveHighlight(
  index: number,
  direction: 1 | -1,
  count: number,
): number {
  if (count <= 0) return 0;
  return (((index + direction) % count) + count) % count;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type PaletteToastTone = 'neutral' | 'success' | 'error' | 'warning';
export interface PaletteToast {
  message: string;
  tone: PaletteToastTone;
  /** Offer this fix as the toast's action. */
  fix?: PaletteFix;
  /** Radio the fix applies to; the action is refused if the selection moved. */
  radioId?: string;
}

/** Toast for a station operation result. A request still waiting is not a success. */
export function operationToast(
  result: { ok: true; message: string } | { ok: false; error: string },
): PaletteToast {
  if (!result.ok) return { message: result.error, tone: 'error' };
  return {
    message: result.message,
    tone: /waiting/i.test(result.message) ? 'neutral' : 'success',
  };
}

/** Toast explaining why a blocked command did not run. */
export function blockedToast(command: PaletteCommand): PaletteToast {
  const reason = command.blocked?.reason ?? 'This command is not available.';
  const radioId =
    command.action && 'radioId' in command.action
      ? command.action.radioId
      : undefined;
  return {
    message: reason,
    tone: 'warning',
    // A fix is only offered for a known radio, so it cannot land elsewhere.
    ...(command.blocked?.fix && radioId
      ? { fix: command.blocked.fix, radioId }
      : {}),
  };
}

/** Accessible label of a result row. */
export function commandLabel(command: PaletteCommand): string {
  return [
    command.value ? `${command.title} ${command.value}` : command.title,
    command.subtitle,
    command.blocked ? `Unavailable: ${command.blocked.reason}` : undefined,
  ]
    .filter(Boolean)
    .join('. ');
}

/* -------------------------------------------------------------------------- */
/* Incidents                                                                  */
/* -------------------------------------------------------------------------- */

export const OPEN_INCIDENT_STATES = [
  'new',
  'acknowledged',
  'in_progress',
] as const satisfies readonly IncidentRecord['state'][];
export const PALETTE_INCIDENT_LIMIT = 20;

/** Open incidents from several lists: deduplicated, newest update first, top `limit`. */
export function mergeOpenIncidents(
  lists: readonly (readonly IncidentRecord[])[],
  limit = PALETTE_INCIDENT_LIMIT,
): IncidentRecord[] {
  const open = new Set<string>(OPEN_INCIDENT_STATES);
  const byId = new Map<string, IncidentRecord>();
  for (const incident of lists.flat()) {
    if (!open.has(incident.state)) continue;
    const previous = byId.get(incident.id);
    if (!previous || previous.revision < incident.revision)
      byId.set(incident.id, incident);
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
    )
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Keyboard shortcut                                                          */
/* -------------------------------------------------------------------------- */

export interface ShortcutKeyEvent {
  /** Undefined on synthetic events (autofill, some IMEs and extensions). */
  key: string | undefined;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
export interface ShortcutTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);
/** The keyboard focus is somewhere the operator types text. */
export function isTypingTarget(target: ShortcutTarget | null | undefined) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase());
}

/**
 * ⌘K / Ctrl+K: opens the palette, or closes it when it is open. Ignored while
 * the operator types in another field.
 */
export function paletteShortcut(
  event: ShortcutKeyEvent,
  state: { open: boolean; target: ShortcutTarget | null | undefined },
): 'open' | 'close' | undefined {
  if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'k')
    return undefined;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
    return undefined;
  if (state.open) return 'close';
  if (isTypingTarget(state.target)) return undefined;
  return 'open';
}

/** '⌘K' on Apple platforms, 'Ctrl K' elsewhere. */
export function shortcutLabel(platform: string | undefined): string {
  return platform && /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K';
}
