# processing-sdk

The connector registry and fixture connectors live in `src/index.ts`; versioned task definitions live in `src/tasks.ts`. Providers, connections, profiles, and tasks are separate concepts. Register new task definitions rather than adding task-specific dispatch branches. Concrete remote/local provider integrations live under `services/processing-connectors`.

See the [repository layout](../../docs/architecture/repository-layout.md) for dependency boundaries.
