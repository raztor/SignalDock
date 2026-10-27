# Development

The operational core includes database-backed login and administration, radio-scoped permissions, a multi-radio dashboard, VGC frequency/memory control, browser RX/TX/PTT, private recordings and frequency history. See [core acceptance](implementation/core-acceptance.md) and [physical browser acceptance](implementation/vgc-acceptance.md). Optional processing, incidents, decoding/APRS and push are separate extension layers.

## Run locally

Use Node 24 (`.nvmrc`), npm 11 and PostgreSQL 18. Simulation requires no physical radio or cloud credential:

```sh
nvm use
npm ci
npm run build
npm run simulate
```

Set `DATABASE_URL` to a disposable development database and `SIGNALDOCK_DATA_DIR` to a private persistent directory. Start `npm run dev:api` and `npm run dev:client` in separate terminals. Without a database, the API serves discovery and health only. Select the backend's complete URL, read the one-time setup token from the private station-secrets file, and create the administrator. Radios and radio grants require explicit configuration; there are no default credentials or automatically enabled transmitters.

The data directory contains persistent station identity, protected keys and recordings. Never commit it or copy its identity to create another independent station. Remembered server URLs reject unexpected identity changes. Client sessions are isolated by server identity and user. HTTPS is required outside loopback development; a phone's localhost is not the development Mac.

## Media and drivers

Configure `LIVEKIT_URL`, optional `LIVEKIT_INTERNAL_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` for live browser media. Configure private gRPC endpoints and opaque credential references through the radio module. `SIGNALDOCK_DRIVER_CREDENTIALS_FILE` maps references to private absolute token files. Simulator RX/TX audio is intentionally unavailable.

The Mac Bluetooth helper runs natively outside Docker. Browser RX and AirPods microphone TX passed physical acceptance; startup choppiness remains an improvement item. Native device builds, physical Linux/Raspberry Pi and abrupt RF process-failure tests remain open rollout gates. Transmission never resumes automatically.

## Checks and generation

```sh
npm run check
npm run export:web
npm run generate:contracts
npm run check:generated
```

Database acceptance requires both `TEST_DATABASE_URL` and `SIGNALDOCK_TEST_DATABASE_URL`. Python interoperability requires `SIGNALDOCK_VGC_PYTHON`. Use disposable test databases. Tests use synthetic adapters and do not open Bluetooth. FFmpeg is required for codec tests.

Public runtime schemas live in `packages/contracts/src`. The private wire authority is `packages/radio-driver-sdk/proto/signaldock/driver/v1/driver.proto`; do not edit generated bindings manually:

```sh
python3.13 -m venv .venv-codegen
.venv-codegen/bin/python -m pip install -r scripts/codegen/requirements.txt
npm run generate:driver
npm run build
npm run check:driver
```

CI runs database, Python/TypeScript interoperability, web export and API-container checks. Fixture results do not replace physical or native-device acceptance. Full Compose services, backup restoration and ARM64 production-image media checks are supplied by the deployment layer.
