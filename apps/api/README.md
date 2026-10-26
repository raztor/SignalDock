# API backend

TypeScript/Fastify backend with authenticated identity, radios, media, history, processing, incidents, APRS and notifications. `app/station.ts` owns composition, migrations, lifecycle and cross-domain hooks. The API starts without operational modules only when `DATABASE_URL` is absent.

```text
src/main.ts                    Process bootstrap and shutdown
src/app/                       Server composition and base-path configuration
src/modules/<domain>/          Domain routes, services, and storage boundaries
src/shared/http/               Common errors and HTTP response policy
test/                          API integration and identity tests
```

`app/create-server.ts` registers discovery and accepts explicit operational composition. Keep vendor protocols in drivers, provider protocols behind the processing SDK, and shared DTOs in `@signaldock/contracts`. The generated OpenAPI catalog derives paths from actual route registrations and links each domain validator.

`worker.ts` runs the same composition with HTTP and radio admission disabled. It executes installed handlers against the same persistent identity, private artifacts and station-scoped queue. Set `SIGNALDOCK_EMBEDDED_JOBS=false` in the API when using that worker. Only one process may own a physical radio runtime.

From the repository root: `npm run dev:api`, `npm run check`, and `npm run build`. Configuration and identity storage are described in [development setup](../../docs/development.md).
