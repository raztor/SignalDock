# Deployment

SignalDock runs a PostgreSQL-backed API, a separate durable worker, and an Expo web export. LiveKit is optional. The VGC driver runs separately with access to its host Bluetooth transport. Preserve the AGPL license and the driver module's benlink attribution when distributing builds.

## Install

Use Docker Compose v2 and Node 24 for the initial secret-generation command:

```sh
npm run setup:deploy
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d
```

`deploy/.env` is created privately and never overwritten. Back it up securely. The web UI listens on `http://localhost:8080`; the API listens on `http://localhost:3000`. Both ports bind to loopback. Configure the API URL in the client. No account or radio is created automatically. Read the one-time bootstrap token from the API's private `/data` volume, complete administrator setup, then add users, radio configurations, and explicit radio grants. The token is consumed once; do not expose it in public logs.

The API and worker share the database and `/data` volume, including station identity, provider credential keyring, and recordings. They must represent the same station. Each station has scoped queue and outbox consumption. The worker does not open radios. Do not run competing radio-owning API processes for one station.

## HTTPS and prefixes

Put the web UI and API behind an HTTPS reverse proxy. Set `SIGNALDOCK_ALLOWED_ORIGINS` to the exact public web origin. For a prefixed API, set `SIGNALDOCK_BASE_PATH` and preserve that path at the proxy. Set `WEB_BASE_PATH` before building a prefixed web export and rebuild the web image after changing it. These prefixes can differ: clients store the complete backend base URL.

Set `SIGNALDOCK_COOKIE_ORIGIN` when using cookie-based session refresh behind a proxy. The standalone client uses isolated bearer sessions and platform-protected refresh-token storage. Never put backend credentials in a web build or URL.

## Live media

Media remains disabled while `LIVEKIT_URL` is empty. To enable it, configure a reachable public `wss://` endpoint, then start the media profile:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile media up --build -d
```

`LIVEKIT_URL` is the client-visible address. `LIVEKIT_INTERNAL_URL` is the private server-to-server WebSocket address. The example uses `ws://livekit:7880` internally. Terminate TLS for the public endpoint and configure LiveKit's advertised address and RTC ports for the deployment network; an HTTPS proxy alone does not route RTC traffic. Review `livekit.yaml`, NAT/firewall routing, and TURN requirements before remote use. No cloud media account is required.

Browser RX and microphone TX were accepted on the development Mac. Native device audio, physical Linux/Raspberry Pi transport, and RF disconnect/process-kill fault tests remain separate rollout gates. Transmission never resumes automatically after a restart.

## VGC driver

See [the driver module](../services/drivers/vgc-benlink/README.md) for its Python image, configuration, private gRPC authentication, audio transport, and host requirements. The driver's endpoint and token reference are configured in a radio's private driver configuration. Mount the referenced credentials file privately in the API and set `SIGNALDOCK_DRIVER_CREDENTIALS_FILE`; never return driver tokens through public APIs. Align socket/volume ownership with the unprivileged container user.

The development Mac's Bluetooth helper runs natively, outside Docker. The Linux image does not establish physical Linux hardware acceptance. Do not expose the private driver RPC publicly or grant the web container access to Bluetooth.

## Optional push relay

The relay entry point is included in the backend image at `apps/push-relay/dist/main.js`. Run it as a separate service with its own database and private configuration (`RELAY_DATABASE_URL`, `RELAY_TOKEN_KEY_BASE64`, `RELAY_PROJECT_ID`, `RELAY_ENROLLMENT_SECRET`, and `EXPO_ACCESS_TOKEN`). Configure the station's `SIGNALDOCK_RELAY_URL` and its signed installation enrollment. See [the relay module](../apps/push-relay/README.md) for the exact interface.

Private enrollment, signature, replay, revocation, and receipt tests are implemented. Public enrollment remains disabled until the security and real-device delivery gates pass. A self-hosted station can operate without a relay or processing credentials.

## Backup and restoration

Stop writes and back up the database **and** private instance data together:

```sh
bash scripts/ops/backup.sh /absolute/private/new-backup-directory
```

The script pauses the API and worker, writes a custom-format PostgreSQL dump and a compressed `/data` archive, and restarts only services that were previously running. Preserve the protected directory and deployment secrets. Recordings without database metadata, or database metadata without identity/keyring/artifacts, are incomplete backups.

Restore only into a fresh database and empty instance-data volume, with API and worker stopped. Use the matching PostgreSQL client to run `pg_restore --no-owner --no-privileges`, extract `instance-data.tar.gz` into the private volume, restore deployment secrets and ownership, then start the services. Verify the station ID, user login, provider credential decryption, and recording playback. Control leases and active transmissions are never restored.

`npm run check:backup` exercises a disposable database dump/restore, persistent identity, login, artifact bytes, and absence of restored control grants. It requires PostgreSQL client tools (`SIGNALDOCK_PG_BIN_DIR`) or Docker. Never point maintenance tooling at another station's data.

## Verification and distribution

CI runs the full TypeScript/Python contract suites, real PostgreSQL jobs, web export, backup restoration, hardened API/worker containers, prefixed web assets, and a real LiveKit PCM round trip on Linux ARM64. These checks must pass on the published revision before claiming deployment acceptance. Docker is unavailable on the development Mac, so local checks alone do not establish container acceptance.

`npm run check:licenses` emits a dependency license inventory under `.local/reports`. Review third-party notices and FFmpeg distribution obligations for released images. Later production gates include native iOS/Android audio and push, external-account onboarding, and physical Linux/Raspberry Pi operation.
