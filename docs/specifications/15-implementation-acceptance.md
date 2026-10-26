# Implementation work packages and acceptance gates

## Current scope

This task produces specifications, not the application scaffold or production deployment. Preserve the hardware proofs as evidence; do not treat their temporary tools as the finished backend.

## Work packages

| Package | Proposed ownership | Dependencies | Deliverable |
|---|---|---|---|
| W0 Contracts and simulators | `packages/contracts`, both SDKs | Specification agreement | Versioned schemas, fake radios/providers, generated types |
| W1 Instance/server identity | API core, client server selector | W0 | Discovery, URL/prefix support, isolated sessions |
| W2 Authentication/admin | API identity, admin UI | W0–W1 | Roles, per-radio permissions, bootstrap/revocation |
| W3 Multi-radio runtime | runtime and radio SDK | W0 | Registry, generations, resource locks, two simulated radios |
| W4 VGC driver | `services/drivers/vgc-benlink` | W3 | Existing proofs behind the driver contract |
| W5 Media/PTT | media/runtime/client audio | W0, W2–W4 | Live mic/RX, ownership, cancellation, observed release |
| W6 Dashboard/client shell | `apps/client`, shared UI | W0–W3 | Modern responsive radio selection and capability-based controls |
| W7 Recording/history | API history, worker, storage | W0, W3–W5 | Bursts, attribution, playable files, search/retention |
| W8 Processing registry/STT/TTS | processing SDK, connectors, workers | W0, W7 | Replaceable profiles and initial API-compatible connector |
| W9 Subscription OAuth | isolated provider auth module | W8 | Official flow, owner isolation, supported text inference |
| W10 Analysis/incidents | task plugins, incident UI/API | W7–W8 | Callsign candidates, summaries, rules and reviewable alerts |
| W11 Digital/APRS | decoders, packet API, map adapters | W3–W4, W7 | Native/sample packets, initial decoders and map |
| W12 Notifications/relay | backend outbox, app, independent relay | W0–W2, W7 | Scoped enrollment, optional mobile delivery, receipt handling |
| W13 Deployment/release | `deploy`, build pipelines, docs | Cross-cutting | Linux images, backups, fresh install, verified matrix |

After W0, independent workstreams may use frozen contracts and simulators. Shared schema changes have one coordinated owner and trigger downstream compatibility checks. Do not redefine the same DTO independently in each component.

## Gates

**G0 — Contract readiness:** schemas, ownership, errors, capabilities, units, and versions agreed; two radio and provider fixtures available.

**G1 — Client feasibility:** Expo web/iOS/Android development builds prove live audio, device interruptions, protected session storage, and notification permission behavior. Map integration is tested before committing to an adapter.

**G2 — Core operations:** two users and two radios remain isolated; listener cannot transmit; stale grants/retries cannot emit; dashboard switching does not retune another radio.

**G3 — Physical radio:** VGC driver preserves tested frequency/audio behavior, then validates live microphone, actual RF release, cancellation before open, reconnect, and uncertainty handling. One real radio plus simulations is not proof of two simultaneous physical radios.

**G4 — History/processing:** bursts retain correct source context, derivatives are versioned, deletion/cancellation is respected, a provider can be replaced without domain edits, and disabled cloud services leave recording functional.

**G5 — OAuth/relay:** actual supported provider flow and headless setup, no billing fallback without configuration, installation/token ownership proof, replay/abuse protection, and real mobile push. These optional features may remain disabled if their gate is incomplete.

**G6 — Production:** sustained operation and recovery on target Linux hardware, ARM64 where claimed, restore/upgrade test, image/license inventory, and client/backend version negotiation.

## Definition of done

Each package delivers code, relevant tests/fixtures, configuration/migrations, updated contracts/docs, and observable failure states. Distinguish local build/tests, simulator integration, physical proof, release publication, deployment, and live acceptance. Mark unverified capabilities explicitly.

Physical TX tests use a declared radio/frequency/power/duration and a receiving observer, record the result, and restore changed configuration. Routine UI tests use simulators instead of repeatedly emitting RF.

## Follow-up candidates

Multi-radio audio mixing; additional manufacturer drivers; fully local processing; advanced digital modes/SSTV; offline maps; instant replay improvements; contact book; activity statistics; incident exports; keyboard/external PTT controls; and optional scheduled announcements. They use the same extension and authorization contracts rather than bypassing them.
