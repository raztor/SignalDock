/**
 * Pure model for the administrator setup checklist shown on the Radios
 * screen. Node-safe (no React Native imports).
 */

export type SetupStepId = 'configure' | 'assign' | 'audio';
export type SetupStepStatus = 'done' | 'skipped' | 'todo' | 'checking';

/** Local, per-device flags (stored per station instance and account). */
export interface SetupFlags {
  dismissed: boolean;
  accessSkipped: boolean;
  audioSkipped: boolean;
  /** Live audio was listened to at least once from this device. */
  listened: boolean;
}

export const DEFAULT_SETUP_FLAGS: SetupFlags = {
  dismissed: false,
  accessSkipped: false,
  audioSkipped: false,
  listened: false,
};

export const SETUP_STORAGE_PREFIX = 'signaldock.setup';

export function setupStorageKey(instanceId: string, userId: string): string {
  return `${SETUP_STORAGE_PREFIX}.${instanceId}.${userId}`;
}

/** Parses stored flags; anything malformed falls back to the defaults. */
export function parseSetupFlags(raw: string | null | undefined): SetupFlags {
  if (!raw) return { ...DEFAULT_SETUP_FLAGS };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { ...DEFAULT_SETUP_FLAGS };
    const record = value as Record<string, unknown>;
    const flag = (key: keyof SetupFlags) => record[key] === true;
    return {
      dismissed: flag('dismissed'),
      accessSkipped: flag('accessSkipped'),
      audioSkipped: flag('audioSkipped'),
      listened: flag('listened'),
    };
  } catch {
    return { ...DEFAULT_SETUP_FLAGS };
  }
}

export function serializeSetupFlags(flags: SetupFlags): string {
  return JSON.stringify(flags);
}

export interface SetupInput {
  /** Number of radio configurations; undefined while loading or unknown. */
  configurations: number | undefined;
  /** Some non-administrator holds a radio grant; undefined while loading. */
  assigned: boolean | undefined;
  /** The server advertises live audio. */
  mediaConfigured: boolean;
  /** This platform can run live audio (web). */
  mediaSupported: boolean;
  flags: SetupFlags;
}

export interface SetupStep {
  id: SetupStepId;
  title: string;
  description: string;
  status: SetupStepStatus;
  /** Text paired with the status mark (never colour alone). */
  statusLabel: string;
  /** The step can be skipped by the administrator. */
  skippable: boolean;
}

const STATUS_LABELS: Record<SetupStepStatus, string> = {
  done: 'Done',
  skipped: 'Skipped',
  todo: 'To do',
  checking: 'Checking…',
};

function step(
  id: SetupStepId,
  title: string,
  description: string,
  status: SetupStepStatus,
  skippable: boolean,
): SetupStep {
  return {
    id,
    title,
    description,
    status,
    statusLabel: STATUS_LABELS[status],
    skippable: skippable && status === 'todo',
  };
}

export function setupSteps(input: SetupInput): SetupStep[] {
  const { flags } = input;
  const configure = step(
    'configure',
    'Configure a radio',
    input.configurations === undefined
      ? 'Checking the station’s radio configurations.'
      : input.configurations > 0
        ? `${input.configurations} radio${
            input.configurations === 1 ? '' : 's'
          } configured.`
        : 'Add a radio driver and its connection in the radio configuration section on this screen.',
    input.configurations === undefined
      ? 'checking'
      : input.configurations > 0
        ? 'done'
        : 'todo',
    false,
  );
  const assign = step(
    'assign',
    'Assign radio access',
    input.assigned
      ? 'At least one non-administrator can use a radio.'
      : flags.accessSkipped
        ? 'Skipped. You can assign access later in Users & access.'
        : 'Give operators and listeners access to radios in Users & access. Configuring a radio does not grant operational access.',
    input.assigned
      ? 'done'
      : flags.accessSkipped
        ? 'skipped'
        : input.assigned === undefined
          ? 'checking'
          : 'todo',
    true,
  );
  const audioDescription = !input.mediaConfigured
    ? 'Live audio is not enabled on this server.'
    : !input.mediaSupported
      ? 'Live audio runs in the web client. Open the station in a browser to test it.'
      : flags.listened
        ? 'Live audio was received on this device.'
        : 'Select a radio you can listen to, then start listening to confirm audio arrives.';
  const audio = step(
    'audio',
    'Test live audio',
    flags.audioSkipped && !(input.mediaConfigured && flags.listened)
      ? `Skipped. ${audioDescription}`
      : audioDescription,
    input.mediaConfigured && flags.listened
      ? 'done'
      : flags.audioSkipped
        ? 'skipped'
        : 'todo',
    true,
  );
  return [configure, assign, audio];
}

export interface SetupProgress {
  /** Steps done or skipped. */
  resolved: number;
  total: number;
  complete: boolean;
  label: string;
}

export function setupProgress(steps: readonly SetupStep[]): SetupProgress {
  const resolved = steps.filter(
    (entry) => entry.status === 'done' || entry.status === 'skipped',
  ).length;
  return {
    resolved,
    total: steps.length,
    complete: resolved === steps.length,
    label: `${resolved} of ${steps.length} done`,
  };
}

/** Index of the first unresolved step (the current one), or -1. */
export function currentSetupStep(steps: readonly SetupStep[]): number {
  return steps.findIndex(
    (entry) => entry.status === 'todo' || entry.status === 'checking',
  );
}

export function showSetupChecklist(input: {
  administrator: boolean;
  flagsLoaded: boolean;
  flags: SetupFlags;
  steps: readonly SetupStep[];
  /** The last progress check failed; the card shows it with "Check again". */
  error?: string | undefined;
}): boolean {
  if (!input.administrator || !input.flagsLoaded || input.flags.dismissed)
    return false;
  // Wait for the first answer so a finished setup never flashes the card,
  // unless that answer was an error the administrator needs to see.
  if (!input.error && input.steps.some((entry) => entry.status === 'checking'))
    return false;
  return !setupProgress(input.steps).complete;
}
