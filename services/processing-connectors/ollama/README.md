# ollama

Implemented local structured-text connector through `/api/chat`, non-streamed JSON/schema output. It accepts loopback/private endpoints only, requires `allowPrivateNetwork: true`, and supports `allowCloud: false`. Responses must declare a completed successful stop. Task validators normalize JSON and verify evidence.

STT/TTS are not advertised and cloud fallback is absent. Operators remain responsible for the chosen local server/model. See the [implementation guide](../../../docs/implementation/processing.md).
