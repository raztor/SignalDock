import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETUP_FLAGS,
  currentSetupStep,
  parseSetupFlags,
  serializeSetupFlags,
  setupProgress,
  setupSteps,
  setupStorageKey,
  showSetupChecklist,
  type SetupFlags,
  type SetupInput,
} from './setup-checklist-model';

const input = (patch: Partial<SetupInput> = {}): SetupInput => ({
  configurations: 0,
  assigned: false,
  mediaConfigured: true,
  mediaSupported: true,
  flags: { ...DEFAULT_SETUP_FLAGS },
  ...patch,
});
const flags = (patch: Partial<SetupFlags>): SetupFlags => ({
  ...DEFAULT_SETUP_FLAGS,
  ...patch,
});
const statuses = (value: SetupInput) =>
  setupSteps(value).map((entry) => entry.status);

describe('setupSteps', () => {
  it('starts with every step to do', () => {
    expect(statuses(input())).toEqual(['todo', 'todo', 'todo']);
    expect(setupSteps(input()).map((entry) => entry.title)).toEqual([
      'Configure a radio',
      'Assign radio access',
      'Test live audio',
    ]);
  });

  it('marks loading data as checking', () => {
    expect(
      statuses(input({ configurations: undefined, assigned: undefined })),
    ).toEqual(['checking', 'checking', 'todo']);
  });

  it('completes steps from station data and local flags', () => {
    expect(
      statuses(
        input({
          configurations: 2,
          assigned: true,
          flags: flags({ listened: true }),
        }),
      ),
    ).toEqual(['done', 'done', 'done']);
    expect(setupSteps(input({ configurations: 2 }))[0]?.description).toBe(
      '2 radios configured.',
    );
  });

  it('lets access and audio be skipped, but not configuration', () => {
    const steps = setupSteps(
      input({ flags: flags({ accessSkipped: true, audioSkipped: true }) }),
    );
    expect(steps.map((entry) => entry.status)).toEqual([
      'todo',
      'skipped',
      'skipped',
    ]);
    expect(steps[0]?.skippable).toBe(false);
    expect(setupSteps(input())[1]?.skippable).toBe(true);
    expect(steps[1]?.skippable).toBe(false);
  });

  it('needs live audio on the server to count a listen', () => {
    const steps = setupSteps(
      input({ mediaConfigured: false, flags: flags({ listened: true }) }),
    );
    expect(steps[2]?.status).toBe('todo');
    expect(steps[2]?.description).toContain('not enabled');
  });

  it('explains the web-only live audio', () => {
    expect(
      setupSteps(input({ mediaSupported: false }))[2]?.description,
    ).toContain('web client');
  });

  it('pairs each status with text', () => {
    for (const entry of setupSteps(
      input({ configurations: 1, flags: flags({ audioSkipped: true }) }),
    ))
      expect(entry.statusLabel.length).toBeGreaterThan(0);
  });
});

describe('progress and visibility', () => {
  it('counts done and skipped steps', () => {
    const steps = setupSteps(
      input({ configurations: 1, flags: flags({ audioSkipped: true }) }),
    );
    expect(setupProgress(steps)).toEqual({
      resolved: 2,
      total: 3,
      complete: false,
      label: '2 of 3 done',
    });
    expect(currentSetupStep(steps)).toBe(1);
  });

  it('is shown only to administrators with incomplete setup', () => {
    const steps = setupSteps(input());
    const base = {
      administrator: true,
      flagsLoaded: true,
      flags: DEFAULT_SETUP_FLAGS,
      steps,
    };
    expect(showSetupChecklist(base)).toBe(true);
    expect(showSetupChecklist({ ...base, administrator: false })).toBe(false);
    expect(showSetupChecklist({ ...base, flagsLoaded: false })).toBe(false);
    expect(
      showSetupChecklist({ ...base, flags: flags({ dismissed: true }) }),
    ).toBe(false);
    const done = setupSteps(
      input({
        configurations: 1,
        assigned: true,
        flags: flags({ listened: true }),
      }),
    );
    expect(showSetupChecklist({ ...base, steps: done })).toBe(false);
    expect(currentSetupStep(done)).toBe(-1);
  });

  it('waits for the first answer before showing', () => {
    expect(
      showSetupChecklist({
        administrator: true,
        flagsLoaded: true,
        flags: DEFAULT_SETUP_FLAGS,
        steps: setupSteps(input({ configurations: undefined })),
      }),
    ).toBe(false);
  });

  it('shows a failed first check so it can be retried', () => {
    expect(
      showSetupChecklist({
        administrator: true,
        flagsLoaded: true,
        flags: DEFAULT_SETUP_FLAGS,
        steps: setupSteps(
          input({ configurations: undefined, assigned: undefined }),
        ),
        error: 'The server is unavailable.',
      }),
    ).toBe(true);
  });
});

describe('flag storage', () => {
  it('round-trips flags', () => {
    const value = flags({ dismissed: true, listened: true });
    expect(parseSetupFlags(serializeSetupFlags(value))).toEqual(value);
  });

  it('falls back to defaults for malformed data', () => {
    expect(parseSetupFlags(null)).toEqual(DEFAULT_SETUP_FLAGS);
    expect(parseSetupFlags('not json')).toEqual(DEFAULT_SETUP_FLAGS);
    expect(parseSetupFlags('[]')).toEqual(DEFAULT_SETUP_FLAGS);
    expect(parseSetupFlags('{"dismissed":"yes"}')).toEqual(DEFAULT_SETUP_FLAGS);
  });

  it('scopes the key by station and account', () => {
    expect(setupStorageKey('i1', 'u1')).toBe('signaldock.setup.i1.u1');
  });
});
