# API backend

TypeScript/Fastify backend. Implemented endpoints currently provide instance discovery and health only; local authentication and operational radio routes remain planned.

```text
src/main.ts                    Process bootstrap and shutdown
src/app/                       Server composition and base-path configuration
src/modules/<domain>/          Domain routes, services, and storage boundaries
src/shared/http/               Common errors and HTTP response policy
test/                          API integration and identity tests
```

`app/create-server.ts` explicitly registers implemented modules. A folder's presence never enables an endpoint. The [module map](src/modules/README.md) marks current and planned areas. Keep vendor protocols in drivers, provider protocols behind the processing SDK, and shared DTOs in `@signaldock/contracts`.

From the repository root: `npm run dev:api`, `npm run check`, and `npm run build`. Configuration and identity storage are described in [development setup](../../docs/development.md).
