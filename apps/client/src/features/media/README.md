# Live media and PTT

`MediaScreen` provides explicit browser listening and hold-to-talk. The lifecycle controller stops microphone capture on release, interruption and context changes. Pending microphone permission or a late TX grant cannot restart cancelled transmission.

The backend/runtime owns authorization and local TX expiry. A screen cannot substitute for those checks.

Application navigation must await `stopActiveMedia` before accepting a different server, account or radio. Native audio remains disabled until development-build validation passes.

Implementation and outstanding acceptance gates: [media.md](../../../../../docs/implementation/media.md).

Specification: [05-audio-ptt.md](../../../../../docs/specifications/05-audio-ptt.md).
