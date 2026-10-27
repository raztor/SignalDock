# Media signaling

`registerMediaRoutes` provides authenticated per-radio listening enrollment and supervised TX start, renewal, status and release. Account/session identity comes from authentication. Clients cannot provide an owner identity.

Media loss and browser disconnects cannot extend the local runtime TX deadline. An authenticated owner may still release TX after its transmit permission is removed.

Implementation and outstanding acceptance gates: [media.md](../../../../../docs/implementation/media.md).

Specification: [05-audio-ptt.md](../../../../../docs/specifications/05-audio-ptt.md).
