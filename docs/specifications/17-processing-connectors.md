# Processing connector SDK

## Mandatory abstraction

All external or local processing goes through a provider-neutral registry. Domain modules depend on capability/task contracts, never vendor SDKs, OAuth details, or a particular model's JSON format.

Separate three concepts:

1. **Connector:** implementation of a protocol/vendor/local service.
2. **Connection:** configured endpoint and authentication, with an explicit credential/usage owner.
3. **Processing profile:** selected connection, model, task settings, privacy/budget rules, and allowed fallback for a capability.

One connector can have multiple connections and profiles. One task may use a different provider from another. Replacing a connector must not require rewriting history, incident, or radio code.

## Capabilities and tasks

Capabilities initially cover `stt.batch`, optional `stt.streaming`, `tts.synthesize`, `text.structured`, and optional future embeddings/search/enrichment. Text tasks include `callsign.extract`, `entities.extract`, `emergency.classify`, and `conversation.summarize`; each has a versioned schema and independent profile.

```ts
// Specification sketch; implementation types belong to packages/processing-sdk.
interface ProcessingConnector {
  describe(): ConnectorManifest;
  validateConnection(input: ConnectionReference): Promise<ConnectionStatus>;
  capabilities(input: ConnectionReference): Promise<CapabilityDescriptor[]>;
  execute(input: ProcessingRequest, signal: AbortSignal): Promise<ProcessingResult>;
}
```

Requests identify instance, job, task/schema version, input artifact/transcript references, profile revision, deadline, and usage owner. Inputs are authorized references resolved by the backend, not arbitrary client-provided file paths. Streaming has a separate typed event contract; a partial stream is not a completed result.

Results include normalized output, provenance, evidence references, timings, and usage/cost when available. Unsupported/unknown confidence or cost stays absent/unknown, never fabricated as zero.

## Initial connector families

| Connector | Scope |
|---|---|
| `openai-api` | Official API-key path with supported text/audio capabilities |
| `openai-compatible` | Configurable base URL/model and explicit Responses or Chat Completions protocol; capabilities tested per endpoint |
| `openai-subscription-oauth` | Official subscription flow for eligible Responses requests; distinct restrictions and credentials |
| `azure-speech` | Optional STT/TTS connector with its own SDK/protocol/authentication |
| `ollama` | Planned local adapter or compatible endpoint, advertising only tested capabilities |
| Local STT/TTS and other vendors | Future packages using the same contracts |

OpenAI compatibility does not imply full endpoint, tool, streaming, schema, STT, or TTS parity. Ollama documents partial compatibility. A generic connector therefore has an explicit capability probe/configuration and cannot claim all OpenAI features merely because `/chat/completions` works.

Default setup offers the OpenAI-compatible family first, without forcing a paid key or model. Models/voices are configurable and listed when the connector supports discovery. Disabled processing is valid. No vendor is required to start the application.

## Authentication and ownership

Authentication strategies are separate modules: API key, supported OAuth/PKCE, service credentials, or no-auth local endpoint. Credentials reference an encrypted store. Provider account linking is separate from SignalDock instance login.

Instance-owned API connections may serve explicitly enabled background profiles. User-owned subscription OAuth connections stay bound to their owner/workspace and approved usage scope; they are not pooled across users or instances. Show which account pays or supplies quota for each profile/job.

Only administrators configure outbound endpoints. Local/LAN endpoints such as Ollama are allowed intentionally, while redirects carrying secrets, cloud metadata destinations, and arbitrary URLs embedded in received messages are rejected by endpoint policy.

## Extensibility and execution policy

New connectors/tasks are versioned packages or isolated worker services with schemas, examples, conformance tests, and capability declarations. No runtime download of arbitrary code from a radio message or untrusted frontend.

Provide timeouts, cancellation, bounded retry, rate limits, circuit breaking, idempotency, queue priority, and per-profile budget. Fallback must be explicitly configured for data transfer and billing. Never silently switch a subscription request to a billed API key or send a local-only job to a cloud provider.

Received text and model output have no radio-control or shell tools. Validate structured output and cited communication/segment IDs. Keep original transcripts separate from generated interpretations.

## Acceptance

Implement a deterministic fake connector plus two differently shaped connectors without changing domain services. Test missing capability, malformed schema, interrupted stream, unknown usage, expired credentials, cancellation, blocked fallback, local endpoint, provider account switching, owner isolation, and a future task added only through its registry/schema.
