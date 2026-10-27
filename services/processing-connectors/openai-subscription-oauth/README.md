# openai-subscription-oauth

Implements the official supported sign-in/token-sharing flow for eligible subscription Responses inference. Connections belong to the linked SignalDock user and cannot be pooled into shared automation. This connector advertises structured text only; it requires `response.completed`, rejects partial/failed/incomplete streams, and never falls back to billed API access.

Authorization uses loopback `http://127.0.0.1:PORT/auth/callback`, state, PKCE and nonce. First registration stores the issued client ID. `jose` verifies signature, issuer, audience, expiry, nonce and subject against official discovery/JWKS. Refresh is serialized by the credential-row lock and persists rotating credentials atomically. Revocation disables admission before contacting the official revocation endpoint.

For headless servers, complete local setup and transfer its protected registration over SSH/HTTPS. Import preserves the destination's persistent host ID; no remote callback is invented. Transferred sessions retain the official preview's host-attribution/revocation limitations. See [operator setup and gates](../../../docs/implementation/processing.md).

Primary documentation: [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [profiles/sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Imported credential binding

Imports verify the signed ID token and the signed resource access token through the fixed issuer's JWKS. The access grant must match the verified subject, issued client ID, issuer, Responses resource audience, inference scopes, and expiry. Caller-supplied scopes and expiration cannot widen the signed grant. An ID token alone never authorizes inference.

Before returning an imported registration, the backend exchanges its refresh token at the fixed official token endpoint and verifies the rotated access grant and any replacement ID token against that same identity. This proves the separate refresh credential is usable for the selected account; invalid, mixed-account, unverifiable, or API-key substitutions fail closed. The trusted response and signed grant determine the replacement scopes and expiration. The destination retains its own host ID. A successful import consumes the transferred refresh token; do not reuse the transfer copy.

Initial sign-in and later refresh also verify resource access tokens. Refresh cannot silently widen approved scopes. Subscription dispatch rejects non-JWT/API-key credentials from older stored records before making an inference or catalog request. Tests use locally signed JWT/JWKS fixtures and fake token responses; eligible-account and live provider acceptance remain separate release gates.

References: [token claims](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [refresh rotation](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), and [identity versus inference permission](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
