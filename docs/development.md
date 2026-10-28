# Development

SignalDock includes instance login and administration, radio-scoped permissions, multiple radio runtimes, VGC control and audio, browser PTT, recordings and frequency history. Optional processing, incidents, decoding/APRS, and notification modules are composed behind explicit configuration and capabilities. See the [acceptance plan](specifications/15-implementation-acceptance.md), [repository layout](architecture/repository-layout.md), and [physical browser acceptance](implementation/vgc-acceptance.md).

## Local setup

Use Node 24 (`.nvmrc`), npm 11, and PostgreSQL 18. The deterministic simulation does not require physical hardware or processing credentials:

Dependency versions follow the [compatible stable release matrix](implementation/dependencies.md). The TypeScript 7 compiler runs alongside the TypeScript 6 compiler API needed by contract generation and Expo tooling. CI and the driver image use Python 3.13.18; the Mac validation lock remains platform-specific.

```sh
nvm use
npm ci
npm run build
npm run simulate
```

Set `DATABASE_URL` and `SIGNALDOCK_DATA_DIR` before running `npm run dev:api`. Without a database URL the API exposes discovery and health only. The private data directory holds persistent station identity, bootstrap material, credential encryption keys, and artifacts. Never commit it. Read the bootstrap token locally, create the first administrator, then explicitly configure radios and permissions. There are no default credentials or automatically enabled transmitters.

Run `npm run dev:client` in a second terminal. Select the backend's complete URL in the client. HTTPS is required outside loopback development; a phone's `localhost` is not the development Mac. Recent server metadata is distinct from isolated authenticated sessions. SecureStore is used on native platforms; browser sessions remain separately scoped by server identity and user.

For separate jobs, set `SIGNALDOCK_EMBEDDED_JOBS=false` on the API and run `npm run start:worker` with the same database and private data directory. Only the API owns radio connections. Queue and outbox consumption are station-scoped.

## Configuration

See [deployment](../deploy/README.md) for Compose, HTTPS, optional LiveKit, private driver credentials, relay configuration, and backup/restore. The API supports `HOST`, `PORT`, `SIGNALDOCK_DISPLAY_NAME`, `SIGNALDOCK_BASE_PATH`, `SIGNALDOCK_ALLOWED_ORIGINS`, `SIGNALDOCK_COOKIE_ORIGIN`, `SIGNALDOCK_DATA_DIR`, and `DATABASE_URL`. Environment files are loaded explicitly with Node's `--env-file` option or by the deployment environment.

Preserve the station identity across restarts. A remembered URL whose identity changes is rejected until the saved entry is explicitly removed and the replacement is verified. Do not clone private identity data to create an independent station.

Live browser audio requires configured LiveKit and a capable physical driver. Simulator audio/PTT is intentionally unavailable. The Mac's VGC transport runs natively; Linux is the production target and needs its own physical validation. User-confirmed browser RX and AirPods microphone TX passed, with brief initial TX choppiness recorded as a follow-up. Native device audio and interruption acceptance remain pending.

## Contracts and checks

Public schemas live in `packages/contracts/src`; generated artifacts include runtime JSON schemas, declarations, and the registered route catalog. Route validators remain authoritative for endpoint-specific request/response envelopes. Do not edit generated artifacts manually.

```sh
npm run generate:contracts
npm run check
npm run check:dependencies
npm run export:web
npm run check:licenses
```

Database suites require both `TEST_DATABASE_URL` and `SIGNALDOCK_TEST_DATABASE_URL` pointing to a disposable PostgreSQL database. Configure `SIGNALDOCK_VGC_PYTHON` for the TS/Python interoperability suite. Python tests use synthetic adapters and do not open Bluetooth.

The private wire authority is `packages/radio-driver-sdk/proto/signaldock/driver/v1/driver.proto`. Regenerate bindings using Python 3.13 and the pinned codegen requirements:

```sh
python3.13 -m venv .venv-codegen
.venv-codegen/bin/python -m pip install -r scripts/codegen/requirements.txt
npm run generate:driver
npm run build
npm run check:driver
```

CI additionally runs Python adapter tests, real database/queue integration, backup restoration, hardened container checks, and Linux ARM64 LiveKit transport. Fixtures and mocked provider endpoints are software acceptance, not physical hardware or external-account acceptance. Keep native iOS/Android, physical Linux, public relay, and live provider credentials as explicit rollout gates.
