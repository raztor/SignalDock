# VGC / benlink radio module

This module owns VGC-specific integration for SignalDock. Its existing tools validate the VR-N7500 over BLE and Bluetooth Classic; the production adapter for the manufacturer-independent Radio Driver API remains planned.

## Credits

The VGC integration builds on **[benlink](https://github.com/khusmann/benlink)** by **[khusmann](https://github.com/khusmann)** and the benlink contributors. Credit belongs to the upstream project for its radio protocol research and documentation, Python control API, and audio-message framing used by these validation tools.

Upstream repository: [github.com/khusmann/benlink](https://github.com/khusmann/benlink). Upstream license: [Apache License 2.0](https://github.com/khusmann/benlink/blob/main/LICENSE). The validated dependency is pinned to [revision c4b9d221](https://github.com/khusmann/benlink/tree/c4b9d22112402ea193d376f412bc028d1778fdb4) in [requirements-validation-macos.lock.txt](requirements-validation-macos.lock.txt). Preserve upstream license and attribution notices when distributing that dependency. SignalDock's own [project license](../../../LICENSE) remains unchanged.

## Layout

```text
vgc-benlink/
  README.md
  requirements-validation-macos.lock.txt
  src/                   Production driver implementation boundary (planned)
  transports/macos/      Native development transport and launcher
  validation/            Existing discovery, tuning, RX conversion, and TX tools
```

The Python production driver belongs under `src`; it will implement the [Radio Driver SDK](../../../packages/radio-driver-sdk/README.md). Bluetooth identifiers, device quirks, codec handling, and Mac/Linux transport choices stay inside this module. Product clients and backend domain modules use generic radio contracts.

## Validation commands

Run from the repository root:

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install -r services/drivers/vgc-benlink/requirements-validation-macos.lock.txt
.venv/bin/python services/drivers/vgc-benlink/validation/radio_probe.py --help
.venv/bin/python services/drivers/vgc-benlink/validation/radio_probe.py scan --seconds 12
```

The first validation command prints help; the second accesses Bluetooth for discovery. See [hardware validation](../../../docs/hardware-validation.md) for frequency, capture, restoration, and TX procedures. Hardware writes/transmission require explicitly prepared tests; repository checks do not access a radio.

All validation outputs remain in the repository-root `results/` directory, which is excluded from Git. Existing recordings and reports retain their original paths. The native launcher resolves the root `.venv` and `results` directory independently of its working directory.

## Environment and status

macOS is the current development/test environment. The native helper is a local transport shim. Linux/BlueZ/RFCOMM packaging, sustained operation, physical cancellation/release conformance, and production gRPC integration still require their acceptance gates. The Mac validation lock is not a Linux production dependency list.
