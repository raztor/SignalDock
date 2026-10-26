# Radio runtime and connector integration

The radio API is vendor neutral. An installed driver factory receives persisted `RadioConfiguration`; neither the public API nor the client receives vendor protocol messages. Driver installation is a deployment action. Configuration cannot execute commands or install arbitrary packages.

## Composition

Compose `RadioApplicationService({ instanceId, database, auth, runtime?, driverFactory?, events? })`, await `start()`, register `registerRadioRoutes(app, { prefix, auth, service })`, and call `close()` during shutdown. Compose `radioMigrations` with the central migration registry before startup. `sd_radios` uses `(instance_id, id)` as its primary key and stores connector options as JSONB. Enabled endpoints are unique per instance.

`createSimulatorRegistry()` installs the two explicit simulator connector IDs. Production starts with no configured radios. Register `createGrpcDriverFactory({ resolveCredential })` under each trusted connector ID, then pass `registry.create` as the factory. Before registration, this factory calls `GrpcRadioDriver.establishSession()`: idle-confirmed `Disconnect`, fresh `Connect`, then `Reconcile`. This establishes a new controller epoch when an earlier backend process crashed while the private driver remained running. No command or TX audio is replayed. A driver must reject disconnect/reset when physical idle is unconfirmed; failed recovery leaves configuration failed and unavailable for control. The VGC implementation preserves its previous generation/fences until physical idle is read back. Normal connection supervision within the same runtime uses `connect()` and retains its active controller fencing sequence.

`credentialRef` resolves outside persisted configuration; inline token/password/private-key fields are rejected. A Unix endpoint is written as `unix:/absolute/path`. The SDK supports authenticated TLS for remote endpoints; custom TLS material is injected through the SDK deployment options rather than accepted from ordinary public requests.

## Public API

All paths below are relative to `/api/v1` (including any deployment prefix). List responses are arrays.

| Route                                       | Permission and behavior                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET radios`                                | Explicit `radio.listen`; returns only assigned radio views                           |
| `GET radios/configurations`                 | `instance.admin`; returns configuration metadata for administration/grant assignment |
| `POST radios`                               | `instance.admin`; creates or updates a complete configuration                        |
| `PUT radios/:id/configuration`              | `instance.admin`; body ID must match the route                                       |
| `GET radios/:id`, `state`, `capabilities`   | `radio.listen`; generic confirmed state/capabilities                                 |
| `POST radios/:id/control`                   | `radio.control`; acquires or renews this exact user/session lease                    |
| `POST radios/:id/control/renew`             | Body `{ controlGrant, generation }`; extends the current lease                       |
| `DELETE radios/:id/control`                 | Same body; revokes the session's control grant                                       |
| `POST radios/:id/operations`                | `radio.control`; `TuningCommand` with operation context and tuning                   |
| `GET radios/:id/memories`                   | `radio.listen`; requires readable-memory capability                                  |
| `POST radios/:id/memories/:memoryId/select` | `radio.control`; body is an operation context                                        |
| `PUT radios/:id/memories/:memoryId`         | `radio.control`; body `{ context, memory }`                                          |

Administrators receive no implicit radio operating grants. Configuration endpoints deliberately remain available before those grants exist. Operational views omit private endpoints and connector options.

## Admission and failure behavior

One session controls a radio. Leases expire after 15 seconds; clients renew every 5 seconds. The grant includes its owner/session, driver generation, and monotonic fencing value within the running runtime. A runtime restart discards all grants and cached outcomes. Identity revocation must call `runtime.revokeSession` or `runtime.revokeUser`; compose the runtime invalidation listener with the TX supervisor to stop transmission immediately.

Mutations validate authenticated routing, generation, revision, expiry, ownership, and capability before dispatch. A repeated operation ID with identical content returns its cached result; changed content fails. Idempotency caches are bounded, process local, and never replay operations after restart. Drivers remain responsible for enforcing wire fencing and deadlines at the hardware boundary. Persistent cross-process fencing requires a single active runtime per physical resource; this implementation does not support multiple concurrent backend replicas controlling the same device.

Shared resource groups exclude conflicting leases and in-flight operations. Tuning and memory changes are rejected during TX preparation/transmission or uncertain stop. Reconnecting does not clear an uncertain TX reservation. Only the TX supervisor may release it after pending preparation settles and physical idle is confirmed. TX state overlays do not increment the driver's tuning revision. Closing the dashboard releases its session-wide grant, which also invalidates active TX admission.

The driver supervisor reconnects with bounded exponential backoff. It observes snapshots and invalidates grants when connection/generation changes. It never launches a process or silently resumes TX. Driver connection failures remain visible as typed health states, while endpoint/token details are excluded from ordinary radio views.

## Evidence and remaining gates

Unit/conformance tests cover two independent simulated radios, competing sessions, shared resources, expiry/revocation, stale contexts, idempotency, uncertain TX locks, memory semantics, persisted configuration using a test database port, and authenticated Fastify routes. The transport suite additionally starts a real Python gRPC server and verifies Node/Python control, typed rejection, bearer authentication, event streaming, and binary RX frames.

`packages/radio-driver-sdk/test/vgc-interop.test.ts` uses the production VGC RPC service over an authenticated Unix socket with synthetic control/audio dependencies. Set `SIGNALDOCK_VGC_PYTHON` to a Python environment containing the VGC and gRPC dependencies; optionally set `SIGNALDOCK_VGC_PYTHONPATH` for the pinned gRPC environment. This gate exercises capability discovery, memory reads, tuning, correctly attributed binary PCM TX, stream termination, observed idle, and recovery of a fresh backend controller from retained driver fences across real Node/Python processes. It first proves that an old epoch rejects a new owner with fence 1, then proves idle-confirmed session establishment creates a fresh epoch and accepts the new owner. The fixture never opens Bluetooth. `SIGNALDOCK_VGC_ROOT` can locate a separate checkout during integration. Without the explicit Python environment this optional cross-module suite is skipped and provides no acceptance evidence.

`apps/api/test/radios.postgres.test.ts` additionally runs against real PostgreSQL when `TEST_DATABASE_URL` is configured. Each run creates and drops an isolated schema. It proves persisted restart, colliding radio IDs across instances, explicit administrator grants, radio scope, inline-secret rejection, private configuration masking, and real identity session revocation with the runtime callback. This suite uses the production identity repository and Argon2 adapter for its full integration case.

Browser interaction, actual microphone audio, physical VGC readback/carrier termination, remote TLS certificates, native mobile builds, and Linux/ARM64 hardware are not proven by these tests. The concrete VGC module owns physical acceptance and its benlink attribution.
