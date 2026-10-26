# Client interface and central dashboard

## Design

Modern, readable operation screens with explicit connection, radio selection, and ownership. No SDR styling requirement. Expo/React Native Web and Expo Router are the proposed shared base; desktop initially means web/PWA, not a native desktop executable.

Project text and built-in interface copy use English, with localization-ready keys. Radio labels, received speech, and user notes retain their original language.

## Main areas

| Area | Required content |
|---|---|
| Servers | Recent URLs, discovery, identity, compatibility, sign-in |
| Dashboard | All authorized radios, health, capability badges, RX/TX, control owner, last activity |
| Radio workspace | Selected radio, memory/frequency controls, listening, PTT, TTS preview, control requests |
| Conversations | Frequency rooms, audio/text entries, search, bookmarks, coverage gaps |
| Map | APRS sources, tracks, stale-position status, links to packets/history |
| Alerts | Notifications, incidents, assignment, acknowledgement, evidence |
| Administration | Users, radios/drivers, connectors, budgets, storage, relay and diagnostics |
| Preferences | Audio devices, notifications, accessibility, saved sessions |

## Multi-radio behavior

The instance and selected radio stay visible in the operation header and PTT area. Dashboard cards update independently. Selecting radio B never retunes radio A. Listening to multiple radios concurrently is an optional capability to validate; the initial client guarantees one selected listening context while the backend can independently capture all configured radios.

Supported controls derive from capability descriptors. A receive-only device has no enabled TX action; a memory-only radio does not display a functional free-VFO control. Driver settings use a restricted schema-driven form, not downloaded executable UI code.

## Interaction states

Show desired and confirmed frequency separately while a command is pending. Unknown state is not rendered as idle. Control ownership shows the current user and request/release action. Listeners retain their permitted playback without gaining write controls.

PTT states are ready, requesting, transmitting, stopping, and failed/unknown. Button depression is not confirmation of physical TX. Switching server/radio, signing out, or losing the operation context cancels the local TX intention.

TTS follows edit → generate → preview → transmit. Notes/chat text never transmit implicitly.

## History layout

One communication card combines playable audio, expandable transcript, timestamps, attribution, notes, and digital results. Processing updates replace the pending section instead of adding duplicate cards. Uncertain frequency or callsign attribution remains visible.

Desktop uses adaptable dashboard/list/detail panels. Mobile uses focused tabs and a compact radio workspace. Include keyboard operation, visible focus, screen-reader labels, large touch targets, text scaling, and light/dark themes. Status must not depend on color alone.

## Device integration and acceptance

Validate WebRTC with development builds on web/iOS/Android before building every screen. Ask for microphone permission when preparing voice transmission and notification permission when enabling notifications. Test browser audio activation, headset changes, calls, focus loss, and locked screens; never resume TX automatically.

Acceptance includes two-radio simulations with different capabilities, listener/operator/admin views, a busy control owner, denied microphone permission, disconnected radio, interrupted PTT, server switching, and keyboard/mobile usability.
