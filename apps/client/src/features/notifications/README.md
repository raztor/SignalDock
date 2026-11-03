# Notifications

`NotificationsScreen` accepts the shared `FeatureScreenProps` and must be rendered inside `StationProvider` (it reads radio names, the selected radio's channel memories and radios' current frequencies). `ToastProvider` is optional. It displays durable history, read state, pagination, delivery status, and notification preferences. API requests use the current instance session through the shared client SDK. Session changes abort outstanding requests and discard the previous instance's list.

Layout: inbox and preferences sit side by side when the screen is at least 960 px wide; otherwise a segmented control switches between them.

- Inbox (`NotificationInbox`): grouped by day in the device time zone, category icon, unread dot plus an "Unread" badge (never colour alone), and explicit "Mark read" / "Open <radio>" buttons. "Open" marks the row read, then asks the workspace to select the radio (it never retunes). "Mark all read" marks the loaded unread rows one by one.
- Preferences (`NotificationPreferences`) edit a local draft; "Save preferences" sends `PUT notification-preferences` with fields the screen does not edit (such as `radioIds`) kept as stored. Category cards with switches; frequency filter chips (`FrequencyFilterPicker`: Any frequency, memories, radios' current frequencies, recent `GET communications?limit=50` frequencies, Custom via `parseFrequencyInput`); `QuietHoursPicker` (24-hour bar: tap the first then the last quiet hour, wrapping past midnight; ±30 min steppers; output `HH:MM`); `TimeZonePicker` (defaults to the device zone; searchable `Intl.supportedValuesOf('timeZone')` list, validated text field fallback); cooldown presets with a custom number field (0–3600 s).
- Pure logic lives in `notification-model.ts` (tested in `notification-model.test.ts`) and is re-exported from `index.ts` with the components.

Push identifies saved resources; it must not introduce a new backend credential destination.

Browser alerts require an explicit permission button and run while the notification screen is open. These are foreground browser notifications; background Web Push/service-worker delivery is not implemented. No push permission is necessary for in-app history.

Before showing an unseen row, the client asks the current station's `notifications/:id/foreground` endpoint for admission. Quiet hours, cooldown, live-listening suppression, current permissions, and expiry remain server decisions. Admission failure or suppression never removes history. Only an admitted record can produce an OS alert.

The browser-safe `@signaldock/notification-sdk` provides `InstallationEnrollmentClient` and `resolveNotificationReference`. A native platform adapter must supply a securely stored Ed25519 installation key, the signed build's Expo project token, and direct relay revocation controls before native enrollment is exposed. Native push remains a development-build acceptance gate. Selecting a notification can only reopen an already saved instance and then load authorized content from it.

Specification: [10-notifications-relay.md](../../../../../docs/specifications/10-notifications-relay.md).
