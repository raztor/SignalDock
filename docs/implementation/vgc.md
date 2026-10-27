# VGC / benlink implementation

The `vgc-benlink` driver implements private Radio Driver API v1 for one explicitly configured VR-N7500 per process. Start separate processes/sockets for independent radios. The service opens hardware only after `Connect`; startup, help and offline configuration validation do not discover or connect to a radio. No vendor protocol is exposed through public product APIs.

## Dependencies and startup

Use Python 3.13+, FFmpeg with the SBC encoder/decoder, Bluetooth BLE and Classic RFCOMM, and the generated Python driver bindings from the same repository revision. The package declares grpcio and protobuf compatibility with those generated bindings and pins benlink to revision `c4b9d22112402ea193d376f412bc028d1778fdb4`.

```sh
python3.13 -m venv .venv-driver
.venv-driver/bin/python -m pip install -e services/drivers/vgc-benlink
.venv-driver/bin/signaldock-vgc --config /private/path/vgc.json --check-config
.venv-driver/bin/signaldock-vgc --config /private/path/vgc.json --socket /private/path/runtime/vgc.sock --token-file /private/path/driver-token
```

An installed wheel needs `SIGNALDOCK_DRIVER_BINDINGS` pointing at `packages/radio-driver-sdk/generated/python`. An editable checkout discovers that directory automatically. On Mac, use the editable checkout because the native source and launcher stay inside this module. The Mac helper requires Xcode Command Line Tools and Bluetooth permission. It builds a locally signed temporary app without adding native dependencies to the product frontend/backend.

The Mac helper keeps the bundle identity `org.signaldock.vgc.transport`. Its first use requests Bluetooth permission asynchronously; allow the expected macOS prompt. A late response can outlive the opening deadline, in which case retry after approval. CoreBluetooth authorization completes before explicit-address paired-device lookup and RFCOMM opening. Device initialization runs away from the main run loop so a framework coordinator wait cannot block cancellation or the native watchdog. Error details distinguish permission, device initialization and RFCOMM phases without exposing device identifiers.

Example private JSON (replace every device identifier before connecting):

```json
{
  "radioId": "00000000-0000-4000-8000-000000000004",
  "bleAddress": "REPLACE_WITH_EXPLICIT_BLE_IDENTIFIER",
  "classicAddress": "REPLACE_WITH_EXPLICIT_CLASSIC_ADDRESS",
  "audioChannel": 2,
  "workingMemoryId": 9,
  "allowExperimentalTx": false
}
```

BLE identifiers on Mac and Classic MAC addresses are separate values. Reserve `workingMemoryId` deliberately: generic tuning writes that memory and selects it on both A/B sides with single watch and scanning disabled. Omit it to disable generic tuning while retaining explicit memory APIs. Frequency ranges currently cover FM 136–174 MHz and 400–470 MHz; a device's own restrictions may be narrower. The driver rejects other model identities until verified.

Use an ASCII bearer token of at least 32 characters in a mode-0600 file, or `SIGNALDOCK_DRIVER_TOKEN`. Authorization metadata is `authorization: Bearer TOKEN`. The Unix socket is mode 0600, capped at 1 MiB messages and 64 concurrent RPCs; the backend must share appropriate Unix ownership. Mount its private parent directory. A TCP listener is intentionally absent.

## Control and state

Commands require UUID operation/control/owner/session identifiers, a current generation/revision, a live deadline and a positive safe-integer control fence. Fences bind an owner/session/control grant; lower fences and a different owner at the same fence are rejected. A higher fence expires a previous transmission. Applied command outcomes are deduplicated in a bounded per-generation cache. Reconnection changes generation and invalidates grants.

A restarted backend establishes its driver session with `Disconnect → Connect → Reconcile` before registering the radio for control. An ordinary `Connect` on an already connected service is idempotent and retains its existing epoch. Disconnect ends active audio and requires a fresh physical idle observation; failure returns `RADIO_STATE_UNCERTAIN` and preserves the prior generation/fences. Connect resets ownership and publishes a fresh generation only after `is_in_tx=false` and any delayed audio opening has settled. An unavailable or transmitting radio cannot silently reset fencing. Recovery may retry the same handshake after physical idle can be confirmed; it never replays TX. A disconnected uncertain service may reconnect its BLE control port only to obtain this read-only idle confirmation.

`ApplyTuning`, memory write/select and readback remain within the VGC module. Unrelated memory parameters, power, squelch and sub-audio fields are preserved. Effective frequency is inferred from verified single-watch settings and channel readback; `status.curr_ch_id` is insufficient and is never treated as authoritative. Region changes require reconnection. Tuning suspends and flushes the previous receive pipeline before changing audio context.

Tuning and memory selection return their verified radio result before asynchronously reopening RX, keeping native compilation/transport latency outside the command response. Reopening is fenced by generation/revision; another tuning operation or disconnect cancels it, and a late opening cannot attach to a new context. A receive reopening failure emits a discontinuity/end marker, reports a subscriber error and publishes degraded state while preserving the successfully applied tuning.

Before mutation, the driver saves original settings/memory in a private, fsynced journal next to its socket. A failed or interrupted write attempts full readback-verified restoration. An unresolved journal blocks subsequent writes and TX. With the service stopped, `--recover --config ... --socket ...` explicitly restores and verifies that snapshot. Archive/inspect stale sockets before recovery. Successful intentional user changes persist; disconnect does not revert them. Include the journal directory in private backups.

## Audio and PTT

RX/TX boundary frames are signed 16-bit little-endian PCM, 32 kHz, mono. TX frames contain at most 640 samples (20 ms); sequence starts at zero and is contiguous. The admission tuning revision remains fixed for that transmission. RX emits a sequence/media timestamp, tuning revision, discontinuity and explicit end-of-burst marker. VGC audio frames contain no frequency, so attribution is `inferred` when selected tuning is confirmed, otherwise `unknown`. Subscriber queues are bounded; gaps are explicit.

PTT is audio-coupled: preparing never sends speech, silence or tones. SBC data starts the carrier; termination frames stop it. The Python process paces both incoming PCM and encoded SBC, monitors local monotonic deadlines every 25 ms, limits renewal to 1.5 seconds and the immutable absolute grant to at most 30 seconds. Each distinct TX grant can be used once per generation; sequential grants may share the same active control fence. Every audio/end/renew request must match its grant and fence. One streaming RPC owns the audio grant.

Normal source EOF flushes the final encoder frames within the live grant. Release, expiry and interruption discard queued encoder data, send two termination frames, drain the transport and request BLE state. Idle is physically confirmed only after an observed `is_in_tx=false` and completed audio opening; a failed observation or unsettled open returns `stop_unconfirmed` and blocks further TX. `Reconcile` can recover after a fresh idle observation. Transmission never resumes automatically.

On Mac the native helper also enforces renewal/absolute deadlines and parent EOF independently of Python. Linux uses a nonblocking kernel RFCOMM socket and the separate Python driver process survives a backend process failure; loss of the entire driver process closes the socket. Physical termination after SIGKILL, OS failure or adapter loss remains unverified and is never claimed from socket closure alone. This is an experimental connector: `allowExperimentalTx` defaults false until coordinated streaming acceptance.

## Linux deployment

```sh
docker build -f services/drivers/vgc-benlink/Dockerfile -t signaldock-vgc .
```

The image includes Python, FFmpeg and the bindings, runs as UID 10001, and accepts the same CLI. Supply a private config/token and writable `/var/lib/signaldock-vgc` socket/journal directory. The host must pair/trust the explicit radio, provide BlueZ D-Bus access and Bluetooth/RFCOMM permissions to this UID, and expose the host Bluetooth network namespace as appropriate. Avoid granting blanket privileged access. Container creation does not pair a radio. Linux ARM64 image construction, device permissions and real radio streaming are deployment gates, not established by the Mac tests.

## Automated and physical evidence

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/drivers/vgc-benlink/src \
  .venv-driver/bin/python -m unittest discover -s services/drivers/vgc-benlink/test -v
swiftc -swift-version 5 -module-cache-path /private/tmp/signaldock-vgc-swift-cache \
  services/drivers/vgc-benlink/transports/macos/streaming_transport.swift \
  -o /private/tmp/signaldock-vgc-transport-check
bash -n services/drivers/vgc-benlink/transports/macos/run_streaming_transport.sh
```

The automated suite uses fake BLE/RFCOMM ports, real synthetic PCM↔SBC conversion through FFmpeg, and an actual authenticated Unix gRPC client/server. It covers fences, stale revisions/generations, failed restoration, private recovery files, cancellation during opening, conflicting prepares, stream ownership, local expiry, absolute limits, stop uncertainty and bounded RX gaps. It never opens Bluetooth. `test/rpc_fixture.py --socket ... --radio-id ... --token ...` exposes the same service in a separate process with fake control/audio for cross-language conformance tests; fixture results are not hardware evidence.

On Mac, the suite fully compiles and links the native helper without launching it. Swift type checking alone does not cover exclusivity lowering/code generation. A fake launcher-exit test also verifies that an early compile/launch failure is surfaced immediately instead of waiting through the hardware-opening deadline.

Earlier Mac discovery, frequency, RX voice and two-tone TX results remain in [hardware validation](../hardware-validation.md). They validate the earlier proof tooling, not this continuous service/helper. Pending gates are sustained physical RX, browser microphone TX, observed carrier release, opening cancellation, process/network interruptions, memory restoration/recovery, native permission handling, clean Linux/ARM64 installation and physical Linux/Raspberry Pi validation. Only a coordinated prepared-observer test may access RF.

On 2026-10-26, a read-only physical availability probe using the new `BenlinkControl` succeeded: BLE connection, device identity, status/settings read and clean disconnection. The radio reported `is_in_tx=false`. Its current settings did not establish verified single-watch selection, so the driver correctly returned unknown tuning and no selected memory. No tuning, memory/settings mutation, audio transport or transmission was attempted. This confirms control availability only; the continuous-audio gates above remain open. The detailed report stays in the ignored local results directory.

The same day, after the expected Mac Bluetooth permission was approved, the corrected native transport opened its private IPC and explicit RFCOMM channel in approximately 3.4 seconds, then closed cleanly. No TX grant was armed and no audio was sent. This establishes RX transport opening only; received voice, browser playback and transmitted microphone audio still require their separate acceptance tests.

## Attribution and license

This connector builds on [benlink by khusmann and contributors](https://github.com/khusmann/benlink), whose protocol research, Python API and audio framing make the implementation possible. Benlink is Apache-2.0; retain its license and notices in distribution. SignalDock and this original implementation remain under the repository's AGPL-3.0 license. No upstream source was copied into the connector.
