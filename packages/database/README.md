# PostgreSQL persistence

`PostgresDatabase` implements the shared `DatabasePort` with node-postgres. Transactions keep one checked-out connection; nested transactions use savepoints. `close` drains the pool and `health` reports connectivity without exposing connection details.

`migrate` applies sorted `{ id, sql }` migration providers inside an advisory-locked transaction. IDs use `000_name`; applied SQL checksums are immutable. Domain modules contribute their own arrays and application composition registers them. `foundationMigrations` owns the job ledger and transactional event outbox. `appendOutbox(tx, event)` inserts alongside domain writes; `dispatchOutbox` supports multiple consumers with row locking and at-least-once delivery.

Production requires PostgreSQL 18. Integration tests run only with an explicit `TEST_DATABASE_URL`, create a private temporary schema, and remove it afterward. A missing URL means those tests are skipped, never a PostgreSQL acceptance claim.

For development on a machine without containers, run `node packages/database/scripts/dev-postgres.mjs` with Node 24 and npm. It installs the pinned portable PostgreSQL 18.4 development runtime into ignored `.local/pg-runtime`, keeps data in `.local/postgres18`, binds only loopback port 55432, and prints a test-only URL. `SIGNALDOCK_DEV_PG_PORT` changes the port. The runtime is isolated from workspace `node_modules` so ordinary dependency installs cannot remove libraries from a running database. Startup verifies both the server version and PL/pgSQL loading. Stop with Ctrl+C; data persists. Never use these fixed local credentials or this development helper in production. CI and deployed installations use an official PostgreSQL 18 service.
