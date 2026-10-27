# VGC browser acceptance — 2026-10-26

The Mac browser test passed for received voice, AirPods microphone transmission and PTT control of a physical VR-N7500. Transmitted voice was slightly choppy at startup, then stabilized and was confirmed to work well. Startup smoothness remains an improvement item.

## Prepared setup

The radio and an observing radio used 147.5400 MHz, simplex FM and DCS 023. The reserved test memory was set to the minimum available power, with its frequency, sub-audio and power verified by full readback. The original complete memory and settings were saved privately before any change.

The test used the TypeScript backend and browser client, self-hosted LiveKit, and the production Python VGC service. BLE supplied control/readback; the native Mac transport supplied Bluetooth Classic RFCOMM audio with benlink framing and continuous SBC/PCM conversion. This is evidence for Mac development operation; Linux production hardware was not involved.

## Observed results

- The user confirmed clear received voice in the browser at the prepared frequency and sub-audio setting.
- Browser PTT with the AirPods microphone activated transmission observed through the radio's BLE status. An initial test did not deliver useful voice; the user identified acoustic echo with the observing radio near the microphone.
- After moving and lowering the observing radio and turning browser listening off during TX, the user confirmed transmitted voice worked well after a briefly choppy start.
- Normal release and the configured eight-second test ceiling were exercised. The driver observed transmission followed by fresh physical idle. Stop uncertainty was exposed during cleanup/tail recovery and cleared by fresh state reconciliation; the test does not establish instantaneous RF release.
- The dashboard read 30 programmed memories from 32 physical slots. Two zero-frequency placeholders were omitted without invalidating the list.
- Offline, the production codec encoded the previously successful two-tone PCM into byte-identical SBC: 32 kHz mono, 16 blocks, eight subbands, bitpool 16 and 40-byte frames, grouped into 20 ms packets.

The automated VGC suite passed 38 tests at this acceptance revision, including actual authenticated Unix gRPC, synthetic FFmpeg conversion, full native helper compilation, stale ownership/generation rejection, cancelled opening, pending TX I/O, retired codec callbacks, asynchronous RX recovery and memory normalization. Simulated tests remain distinct from physical evidence.

## Restoration

After the backend and media sessions stopped, the private test TX flag was disabled and the driver was stopped. The production control/recovery code restored the complete original memory, including power and sub-audio, and all original settings, including A/B selection. A second BLE connection independently read both models back and matched the saved originals exactly. Fresh status confirmed physical TX idle. No transmission was attempted during restoration.

The recovery journal has no pending entry. The test driver, native helper and state watcher were stopped. Private device identifiers, credentials, voice recordings and detailed reports remain excluded from Git.

## Remaining gates

This test does not establish fully smooth TX startup, abrupt driver/OS failure behavior, blocked native write conformance, all browser/network interruption cases, native iOS/Android audio, or physical Linux/Raspberry Pi operation. Linux ARM64 packaging and host Bluetooth permissions also need their deployment checks. Transmission remains experimental and requires explicit enablement for further coordinated tests.

See the [implementation guide](vgc.md) for contracts, configuration and recovery, and the [module attribution](../../services/drivers/vgc-benlink/README.md#credits) for benlink credits and licensing.
