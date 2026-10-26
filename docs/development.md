# Development foundation

The repository contains a working foundation for W0 plus the discovery portion of W1. It is not yet an operational radio application. The full scope remains in the [implementation plan](specifications/15-implementation-acceptance.md).

## Run locally

Use Node 24 (`.nvmrc`) and npm 11. No radio, cloud account, database, or Python environment is needed for the TypeScript simulation and discovery UI.

```sh
nvm use
npm ci
npm run check
npm run simulate
npm run dev:api
```

In another terminal:

```sh
npm run dev:client
```

Open the web client from the Expo terminal. Check `http://localhost:3000` to discover the local API and remember it. The screen displays the server identity and current availability; there is no working sign-in or radio dashboard yet. Expo web export is available with `npm run export:web`. Native build/device acceptance, live media, and background behavior remain G1 work.

The client requires HTTPS outside loopback development. A phone needs a reachable HTTPS backend; `localhost` on the phone is not the Mac. Only non-secret recent-server metadata is persisted. No password, bearer token, or refresh token is implemented or saved in this slice.

## Workspace boundaries

| Location | Implemented responsibility |
|---|---|
| `packages/contracts` | Runtime schemas, inferred TS models, version/error conventions, generated JSON Schema/OpenAPI/TS declarations |
| `packages/client-sdk` | Prefix-aware discovery, protocol/identity validation, serialized recent-server storage |
| `packages/radio-driver-sdk` | Control abstraction, two simulator capability sets, private protobuf contract and generated TS/Python bindings |
| `services/radio-runtime` | In-memory registry, per-radio control leases, resource-group exclusion, tuning revisions/deadlines and bounded idempotency records |
| `packages/processing-sdk` | Connector registry, connection/profile/owner boundaries, local-only policy, cancellation and deterministic text/STT fixtures |
| `apps/api` | Fastify discovery/health, durable Ed25519 instance identity, configured CORS and URL prefixes |
| `apps/client` | Expo web/mobile source for server discovery and recent servers |
| `deploy` | Discovery API container and Compose definition; no hardware access requested |

The runtime and fixture connectors are exercised by tests and the simulation command; they are not exposed through unauthenticated API routes. Simulator audio/PTT capabilities are disabled. Fixture transcripts are known text selected by artifact ID, not speech recognition. No external processing is called.

The private driver protobuf describes future media/TX RPCs but no gRPC listener, TX supervisor, media engine, or VGC production adapter has been implemented. Generated interfaces are not evidence of an operational transport. The public OpenAPI document lists only implemented discovery and health routes. Other component schemas are provisional foundations, not public mutation endpoints.

## Configuration and identity

The API reads environment variables from its process. To load a file explicitly, use Node's `--env-file` option; copying an environment file alone does not load it.

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address; container uses `0.0.0.0` |
| `PORT` | `3000` | HTTP port |
| `SIGNALDOCK_DATA_DIR` | repository `.local/instance` | Persistent identity directory; container uses `/data` |
| `SIGNALDOCK_DISPLAY_NAME` | `SignalDock station` | Public station name |
| `SIGNALDOCK_BASE_PATH` | empty | Direct deployment prefix such as `/station/north` |
| `SIGNALDOCK_ALLOWED_ORIGINS` | `http://localhost:8081` | Comma-separated allowed browser origins |

Identity is atomically created with a protected private key and reused on restart. Invalid or mismatched keys stop startup rather than silently replacing the station. Discovery returns only the public identity. Preserve the identity directory in backups; do not copy it to create a second independent station. Changed identities at remembered URLs are rejected until the saved entry is explicitly removed and the replacement is verified.

When the API itself handles a prefix, preserve that prefix at the reverse proxy. A proxy that strips its prefix may leave `SIGNALDOCK_BASE_PATH` empty; clients still use the public prefixed base URL. Generated OpenAPI paths are relative to the instance base. Production HTTPS termination remains an operator setup step.

## Contracts and generation

Public/domain schemas in `packages/contracts/src` are the authority for JSON contracts. `z.infer` supplies implementation types. Generate interchange schemas, OpenAPI, and TS declaration artifacts with:

```sh
npm run generate:contracts
npm run check:generated
```

The independent private wire authority is `packages/radio-driver-sdk/proto/signaldock/driver/v1/driver.proto`. Do not hand-edit generated bindings. To regenerate:

```sh
python3.13 -m venv .venv-codegen
.venv-codegen/bin/python -m pip install -r scripts/requirements-codegen.txt
npm run generate:driver
npm run build
npm run check:driver
```

The final command sends binary frames from TypeScript to Python and back, checking audio bytes and 64-bit media clocks. A future driver transport must validate and map wire values into normalized schemas before applying operations. In particular, protobuf integer widths do not bypass JS safe-integer checks for domain revisions/frequencies.

## Verification

`npm run check` builds the Node packages, type-checks client and tests, runs the contract/runtime/SDK/API suites, checks formatting, and detects stale generated JSON artifacts. CI additionally regenerates both driver bindings, checks cross-language interoperability, exports the web app, and builds/smoke-tests the API container. Native mobile and physical-radio tests are separate gates.

Docker is not installed on the development Mac. The container definition is verified through the Linux CI job before claiming container acceptance. It installs only API/contracts production dependencies in the runtime image, excludes Expo CLI tooling, preserves the project license, runs as a non-root user, and stores instance identity in a volume.

```sh
docker compose -f deploy/compose.yaml up --build
```

This starts discovery only. Database, authentication, recording, media, providers, relay, and Linux Bluetooth integration are later packages.

## Dependency findings

The initial October 26, 2026 audit reports five high-severity findings in the Expo CLI dependency chain, including `node-forge` and the CLI's Zod 3 dependency. The registry currently offers no compatible patched `node-forge` release; the CLI still requests Zod 3. Do not force a cross-major replacement or downgrade the entire Expo SDK merely to suppress the report. Track upstream fixes before mobile publication. The core contracts use patched Zod 4.6.7; the backend runtime dependency installation excludes Expo, its CLI, and `node-forge`.

Sources: [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). This is an observed dependency finding, not a completed production security review.

## Next implementation stages

Finish G0 with transport adapters, fuller capability/conformance coverage, and contract review. Continue W1 session context isolation and W2 local authentication/admin before exposing radios. Then connect the W3 runtime to authenticated routes and implement W4's VGC adapter. W5/G1 validates real microphone/RX/PTT and native interruption behavior. No simulator test replaces the physical release and Linux production gates.
