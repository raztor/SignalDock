# Processing implementation

## Boundaries and composition

Radio operation and recording work without processing credentials. Optional providers live in `@signaldock/processing-connectors`; domain tasks register through `@signaldock/processing-sdk`. Providers do not import radio drivers or select task names. Built-in tasks are `speech.transcribe`, `speech.synthesize` and `conversation.summarize`. Additional tasks supply a version, capability, input/output validators, prompt/schema and normalizer.

Composition exports:

- `createProcessingRegistry(tasks?)`, plus `registerTask`/`register` for installed extensions.
- `CredentialVault(activeKeyId, keys)` with persistent operator-managed 32-byte encryption keys.
- `OpenAISubscriptionOAuth(hostId)` with a persistent server host ID, separate from keys and tokens.
- `ProcessingRuntime({db,auth,artifacts,queue,registry,vault,subscriptionOAuth,validateInputs,authorizeSourceRead?,onCompleted?,authorizeBackgroundUser?})`.
- `createHistoryProcessingHooks(history,authorizeActor,{onTranscriptCommitted?})` supplies source authorization and transcript persistence. The optional callback receives the terminal transaction, actor, updated communication and transcript; it may enqueue analysis/outbox work in that transaction, without external IO. Those writes become visible atomically with the transcript.
- `registerProcessingRoutes(app,{prefix,auth,processing,transmitPreparedSpeech?})`.
- `registerProcessingHandlers(queue,processing)`.
- `ProcessingScreen({session,radioId?,onTransmitSpeech?})`.

The integration owner registers `processingMigrations` (`030_processing`) before application startup. Root workspace references/dependencies and worker composition are separate integration responsibilities. The connector package pins `jose` 6.2.13; official API operations use standard `fetch`, not an implicit vendor SDK.

`validateInputs` must resolve every communication in the selected instance, authorize its radio, reject deleted sources, compare the source revision, and match audio artifacts to available recordings. Current jobs accept one versioned source communication. Structured text must correspond to the authorized source transcript; source text never gains tools or system authority. This callback runs before enqueue, before provider IO, before reading audio and inside final commit. `onCompleted` runs in that final transaction: append a provider transcript revision using the history service's transaction argument, with connector/profile/task provenance. Never create another database transaction inside this callback.

The history hooks require `validateJobSource(job,transaction)` for transactional work. Enqueue revalidates and locks the source before inserting any domain/shared queue row, preventing deletion from racing a late insert of copied text. Structured jobs persist `source.transcriptRevisionId` and validate that exact immutable transcript and frozen input text. The authorization callback receives an optional fourth transaction argument; pass it through to identity checks. `validateInputs` additionally receives the optional claimed radio ID and rejects a mismatch with the actual source radio. `onCompleted` receives the original source snapshot as its optional fifth argument for versioned analysis persistence.

Include `authorizeSourceRead` from `createHistoryProcessingHooks` in runtime composition. Job lists, previews and prepared transmission reauthorize the current radio of the persisted source, ignoring a caller's claimed radio as an authority. Revoked/deleted sources are filtered or denied. A legitimate older result remains viewable with a current read grant even after the source revision advances.

Wire history's source-deletion callback to `removeProcessingSourceDerivatives(transaction,instanceId,communicationId)` while the source lock is held. It locks shared jobs before domain derivatives, clears copied shared results/payloads/diagnostics, cancels unfinished jobs and deletes domain requests/results in the same transaction. Only safe queue audit references remain. The helper performs no network/artifact IO and opens no transaction. History retains responsibility for original recordings and its own transcript deletion.

The shared queue atomically enqueues with the business row using `enqueue(job,transaction)`. The handler saves its result only through `execution.commit`: source locks, cancellation/deadline/attempt guards and derivative writes share the final transaction. Generated TTS artifacts are removed if commit fails. Cloud jobs use one attempt; an uncertain provider outcome is never automatically replayed. Manual jobs retain initiating-session authorization and stop if the session expires or is revoked.

## Connection and profile setup

Connection creation is administrator-only. Choose the connector, display name, endpoint, exact capability subset, public configuration and optional API key. Secrets are accepted in the dedicated credential field, encrypted with AES-256-GCM, and excluded from public views/logs. Configuration/settings reject credential-shaped fields. Public views say `configured` until actual execution establishes access; configuration is not a health check.

Profiles specify connection, capability, task, model, immutable revision, speech settings and explicit `allowCloud`. Creating or changing a profile does not execute a job. Missing capabilities fail explicitly; no provider or billing fallback occurs.

Examples of non-secret settings:

| Provider | Connection configuration | Profile settings |
| --- | --- | --- |
| OpenAI API | Endpoint `https://api.openai.com/v1` | STT optional `language`; TTS `voice` |
| API-compatible | `protocol: "responses"` or `"chat-completions"`; optional `supportsJsonSchema` | Server-specific model, optional speech settings |
| Local compatible | Private/loopback endpoint and `allowPrivateNetwork: true` | `allowCloud: false` |
| Azure | Regional transcription endpoint; `ttsEndpoint: "https://REGION.tts.speech.microsoft.com"` | Required `language`; TTS also `voice` |
| Ollama | `http://ollama:11434`, `allowPrivateNetwork: true` | Installed local model; structured text only |

Azure recorded transcription uses REST version `2025-10-15`. API-key TTS requests WAV; Azure requests RIFF 24 kHz mono PCM. Audio input/output is bounded at 25 MiB in the provider layer. Media applies its stricter transmission duration/size limits. The endpoint policy refuses embedded credentials, query strings, fragments, redirects and metadata/link-local addresses; HTTP requires an explicitly allowed local endpoint. Operators control DNS/network egress for configured providers.

## Automatic RX transcription

Automation defaults **off**. No connection/profile creation implies permission to upload recordings automatically. The administrator separately calls `PUT /api/v1/processing/background/consent` with the radio, exact provider endpoint, profile ID/revision, explicit service-owner user and `allowAutomaticUpload: true`. The server records consenting administrator/time, a new consent ID and a fingerprint of the provider connection. This is a specific payload/destination opt-in for future finalized RX recordings on that radio.

Only instance-owned recorded-STT profiles can be selected. User subscription credentials cannot be used for shared automation. `authorizeBackgroundUser(instanceId,userId,permission,radioId?)` must resolve the currently enabled service owner through the identity service's sessionless user authorization policy; never fabricate a Principal/session. `ProcessingActor` distinguishes this protected service actor from HTTP principals. Public callers cannot submit an actor or consent ID through job requests.

Wire history's finalized-reception hook to `enqueueFinalizedCommunication(communication)`. No consent returns `disabled`; stale configuration/permissions return `requires_configuration`. The recording remains available. The hook requires a received voice communication and an available recording. Jobs bind communication revision, artifact and consent ID, and deduplicate on those values.

Consent is checked again before provider dispatch and inside terminal commit. Disabled consent, changed endpoint/provider configuration/profile revision, revoked connection or disabled service user prevents further work or result publication. Any provider/profile change requires renewed consent. `DELETE /api/v1/processing/background/:radioId` disables automatic processing. Recording capture never depends on a provider succeeding.

## Speech preview and explicit transmission

Manual STT chooses an authorized recording from the radio's history. An empty successful transcript is valid silence, not an error. The completed transcript is retained as a versioned derivative with source context.

TTS creates a private stored preview. `GET /api/v1/processing/jobs/:id/audio` requires the current job owner and uses an authenticated, non-cacheable response. The browser screen fetches a blob without putting access tokens in a media URL; it revokes object URLs on replacement/unmount and resets state across server/session changes. Native preview playback remains an integration/device acceptance gate.

Explicit `POST /api/v1/processing/jobs/:id/transmit` exists only when the shared media transmitter is injected. It requires a completed user-owned TTS preview, unchanged profile/connection, destination radio permission and a fresh control context (`radioId`, `generation`, `expectedRevision`, `controlGrant`). `prepareTransmission` rechecks these references. The callback delegates to `MediaService.transmitEncodedAudio`: bounded decoding/resampling, live-media admission, TX lease/fencing/heartbeat, pacing, cancellation and archive hooks. Provider WAV/MP3 bytes are never treated as raw PCM. Speech completion, browser reconnection and process restart never key the radio automatically.

## Subscription onboarding

The official supported subscription flow is separate from billed API-key access. It supports eligible Responses text inference only. Scope grants do not establish speech API access. Requests use the public Responses endpoint, `store: false`, streamed output and a required terminal completed event. Failed/incomplete/partial streams are rejected.

After building the connector package, run locally:

```sh
node services/processing-connectors/dist/openai-subscription-oauth/src/setup.js --output .local/subscription-registration.json
```

Open the printed official authorization URL on that computer. The helper listens only on `127.0.0.1`, uses state/nonce/PKCE, validates official discovery/JWKS through `jose`, and writes a new registration file with mode `0600`. Its persistent local host ID is `.local/openai-subscription-host-id`. Neither file belongs in Git or a mobile/browser cache.

For a headless server, transfer the protected file through SSH and import it through the authenticated `POST /api/v1/processing/subscriptions/import` endpoint as the intended SignalDock user. This verifies issuer, issued client, identity token, expiration and inference scopes, then encrypts credentials under that user. Composition supplies the target server's persistent host ID; import preserves it. Remove the transfer copy after confirmed import. Do not invent a public redirect, scrape another application's stored tokens, or convert denied consent into an API-key fallback.

Refresh occurs under a database credential-row lock and atomically saves the rotated refresh/access/identity tokens. Lost/expired/revoked credentials require reauthorization. Revoking a connection disables admission before requesting official token revocation. The official preview currently imposes eligibility, model, field and transferred-session limitations; eligible-account onboarding, refresh, revocation, model discovery and headless transfer require separate external-account acceptance.

## Credential key lifecycle

Configure encryption keys through persistent protected deployment secrets. No random/default startup key is generated. Keep keys separate from PostgreSQL backups and never return them over public APIs. AES-GCM additional data binds the instance, credential ID and owner; moving ciphertext between owners/instances fails authentication.

To rotate, make old/new keys available, select the new active key, run administrator-only `POST /api/v1/processing/credentials/rewrap`, verify restoration with the new key, and retire the old key after required backup retention. A missing old key fails closed. Back up instance identity, subscription host ID, database, artifacts and credential key material through separate protected channels.

## Validation and release gates

Focused checks:

```sh
npx tsc -b services/processing-connectors packages/client-sdk
npx tsc -p apps/api
npx tsc --noEmit -p apps/client
npx vitest run services/processing-connectors/test packages/processing-sdk/test apps/api/test/processing.test.ts
```

Tests use deterministic audio/text, a real loopback mock HTTP server, mocked provider endpoints and signed JWKS fixtures. They cover capability replacement, local-only policy, cancellation, terminal failure, ownership, encrypted credential scope/key rotation, stale source/profile suppression, generated-artifact cleanup, consent invalidation, API prefix/auth boundaries and the shared TTS callback. They make no real provider calls or radio-audio uploads.

With `TEST_DATABASE_URL` pointing to a disposable local PostgreSQL server, the retention test creates/drops its own unique schema and verifies rollback, removal of copied source text/results, unfinished-job cancellation, idempotency and instance/source isolation. Its test-only dependencies pin `pg` and `@types/pg` at 8.23.1.

Outstanding external gates: database-backed cumulative integration/worker restarts, actual OpenAI/Azure/Ollama account/model acceptance, official eligible subscription onboarding/refresh/revocation/headless transfer, native preview/secure-storage compatibility, native audio/push builds and physical Linux/ARM64 radio acceptance. No fixture establishes those outcomes.

Primary references: [OpenAI subscription sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [subscription models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [Azure fast transcription](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create), [Azure speech synthesis REST](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech), and [Ollama chat API](https://docs.ollama.com/api/chat).
