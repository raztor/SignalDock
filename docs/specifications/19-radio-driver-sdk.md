# Manufacturer-independent radio driver SDK

## Design decision

Use a private, versioned **SignalDock Radio Driver API**, proposed as gRPC with generated TypeScript/Python bindings. Keep it separate from the public HTTP API. Local Unix sockets are preferred on one host; authenticated internal transport is required across hosts. Audio uses bounded binary streaming, not repeated JSON uploads through the public API.

Drivers run out of process so Python/benlink, TS libraries, serial/CAT tools, native integrations, or future network radios can share a contract. A new manufacturer must not require frontend conditionals or edits to backend domain services.

## Manifest and configuration

Declare `driverId`, package/version, driver API range, supported device families, configuration JSON Schema, required host access, discovery support, health checks, and documented quirks. Validate configuration server-side. Discovery never silently pairs an unrelated device.

The schema describes settings, not executable frontend code. Driver installation is an administrator/deployment operation; a discovered manifest cannot install or execute itself. Vendor extensions use namespaced fields and do not redefine standard fields.

## Capabilities

Required: identity, health, connection lifecycle, capability discovery, and state snapshot. Optional capabilities include tuning, memory read/write/select, power, squelch, signaling, scanning, dual watch, RX audio, TX audio, PTT, packets, position, RSSI, and future spectrum sources.

Advertise limits and verification level, not a single `supportsRadio` boolean. Distinguish read-only/writable state, frequency ranges, modes, discrete/continuous power, audio formats, half/full duplex, independently receivable channels, and physical TX-state observation.

PTT mechanism is `explicit`, `audio_coupled`, or `unsupported`. A VGC driver may begin RF only when audio arrives; it must not falsely advertise an independent carrier-only PTT method. A receive-only source remains a valid radio resource.

## RPC groups

| Group | Operations |
|---|---|
| Lifecycle | `Describe`, `Connect`, `Disconnect`, `Health`, `Reconcile` |
| State/control | `GetSnapshot`, `ApplyTuning`, `ListMemories`, `ReadMemory`, `WriteMemory`, `SelectMemory`, `UpdateSettings` |
| Events | `WatchEvents` with generation and sequence |
| RX | `OpenRxStream`, `CloseRxStream` |
| TX | `PrepareTransmission`, `PushTxAudio`, `EndTransmission`, `ObserveTransmission` |
| Packets | Optional receive/send operations with explicit authorization |

Each mutable request has operation ID, radio ID, generation, expected revision, deadline, and control/TX grant. Results distinguish acceptance from physical confirmation. Every TX path honors local expiry and cancellation, including while a hardware channel is still opening.

Audio frames carry stream ID, sequence, capture/media time, format, payload, signal-context/tuning revision, attribution confidence, and discontinuity markers. Units are explicit: integer Hz, timestamps with UTC/media-clock distinction, and power units or labeled discrete levels.

## Driver composition and conformance

A driver may combine separate control, audio, and PTT transports—for example serial control plus sound-card audio—without exposing that composition to clients. The runtime owns shared-resource locks. Driver errors map to standard unavailable, unsupported, conflict, timeout, device-rejected, and unconfirmed states.

The first `vgc-benlink` package wraps the tested protocol and its Mac transport. Other models in that family require their own capability verification. Future Hamlib/CAT/network integrations are extension candidates, not already supported devices.

Conformance requires simulator fixtures, capability tests, unsupported-operation rejection, stale-generation rejection, cancellation, reconnect without replay, timing/discontinuity behavior, shared-resource exclusion, and documented physical acceptance. A driver without a proven stop path cannot silently enable ordinary TX controls.
