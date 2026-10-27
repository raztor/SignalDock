# Notifications

`NotificationsScreen` accepts the shared `FeatureScreenProps`. It displays durable history, read state, pagination, delivery status, and notification preferences. API requests use the current instance session through the shared client SDK. Session changes abort outstanding requests and discard the previous instance's list.

Push identifies saved resources; it must not introduce a new backend credential destination.

Browser alerts require an explicit permission button and run while the notification screen is open. These are foreground browser notifications; background Web Push/service-worker delivery is not implemented. No push permission is necessary for in-app history.

Before showing an unseen row, the client asks the current station's `notifications/:id/foreground` endpoint for admission. Quiet hours, cooldown, live-listening suppression, current permissions, and expiry remain server decisions. Admission failure or suppression never removes history. Only an admitted record can produce an OS alert.

The browser-safe `@signaldock/notification-sdk` provides `InstallationEnrollmentClient` and `resolveNotificationReference`. A native platform adapter must supply a securely stored Ed25519 installation key, the signed build's Expo project token, and direct relay revocation controls before native enrollment is exposed. Native push remains a development-build acceptance gate. Selecting a notification can only reopen an already saved instance and then load authorized content from it.

Specification: [10-notifications-relay.md](../../../../../docs/specifications/10-notifications-relay.md).
