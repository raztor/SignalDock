# macOS development transport

The Swift helper and Bash launcher provide native IOBluetooth access for the local VR-N7500 audio proofs. The launcher builds a temporary signed app, uses the root `.venv`, and writes reports under the root `results/`.

`streaming_transport.swift` and `run_streaming_transport.sh` supply the experimental continuous service transport. They exchange bounded NDJSON over a private Unix socket, open only the configured Classic address/channel, and enforce an independent TX renewal deadline of at most 1.5 seconds and an absolute limit of 30 seconds. Parent EOF or grant expiry sends audio termination frames and drains before closing. The earlier proof helper remains unchanged.

The streaming launcher requires an editable checkout, Xcode Command Line Tools, local code signing, and Bluetooth permission for its temporary app. No Python Objective-C bridge is needed by the streaming service. Its new cancellation/release behavior still requires physical acceptance. Linux uses kernel RFCOMM directly. Do not open either helper during routine repository validation.
