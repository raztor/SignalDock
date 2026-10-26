# SignalDock

An open-source, self-hosted platform for operating multiple radios from configurable web and mobile clients.

Repository: [raztor/SignalDock](https://github.com/raztor/SignalDock). The project uses the existing [GNU Affero General Public License v3](LICENSE).

The project is currently in the specification and hardware-validation stage. The application, public API, Docker deployment, mobile releases, and push relay have not been built yet.

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

Confirmed: device/configuration reads, temporary RX-frequency write and full restoration, clear received voice playback on Mac, two-tone transmission, observed PTT activation/release, and receiver-side confirmation. This does not establish live network microphone operation or production Linux compatibility.

Create the validated Mac environment:

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
```

The lock file is specific to the tested Mac environment. Linux dependencies and driver packaging will be validated separately; PyObjC packages are not portable Linux requirements.

Read-only discovery and probe:

```sh
.venv/bin/python radio_probe.py scan --seconds 12
.venv/bin/python radio_probe.py probe RADIO_BLE_UUID --watch 15
```

`frequency_probe.py` and `tx_probe.py` require `--apply` to perform writes or transmit. Do not run hardware commands simply to validate documentation or syntax. Reports/recordings in `results/`, the virtual environment, native build outputs, and upstream checkout are excluded from source control.

## Development and production

Develop and perform current tests on macOS. Production will target Linux mini PCs/Raspberry Pi. Product frontend/backend are planned in TypeScript; hardware drivers and processing tools may use specialized runtimes behind versioned contracts.

There is no requirement for a central account or cloud processing key to operate a self-hosted core. Public app signing, optional relay credentials, and third-party provider credentials are deployment concerns and will not be committed to this repository.
