/**
 * Pure helpers for the received-audio level meter. Levels are 0..1 as reported
 * by `RadioMediaController.rxLevel()`. Plain TypeScript for node tests.
 */

export const LEVEL_SEGMENTS = 20;
/** Levels at or above this read as "Receiving audio". */
export const LEVEL_SIGNAL_THRESHOLD = 0.04;
/** Poll interval while animating (~15 Hz) and with reduced motion (2 Hz). */
export const LEVEL_POLL_MS = 66;
export const LEVEL_REDUCED_POLL_MS = 500;
/** How fast the displayed level falls back, in full scales per second. */
export const LEVEL_RELEASE_PER_SECOND = 1.5;
/** Share of the top segments drawn in the "hot" tone. */
const HOT_SHARE = 0.15;

export type LevelZone = 'normal' | 'hot';

export function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

/** Number of lit segments for a level (0..count). */
export function litSegments(level: number, count = LEVEL_SEGMENTS): number {
  const segments = Math.max(0, Math.floor(count));
  const value = clampLevel(level);
  if (value < LEVEL_SIGNAL_THRESHOLD) return 0;
  return Math.min(segments, Math.max(1, Math.round(value * segments)));
}

/** Zone of a segment by index (0 = left/lowest). */
export function segmentZone(index: number, count = LEVEL_SEGMENTS): LevelZone {
  const hot = Math.max(1, Math.round(count * HOT_SHARE));
  return index >= count - hot ? 'hot' : 'normal';
}

/** Instant attack, linear release so the meter does not flicker. */
export function smoothLevel(
  previous: number,
  target: number,
  elapsedMs: number,
  releasePerSecond = LEVEL_RELEASE_PER_SECOND,
): number {
  const next = clampLevel(target);
  const current = clampLevel(previous);
  if (next >= current) return next;
  const fall = (Math.max(0, elapsedMs) / 1000) * Math.max(0, releasePerSecond);
  return Math.max(next, current - fall);
}

export function levelPollInterval(reducedMotion: boolean): number {
  return reducedMotion ? LEVEL_REDUCED_POLL_MS : LEVEL_POLL_MS;
}

/** Spoken/visible description of the meter state. */
export function levelDescription(
  level: number,
  listening: boolean,
  measurable: boolean,
): string {
  if (!listening) return 'Not listening';
  if (!measurable) return 'Level unavailable';
  return clampLevel(level) >= LEVEL_SIGNAL_THRESHOLD
    ? 'Receiving audio'
    : 'Silent';
}
