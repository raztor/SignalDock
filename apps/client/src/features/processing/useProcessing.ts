import type { ClientSession } from '@signaldock/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_PROCESSING_DATA,
  fetchJobs,
  loadProcessingData,
  type ProcessingData,
} from './processing-api';
import { errorMessage, hasActiveJobs, JOB_POLL_MS } from './processing-model';

export const ACTION_TIMEOUT_MS = 40_000;

export interface RunOptions {
  /** Extra cancellation (for example the user's Stop button). */
  signal?: AbortSignal;
  /** Reload everything after a successful action (default true). */
  reload?: boolean;
}

export interface ProcessingController {
  data: ProcessingData;
  loaded: boolean;
  /** Last error from loading or an action (shown as an alert). */
  status: string;
  clearStatus(): void;
  busy: boolean;
  /**
   * Runs one action at a time. Results from a previous session/radio are
   * ignored, and session changes abort the action. Resolves true on success.
   */
  run(
    action: (signal: AbortSignal) => Promise<void>,
    options?: RunOptions,
  ): Promise<boolean>;
  reload(): void;
}

/**
 * Data and action runner for the Processing screen. Changing the session or
 * radio aborts pending requests and clears private results.
 */
export function useProcessing(
  session: ClientSession,
  radioId: string | undefined,
  administrator: boolean,
  active: boolean,
): ProcessingController {
  const [data, setData] = useState<ProcessingData>(EMPTY_PROCESSING_DATA);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const scope = useRef(new AbortController());
  const generation = useRef(0);
  const busyRef = useRef(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const current = generation.current;
      const next = await loadProcessingData(
        session,
        radioId,
        administrator,
        signal,
      );
      if (current !== generation.current) return;
      setData(next);
      setLoaded(true);
    },
    [session, radioId, administrator],
  );

  useEffect(() => {
    const controller = new AbortController();
    scope.current.abort();
    scope.current = controller;
    generation.current++;
    setData(EMPTY_PROCESSING_DATA);
    setLoaded(false);
    setStatus('');
    busyRef.current = false;
    setBusy(false);
    void load(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setStatus(errorMessage(error));
    });
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [load]);

  const run = useCallback(
    async (
      action: (signal: AbortSignal) => Promise<void>,
      options: RunOptions = {},
    ) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      const current = generation.current;
      const owner = scope.current;
      const signal = AbortSignal.any([
        owner.signal,
        AbortSignal.timeout(ACTION_TIMEOUT_MS),
        ...(options.signal ? [options.signal] : []),
      ]);
      let ok = false;
      try {
        setStatus('');
        await action(signal);
        ok = true;
        if (options.reload !== false && current === generation.current)
          await load(signal);
      } catch (error) {
        if (current === generation.current && !owner.signal.aborted)
          setStatus(errorMessage(error));
      } finally {
        if (current === generation.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
      return ok && current === generation.current;
    },
    [load],
  );

  const reload = useCallback(() => {
    void run(async () => undefined);
  }, [run]);

  // Poll only the job list while jobs are in flight and the screen is visible.
  const polling = active && hasActiveJobs(data.jobs);
  useEffect(() => {
    if (!polling) return;
    const owner = scope.current;
    const current = generation.current;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || owner.signal.aborted) return;
      inFlight = true;
      void fetchJobs(session, owner.signal)
        .then((jobs) => {
          if (current === generation.current)
            setData((previous) => ({ ...previous, jobs }));
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, session]);

  const clearStatus = useCallback(() => setStatus(''), []);
  return { data, loaded, status, clearStatus, busy, run, reload };
}
