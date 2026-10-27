# Docker, deployment, and operations

## Supported environments

- Development: macOS, with the minimum native hardware driver transport outside Docker.
- Production: Linux mini PC or Raspberry Pi, with `amd64`/`arm64` images tested on actual target hardware.
- Simulation: no radio or paid provider required.

The entire product stack is containerized where practical. Physical device access is isolated to the radio runtime/driver boundary. Do not promise that Docker Desktop exposes Mac Bluetooth identically to native Linux.

## Proposed Compose services

Web client/reverse proxy; API; PostgreSQL; processing worker; media transport; radio runtime plus selected drivers. The relay is a separate optional Compose deployment. Optional storage/local-processing services are profiles, not mandatory dependencies.

Start with one deployable backend and worker rather than many independently administered services. Local files use persistent volumes; database migrations are versioned. Keep provider keys, instance keys, app delivery credentials, and development credentials outside images and source control.

## Setup experience

Installation generates instance identity, offers one-time administrator bootstrap, configures public URL/prefix and allowed web origins, and enables installed radios/connectors through validated schemas. Default core startup works with processing/push disabled.

For each driver, document Bluetooth/serial/sound/GPIO/network access and minimum host permissions. Validate Linux BlueZ/D-Bus/RFCOMM access as appropriate; do not place all containers in privileged mode. Host-installed prerequisites and pairing remain explicit installation steps.

## Network and media

Terminate valid HTTPS; document reverse-proxy headers, WebSocket upgrades, media ports, and optional TURN configuration for networks that require relay traversal. The push relay is unrelated to a WebRTC TURN relay and does not make a private backend reachable.

Same-origin self-hosted web is the simplest default. A published universal web client needs appropriate CORS and browser private-network compatibility. Native apps still need reachability through LAN/VPN/public HTTPS.

## Operations

Health separates API/database/storage/worker/media/each driver/provider/relay. Report queue depth, recording gaps, audio latency/loss, driver reconnects, TX uncertainty, disk usage, and delivery failures. Avoid secrets and full sensitive payloads in routine logs.

Set resource limits so local analysis or decoders do not starve radio control. Support graceful shutdown, maintenance mode that prevents new TX, identity-preserving backup/restore, versioned upgrades, and documented rollback limits after migrations.

Build immutable tagged images and publish architecture/driver support explicitly. Preserve third-party notices and produce a dependency/license inventory. Do not mark a release complete merely because containers start.

## Acceptance

Fresh install without external keys; prefix HTTPS deployment; two simulated radios; sustained capture under processing load; no-Internet local operation; full disk; worker/API/driver restarts; backup restore; upgrade/migration; and actual Linux Bluetooth RX/TX. Push and cloud processing outages must not stop local operation.
