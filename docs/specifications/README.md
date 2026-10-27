# SignalDock specifications

Version: 0.1. Date: October 26, 2026. Status: implementation specification, not implemented functionality.

SignalDock is an open-source, self-hosted platform for operating multiple radios from a modern web/mobile client. Users choose a server URL, sign in to that instance, and select a radio from a central dashboard. The first hardware integration is VGC through benlink; the platform and its internal driver API are manufacturer-independent.

## Accepted product decisions

- Product frontend and backend use TypeScript. Expo is the proposed shared web/iOS/Android client, subject to live-audio validation.
- The canonical repository is [raztor/SignalDock](https://github.com/raztor/SignalDock); its existing [GNU AGPL v3 license](../../LICENSE) is preserved.
- One published mobile app connects to independently hosted servers. Users may also build their own app or serve their own web client.
- Server URLs are runtime settings, with recent servers and isolated sessions. There is no mandatory central user account.
- An instance supports multiple radios. Each radio has its own capabilities, permissions, control owner, audio streams, history, and transmission lock.
- One operator controls a radio's tuning at a time; authorized listeners share its actual reception. Independent radios can operate independently.
- The interface prioritizes operation, conversations, maps, and alerts. An SDR-style interface and RF waterfall are outside the initial scope.
- Audio and transcription belong to the same history entry, grouped by radio and frequency.
- External processing is modular: STT, TTS, callsign extraction, emergency detection, summaries, and future integrations select independent connectors and profiles.
- OpenAI API compatibility is the default connector family. Subscription OAuth is a separate connector with its actual supported capabilities. Azure, other services, and local Ollama-style integrations remain replaceable options.
- An optional project-operated push relay reduces setup for users of the published app. It does not proxy normal backend traffic or receive radio credentials.
- Development and current hardware tests run on macOS; production targets Linux mini PCs and Raspberry Pi. Mac-specific code stays in the hardware adapter.
- The VGC driver initially reuses Python/benlink. Other drivers may use another language behind the same internal contract; product services remain TS.
- All maintained project documentation, comments, CLI messages, and interface text use English. Received content and upstream sources retain their original language.

## Specification map

| Area | Document |
|---|---|
| Scope, architecture, quality goals | [00-product-architecture.md](00-product-architecture.md) |
| Configurable servers and sessions | [01-servers-sessions.md](01-servers-sessions.md) |
| Dashboard and web/mobile interface | [02-client-interface.md](02-client-interface.md) |
| Identity and administration | [03-identity-administration.md](03-identity-administration.md) |
| Radio runtime and ownership | [04-radio-runtime.md](04-radio-runtime.md) |
| Live audio and PTT | [05-audio-ptt.md](05-audio-ptt.md) |
| Conversations and recordings | [06-history-recordings.md](06-history-recordings.md) |
| STT and TTS workflows | [07-speech.md](07-speech.md) |
| Analysis, emergencies, incidents | [08-analysis-incidents.md](08-analysis-incidents.md) |
| Digital decoding and APRS | [09-digital-aprs.md](09-digital-aprs.md) |
| Notifications and optional relay | [10-notifications-relay.md](10-notifications-relay.md) |
| Public API and event contracts | [11-api-contracts.md](11-api-contracts.md) |
| Data model and processing jobs | [12-data-processing.md](12-data-processing.md) |
| Docker and operations | [13-infrastructure.md](13-infrastructure.md) |
| Open-source distribution | [14-open-source-distribution.md](14-open-source-distribution.md) |
| Work packages and acceptance gates | [15-implementation-acceptance.md](15-implementation-acceptance.md) |
| Evidence and primary sources | [16-evidence-sources.md](16-evidence-sources.md) |
| Processing connector SDK | [17-processing-connectors.md](17-processing-connectors.md) |
| OpenAI subscription OAuth | [18-openai-oauth.md](18-openai-oauth.md) |
| Manufacturer-independent radio driver SDK | [19-radio-driver-sdk.md](19-radio-driver-sdk.md) |

## Evidence versus planned functionality

The VR-N7500 passed device/configuration reads, temporary RX-frequency write and restoration, received voice playback on Mac, two-tone transmission from Mac, and PTT activation/release. A second radio and operator listening confirmed audio in both directions. See [hardware validation](../hardware-validation.md).

Network microphone streaming, Expo/WebRTC, push delivery, digital decoding, reliable dual-watch attribution, multiple physical radios, and sustained Linux/Docker operation are not yet validated. Acceptance criteria describe required future tests.

The initial workspace now implements contracts, simulators, persistent identity/discovery, an Expo server selector, and a discovery-container definition. See [development status](../development.md). Other `apps/`, `packages/`, `services/`, and `deploy/` responsibilities remain planned until their acceptance gates pass.

## Remaining decisions

Brand assets and public domains; retention defaults; relay quotas and operating policy; production hardware; processing-model choices after evaluation; and the supported headless OAuth onboarding path. These do not justify hard-coding a vendor or blocking the core radio/history implementation.
