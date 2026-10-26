# openai-subscription-oauth

Implements the official supported sign-in/token-sharing flow for eligible subscription Responses inference. Connections belong to the linked SignalDock user and cannot be pooled into shared automation. This connector advertises structured text only; it requires `response.completed`, rejects partial/failed/incomplete streams, and never falls back to billed API access.

Authorization uses loopback `http://127.0.0.1:PORT/auth/callback`, state, PKCE and nonce. First registration stores the issued client ID. `jose` verifies signature, issuer, audience, expiry, nonce and subject against official discovery/JWKS. Refresh is serialized by the credential-row lock and persists rotating credentials atomically. Revocation disables admission before contacting the official revocation endpoint.

For headless servers, complete local setup and transfer its protected registration over SSH/HTTPS. Import preserves the destination's persistent host ID; no remote callback is invented. Transferred sessions retain the official preview's host-attribution/revocation limitations. See [operator setup and gates](../../../docs/implementation/processing.md).

Primary documentation: [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [profiles/sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
