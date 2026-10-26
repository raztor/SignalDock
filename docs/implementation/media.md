# Live media and supervised transmission

SignalDock uses self-hosted LiveKit through `services/media-gateway`. Public clients receive the application media-session contract; private radio RPC and vendor protocols remain on the server. Core listening and transmission require no cloud-processing account.

## Composition

- `TxSupervisor` is exported from `@signaldock/radio-runtime/tx`. Inject `TxRuntimePort` and a per-radio `TxDriverPort`. Connect runtime control-invalidation events to `invalidateControl(radioId, reason)`. Map supervisor state changes into the runtime TX overlay without changing the tuning revision.
- `createGrpcTxDriver(client)` adapts the generic private gRPC audio methods; `grpcRxFrames(client, generation, signal)` checks stream identity, safe integer conversion, frame ordering and normalized PCM.
- `LiveKitCredentials({serverUrl, apiKey, apiSecret})` owns credential issuance and revocation. Use WSS in production. Unencrypted WS is accepted only on loopback.
- Docker deployments may additionally set `internalServerUrl` to a trusted WS/WSS service address such as `ws://livekit:7880`. The Node bridge and room-service API use this internal address; issued browser sessions always retain the public `serverUrl`. Internal configuration rejects embedded credentials, query parameters and fragments. It does not relax public URL validation.
- `MediaService({instanceId, auth, credentials, supervisor, rxSource, onFrame?, onError?, resolveTuning?})` owns enrollment, revalidation and the PCM bridge. `registerMediaRoutes(app, prefix, {auth, media})` registers authenticated endpoints below `/api/v1`.
- Call `media.attachRadio(radioId)` after radio startup, including when no browser is listening. Call it again after a driver generation changes. Stop media before destroying its runtime/driver dependencies.
- Media shutdown attempts every radio permission update, TX stop, enrollment removal and bridge/resource closure before reporting an `AggregateError`. Diagnostic callback failures do not abort cleanup. The single-process CLI must continue recorder/runtime teardown in `finally`/`allSettled` blocks and call `disposeMediaRuntime()` only after all media services and rooms close. This final provider-neutral wrapper disposes the process-wide native media thread; individual service instances and test fixtures must not invoke it because other instances can share that runtime.
- `MediaScreen(FeatureScreenProps)` provides browser listening and hold-to-talk. Await `stopActiveMedia(reason, {instanceId?, radioId?})` before committing any server, radio, account or navigation context change. It invalidates pending operations and stops microphone tracks synchronously before waiting for bounded cleanup requests.

## Admission and isolation

Each instance/radio has its own room and RX track. A short-lived listener credential can subscribe but cannot publish or send data. A transmitter credential can publish only microphone audio and cannot subscribe or send data. The SFU token never grants radio control: the bridge accepts only a backend-enrolled participant matching a currently active TX grant, account, login session, radio and generation. A second participant cannot reuse the same grant. Unenrolled tracks are ignored.

RX tracks also use a publisher-side allowlist, denied by default before publication and updated from current backend enrollment. Removing enrollment removes that identity from the RX track before disconnecting the participant. A still-valid self-hosted SFU JWT cannot reconnect and regain RX access. The browser restricts its microphone track subscribers to the server bridge. Admission and renewal signing operations recheck login epochs, current authentication, permissions, service lifecycle and enrollment identity before committing; signing completed after logout, removal or shutdown cannot create a new enrollment.

The pinned Node SDK does not yet expose its native track-permission setter. `subscription-permissions.ts` isolates the corresponding FFI operation from `@livekit/rtc-ffi-bindings` 0.13.1 with runtime handle/response checks. Failure disconnects the bridge rather than publishing permissive audio. Upgrading the SDK or FFI requires rerunning the actual SFU allowlist/revoked-JWT proof. Replace this compatibility seam with the official public setter when available.

The server rechecks enrolled access and permissions every two seconds and removes revoked or expired enrollments. Clients renew listening enrollment every 20 seconds; an expired SFU join token alone does not disconnect an existing SFU connection. Application admission and participant removal enforce the listening lifecycle. TX authorization has a separate 1.5-second deadline and is never derived from the SFU token lifetime.

The browser creates its microphone only on an explicit press, requests permission before starting the short grant, and publishes after all context checks succeed. A release during a permission prompt or a late grant never publishes audio. Release, pointer cancellation, blur, suspension, connection interruption and context changes stop capture. Reconnection never resumes transmission automatically. Cleanup stays bound to the original instance even if the UI receives a new server context.

## TX safety and uncertainty

Default heartbeats run every 250 ms. The local supervisor checks expiration every 100 ms, expires grants after 1,500 ms without renewal, and caps continuous TX at 30 seconds. Renewals propagate to the radio adapter, which must enforce its own inactivity and absolute deadlines independently of HTTP, WebRTC and the Node process.

Every TX operation includes a fresh grant ID, control fence, generation and immutable tuning revision. Audio sequences and media timestamps must increase, queued latency is bounded, and release discards unsent queued audio. No commands or audio are replayed. Tuning changes are rejected while the runtime reserves the radio. Actual observed tuning and driver generation are checked again before accepted audio.

Preparation does not establish physical RF transmission. Accepted audio remains `tx_unconfirmed` until the adapter reports a physically confirmed carrier. A release becomes `idle` only after preparation and every admitted write/renewal have settled before the adapter confirms physical idle. Lost links, timeouts and delayed operations retain `stop_unconfirmed` plus the reservation. Aborting an operation or timing it out does not establish that its underlying driver promise has settled. `reconcile(radioId)` may clear that state only after settled operations and a fresh physically confirmed idle observation. A process crash cannot itself prove carrier release; independent adapter/hardware watchdog acceptance remains required.

After a driver generation changes, the old grant's observation is insufficient and may be rejected as stale. Recovery uses the optional `TxDriverPort.observeCurrent({radioId, generation})` seam from the current driver only after all old admitted operations settle. The gRPC implementation enables it only for a driver declaring `physicalTxObservation`, and calls its fresh private `Reconcile` operation directly. That operation must observe hardware TX state; a cached snapshot or a runtime TX overlay does not satisfy the contract. Only matching radio/generation plus a ready, physically idle observation can release the old reservation, and the runtime generation is checked again afterward. Unsupported capability, unknown/transmitting state, an in-flight old operation, mismatched proof, or another generation change keeps the reservation. Recovery does not reset the driver, reuse the old grant for a new generation, or start transmission.

## Recording and prepared speech

RX capture runs before WebRTC publication. Its callback receives `(frame, {radioId, generation, direction, tuningRevision, frequencyHz?, attributionConfidence, sourceCodec?})`; retain explicit burst-end and discontinuity markers. Resolve frequency only from the exact generation/revision. Missing mappings remain unattributed, and inferred driver attribution is never promoted to confirmed.

`TxSupervisor.onFrame(frame, grant, source)` captures accepted microphone and TTS audio through the same path. `source` is `microphone` or `tts`; the grant carries radio, generation, session, tuning revision and TX grant identity. Inject a synchronous bounded recording handoff. Recording errors must produce gap telemetry through `onError`/`onCaptureError`; slow or failed storage must not disable the TX watchdog.

`transmitEncodedAudio(principal, {radioId, generation, expectedRevision, controlGrant}, {bytes, contentType}, signal)` is the processing module's explicit authorized TTS callback. It checks permissions before conversion, decodes supported bounded audio bytes through FFmpeg pipes, normalizes to mono PCM s16le at 32 kHz, and only then opens the common TX supervisor. It rejects input over 16 MiB and decoded duration over 30 seconds. It paces 20 ms frames, renews the grant, archives with source `tts`, and stops on cancellation, revoked control or deadline. A processing job never transmits automatically. FFmpeg cannot access input files or network URLs through this decoder.

## Runtime and platform gate

Pinned libraries: `@livekit/rtc-node` 1.2.1, `livekit-server-sdk` 2.19.2, browser `livekit-client` 2.23.0. The Node SDK's optional FFI packages include macOS ARM64 and Linux ARM64 GNU builds. Production images must retain optional dependencies and use glibc; Alpine/musl is not accepted by this gate. Install FFmpeg for prepared speech conversion. Do not exclude native optional packages when installing with `--ignore-scripts`.

On 2026-10-26, Node 24.22.1 on macOS ARM64 loaded the native SDK, captured synthetic PCM, and passed an actual loopback SFU roundtrip using LiveKit server 1.13.11: 154 decoded RX frames, 111 TX frames and nonzero decoded audio in both directions, with 160 source archival frames. `services/media-gateway/proof/local-roundtrip.mjs` reproduces this using a disposable loopback server and synthetic audio. It does not connect a radio or prove RF behavior. Supply `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` for the disposable SFU; defaults are local test credentials only.

The final permission proof also verified zero RX subscriptions before enrollment, admitted nonzero PCM, and zero RX subscriptions after reconnecting with a revoked but unexpired JWT. Its representative roundtrip produced 106 RX frames, 131 TX frames and 137 archival frames; counts vary with scheduling.

The Expo 58.0.19 client and web adapter typecheck. An isolated project using React Native 0.88.0, `@livekit/react-native` 3.1.0, Expo plugin 1.1.0, WebRTC 150.1.0 and `@config-plugins/react-native-webrtc` 14.0.0 passed Expo configuration and iOS/Android `prebuild --no-install`, including generated microphone permissions. This proves configuration generation, not binary or native runtime compatibility. Native audio is explicitly disabled in the client until iOS and Android development builds validate permissions, audio routing, interruption handling and release. Expo Go cannot validate these native modules. Linux ARM64 execution, physical Mac RX/microphone TX/PTT through this new media transport, browser acceptance, and whole-process failure release remain separate outstanding gates.

Official references: [Node RTC SDK](https://github.com/livekit/node-sdks/tree/main/packages/livekit-rtc), [Expo integration](https://docs.livekit.io/transport/sdk-platforms/expo/).

## Focused verification

After workspace dependencies and project references are installed:

```sh
npx vitest run services/radio-runtime/test/tx-supervisor.test.ts services/media-gateway/test apps/api/src/modules/media/media.routes.test.ts apps/client/src/features/media/controller.test.ts
npx tsc -b
npx tsc -p apps/client/tsconfig.json
node services/media-gateway/proof/local-roundtrip.mjs
```

Tests cover expiry, driver renewal, stale/replayed audio, cancelled delayed preparation, uncertain release/reconciliation, PCM byte order, admission scopes, authorization, duplicate participants, original-instance cleanup and actual WAV24k-to-PCM32k conversion. The FFmpeg decode tests require FFmpeg in the test environment. Synthetic tests are not physical or native acceptance.
