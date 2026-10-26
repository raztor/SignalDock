# azure-speech

Implemented recorded STT through fast transcription REST API `2025-10-15`, multipart `audio`/`definition`, and explicit `language` locale. Streaming transcription is not advertised.

The connection endpoint is the transcription base. Configure `ttsEndpoint` separately, for example `https://REGION.tts.speech.microsoft.com`. Synthesis requires `language` and `voice`, escapes text in SSML and requests `riff-24khz-16bit-mono-pcm`. Both use the encrypted resource key. Actual account, region and locale availability require external acceptance. See the [implementation guide](../../../docs/implementation/processing.md).
