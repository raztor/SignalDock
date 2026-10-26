# processing-sdk

The connector registry and fixture connectors live in `src/index.ts`; versioned task definitions live in `src/tasks.ts`. Providers, connections, profiles, and tasks are separate concepts. Register new task definitions rather than adding task-specific dispatch branches. Concrete remote/local provider integrations live under `services/processing-connectors`.

See the [repository layout](../../docs/architecture/repository-layout.md) for dependency boundaries.

`ProcessingExecutionContext` carries resolved credentials, settings and authorized artifact callbacks inside the backend only. It is not an API DTO. Optional task `describePrompt` and `normalizeOutput` methods supply schema/validation without vendor dispatch changes. Built-in speech tasks cover recorded transcription and synthesis.

The registry checks ownership, configured capabilities, cloud policy, profile revision, task version, cancellation, deadlines, result identity and cited communications. Configurable connectors may resolve execution scope from their endpoint; API-compatible connections stay cloud by default and permit explicitly configured private endpoints for local-only profiles. Fixtures are marked simulated and do not establish external-service acceptance.
