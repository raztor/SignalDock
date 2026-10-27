# Identity, permissions, and administration

## Instance authentication

Users, passwords, roles, and sessions belong to each backend. Instance login is separate from optional provider OAuth and relay device enrollment. None of those external connections creates radio permissions.

Public registration starts disabled. Administrators create users or invitations. Initial admin setup uses a one-time bootstrap mechanism, not a shared password embedded in an image. Passwords use a maintained adaptive hash, proposed Argon2id. Refresh credentials rotate and support revocation/reuse detection.

Include login/logout, session listing/revocation, account deactivation, and recovery through a configured channel or local administration command. Email is not a mandatory dependency for a private instance.

## Roles and radio scope

| Role | Baseline permissions |
|---|---|
| Listener | Listen and read history for assigned radios |
| Operator | Listener access plus assigned control/TX capabilities |
| Administrator | Instance configuration, users, drivers, permissions, storage and integrations |

Roles are templates; enforcement uses capabilities such as `radio.listen`, `radio.control`, `radio.transmit`, `history.read`, `recording.export`, `incident.manage`, and `instance.admin`. Assign them per radio. Administration never triggers TX implicitly.

The dashboard lists only authorized radios. Guessing another radio ID cannot expose its media/history. Removing control/TX permission invalidates the active grant and requests termination of that transmission.

## Administration areas

- Create/disable users, assign roles/radios, revoke sessions.
- Add radios using installed driver manifests and configuration schemas; inspect actual capabilities and connection health.
- Configure STT, TTS, analysis profiles, external/local connections, credential owners, budgets, and allowed outbound destinations.
- Configure retention, exports, backups, file storage, and quotas.
- Enable relay subscriptions and test notification delivery to the requesting user's authorized device.
- Inspect versions, audit records, processing failures, radio state uncertainty, and resource usage.

Secrets are stored only on the owning instance or appropriate relay. APIs return masked status, not plaintext provider credentials. Encryption keys live outside database rows and are included in the recovery plan. Native client refresh tokens use platform-protected storage.

## Audit requirements

Record actor, instance/radio IDs, action, result, time, and correlation for access, permission changes, tuning, PTT/TTS, exports, retention, and connector configuration. Distinguish requested, accepted, applied, rejected, and unconfirmed device actions.

Do not log passwords, bearer/refresh tokens, provider secrets, or raw push tokens. Provider OAuth identity is not silently linked to another local user with the same email.

## Acceptance

Direct API requests from a listener cannot tune or transmit. Operators cannot control unassigned radios. Revocation affects an active session. Logout invalidates refresh and push grants. Restored instances preserve identity intentionally. Secrets do not appear in frontend bundles, API responses, ordinary exports, or logs.
