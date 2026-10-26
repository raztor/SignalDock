# Digital decoding and APRS

## Inputs and modules

Accept device-native packets and recorded audio as separate sources. Prefer native APRS/AX.25 packets when a driver supports them; use recorded-audio decoding as an independently validated alternative.

Every decoder declares ID/version, supported modes, input format/rate, limits, and output schema. Run it as an isolated job without PTT permissions, broad secrets, or arbitrary filesystem access. Reprocessing an archive produces a new result version.

## Initial scope

| Mode | Plan |
|---|---|
| APRS/AX.25 | Packet integration plus AFSK1200 audio validation |
| DTMF | Timestamped sequences linked to source audio |
| SSTV over FM | Follow-up module after successful sample tests |
| Other audio modes | Additional connectors after format/hardware validation |

Dire Wolf and multimon-ng are candidates, subject to sample, architecture, license, and redistribution review. Their advertised modes do not prove compatibility with compressed radio audio. Do not promise modes requiring unavailable RF/baseband data or unsupported receiver modulation.

## Packets and source attribution

Store available original frames, capture/receive time, radio, frequency attribution, source type, callsign/path, parsed fields, and parser version. Deduplicate display without losing evidence of separate RF/Internet receptions.

Optional APRS-IS reception is distinct from publishing, IGate, or digipeating. Enabling Internet reception does not enable RF retransmission. Those behaviors require separate configuration and specifications.

## Map

- Station symbols, callsigns, last received positions, and explicit age.
- Time-window tracks and filters by source/radio/callsign.
- Details linked to packet evidence and history.
- No stale position displayed as current or interpolated point labeled as received.
- Incident overlays distinguish confirmed positions from textual location candidates.
- Proposed MapLibre-based web/mobile adapters, pending Expo proof of concept. Tile sources, attribution, and access are installation settings.

Local packet data remains available offline; a base map without cached tiles may not. Offline cartography is not guaranteed initially.

## Acceptance

Valid/malformed packet; duplicate RF/Internet source; no-position callsign; stale position; ambiguous frequency; decoder timeout; unsupported recording format; repeatable sample decoding; and permissions across multiple radios. Decoders cannot interfere with control or live audio.
