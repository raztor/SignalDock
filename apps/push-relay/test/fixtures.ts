import { RelayError } from '@signaldock/notification-sdk';
import type {
  RelayChallenge,
  RelayGrant,
  RelayInstallation,
} from '@signaldock/notification-sdk';
import type { PushMessage, PushTransport, PushTicket } from '../src/expo.js';
import type {
  RelayStore,
  RelayTransaction,
  StoredDelivery,
} from '../src/store.js';

export class FixtureRelayStore implements RelayStore {
  state = {
    challenges: new Map<string, RelayChallenge>(),
    installations: new Map<string, RelayInstallation>(),
    grants: new Map<string, RelayGrant>(),
    nonces: new Map<string, string>(),
    deliveries: new Map<string, StoredDelivery>(),
  };
  private pending: Promise<unknown> = Promise.resolve();
  transaction<T>(action: (tx: RelayTransaction) => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      const state = structuredClone(this.state);
      const clone = <V>(value: V) => structuredClone(value);
      const tx: RelayTransaction = {
        getChallenge: async (id) => clone(state.challenges.get(id) ?? null),
        saveChallenge: async (record) => {
          state.challenges.set(record.challengeId, clone(record));
        },
        deleteChallenge: async (id) => {
          state.challenges.delete(id);
        },
        getInstallation: async (id) =>
          clone(state.installations.get(id) ?? null),
        saveInstallation: async (record) => {
          state.installations.set(record.installationId, clone(record));
        },
        getGrant: async (id) => clone(state.grants.get(id) ?? null),
        saveGrant: async (record) => {
          state.grants.set(record.grantId, clone(record));
        },
        revokeGrants: async (id, time, grantId) => {
          for (const grant of state.grants.values())
            if (
              grant.installationId === id &&
              (!grantId || grant.grantId === grantId)
            )
              grant.revokedAt = time;
        },
        consumeNonce: async (scope, nonce, time) => {
          const key = `${scope}:${nonce}`;
          if (state.nonces.has(key)) return false;
          state.nonces.set(key, time);
          return true;
        },
        getDelivery: async (id) => clone(state.deliveries.get(id) ?? null),
        saveDelivery: async (record) => {
          const previous = state.deliveries.get(record.requestId);
          if (previous && previous.registrationId !== record.registrationId)
            throw new RelayError(
              'REPLAY',
              'A reserved delivery cannot change its registration.',
            );
          state.deliveries.set(record.requestId, clone(record));
        },
        countDeliveries: async (installationId, grantId, since) => {
          const all = [...state.deliveries.values()].filter(
            (value) =>
              value.installationId === installationId &&
              value.createdAt >= since,
          );
          return {
            installation: all.length,
            grant: all.filter((value) => value.grantId === grantId).length,
          };
        },
        pendingReceipts: async () =>
          clone(
            [...state.deliveries.values()].filter(
              (value) =>
                value.state === 'provider_accepted' && !value.receiptChecked,
            ),
          ),
      };
      const value = await action(tx);
      this.state = state;
      return value;
    });
    this.pending = result.catch(() => undefined);
    return result;
  }
  async cleanup(before: string): Promise<void> {
    for (const [id, value] of this.state.challenges)
      if (value.expiresAt < before) this.state.challenges.delete(id);
  }
}
export class FixturePushTransport implements PushTransport {
  readonly messages: PushMessage[] = [];
  invalidDevice = false;
  async send(message: PushMessage): Promise<PushTicket> {
    this.messages.push(structuredClone(message));
    return { id: `ticket-${this.messages.length}`, status: 'ok' as const };
  }
  async receipts(ticketIds: string[]) {
    return Object.fromEntries(
      ticketIds.map((id) => [
        id,
        this.invalidDevice
          ? { status: 'error' as const, error: 'DeviceNotRegistered' }
          : { status: 'ok' as const },
      ]),
    );
  }
}
