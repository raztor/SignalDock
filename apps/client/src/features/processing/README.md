# Speech and processing settings

`ProcessingScreen` implements provider connections, profiles, a radio-history source picker, speech/text jobs, cancellation and browser audio previews. It accepts the shared `FeatureScreenProps` and an optional `onTransmitSpeech(jobId,radioId)` callback from the radio/media shell for explicit prepared speech transmission.

Provider options/tasks come from the instance. Secrets stay on the backend and the API-key input clears after submission. Requests use the shared selected-instance client; session changes abort pending requests and clear private results/preview state. Browser previews use authenticated blobs, never bearer tokens in URLs. Native playback and actual device acceptance remain gates. See the [implementation guide](../../../../../docs/implementation/processing.md).

Specification: [17-processing-connectors.md](../../../../../docs/specifications/17-processing-connectors.md).
