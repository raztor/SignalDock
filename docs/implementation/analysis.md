# Transcript analysis and incident implementation

The extension provides local analysis, provider-neutral task definitions, persisted incidents, administrative rules, and one Expo/React Native screen for web and native use. Core radio operation has no processing-credential dependency.

## Composition

1. Include `incidentMigrations` from `apps/api/src/modules/incidents/migrations.ts` after shared database, identity and history migrations. Its stable ID is `040_incidents`.
2. Instantiate `SqlIncidentRepository(database, appendOutbox)` and `IncidentService(repository, auth)`. Defaults do not enable emergency rules. Administrators configure literal rules through the incident screen/API, or deployment code explicitly selects `useDefaultRules: true`.
3. Call `registerIncidentRoutes(app, { prefix, auth, service })` after the shared HTTP configuration. Register public schemas through the integration-owned API catalog.
4. Import `createLocalTranscriptAnalysisHandler` from `@signaldock/processing-tasks` and register it as `analysis.transcript`. Optional `createRuleAnalysisHandler(service)` registers as `analysis.rules` when only classification is desired. Both factories depend only on structural service ports and shared contracts. Embedded jobs and standalone workers use these same exports; `apps/worker/src/handlers/analysis.ts` re-exports them.
5. Enqueue with payload `{ communicationId, transcriptRevisionId }` and trusted `source: { communicationId, communicationRevision }`, taken from the same stored communication revision. The queue must use the history source validator and the terminal commit context. The handlers reject missing/mismatched source IDs.
6. For provider-backed extraction/classification, call `registerAnalysisTasks(processingRegistry)`. Generic provider connectors use the task prompt/schema/normalizer. Classification persistence uses `service.acceptAssessment(reference, result, signal, execution)` inside the processing job's single terminal commit flow; orchestration must not call a second commit after the job is already complete.
7. Register `IncidentsScreen` from `apps/client/src/features/incidents/IncidentsScreen.tsx` using shared `FeatureScreenProps`. The feature uses the supplied instance URL and session, validates returned instance identity, and aborts/discards in-flight responses when instance, token or radio context changes.

The task package manifest adds only shared contracts, processing SDK and Zod. The API and standalone worker need `@signaldock/processing-tasks`; no cross-application source import is required. The PostgreSQL tests additionally use the actual database, history and job-queue packages. Root dependency manifests, migration order, application navigation and job admission wiring belong to integration.

## Verification

Focused checks:

```sh
npx tsc -b packages/database packages/job-queue packages/history services/processing-tasks packages/client-sdk apps/api
npx tsc -p apps/client/tsconfig.json --noEmit
npx vitest run services/processing-tasks/test/tasks.test.ts
TEST_DATABASE_URL="$LOCAL_TEST_DATABASE_URL" npx vitest run apps/api/test/incidents-postgres.test.ts
```

The database suite creates a unique temporary schema and removes it afterward. It exercises actual PostgreSQL migrations, scoped permissions including administrators, Fastify request validation and revision conflicts, atomic incident/result/outbox writes, retry idempotency, corrected/deleted sources, provider evidence validation, retention holds and history cleanup. A real pg-boss job pauses before terminal commit, receives a transcript correction and cannot persist late derivatives. The task suite covers generic registration, provider JSON metadata, exact evidence, empty results, hostile transcript text, candidates, literal rule safety and radio/frequency/time scopes.

## Acceptance limits

The incident screen is implemented and typechecked; integrated web interaction, native builds and accessibility review remain application acceptance. Generic provider metadata is covered without network calls; real provider output quality and credentials are separate acceptance. Deterministic rules and conservative extraction are deliberately limited linguistic heuristics, with false positives and false negatives. They provide review signals, never emergency dispatch or autonomous actions. No task receives a radio-control or shell capability.

Incident listing is cursor-paged. Detail returns the incident's full evidence, assessments and action history; dedicated pagination for very large incident audits is follow-up work. Rule count is bounded at 100 per instance. Person/organization extraction requires a capable configured provider; the local extractor currently emits only conservative place mentions.
