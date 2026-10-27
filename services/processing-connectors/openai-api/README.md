# openai-api

Implemented API-key connector for `https://api.openai.com/v1`: registered structured text through Responses, recorded transcription and WAV synthesis. Profiles supply model and speech settings. Credentials remain in encrypted backend storage. Text requests use `store: false`, request no tools and require a completed result. Synthesis creates a private artifact; transmission uses the authorized media path.

Subscription credentials use the [separate connector](../openai-subscription-oauth/README.md). See the [SDK](../../../packages/processing-sdk/README.md) and [configuration/acceptance guide](../../../docs/implementation/processing.md).
