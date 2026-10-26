# VGC VR-N7500 hardware validation

Test date: October 26, 2026. These results establish the first SignalDock driver proof; they do not define the capabilities of every future radio.

## Environment

- macOS development host, Python 3.13.15 in `.venv`.
- benlink 0.1.1 installed from revision `c4b9d22112402ea193d376f412bc028d1778fdb4` of [khusmann/benlink](https://github.com/khusmann/benlink).
- Dependency versions in `services/drivers/vgc-benlink/requirements-validation-macos.lock.txt`; upstream source in ignored `vendor/benlink`.
- Native Mac audio access through a temporary signed utility in `services/drivers/vgc-benlink/transports/macos/`; frame parsing/generation through benlink; SBC conversion through the existing FFmpeg installation.

## Verified results

| Test | Result | Local report |
|---|---|---|
| BLE reads/events | Device, status, settings, three memories, event, clean disconnect | `results/20261026-175002-417084-probe.json` |
| RX-frequency write | 147.5400 → 147.5525 MHz, readback, complete memory restoration | `results/20261026-175226-940225-frequency.json` |
| Voice RX to Mac | 94,364 received bytes; 251 AudioData messages; 77,308 SBC bytes; clear playback confirmed | `results/20261026-180103-classic.json` |
| RX conversion | Mono 32 kHz WAV, 7.028 seconds, no trailing protocol bytes | `results/20261026-180103-classic.audio-analysis.json` |
| TX/PTT | Two tones received on second radio; TX on/off observed; settings restored | `results/20261026-181027-742978-tx.json` |
| Pre-start cancellation | No TX blocks attempted; channel closed successfully | `results/20261026-181257-classic.json` |

Reports contain private device identifiers/configuration and are not committed. Historical listener feedback remains in its original language. The operator confirmed clear received voice and both transmitted tones followed by carrier termination.

## Read proof

The radio reported vendor `1`, product `8`, hardware `1`, firmware `144` as a raw protocol number, 32 channels, and 6 regions. These are observed values, not a decoded marketing firmware version.

Initial memories were `EPU1` at 462.3000 MHz, `EPU2` at 462.3125 MHz, and `EPU3` at 462.3250 MHz. Existing device labels and frequencies were read, not chosen/programmed by the test. A status event was received and disconnection completed with exit code 0.

`supports_vfo=false` was reported. A general free-tuning feature therefore needs a validated memory-based implementation or another supported mechanism; do not claim native VFO support from the generic library API.

## Frequency write and recovery

Memory index `9`, device label `Largo 1`, region `0`: RX changed from 147.5400 to 147.5525 MHz for three seconds. Only `rx_freq` changed. All original fields, including TX frequency, were restored and checked by readback. No audio/PTT was sent.

```sh
.venv/bin/python services/drivers/vgc-benlink/validation/frequency_probe.py --address RADIO_BLE_UUID --channel 9 --rx-mhz 147.5525 --hold 3 --apply
```

Without `--apply`, the tool only reads/prepares. An explicit memory index is required. The original snapshot is written atomically and synchronized before sending. A write timeout can still mean the device changed, so restoration is armed before the first write and attempted in `finally`.

If restoration cannot be confirmed, preserve the report and use its recovery path:

```sh
.venv/bin/python services/drivers/vgc-benlink/validation/frequency_probe.py --restore-from results/REPORT-frequency.json --apply
```

A persistent Bluetooth outage or forced process termination may require manual recovery. Do not change regions or edit the same memory from another controller during the test. Recovery refuses to overwrite a different region.

## Mac audio proof

The tested Python does not expose `socket.AF_BLUETOOTH` or `socket.BTPROTO_RFCOMM`. The upstream socket-based audio examples therefore do not run directly on this Mac.

macOS cached services included `SPP Dev` channel 4, `Voice Gateway` channel 1, and `BS AOC` channel 2. A fresh SDP query timed out, but opening **BS AOC/channel 2**, receiving audio, and closing it subsequently succeeded with native `IOBluetooth`.

Read-only service discovery and receive-only capture:

```sh
bash services/drivers/vgc-benlink/transports/macos/run_mac_bluetooth_probe.sh
bash services/drivers/vgc-benlink/transports/macos/run_mac_bluetooth_probe.sh --audio-rx
.venv/bin/python services/drivers/vgc-benlink/validation/decode_audio_capture.py results/REPORT-classic.json
afplay results/REPORT-classic.wav
```

The first command without options does not open audio or transmit. `--audio-rx` captures for 30 seconds without writing audio frames. The second radio was configured to 147.5400 MHz simplex and DCS 023. Captured unknown message types were preserved; they did not prevent voice extraction. The post-capture BLE status reported no TX and no active AOC connection.

The helper is compiled into a temporary app and removed afterward. Existing developer tools, Bluetooth permission, and FFmpeg are prerequisites. It is a development shim, not the future generic radio runtime.

## TX/PTT proof

```sh
.venv/bin/python services/drivers/vgc-benlink/validation/prepare_tx_test.py
.venv/bin/python services/drivers/vgc-benlink/validation/tx_probe.py --address RADIO_BLE_UUID --frequency 147.54 --channel 9
```

The second command only prepares without `--apply`. The confirmed transmission used `--apply` after the receiver was ready. It selected both A/B memories to index 9, disabled dual watch for the test, verified minimum-power flags, and sent 100 blocks at 20 ms intervals containing a two-second signal with 880 Hz and 1320 Hz tones and pauses.

BLE observed `is_in_tx=true`, then `false`. Both audio-end writes and RFCOMM close returned success. The receiver confirmed the tones on 147.5400 MHz and carrier termination. Every original memory and settings field was restored and verified, including original power and A=9/B=3 selection.

SBC frames are generated with benlink framing and checked through ffprobe. Encoding uses 7.5 ms maximum algorithmic delay to obtain 16-block frames reliably; a fractional-microsecond setting initially produced shorter frames and was rejected before any transmission.

The native test has a block limit, three-second watchdog, expiry, cancellation checks, two audio-end writes, and transport drain delay. A pending native job is cancelled/waited before restoring higher power if control fails. The pre-start cancellation path was tested without sending TX audio; in-flight hardware-link failure paths were not physically tested.

## Observed quirks

- Restricted execution initially reported Bluetooth unsupported; host Bluetooth access worked.
- Early attempts disconnected during GATT discovery. Activating pairing on the **base**, with red/green flashing, and releasing phone Bluetooth enabled the initial successful BLE session.
- The radio later appeared paired in macOS. Appearance in that UI alone did not prove audio/control operation.
- BLE discovery/control could require pairing mode to be reactivated after a timeout. Avoid assuming stable long-running reconnection from these short tests.
- The reported channel index sometimes stayed at `31`, matching an APRS memory, even after A/B selection was read back as 9/9. This did not establish the effective RF channel. Early attempts stopped; after pairing was reactivated the successful TX attempt reported index 9 and receiver-side confirmation established the frequency.
- This ambiguity is retained as a driver quirk. Do not silently use that field as the sole basis for conversation attribution or physical tuning confirmation.

## Not yet established

Live microphone over a network, Expo/WebRTC, long-running reconnect behavior, reliable dual-watch source attribution, APRS integration, other radio models, multiple physical radios, and Linux/containerized hardware operation. The product specification defines separate acceptance gates for them.
