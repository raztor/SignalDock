# Background worker application

Status: planned (W7–W11). This application will execute recording derivatives, speech/analysis tasks, decoder work, retention, and other asynchronous jobs through shared contracts. It has no entry point or workspace package yet.

Provider implementations live under `services/processing-connectors`; task execution contracts live in `packages/processing-sdk`. Workers must preserve job provenance, cancellation, owner scope, and deletion semantics.
