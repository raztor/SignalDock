# APRS map and packets

`AprsScreen` takes shared `FeatureScreenProps` and an optional `mapStyleUrl`. It uses the configured instance session through the shared client SDK. Context changes clear old packets, positions, selections, and polling; responses are checked against the active instance and selected radio.

The screen provides callsign/source/time filters, station freshness, packet evidence, pagination, and recorded-audio decoder jobs. Recordings are selected from readable communication history; callers never enter internal artifact IDs. Packet details retain original text/frame evidence, route, receive time, parser version, source, and frequency uncertainty. DTMF results show timed symbols.

The web adapter uses MapLibre GL JS 6.16.0, loaded dynamically. Its default style is a local background with received station/track overlays and makes no external map requests. An administrator may supply an HTTPS style URL with suitable attribution. Such a style can contact third-party tiles, fonts, and imagery services and expose the viewed region and client address; API credentials are never attached to map requests.

Stations use the latest received point per radio and callsign. Tracks connect received points from the same source and never extrapolate. Stale or future-dated points are visually distinguished. The packet list remains usable when WebGL or base-map loading fails. Native clients retain station/packet/decoder lists and explicitly show the unavailable interactive map; a native map adapter remains gated.

`map-model.test.ts` verifies station isolation, freshness, and source-separated tracks. WebGL interaction and native development-build acceptance require integration testing with the application shell.

Specification: [09-digital-aprs.md](../../../../../docs/specifications/09-digital-aprs.md).
