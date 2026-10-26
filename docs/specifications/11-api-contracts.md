# Public API and event contracts

## Versioning and discovery

Base: `{serverBase}/api/v1`. Preserve deployment prefixes. Maintain OpenAPI schemas and generated TS client types in `packages/contracts`/`packages/client-sdk`; schemas are the shared authority. Private driver RPC and push-relay protocol have their own versions.

Illustrative unauthenticated `GET /server-info` response:

```json
{
  "product": "SignalDock",
  "instanceId": "persistent-instance-uuid",
  "displayName": "My radio station",
  "version": "application-version",
  "protocol": {"min": 1, "max": 1},
  "identity": {"keyId": "persistent-key-id", "publicKey": "public-key-description"},
  "routes": {"api": "api/v1", "events": "api/v1/events", "media": "api/v1/media"},
  "features": {"multiRadio": true, "pushRelay": "optional"}
}
```

Routes are base-relative, never arbitrary credential destinations. Public discovery exposes no radio addresses, private endpoints, user list, or provider secrets. Capability availability after login reflects the user's permissions and configured drivers/connectors.

## Resource groups

| Area | Proposed endpoints below `/api/v1` |
|---|---|
| Sessions | `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/sessions`, `/me` |
| Radio dashboard | `/radios`, `/radios/{id}`, `/radios/{id}/state`, `/radios/{id}/capabilities` |
| Memories/tuning | `/radios/{id}/memories`, `/radios/{id}/operations` |
| Ownership | `/radios/{id}/control`, `/radios/{id}/tx-sessions` |
| Media signaling | `/media/sessions`, `/media/sessions/{id}` |
| History/files | `/conversations`, `/communications`, `/recordings/{id}`, `/exports` |
| Processing | `/processing/connectors`, `/processing/connections`, `/processing/profiles`, `/processing/jobs` |
| Incidents/APRS | `/incidents`, `/packets`, `/positions` |
| Notifications | `/notifications`, `/notification-preferences`, `/push/subscriptions` |
| Administration | `/admin/users`, `/admin/drivers`, `/admin/settings`, `/admin/health`, `/admin/audit` |

These are contract targets, not existing routes. Specify each method/body/authorization before implementation. Mutable radio operations have an operation ID, expected revision/generation, deadline, and control grant. No generic public raw-Bluetooth or arbitrary-shell endpoint is provided.

## State and events

Events use a common envelope:

```ts
type EventEnvelope<T> = {
  protocolVersion: 1;
  eventId: string;
  instanceId: string;
  radioId?: string;
  streamGeneration: string;
  sequence: number;
  occurredAt: string; // UTC ISO 8601
  type: string;
  payloadVersion: number;
  correlationId?: string;
  payload: T;
};
```

Initial types include radio state/capabilities, ownership, TX state, communication created/updated, transcript revision, analysis completed, incident updated, APRS packet/position, and notification created.

Sockets authenticate before subscription. Permission changes affect existing subscriptions. Reconnection requests a cursor or performs a snapshot resync when the retained event window is unavailable. Delivery may repeat events; consumers deduplicate by event ID. Ordering is scoped to its stream/generation, not assumed global across radios.

## Shared conventions

UUID-style IDs; integer Hz; explicit sample rates/power units; UTC persistence with client-local display; stable cursor pagination; bounded uploads and HTTP range support for recordings; structured errors with code, message, correlation ID, and retry guidance.

Important errors: `UNAUTHORIZED`, `FORBIDDEN`, `API_INCOMPATIBLE`, `CAPABILITY_UNSUPPORTED`, `CONTROL_BUSY`, `STALE_REVISION`, `STALE_GENERATION`, `RADIO_UNAVAILABLE`, `RADIO_STATE_UNCERTAIN`, `TX_LIMIT_REACHED`, `PROVIDER_UNAVAILABLE`, and `REQUIRES_CONFIGURATION`.

Idempotent retries may retrieve an existing operation/result; they never replay RF audio. Acknowledged HTTP acceptance is distinct from completed physical action.

## Acceptance

Schema validation, generated client compatibility, prefix deployment, unsupported protocol version, two-radio event routing, cursor gaps, revoked subscriptions, duplicate mutations, typed errors, and no cross-instance token forwarding. Freeze these shared contracts before dependent workstreams implement conflicting DTOs.
