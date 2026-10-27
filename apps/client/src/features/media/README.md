# Live media and PTT

`MediaScreen` provides explicit browser listening and hold-to-talk. The lifecycle controller stops microphone capture on release, interruption and context changes. Pending microphone permission or a late TX grant cannot restart cancelled transmission.

The backend/runtime owns authorization and local TX expiry. A screen cannot substitute for those checks.

Application navigation must await `stopActiveMedia` before accepting a different server, account or radio. Native audio remains disabled until development-build validation passes.

Pass `mediaAvailable={serverInfo.features.liveAudio}` to `MediaScreen`. It defaults to unavailable, loads the authenticated `RadioView` through its shared schema, and disables unsupported listening/PTT with reasons based on server configuration, capabilities, radio state, per-radio permissions and control ownership. The backend remains authoritative for same-account sessions and all transmission admission.

Implementation and outstanding acceptance gates: [media.md](../../../../../docs/implementation/media.md).

Specification: [05-audio-ptt.md](../../../../../docs/specifications/05-audio-ptt.md).
