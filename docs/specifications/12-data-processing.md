# Data model, files, and jobs

## Persistence

PostgreSQL is the proposed source of truth. Start with a private persistent recording volume behind an artifact-storage interface; add an S3-compatible implementation without changing communication IDs or processing contracts. Do not store large audio blobs in ordinary message rows.

| Domain | Main records |
|---|---|
| Identity | InstanceIdentity, User, RoleAssignment, Session, AuditEntry |
| Radios | Radio, DriverInstallation, DriverConfiguration, CapabilitySnapshot, TuningSnapshot, ControlGrant, TxSession, CoverageInterval |
| History | FrequencyConversation, Communication, Recording, TranscriptRevision, Annotation, AnalysisResult |
| Digital/incidents | Packet, AprsPosition, Incident, IncidentEvidence, IncidentAction |
| Processing | ConnectorConnection, CredentialReference, ProcessingProfile, ProcessingJob, JobAttempt |
| Notifications | Notification, NotificationPreference, DeviceSubscription, RelayGrantReference, DeliveryAttempt |
| Reliability | EventOutbox, ConsumerCheckpoint |

All source records carry ownership and radio context. Client-side caches also include instance identity, even if two self-hosted databases generate identical local IDs.

## Communication integrity

Communications retain direction/kind, captured start/end, frequency/signaling/power snapshot, attribution evidence, driver generation, and gap/discontinuity markers. Recording metadata includes content checksum, format, size, storage reference, and lifecycle state.

Transcripts and analysis are versioned derivatives. Store provider/connection/profile/model/schema versions and input revision/checksum. Human corrections are distinct from provider output. Derived output cannot overwrite source evidence or resurrect deleted input.

Use constraints for radio/conversation ownership and uniqueness of idempotency keys. Create user-visible notification/communication state and outbox records transactionally. External delivery and processing are at-least-once with deduplication, not an unsupported exactly-once claim.

## Jobs

States: `queued`, `running`, `retry_wait`, `completed`, `failed`, `cancelled`, `requires_configuration`. Every attempt has deadline, input revision, profile revision, usage owner, correlation ID, result/error, and available usage metrics.

Use bounded retries, concurrency, and backpressure. Live media/control has priority over STT, summaries, and offline decoding. A slow worker cannot grow memory or disk queues without bounds. Database-backed jobs are sufficient initially; introduce Redis or another broker only if justified by measured contention/throughput.

Cancellation propagates to connectors and suppresses late writes. Deleting a recording invalidates dependent work. Quota or missing credentials are visible states, not infinite retries.

## Retention, backup, and export

Configurable independent retention for audio, text, packets, analysis, audit, and delivery metadata. Incident holds and permissions constrain deletion. Define behavior for disk full: preserve control and disclose recording gaps unless an explicit instance policy requires recording before allowing TX.

Backups include database, artifacts, instance identity, and protected configuration/credential recovery material. Test restoration into an isolated environment. A deliberate clone gets a new instance identity; restoring the same instance preserves it.

Exports use stable IDs, timestamps, formats, provenance, and checksums. Downloads are authorized and auditable; raw secret/configuration stores are not part of ordinary history exports.

## Acceptance

Duplicate job, worker crash after provider success, late response after cancellation/deletion, profile changed during processing, storage failure, retained incident evidence, backup restoration, and two-radio quota isolation. A restored history must still resolve its recordings and provenance.
