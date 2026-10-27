# Backend API

The Fastify application composes persistent station identity, one-time administrator bootstrap, local sessions, radio-scoped authorization, supervised radio runtimes, optional LiveKit media admission, private recording capture and frequency history.

Set `DATABASE_URL` and a protected `SIGNALDOCK_DATA_DIR`, build, then start `npm run dev:api` from the repository root. Without a database URL, discovery and health remain available. Read the private setup token locally; no default user or radio is created.

Application composition is in `src/app`; domain implementations and validators are in `src/modules`. Public routes are versioned under `/api/v1` and respect a configured instance prefix. Vendor control stays behind private driver RPC. Core operation needs no processing provider account.

See [development](../../docs/development.md), [core acceptance](../../docs/implementation/core-acceptance.md) and [the VGC module](../../services/drivers/vgc-benlink/README.md). Optional domains and standalone background-worker composition arrive in subsequent stack layers.
