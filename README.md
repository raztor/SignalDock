# SignalDock

An open-source, self-hosted platform for operating multiple radios from configurable web and mobile clients.

Repository: [raztor/SignalDock](https://github.com/raztor/SignalDock). The project uses the existing [GNU Affero General Public License v3](LICENSE).

SignalDock includes a TypeScript/Fastify backend and Expo client with instance login, administration, scoped multi-radio control, browser RX/TX/PTT, private recordings and frequency-based history. Optional modules provide processing profiles, speech adapters, transcript analysis/incidents, recorded-audio decoding/APRS, and notification history with a private push relay. Core operation requires no cloud-processing credentials.

The browser path has been tested with a physical VGC VR-N7500 on macOS, including received voice, AirPods microphone transmission and observed carrier termination. Native device execution, physical Linux/Raspberry Pi validation, real external account onboarding and public relay activation have separate release gates. See [operational composition](docs/implementation/operational-core.md) and [physical acceptance evidence](docs/implementation/vgc-acceptance.md).

## Repository structure

| Area | Location |
|---|---|
| Web/mobile frontend | [apps/client](apps/client/README.md) |
| Backend API and domain modules | [apps/api](apps/api/README.md) |
| Background worker and optional push relay | [apps](apps/README.md) |
| Shared contracts, SDKs, and presentation | [packages](packages/README.md) |
| Radio runtime and hardware/provider integrations | [services](services/README.md) |
| Generation, checks, development, and maintenance | [scripts](scripts/README.md) |
| Docker and deployment | [deploy](deploy/README.md) |

The [full folder/module map](docs/architecture/repository-layout.md) describes dependency and ownership boundaries.

## Start development

```sh
nvm use
npm ci
npm run check
npm run simulate
```

Start PostgreSQL 18, or run the optional local runtime with `node packages/database/scripts/dev-postgres.mjs`. Set `DATABASE_URL` to that database and run `npm run dev:api`; run `npm run dev:client` in another terminal. Select `http://localhost:3000`, use the setup token from the private `.local/instance/station-secrets.json` file to create the administrator, and assign explicit radio permissions. With no database configured, the API intentionally serves discovery only.

For containers, run `npm run setup:deploy`, then `docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d`. The web client is at `http://localhost:8080`; its backend URL is configurable. Configure the optional media service and radio driver separately using the [deployment guide](deploy/README.md). Do not commit the generated `.env`, identity, provider keys or recordings.

## Product specification

Start with the [specification index](docs/specifications/README.md). It defines the dashboard, multi-server login, per-radio control, live audio/PTT, conversations with audio/transcripts, processing connectors, incidents, digital decoding/APRS, push relay, open-source distribution, and implementation gates.

Key extension boundaries:

- [Radio Driver SDK](docs/specifications/19-radio-driver-sdk.md): manufacturer-independent control/audio/PTT capabilities; initial implementation through VGC/benlink.
- [Processing Connector SDK](docs/specifications/17-processing-connectors.md): independent providers for STT, TTS, callsigns, emergencies, summaries, and future local/remote integrations.
- [Server/session contract](docs/specifications/01-servers-sessions.md): one published client can connect to independently hosted backends by URL.
- [Optional notification relay](docs/specifications/10-notifications-relay.md): low-configuration mobile delivery without sharing publisher secrets with instance owners.
- [Implementation plan](docs/specifications/15-implementation-acceptance.md): component boundaries, dependencies, and acceptance criteria.

All maintained documentation, comments, interface copy, and CLI messages use English. Received radio content, device memory names, historical evidence, and upstream dependencies retain their original language.

## Hardware validation tools

Current proofs use a VR-N7500, Python 3.13/benlink, and a minimal macOS `IOBluetooth` transport. See [hardware validation](docs/hardware-validation.md) for results, commands, limitations, and recovery notes.

The tools now live in the [VGC module](services/drivers/vgc-benlink/README.md), whose README credits [khusmann/benlink](https://github.com/khusmann/benlink) and links its upstream license.

Confirmed: device/configuration reads, frequency control and full restoration, clear browser RX, browser transmission using the AirPods microphone, recording playback and observed PTT activation/release. Initial microphone startup was briefly choppy before stabilizing. These Mac results do not establish physical Linux compatibility or native mobile acceptance.

Create the validated Mac environment:

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install -r services/drivers/vgc-benlink/requirements-validation-macos.lock.txt
```

The lock file is specific to the tested Mac environment. Linux dependencies and driver packaging will be validated separately; PyObjC packages are not portable Linux requirements.

Read-only discovery and probe:

```sh
.venv/bin/python services/drivers/vgc-benlink/validation/radio_probe.py scan --seconds 12
.venv/bin/python services/drivers/vgc-benlink/validation/radio_probe.py probe RADIO_BLE_UUID --watch 15
```

`frequency_probe.py` and `tx_probe.py` require `--apply` to perform writes or transmit. Do not run hardware commands simply to validate documentation or syntax. Reports/recordings in `results/`, the virtual environment, native build outputs, and upstream checkout are excluded from source control.

## Development and production

Develop and perform current tests on macOS. Production targets Linux mini PCs/Raspberry Pi. Frontend/backend use TypeScript; hardware drivers and processing tools use specialized runtimes behind versioned contracts. The small Mac Bluetooth transport is isolated in the VGC module.

There is no requirement for a central account or cloud processing key to operate a self-hosted core. Public app signing, optional relay credentials, and third-party provider credentials are deployment concerns and will not be committed to this repository.
