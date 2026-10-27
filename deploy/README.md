# Operational API image

`api.Dockerfile` builds the complete backend workspace and installs the API's production dependency closure. It runs as an unprivileged user with persistent private data under `/data`, and includes FFmpeg for audio conversion. The existing Compose slice exposes discovery by default; full database/worker/web/media packaging follows in the deployment layer.

For the operational API, supply a reachable PostgreSQL 18 `DATABASE_URL`, mount a persistent `/data` volume, and configure allowed browser origins and the public path prefix. Read the one-time setup token privately, bootstrap the administrator, and configure radios and explicit grants. No transmitter is enabled automatically.

Live media requires the documented LiveKit URL/key/secret variables; private radio RPC requires a protected credential-reference mapping. Do not expose driver endpoints publicly or give the web client Bluetooth access. The Mac helper runs outside Docker. See [development](../docs/development.md), [core acceptance](../docs/implementation/core-acceptance.md), and [infrastructure specifications](../docs/specifications/13-infrastructure.md).

CI builds and smoke-tests the API image. Clean full-stack installation, coordinated database/artifact restoration and ARM64 production-image media acceptance are separate deployment-layer gates; physical Linux/Raspberry Pi validation needs target hardware.
