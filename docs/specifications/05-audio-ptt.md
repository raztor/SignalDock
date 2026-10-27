# Live audio and PTT

## Media paths

- RX: driver → runtime/media distribution → authorized clients; recording and processing consume parallel copies.
- Voice TX: client microphone → media transport → driver → radio, with a valid TX grant.
- TTS TX: prepared audio → the same admission, pacing, queue, and termination path. It has no permission bypass.

WebRTC is proposed for network audio; HTTPS/WebSocket handle authentication, signaling, and state. Select the concrete media implementation only after a TS/Node, ARM64, and Expo proof of concept. A file player alone does not establish live microphone support.

Clients do not directly connect to the production radio over Bluetooth. Audio codecs and physical PTT mechanisms are driver capabilities. Receive-only, audio-coupled PTT, and explicit PTT devices must all be representable.

## Grants and concurrency

One control grant per radio. Proposed initial control lifetime: 15 seconds, renewed every 5. Each grant carries owner/session/radio IDs, expiry, generation, and a fencing counter.

PTT is a shorter grant inside control ownership. Initial proposed values: renew every 250 ms, expire after 1,500 ms, and limit continuous TX to 30 seconds. These are configurable test targets, not proven RF-release guarantees. The runtime checks expiration locally.

Different operators may transmit on independent radios, subject to resource-group constraints. A user session initially transmits on only one selected radio at a time. Retuning during TX is rejected. No queued microphone audio or request retry can start an old transmission.

## Transmission lifecycle

`idle → preparing → granted → transmitting → stopping → idle`.

Error states include `rejected`, `failed_before_tx`, `tx_unconfirmed`, and `stop_unconfirmed`. A successful media write is not physical TX confirmation. Record the device's observed state when available and identify drivers without such observation.

Release, expired grant, permission revocation, disconnect, app suspension, or server/radio switching stops input and requests physical termination. The driver handles its actual stop mechanism. For VGC, audio-end framing and transport drain follow tested behavior; the drain delay is not described as measured RF release time.

If the hardware link disappears, software cannot guarantee physical release merely by closing a socket. Mark uncertainty, reject new TX, and reconcile or request local intervention. Restarting any process must not re-arm TX.

## Audio quality and devices

Negotiate driver input/output format, sample rate, channels, timing, and network codec. Bound queues and report latency, underruns, loss, and clock discontinuities. Take archive/decoder audio before optional speech filters. Preserve provenance when the source itself is already compressed.

Test speakers, microphone, headsets, mobile Bluetooth routing, calls, focus loss, and lock screens. Background listening is offered only where verified; microphone TX never resumes automatically after an interruption.

## Acceptance

Two listeners/one transmitter; simultaneous acquisition; independent radios; shared hardware lock; revoked user; duplicate request; closed tab; Wi-Fi loss; instance/radio switch; suspended mobile app; media/runtime crash; delayed driver open; and expired job. Confirm intelligible voice and actual RF carrier termination using a second radio. The existing two-tone proof does not cover all these conditions.
