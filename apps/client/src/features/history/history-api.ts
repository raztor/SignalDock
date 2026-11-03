import { apiRequest } from '@signaldock/client-sdk';
import type {
  ClientSession,
  Communication,
  Conversation,
  CoverageInterval,
} from '@signaldock/contracts';
import {
  WAVEFORM_POINTS,
  errorMessage,
  isMissingRoute,
  parseActivity,
  parseCoverage,
  parseWaveform,
  type ActivityData,
  type PageCursor,
  type WaveformData,
} from './history-model';

export interface CommunicationPage {
  items: Communication[];
  nextCursor?: PageCursor;
}

/** Route paths, relative to the instance's api/v1 prefix. */
export const HISTORY_ROUTES = {
  conversations: 'conversations',
  /** Existing coverage list: `{ items: CoverageInterval[] }`. */
  coverage: (radioId: string) => `radios/${radioId}/coverage`,
  /** Peaks (0..1) and duration for one communication's recording. */
  waveform: (communicationId: string, points: number) =>
    `communications/${communicationId}/waveform?points=${points}`,
} as const;

export function fetchCommunications(
  session: ClientSession,
  path: string,
  signal: AbortSignal,
): Promise<CommunicationPage> {
  return apiRequest<CommunicationPage>(session, path, { signal });
}

export async function fetchConversations(
  session: ClientSession,
  signal: AbortSignal,
): Promise<Conversation[]> {
  const result = await apiRequest<{ items: Conversation[] }>(
    session,
    HISTORY_ROUTES.conversations,
    { signal },
  );
  return result.items;
}

export type OptionalResult<T> =
  | { status: 'ready'; data: T }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

/** `GET history/activity`; a missing route degrades to `unsupported`. */
export async function fetchActivity(
  session: ClientSession,
  path: string,
  signal: AbortSignal,
): Promise<OptionalResult<ActivityData>> {
  try {
    const data = parseActivity(
      await apiRequest<unknown>(session, path, { signal }),
    );
    return data
      ? { status: 'ready', data }
      : { status: 'error', message: 'Activity data was not understood.' };
  } catch (failure) {
    if (signal.aborted) throw failure;
    return isMissingRoute(failure)
      ? { status: 'unsupported' }
      : {
          status: 'error',
          message: errorMessage(failure, 'Activity could not be loaded.'),
        };
  }
}

/** Coverage intervals for one radio; failures hide gap rows. */
export async function fetchCoverage(
  session: ClientSession,
  radioId: string,
  signal: AbortSignal,
): Promise<OptionalResult<CoverageInterval[]>> {
  try {
    const data = parseCoverage(
      await apiRequest<unknown>(session, HISTORY_ROUTES.coverage(radioId), {
        signal,
      }),
    );
    return data
      ? { status: 'ready', data }
      : { status: 'error', message: 'Coverage data was not understood.' };
  } catch (failure) {
    if (signal.aborted) throw failure;
    return isMissingRoute(failure)
      ? { status: 'unsupported' }
      : {
          status: 'error',
          message: errorMessage(failure, 'Coverage could not be loaded.'),
        };
  }
}

const WAVEFORM_CONCURRENCY = 4;

/**
 * Loads waveform peaks once per communication for the workspace lifetime,
 * at most four at a time. Resolves `null` when there is nothing to draw
 * (empty peaks, missing route, or any failure): rows then show a flat
 * duration bar.
 */
export class WaveformLoader {
  private readonly cache = new Map<string, Promise<WaveformData | null>>();
  private readonly controller = new AbortController();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  /** Set once the server answers that the route does not exist. */
  private unsupported = false;

  constructor(
    private readonly session: ClientSession,
    private readonly points = WAVEFORM_POINTS,
  ) {}

  load(communicationId: string): Promise<WaveformData | null> {
    let result = this.cache.get(communicationId);
    if (!result) {
      result = this.slot(() => this.fetch(communicationId)).catch(() => null);
      this.cache.set(communicationId, result);
    }
    return result;
  }

  dispose(): void {
    this.controller.abort();
    this.waiting.splice(0).forEach((resume) => resume());
  }

  private async slot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= WAVEFORM_CONCURRENCY)
      await new Promise<void>((resume) => this.waiting.push(resume));
    this.active++;
    try {
      return await run();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async fetch(id: string): Promise<WaveformData | null> {
    if (this.unsupported || this.controller.signal.aborted) return null;
    try {
      const data = parseWaveform(
        await apiRequest<unknown>(
          this.session,
          HISTORY_ROUTES.waveform(id, this.points),
          { signal: this.controller.signal },
        ),
      );
      return data && data.peaks.length ? data : null;
    } catch (failure) {
      if (!this.controller.signal.aborted && isMissingRoute(failure))
        this.unsupported = true;
      return null;
    }
  }
}
