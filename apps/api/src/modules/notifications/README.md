# Notification orchestration

Durable, instance-scoped notification history, preferences, device subscriptions, and delivery orchestration. The browser and history work without a relay or cloud credentials.

`PostgresNotificationRepository` uses migration `050_notifications`; `NotificationService` receives the authentication port, a fresh-user audience port, and an optional relay port. `registerNotificationRoutes` mounts beneath the application's `/api/v1` prefix. Background delivery uses `NotificationAudiencePort.authorizeUser`, without inventing an active login session.

Routes include `GET notifications`, `POST notifications/:id/read`, `GET/PUT notification-preferences`, `POST notifications/presence`, `GET push/configuration`, and `GET/POST/DELETE push/subscriptions`. IDs, users, radios, and grants are checked against the authenticated instance. Cursor pagination never changes the credential destination.

Preference and device-subscription self-service requires `notifications.read` and is always restricted to the principal's own user ID, including listeners/operators. Instance relay configuration remains an administrator/deployment concern. Subscription creation locks and rechecks its authoritative identity session in the same transaction after relay inspection; logout cannot be followed by a late enrollment insert. Delivery checks the persisted source session and current subscription immediately before dispatch, including revocation and absolute refresh-family expiry. Access-token expiry alone does not disable background notifications. Identity locks are released before network IO so optional push cannot delay radio/media revocation. An already admitted generic push may finish in flight.

Call `publishForUser(userId, event, context)` after a finalized communication, transcript, incident, or other domain event. It deduplicates by instance/user/event/category and atomically creates the delivery outbox entry. No transcript, callsign, or recording text enters the relay payload. Preferences support category, authorized radio/frequency, quiet hours, cooldown, and live-listening suppression. Incidents bypass listening suppression; other preferences still apply.

The worker consumes `notification.delivery_requested` as `notifications.deliver`, and `notification.subscription_revoked` as `notifications.revoke`. Connect identity logout/revocation callbacks to `revokeForUser(instanceId, userId, sessionId?)`. Media clients refresh authenticated presence while listening; presence expires after 45 seconds. Superseded device grants are queued for revocation atomically.

The optional relay is independent of instance credentials. Only verified installation grants are accepted; raw tokens and caller-selected relay URLs are rejected. Native enrollment remains restricted to private testing. A provider receipt means provider acceptance; only authenticated application opening marks an item read.

Implementation details and acceptance gates: [notification delivery](../../../../../docs/implementation/notifications.md).

Specification: [10-notifications-relay.md](../../../../../docs/specifications/10-notifications-relay.md).
