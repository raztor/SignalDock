# Background worker application

The standalone worker uses the shared backend composition entry point `apps/api/dist/worker.js` (`npm run start:worker`). It starts station-scoped jobs and outbox dispatch without opening HTTP or physical radios. The deployment worker uses the API image so migrations, domain services and shared package versions stay aligned.

Handler files in this directory are compatibility exports or small registration functions. Concrete reusable handlers live in the corresponding shared packages. API and worker processes must share `DATABASE_URL` and `SIGNALDOCK_DATA_DIR`; each station has its own queue schema. Persistent encryption/identity keys must survive worker replacement.

Provider implementations live under `services/processing-connectors`; task execution contracts live in `packages/processing-sdk`. Workers must preserve job provenance, cancellation, owner scope, and deletion semantics.
