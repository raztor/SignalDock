import { describe, expect, it } from 'vitest';
import {
  LEVEL_POLL_MS,
  LEVEL_REDUCED_POLL_MS,
  LEVEL_SEGMENTS,
  clampLevel,
  levelDescription,
  levelPollInterval,
  litSegments,
  segmentZone,
  smoothLevel,
} from './level-model';

describe('level meter model', () => {
  it('clamps levels to 0..1', () => {
    expect(clampLevel(-1)).toBe(0);
    expect(clampLevel(2)).toBe(1);
    expect(clampLevel(Number.NaN)).toBe(0);
    expect(clampLevel(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampLevel(0.3)).toBe(0.3);
  });

  it('lights segments proportionally with silence at zero', () => {
    expect(litSegments(0)).toBe(0);
    expect(litSegments(0.02)).toBe(0);
    expect(litSegments(0.04)).toBe(1);
    expect(litSegments(0.5)).toBe(10);
    expect(litSegments(1)).toBe(LEVEL_SEGMENTS);
    expect(litSegments(5)).toBe(LEVEL_SEGMENTS);
    expect(litSegments(0.5, 10)).toBe(5);
    expect(litSegments(0.5, 0)).toBe(0);
  });

  it('marks the top segments as hot', () => {
    expect(segmentZone(0)).toBe('normal');
    expect(segmentZone(16)).toBe('normal');
    expect(segmentZone(17)).toBe('hot');
    expect(segmentZone(19)).toBe('hot');
    expect(segmentZone(4, 5)).toBe('hot');
    expect(segmentZone(3, 5)).toBe('normal');
  });

  it('attacks instantly and releases linearly', () => {
    expect(smoothLevel(0.2, 0.8, 66)).toBe(0.8);
    expect(smoothLevel(0.8, 0, 100)).toBeCloseTo(0.65);
    expect(smoothLevel(0.8, 0.7, 1000)).toBe(0.7);
    expect(smoothLevel(0.8, 0, -50)).toBe(0.8);
    expect(smoothLevel(Number.NaN, 0.5, 66)).toBe(0.5);
  });

  it('polls slower with reduced motion', () => {
    expect(levelPollInterval(false)).toBe(LEVEL_POLL_MS);
    expect(levelPollInterval(true)).toBe(LEVEL_REDUCED_POLL_MS);
    expect(1000 / LEVEL_POLL_MS).toBeGreaterThan(14);
    expect(1000 / LEVEL_REDUCED_POLL_MS).toBe(2);
  });

  it('describes the meter state', () => {
    expect(levelDescription(0.5, false, true)).toBe('Not listening');
    expect(levelDescription(0.5, true, false)).toBe('Level unavailable');
    expect(levelDescription(0.5, true, true)).toBe('Receiving audio');
    expect(levelDescription(0.01, true, true)).toBe('Silent');
  });
});
