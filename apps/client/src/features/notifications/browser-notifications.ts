import type { NotificationRecord } from '@signaldock/contracts';

/** Foreground browser adapter. This is not a service-worker Web Push subscription. */
export class BrowserNotificationAdapter {
  private readonly active = new Set<Notification>();
  available(): boolean {
    return typeof globalThis.Notification !== 'undefined';
  }
  permission(): NotificationPermission | 'unsupported' {
    return this.available()
      ? globalThis.Notification.permission
      : 'unsupported';
  }
  async requestPermission(): Promise<NotificationPermission | 'unsupported'> {
    return this.available()
      ? globalThis.Notification.requestPermission()
      : 'unsupported';
  }
  show(record: NotificationRecord, onOpen: () => void): void {
    if (this.permission() !== 'granted') return;
    let notification: Notification;
    try {
      notification = new globalThis.Notification('SignalDock', {
        body:
          record.category === 'incident'
            ? 'An incident needs your attention.'
            : 'A station update is available.',
        tag: `${record.instanceId}:${record.id}`,
      });
    } catch {
      return;
    } // Unsupported browser delivery must not interrupt durable history.
    if (this.active.size >= 32) {
      const oldest = this.active.values().next().value;
      if (oldest) {
        oldest.onclick = null;
        oldest.close();
        this.active.delete(oldest);
      }
    }
    this.active.add(notification);
    notification.onclick = () => {
      onOpen();
      notification.close();
      this.active.delete(notification);
    };
    notification.onclose = () => {
      this.active.delete(notification);
    };
  }
  dispose(): void {
    for (const notification of this.active) {
      notification.onclick = null;
      notification.close();
    }
    this.active.clear();
  }
}
