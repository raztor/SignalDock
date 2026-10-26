import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserNotificationAdapter } from '../src/features/notifications/browser-notifications.js';

afterEach(() => vi.unstubAllGlobals());
const randomUUID = () => globalThis.crypto.randomUUID();
const record = () => ({
  id: randomUUID(),
  instanceId: randomUUID(),
  userId: randomUUID(),
  eventId: randomUUID(),
  category: 'communication' as const,
  createdAt: new Date().toISOString(),
  deliveryState: 'queued' as const,
});
describe('foreground browser notification isolation', () => {
  it('does not break history on platforms without usable browser notification constructors', () => {
    vi.stubGlobal('Notification', undefined);
    const adapter = new BrowserNotificationAdapter();
    expect(adapter.permission()).toBe('unsupported');
    expect(() => adapter.show(record(), () => undefined)).not.toThrow();
    class Unsupported {
      static permission = 'granted';
      constructor() {
        throw new Error('Not supported on this platform');
      }
    }
    vi.stubGlobal('Notification', Unsupported);
    expect(() => adapter.show(record(), () => undefined)).not.toThrow();
  });
  it('clears old notification click handlers when its instance session is disposed', () => {
    class FakeNotification {
      static permission = 'granted';
      static last: FakeNotification;
      onclick: (() => void) | null = null;
      onclose: (() => void) | null = null;
      closed = false;
      constructor() {
        FakeNotification.last = this;
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    const open = vi.fn();
    const adapter = new BrowserNotificationAdapter();
    adapter.show(record(), open);
    const old = FakeNotification.last;
    expect(old.onclick).toBeTypeOf('function');
    adapter.dispose();
    expect(old.onclick).toBeNull();
    expect(old.closed).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});
