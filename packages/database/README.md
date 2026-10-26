# PostgreSQL persistence

`PostgresDatabase` implements the shared `DatabasePort` with node-postgres. Transactions keep one checked-out connection; nested transactions use savepoints. `close` drains the pool and `health` reports connectivity without exposing connection details.

`migrate` applies sorted `{ id, sql }` migration providers inside an advisory-locked transaction. IDs use `000_name`; applied SQL checksums are immutable. Domain modules contribute their own arrays and application composition registers them. `foundationMigrations` owns the job ledger and transactional event outbox. `appendOutbox(tx, event)` inserts alongside domain writes; `dispatchOutbox` supports multiple consumers with row locking and at-least-once delivery.

Production requires PostgreSQL 18. Integration tests run only with an explicit `TEST_DATABASE_URL`, create a private temporary schema, and remove it afterward. A missing URL means those tests are skipped, never a PostgreSQL acceptance claim.
