# Optional push relay application

An independently deployable, **private-test-only** push relay. Public enrollment is hard-disabled in code. Instance history and preferences remain in the backend; the relay stores only encrypted device tokens, signed grant scopes, and minimal delivery metadata.

Publisher credentials stay here. `RelayService` accepts an injectable `PushTransport`; tests use a fake transport and do not contact Expo. The production adapter uses only the fixed Expo HTTPS push/receipt endpoints, bounded timeouts, and an isolated publisher access token.

Activity and challenge payloads include an absolute provider expiration. Enable Expo's enhanced push security for the publisher project so the bearer credential is enforced. Provider fields and receipt semantics follow the [official Expo push API](https://docs.expo.dev/push-notifications/sending-notifications/).

Enrollment requires a private invitation and a fixed Expo project ID. The installation creates its own Ed25519 key and client nonce. A random challenge travels only through the submitted push token; HTTP returns its ID and expiry. The installation signs the matching received challenge before enrollment succeeds. An unsolicited challenge is rejected by the client SDK. Installation-signed grants bind one backend public key, instance, user subscription reference, category/radio scope, and expiry. Backends cannot send arbitrary tokens or callback URLs.

Requests use domain-separated Ed25519 signatures, timestamp windows, persistent nonces, bounded TTLs, stable idempotency IDs, and serialized installation/grant quotas. Device owners can revoke a grant or all grants directly with their installation key, even if their backend is hostile. Backend-originated revocation can affect only its own grant. Tokens use AES-256-GCM with installation-bound authenticated data and are never logged. Invalid-device receipts clear tokens and revoke grants.

Each verified enrollment creates a new opaque registration generation. A delivery reservation stores that generation immutably; immediate failures and delayed invalid-device receipts disable a token only if the installation still has the same generation under its row lock. A failed old-token receipt remains failed without clearing or revoking a newly verified registration. Explicit owner revocation remains authoritative during concurrent receipt cleanup.

Startup registers `relayMigrations`, preserving `001_private_relay` and applying the additive `002_registration_generation` migration. Existing installations receive a generation; legacy deliveries keep an unknown (`null`) generation because their original receiving token cannot be inferred safely. Legacy errors remain recorded but cannot revoke today's installation. Independent relay deployments using the exported service must apply the complete relay migration list before admitting requests.

After building dependencies, run `npm start --workspace=@signaldock/push-relay`. Required environment:

| Variable                  | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `RELAY_DATABASE_URL`      | Separate PostgreSQL database owned by the relay                 |
| `RELAY_TOKEN_KEY_BASE64`  | Base64 encoding of a stable random 32-byte token encryption key |
| `RELAY_PROJECT_ID`        | UUID of the allowed Expo publisher project                      |
| `RELAY_ENROLLMENT_SECRET` | Private-test enrollment invitation                              |
| `EXPO_ACCESS_TOKEN`       | Publisher credential, never shared with a station backend       |
| `HOST`, `PORT`            | Bind address; defaults to `127.0.0.1:3001`                      |

Startup applies the private relay migration and refuses a database containing the instance user table. Expose through a fixed HTTPS reverse proxy; preserve any configured URL prefix. Backup the database and encryption key together, separately from station secrets. Lost encryption keys require device re-enrollment. Routing metadata is retained for seven days; expired challenge and nonce data is cleaned hourly. No audio, transcript, frequency, callsign, arbitrary message body, or backend URL is sent to Expo by activity delivery.

Delivery reservations commit before external sending. Retries return the persisted result for the same ID. A process crash or ambiguous provider failure after reservation does not automatically resend: this deliberately avoids duplicate alerts and does not promise exactly-once external delivery. Receipt polling runs every 30 seconds; provider acceptance never means a user saw the alert.

Migration `003_receipt_schedule` adds persisted receipt attempt/check times and a 24-hour lookup horizon. Due batches claim up to 100 rows with a short database lease and release all locks before provider IO. Missing responses and provider outages back off from 15 seconds to five minutes; their next check moves behind other due tickets, so an old missing batch cannot monopolize polling. After the horizon an unresolved receipt becomes `ReceiptUnavailable` and leaves the polling queue. Restart preserves scheduling; none of these retries resend a notification.

Public activation still requires signed native development-build token ownership, project attestation policy, persistent abuse controls, operational key rotation, real Expo delivery/receipt checks, and independent revocation/navigation acceptance. The current mode cannot be switched to public by an environment flag.

See [implementation and gates](../../docs/implementation/notifications.md) and [relay specification](../../docs/specifications/10-notifications-relay.md).
