# Implementation execution

Baseline: `f174521`. The existing foundation is the first PR against `main`. Work is developed in isolated worktrees and published as one dependency-ordered stack. Optional features remain above the operational-core acceptance layer.

| Owner | Private branch | Responsibility |
|---|---|---|
| 1 | Published stack | Contracts, composition, navigation, dependency lock, CI, deployment and cumulative acceptance |
| 2 | `n-cx/work-identity` | Authentication, instance sessions, users and permissions |
| 3 | `n-cx/work-radios` | Generic radio runtime/RPC, control and dashboard |
| 4 | `n-cx/work-vgc` | VGC production driver and physical validation |
| 5 | `n-cx/work-media` | Media bridge, TX supervision and live client audio |
| 6 | `n-cx/work-persistence` | Database/storage/jobs/outbox, recording and history |
| 7 | `n-cx/work-processing` | Providers, STT/TTS and subscription authentication |
| 8 | `n-cx/work-analysis` | Versioned analysis tasks, rules and incidents |
| 9 | `n-cx/work-digital` | Decoders, packets, positions and map |
| 10 | `n-cx/work-notifications` | Notification history, delivery and optional relay |

## Interface ownership

Common ports and DTOs are exported from `packages/contracts/src/application.ts`; runtime JSON schemas and the independent protobuf contract remain authoritative at their boundaries. Changes are integrated at the owning layer, regenerated and retested before consumers adopt them. The API shared auth helper consumes the `AuthenticationPort`; domains cannot bypass radio-scoped permission checks.

Migrations are supplied by domain repositories as `MigrationDefinition[]` and composed in order through the shared migration runner. PostgreSQL is the source of truth. File storage and the pg-boss scheduler remain behind common ports; fixtures do not replace persistence acceptance.

## Acceptance ledger

- Foundation: 44 automated tests, web export, TS/Python serialization and Linux discovery-container smoke passed at the baseline.
- G0 extension: application ports and driver memory/streaming/fencing/renewal messages are being integrated. Serialization alone does not establish real RPC interoperability.
- Operational core: pending authenticated multi-radio/browser media/recording integration and physical voice/PTT acceptance on Mac.
- Optional providers, incidents, APRS and notifications: pending their domain and combined acceptance tests.
- Native media/push, public relay activation and physical Linux/ARM64 hardware: separate release gates; not established by local fixtures or image publication.

Each domain handoff records commits, exports, migration/dependency requirements, executed tests, configuration and actual remaining gates. Shared stack changes and merges are performed only by the integration owner, with current cumulative checks required before promotion.
