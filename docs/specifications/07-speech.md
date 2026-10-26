# Speech-to-text and text-to-speech

## Provider-independent workflows

STT and TTS are separate capabilities of the [processing connector SDK](17-processing-connectors.md). The same instance can use different vendors, credentials, or local services for STT, TTS, callsigns, summaries, and emergencies. No domain module imports a vendor SDK.

The default connector family is OpenAI API-compatible. Azure Speech and other services remain alternatives; local engines can be added behind the same contracts. A provider without a capability cannot silently emulate or advertise it.

## STT

- Configurable language, initially Spanish; use regional locales only where supported.
- Finalized-burst transcription as the baseline; partial streaming results when the connector supports them.
- Optional vocabulary hints for callsigns, places, and names, with explicit capability validation.
- Store original text, available timestamps, language, model/provider, profile revision, and available usage metrics.
- States: disabled, queued, processing, partial, completed, failed, cancelled.
- Bounded retries and idempotency. Silence/noise may produce an empty result; the system does not require a fabricated sentence.
- Human correction and reprocessing create revisions without deleting original results.

Confidence, diarization, and word timestamps are optional. Do not manufacture them or compare scores from unrelated engines as if calibrated. Separating speakers does not establish their identity; callsign extraction remains an independent task.

## TTS

Text → synthesis job → playable preview → explicit TX request. Rendering audio does not acquire PTT. Before sending, recheck radio, destination/tuning revision, permissions, control owner, and intention expiry.

Voice/language choices come from the connector. Editing text or voice invalidates the old preview. Preserve source text, generated audio, settings, and the authorizing user. Queues are cancellable and never resume RF emissions automatically after restart.

Scheduled announcements are a later optional extension using the same controls, disabled by default.

## Selection and evaluation

Use an authorized radio corpus containing clean/noisy/weak/clipped speech, callsigns, numbers, and silence. Compare word errors, exact callsign/number recognition, missing/spurious text, latency, and cost against human references and a held-out set. Do not claim a provider is most accurate before that test.

Azure Speech remains a useful candidate for STT/TTS and vocabulary support; OpenAI API compatibility is the requested initial family. Configuration must reflect differences between real-time, fast, and batch APIs rather than exposing unsupported options.

Provider credentials, region, allowed data transfer, and budget are configured by the instance administrator. No evaluation recording is uploaded as part of this documentation task.

## Subscription OAuth boundary

OpenAI subscription OAuth is separate from API-key audio access. The reviewed flow supports eligible Responses requests and explicitly excludes the transcription API/audio input. STT and TTS are not enabled merely because that OAuth account connected. See [OAuth scope](18-openai-oauth.md).

## Acceptance

Replace STT without changing history; replace TTS without changing PTT; absent/expired credentials; quota; interrupted partial output; missing timestamps; unsupported voice; synthesis cancellation; destination changes after preview; and explicitly configured fallback that never silently changes billing or privacy policy.
