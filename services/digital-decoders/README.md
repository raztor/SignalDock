# Recorded-audio decoders

This package provides bounded, receive-only decoding and APRS/AX.25 parsing. It never opens a radio, transmits, forwards packets, or treats received text as executable instructions.

## Implemented capabilities

- Bell 202 AFSK1200 demodulation, NRZI/HDLC framing, bit unstuffing, and verified AX.25 UI frame checksums.
- Timed DTMF sequences with tone-energy, separation, twist, and duration checks.
- TNC2 and binary AX.25 UI parsing; uncompressed APRS positions, timestamped positions, messages, status, telemetry/weather classification, and raw source preservation by the consuming service.

Compressed/Mic-E/object positions are not decoded into invented coordinates. Ambiguous positions remain ambiguous. Separate native and recorded-audio sources retain their provenance.

## Input and isolation

Input is a complete mono PCM16 RIFF/WAVE recording at 8–48 kHz, at most 120 seconds and 16 MiB. The worker API accepts bytes, not user-controlled file paths or shell commands. The default timeout is ten seconds and the configured maximum is thirty seconds.

`decodeRecording` launches a child Node process with an explicit minimal environment, restricted filesystem reads for its own code/dependencies, a 64 MiB JS heap limit, and forced termination on timeout/cancellation. It receives no database, provider, radio, or shell capability. These restrictions are not presented as a full operating-system or network sandbox; the installed decoder implementation is trusted code.

Use `decodeWave` only in controlled unit tests or inside that process. Production worker jobs call `decodeRecording`; control/media processes should not run unbounded DSP synchronously.

## Verification and limits

Synthetic tests decode valid packets at 16, 22.05, 32, and 48 kHz, reject bad checksums and unsupported WAV formats, detect DTMF timing, and verify worker cancellation/timeout. Where FFmpeg is installed, a generated AFSK fixture is encoded to SBC and decoded back before demodulation. That synthetic codec test is separate from physical radio acceptance: real VR-N7500 compressed RF recordings remain unverified.

No external CLI decoder is downloaded or executed. Future decoder packages must declare supported formats, bounded execution, provenance, licensing, and their own sample/physical evidence.

Protocol references: [APRS protocol reference](https://www.aprs.org/doc/APRS101.PDF), [APRS on-air formats](https://www.aprs.org/APRS-docs/PROTOCOL.TXT).
