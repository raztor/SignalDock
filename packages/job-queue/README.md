# PostgreSQL job queue

`PostgresJobQueue` implements the shared queue port using pg-boss for scheduling and the SignalDock job ledger for ownership, idempotency, attempts, deadlines, cancellation, and source validity. `enqueue(input, transaction?)` inserts the ledger and publication outbox atomically with an optional caller transaction. Internal `job.enqueue` events are exclusively acknowledged by this adapter; generic event delivery excludes them.

Register handlers before `start`. Handlers receive `(job, signal, execution)`. Remote/provider work happens before persistence. Their final derivative write must use `execution.commit(tx => ...)`, which locks source first, validates current attempt/cancellation/deadline, commits derivative writes, and marks the job complete in the same transaction. The commit is terminal and allowed once; do not perform network work inside it or persist derivatives afterward. Own transcript revision updates do not invalidate a successful committed result.

Source-bound jobs require the constructor's `validateSource(job, tx)` implementation. Without a validator they fail closed. Workers poll cancellation across processes, abort on deadline, fence stale attempts, use bounded retries/concurrency/queue size, and preserve completed/cancelled states. Missing handlers/configuration remain visible rather than retrying forever. A replayed provider call may still occur after a crash before persistence; this is not an exactly-once external-side-effect guarantee.

`stop` aborts active handlers and drains pg-boss. Production migrations include `foundationMigrations` from the database package. Real integration tests require PostgreSQL 18 through `TEST_DATABASE_URL` and isolate business/pg-boss schemas per suite.
