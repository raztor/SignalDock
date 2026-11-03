# Live media and PTT

`MediaProvider` (mounted once per workspace inside `StationProvider`) owns one `RadioMediaController` for the selected radio and exposes it through `useRadioMedia()`. `components/` renders it: `LivePanel` (listen toggle, received level, hero hold-to-talk with the 30 s ring), `PttButton`, `ListenToggle` and `LevelMeter`. The lifecycle controller stops microphone capture on release, interruption and context changes. Pending microphone permission or a late TX grant cannot restart cancelled transmission.

The backend/runtime owns authorization and local TX expiry. A screen cannot substitute for those checks.

Application navigation must await `stopActiveMedia` before accepting a different server, account or radio. Switching workspace sections awaits `stopActiveTransmit`, which stops transmission but keeps listening. Native audio remains disabled until development-build validation passes.

Pass `mediaAvailable={serverInfo.features.liveAudio}` to `MediaProvider`. It uses the schema-validated `RadioView` from `useStation()` and disables unsupported listening/PTT with reasons based on server configuration, capabilities, radio state, per-radio permissions and control ownership. The backend remains authoritative for same-account sessions and all transmission admission.

Implementation and outstanding acceptance gates: [media.md](../../../../../docs/implementation/media.md).

Specification: [05-audio-ptt.md](../../../../../docs/specifications/05-audio-ptt.md).
