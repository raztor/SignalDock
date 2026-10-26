# openai-compatible

Implemented configurable HTTP connector. Select `protocol: "responses"` (default) or `"chat-completions"`; set `supportsJsonSchema: true` only when supported. Explicit connection capabilities describe actual server behavior. An absent key is permitted only for this generic connector.

Registered tasks normalize structured JSON and verify evidence. Optional STT uploads an authorized artifact; optional TTS stores a private WAV preview. Local endpoints require `allowPrivateNetwork: true` and can run with `allowCloud: false`. There is no fallback to another endpoint. See the [SDK](../../../packages/processing-sdk/README.md) and [configuration guide](../../../docs/implementation/processing.md).
