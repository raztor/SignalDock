# Incident API

`registerIncidentRoutes(app, { prefix, auth, service })` installs authenticated routes. Instantiate `IncidentService(new SqlIncidentRepository(database, appendOutbox), auth)` after incident migrations `040_incidents` and `041_analysis_provenance`, and history migration `020_history`. The shared database foundations and identity table must also exist.

The module exports its migration rather than editing the central migration registry. It owns `sd_incident_rules`, rule-administration audit, `sd_analysis_results`, `sd_incidents`, `sd_incident_evidence`, and incident actions. Public incident records use the shared `IncidentRecord` contract.

| Method    | Path relative to `/api/v1`     | Purpose                                                                                    |
| --------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| GET       | `/incidents`                   | Permitted radios, optional `radioId`, state, opaque cursor and limit of 1–100.             |
| GET       | `/incidents/:id`               | Incident, immutable assessment provenance and operator actions.                            |
| PATCH     | `/incidents/:id`               | Expected revision plus state, assignee, retention hold or note.                            |
| GET, POST | `/incidents/rules`             | Administrator rule listing or creation/update. The server allocates a UUID when omitted.   |
| DELETE    | `/incidents/rules/:id`         | Administrator rule removal, with an audit entry.                                           |
| GET       | `/communications/:id/analysis` | Stored callsign, entity, summary and classification results for a permitted communication. |

Incident reads require both `incident.read` and `history.read` on the radio. Modifications also require `incident.manage`. An administrator needs explicit radio grants. Assigning another user requires `instance.admin`; the assignee must be an enabled user of this instance. Rule management requires `instance.admin`.

Acknowledgement and starting work assign the operator when unassigned. Resolution/dismissal requires a note; reopening is an explicit transition to acknowledged. Every modification checks `expectedRevision`, increments the revision and appends an audit entry. Automatic assessments never resolve, dismiss, reopen or release a hold.

Worker methods compute outside a transaction, then write all derivatives through the queue's terminal `execution.commit`. They reload the exact current transcript revision under a source lock before persistence. Result IDs are idempotent and cannot be reused with changed content. Evidence and `incident.created`/`incident.updated` outbox references commit atomically. Outbox payloads carry opaque IDs, not transcripts.

Provider completion uses `service.acceptProcessingResult(transaction, request, result, signal, originalSource)` from inside the processing runtime's existing terminal transaction. It opens no transaction and performs no external I/O. The hook handles normalized callsign, entity, summary and emergency results; other tasks return `{ handled: false }` for hook composition. It requires the original communication ID/revision and transcript revision ID, matches frozen request text, validates job/profile/task/evidence references, and persists source and provider provenance. Emergency output follows the same incident creation and aggregation path as local rules.

Same-radio, confirmed-frequency positive assessments can aggregate within a five-minute source-time window. Unknown-frequency sources only update incidents already linked to the same communication. Revised transcripts preserve previous evidence and human decisions. Each assessment stores task/version, connector, profile revision, input hash and source revision reference. Automatic titles contain no transcript-derived content.

New incidents hold source evidence by default. History deletion rejects held evidence. After an explicit release, history deletion removes associated analysis results and quoted evidence before deleting transcript revisions; incident state and operator audit remain. Human-authored decision notes are retained as audit records.

See [analysis implementation](../../../../../docs/implementation/analysis.md) for worker wiring and acceptance evidence.
