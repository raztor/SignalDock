# Processing orchestration

Implemented: authenticated connection/profile configuration, encrypted provider credentials, verified subscription import/revocation, explicit jobs/cancellation, private speech previews, optional shared-media TTS transmission and default-off automatic RX consent.

`registerProcessingRoutes(app,{prefix,auth,processing,transmitPreparedSpeech?})` composes the module. Register `processingMigrations` once through the shared migration registry. Runtime factories and history/identity/queue integration callbacks are documented in the [implementation guide](../../../../../docs/implementation/processing.md). No provider credentials are required for core operation.

Specification: [17-processing-connectors.md](../../../../../docs/specifications/17-processing-connectors.md).
