import { describe, expect, it, vi } from 'vitest';
import {
  createPttKeyboardRelease,
  isPttKey,
  type PttKeyEvent,
  type PttKeyTarget,
} from './ptt-keyboard';

interface FakeKeyEvent extends PttKeyEvent {
  /** Where the event landed; the tracker must not care. */
  target: { tagName: string; role?: string };
}

function fakeDocument() {
  const listeners = new Set<(event: PttKeyEvent) => void>();
  const target: PttKeyTarget = {
    addEventListener: (_type, listener, capture) => {
      expect(capture).toBe(true);
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  const keyup = (event: FakeKeyEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { target, keyup, listeners };
}

describe('PTT keyboard release', () => {
  it('recognises Space and Enter only', () => {
    expect(isPttKey(' ')).toBe(true);
    expect(isPttKey('Spacebar')).toBe(true);
    expect(isPttKey('Enter')).toBe(true);
    expect(isPttKey('a')).toBe(false);
    expect(isPttKey('Tab')).toBe(false);
    expect(isPttKey(undefined)).toBe(false);
  });

  it('stops TX on keyup even when the target is not a button', () => {
    const doc = fakeDocument();
    const stopTransmit = vi.fn();
    const tracker = createPttKeyboardRelease(doc.target, stopTransmit);
    tracker.keyDown({ key: ' ' });
    expect(tracker.held).toBe(true);
    // Focus moved to a text input (or body) while Space was held.
    doc.keyup({ key: 'Tab', target: { tagName: 'input' } });
    expect(stopTransmit).not.toHaveBeenCalled();
    doc.keyup({ key: ' ', target: { tagName: 'input' } });
    expect(stopTransmit).toHaveBeenCalledTimes(1);
    expect(tracker.held).toBe(false);
    expect(doc.listeners.size).toBe(0);
    doc.keyup({ key: ' ', target: { tagName: 'body' } });
    expect(stopTransmit).toHaveBeenCalledTimes(1);
  });

  it('stops on Enter released on a tab item', () => {
    const doc = fakeDocument();
    const stopTransmit = vi.fn();
    const tracker = createPttKeyboardRelease(doc.target, stopTransmit);
    tracker.keyDown({ key: 'Enter' });
    doc.keyup({ key: 'Enter', target: { tagName: 'div', role: 'tab' } });
    expect(stopTransmit).toHaveBeenCalledTimes(1);
  });

  it('ignores auto-repeat and other keys', () => {
    const doc = fakeDocument();
    const stopTransmit = vi.fn();
    const tracker = createPttKeyboardRelease(doc.target, stopTransmit);
    tracker.keyDown({ key: ' ', repeat: true });
    tracker.keyDown({ key: 'a' });
    expect(tracker.held).toBe(false);
    expect(doc.listeners.size).toBe(0);
    tracker.keyDown({ key: ' ' });
    tracker.keyDown({ key: ' ' });
    expect(doc.listeners.size).toBe(1);
  });

  it('removes the listener on dispose without reporting a release', () => {
    const doc = fakeDocument();
    const stopTransmit = vi.fn();
    const tracker = createPttKeyboardRelease(doc.target, stopTransmit);
    tracker.keyDown({ key: ' ' });
    tracker.dispose();
    expect(doc.listeners.size).toBe(0);
    doc.keyup({ key: ' ', target: { tagName: 'body' } });
    expect(stopTransmit).not.toHaveBeenCalled();
  });
});
