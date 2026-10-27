# Notifications and optional push relay

## Goal and delivery paths

Users of the published mobile app should enable notifications without creating their own APNs/FCM credentials. Proposed path:

**Self-hosted backend → SignalDock relay → Expo Push → APNs/FCM → published app.**

The publisher configures mobile delivery credentials once for its own app/project. Self-hosted instances receive only narrow relay grants; they never receive publisher credentials. The relay is optional, independently deployable, and open source. Own app builds can use their own relay/project credentials instead.

In-app notifications and durable notification history belong to each backend and work without a relay. Web Push uses a separate browser/service-worker/VAPID adapter, not Expo mobile tokens. Its cross-origin installation and browser support require a separate acceptance path.

## Notification types and preferences

New finalized communication; transcript ready where requested; emergency/incident update; control request; radio disconnected/recovered; storage threshold; and provider/processing failure relevant to an authorized user.

Subscriptions are per instance, user, radio/frequency, event type, and device. Include quiet hours, grouping, cooldowns, and an option to suppress ordinary pushes while actively listening. Do not send a push per audio frame or partial transcription. Prefer one initial communication alert with later content fetched from the backend.

Emergency priority does not promise bypass of operating-system focus modes or entitlement-specific critical alerts. Push never starts PTT, sends TTS, or arms a radio.

## Low-configuration enrollment

1. User signs into an instance and enables notifications for selected radios/events.
2. The app obtains permission and its publisher-project push token.
3. The app enrolls its installation with the configured relay using an installation key and a fresh challenge. No SignalDock central account is required.
4. The app explicitly authorizes a binding between that installation and the selected instance identity/user subscription.
5. The relay issues a scoped, expiring/revocable grant. The app passes the instance its opaque subscription/grant reference through its authenticated API.
6. The instance sends permitted event references, authenticated with its persistent instance identity and that grant. The relay routes only to the bound installation.

The backend generates identity keys automatically during setup. The normal flow needs no copy/paste of publisher secrets. Relay availability, configured URL, enrollment state, and a test-notification action are visible in settings.

## Enrollment and abuse boundary

The relay must not become an anonymous endpoint that accepts any push token plus arbitrary text. Before public release, prove installation ownership and bind the token to the intended app/project. A proposed foreground enrollment challenge delivered to the installation must be acknowledged using the installation key and matched to a locally initiated enrollment; assess app attestation where appropriate. Merely submitting a token or public key is not proof of owning its receiving installation.

Each grant binds installation, instance public key, opaque user/subscription reference, allowed event categories, expiry, and quota. Requests have signature, timestamp, nonce/idempotency key, and bounded TTL. Reject replay, forged identity, unknown grant, revoked subscription, and arbitrary recipient replacement. Rate-limit by instance, grant, and device, with abuse suspension and bounded fan-out.

Do not validate instance ownership by making unrestricted relay callbacks to user-provided URLs: private instances must work without inbound relay access, and the relay must not fetch arbitrary internal hosts. Use the app-mediated signed challenge/binding protocol.

The exact enrollment proof and key storage must pass a focused prototype and security review. Open public relay access is a release gate, not assumed solved by these prose steps.

## Privacy and navigation

Default payload: generic title/body plus opaque `instanceId`, `radioId`, `eventId`, and `notificationId`. Do not include transcripts, recordings, provider keys, credentials, or precise positions. Detailed previews are opt-in and disclose the data path.

The relay stores delivery tokens and minimum routing/receipt metadata, not radio history. Protect tokens at rest, redact logs, define deletion/retention, and expose subscription revocation. No audio/provider payload travels through the relay.

On tap, the app resolves the saved instance locally, selects its context, authenticates if needed, and fetches the event from that backend. It does not follow an arbitrary payload URL or forward another instance's token. If the backend is private/offline, show that access requires its network/VPN. Push does not create a tunnel.

Logout/removal revokes the binding at the backend and directly at the relay when possible. A disconnected/untrusted backend must not be able to prevent user-side revocation. Token rotation and app reinstalls replace stale registrations.

## Reliability and alternatives

Persist notifications and an outbox before enqueueing delivery. Track queued, relay-accepted, provider-accepted, failed, expired, and application-opened states separately. Provider receipt success is not proof the user saw the notification.

Handle tickets/receipts, invalid registrations, backoff, deduplication, expiry, and credential failures. Relay outage queues bounded/expiring events while normal radio/history operation continues. Do not deliver a burst of obsolete activity alerts after recovery. Public service limits/costs are an operating policy, not a promise of unlimited free delivery.

Self-build users may configure their own Expo project/relay or a later direct APNs/FCM adapter. Central credentials are never bundled with open-source clients. Web Push credentials belong to the serving web origin/installation.

## Acceptance

Two independent backends notify one app; multiple devices for one user; revoked grant; sign-out; token rotation; malicious backend; replay; leaked recipient identifier; relay outage; duplicate events; expired push; denied OS permission; private backend navigation; and payload URL injection. Validate real Android/iOS delivery before release. The project relay may be off without preventing core startup.
