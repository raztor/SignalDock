# Notification implementation and acceptance

The current implementation supports durable instance history, preferences, authorized device-subscription management, transactional delivery/revocation outbox entries, foreground browser alerts, and a private signed relay. Optional push never blocks history or core radio operation.

## Integration

1. Add `notificationMigrations` after the database foundation and identity migrations. The exported migration ID is `050_notifications`; subscription lifecycle requires the authoritative identity tables.
2. Construct `PostgresNotificationRepository(database)` and `NotificationService(repository, authentication, audience, optionalRelay)`; mount `registerNotificationRoutes` under the application API prefix.
3. Connect finalized domain events to `publishForUser`. Resolve recipients through enabled users with current radio permissions. Do not emit per audio frame or partial transcript.
4. Convert outbox `notification.delivery_requested` to `notifications.deliver` and `notification.subscription_revoked` to `notifications.revoke`; use the exported worker handlers. Commit visible domain state before external delivery.
   Also run `NotificationService.reconcileRevocations(instanceId, limit = 10)` periodically outside the outbox transaction. Migration `052_notifications_revocation` preserves intent after a wake-up job exhausts retries or expires, backfills existing revocations, and recovers lost source-session revocation callbacks. Retries continue until the relay confirms revocation or the original grant expires.
5. Connect identity session/user revocation to `revokeForUser`. A media client may refresh listening presence before its 45-second expiry; it must clear presence on exit.
6. Register `NotificationsScreen` with the current `ClientSession`. Configure a relay once at the station; enrollment requests cannot supply an arbitrary relay URL.

For private relay integration, use `SignedRelayClient` with the configured HTTPS relay URL, instance ID, and instance Ed25519 private key. The installation signs a grant for the corresponding public key. Its `subscriptionRef` is the station's authenticated user ID; the backend verifies it against the current principal before subscription. Installation keys and publisher credentials are independent of station login credentials.

## Failure behavior

History and outbox creation share a database transaction. Duplicate finalized events create one entry. Delivery reloads enabled-user state, radio grants, preferences, expiry, presence, and cooldown. Lost rights or disabled users stop delivery. Local unsubscribe commits before relay revocation is retried; device owners also have direct installation-key revocation independent of a station. Re-enrollment queues any superseded grant for revocation.

Enrollment rechecks and locks the authoritative `sd_sessions` row after external grant inspection, inside the subscription upsert transaction. Source-session revocation and absolute refresh-family expiry are checked again in a short transaction before each push dispatch; expired access tokens alone do not stop an idle mobile device's notifications. No identity lock spans relay/provider network IO, preserving prompt core runtime revocation. A generic push already admitted for dispatch may complete in flight. Relay send/inspect reload the grant after acquiring the installation lock so concurrent grant revocation cannot leave a stale authorized snapshot.

Each device attempt stores the exact signed request payload. A retry cannot refresh timestamps or extend its TTL. The relay's reserved request ID survives restart and cannot send a different payload. Ambiguous sends remain reserved rather than being sent again automatically. Delivery is at least once at the job boundary, idempotent at the application/relay boundary, and inherently uncertain after an external provider accepts it.

The relay sees opaque instance/radio/event/notification references and a generic category message. Content is fetched from a saved station after authentication. A notification cannot introduce a backend URL. Push receipt success is separate from authenticated `application_opened` state.

## Validation

Build the contracts, database, client SDK, notification SDK, API, and relay before tests. Focused suites are `apps/api/test/notifications*.test.ts`, `apps/push-relay/test/*.test.ts`, and `packages/notification-sdk/test/*.test.ts`. Set `SIGNALDOCK_TEST_DATABASE_URL` to a disposable PostgreSQL 18 database to run the integration cases; each creates and drops a unique schema and leaves the public schema untouched. Without it, database cases are explicitly skipped. Every push transport in tests is a fake.

Coverage includes replay, forgery, scope/TTL/quota rejection, independently revocable instance grants, malformed payloads, unsafe navigation, ciphertext corruption, provider error cleanup, atomic outbox rollback, event deduplication, persisted relay reservations, user permission changes, quiet hours, cooldown, and listening suppression.

## Release gates still open

- Application shell, durable event dispatcher, identity callbacks and job registry are wired. The composed PostgreSQL integration test covers notification fanout; actual device delivery remains separate.
- Validate browser permission UX and notification opening in the actual running application. Foreground notifications do not provide background Web Push.
- Supply secure native installation signing/token adapters and demonstrate challenge receipt in signed iOS/Android development builds. No native enrollment UI is enabled yet.
- Validate actual Expo publishing credentials, delivery receipts, device token rotation, direct owner revocation, and saved-instance navigation with real devices.
- Review persistent relay abuse protection, publisher-project attestation, installation/instance key rotation, token re-encryption, and deployment operations before public enrollment. Public mode is hard-disabled in this implementation.

No physical push delivery or public-relay activation is claimed by mocked transport or PostgreSQL integration tests.
