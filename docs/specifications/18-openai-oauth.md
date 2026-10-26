# OpenAI subscription OAuth connector

## Verified scope as of October 26, 2026

Official documentation describes subscription-backed access for eligible open-source/self-hosted applications. It is a distinct authentication and request contract, not an API key obtained from a normal SignalDock login.

The reviewed preview uses eligible Responses requests. Audio input and the transcription API are explicitly unsupported on that route; TTS is not advertised by this connector. Connect STT/TTS through separately supported API-key or other provider capabilities.

Sources: [open-source overview](https://developers.openai.com/siwc/token-sharing-open-source), [inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Product behavior

Expose a separate provider connection action using the provider's approved sign-in labeling. It links credentials to an existing local account; it does not grant radio permissions or replace the instance URL/username/password flow.

Store validated account/workspace identity, issued client registration, granted scopes, protected tokens, and stable host identity. Never scrape browser sessions, import unrelated application credential files, or use private web-service endpoints.

Subscription connection states include unconfigured, authorizing, connected, consent-required, expired, revoked, ineligible, and quota-exhausted. A valid identity result without inference permission does not enable analysis. Available models are account-specific, not a hard-coded global list.

## Authorization implementation

Use the official dynamic registration/returning-client flow, fresh state/nonce/PKCE, token validation, exact supported callback, and protected refresh handling. Reuse registration for the same account/workspace and stable host identity for the same installation; a restart does not create a new host.

The official initial flow uses a loopback callback. A browser on a phone/laptop does not magically deliver that callback to a remote Linux backend. Therefore the self-hosted onboarding path requires a dedicated spike: use an officially supported local setup/import flow and protected transfer to the target instance, or another officially supported registration path if available when implemented. Do not invent an arbitrary remote redirect or promise one-click mobile onboarding before validation.

See [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [self-hosted setup](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). This onboarding limitation does not block API-key connections or core operation.

## Request and completion rules

The connector follows the documented Responses streaming/stateless constraints, validates granted permissions, selects an account-available model, and waits for terminal completion. Partial output followed by a limit/error is not success. Unsupported request options are rejected or omitted according to this connector's schema, not forwarded blindly from generic API settings.

No automatic fallback to a paid API key, another account, or another provider. Background instance-wide processing using a person's subscription requires explicit scope/eligibility validation and an approved owner policy; do not assume one connected account can be shared indiscriminately among all users.

## Acceptance and release gate

Verify initial and returning sign-in, denied inference consent, wrong account/workspace, refresh rotation, revocation, model discovery, interrupted completion, exhausted plan, protected headless setup, and ownership isolation. Until those pass, the connector is experimental/unavailable with a clear reason; API-key operation remains supported independently.
