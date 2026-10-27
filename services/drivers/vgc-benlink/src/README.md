# Production adapter source

`vgc_benlink` implements the private Radio Driver API. `adapter.py` supervises state, stream lifetimes, fencing and local TX deadlines; `control.py` isolates benlink behavior; `transport.py` selects Linux RFCOMM or the native Mac helper; `codec.py` converts continuous SBC/PCM; `service.py` exposes authenticated gRPC; `server.py` supplies the Unix-socket CLI. Existing hardware proofs remain in `../validation`.

Public construction seams are `VgcDriver(config, control, transport_factory, codec_factory)`, `VgcService(driver, token)` and `serve(driver, socket_path, token, stopping)`. Tests inject fake ports. Production uses `BenlinkControl`, `platform_transport` and `FfmpegCodec`. See the [implementation guide](../../../../docs/implementation/vgc.md).
