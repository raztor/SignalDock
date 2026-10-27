// Generated from contract schemas. Run npm run generate:contracts.
export interface CoverageInterval {
  id: string;
  radioId: string;
  generation: string;
  frequencyHz?: number;
  attribution: "confirmed" | "inferred" | "unknown";
  startedAt: string;
  endedAt?: string;
  reason?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  refreshExpiresAt: string;
  revokedAt: string | null;
  label: string;
  current: boolean;
}

export interface PacketRecord {
  packetId: string;
  instanceId: string;
  radioId: string;
  receivedAt: string;
  source: "native" | "recording" | "aprs_is";
  rawFrameBase64?: string;
  rawText?: string;
  frequencyHz?: number;
  attribution: "confirmed" | "inferred" | "unknown";
  parserVersion: string;
  callsign?: string;
  destination?: string;
  path: string[];
  kind: string;
  parsed?: {
    [k: string]: unknown;
  };
  position?: {
    positionId: string;
    packetId: string;
    instanceId: string;
    radioId: string;
    callsign: string;
    lat: number;
    lon: number;
    symbol?: string;
    receivedAt: string;
    source: "native" | "recording" | "aprs_is";
  };
}

export interface PositionRecord {
  positionId: string;
  packetId: string;
  instanceId: string;
  radioId: string;
  callsign: string;
  lat: number;
  lon: number;
  symbol?: string;
  receivedAt: string;
  source: "native" | "recording" | "aprs_is";
}

export interface IncidentEvidence {
  communicationId: string;
  transcriptRevisionId?: string;
  quote?: string;
}

export interface IncidentRecord {
  id: string;
  instanceId: string;
  radioId: string;
  state: "new" | "acknowledged" | "in_progress" | "resolved" | "dismissed";
  priority: "low" | "medium" | "high" | "critical";
  title: string;
  ownerUserId?: string;
  retentionHold: boolean;
  evidence: {
    communicationId: string;
    transcriptRevisionId?: string;
    quote?: string;
  }[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role: "listener" | "operator" | "administrator";
  radioPermissions?: {
    radioId: string;
    permissions: (
      | "radio.listen"
      | "radio.control"
      | "radio.transmit"
      | "radio.configure"
      | "history.read"
      | "history.write"
      | "recording.export"
      | "incident.read"
      | "incident.manage"
      | "aprs.read"
      | "processing.manage"
      | "notifications.read"
      | "notifications.manage"
      | "instance.admin"
    )[];
  }[];
}

export interface UpdateUserRequest {
  role?: "listener" | "operator" | "administrator";
  enabled?: boolean;
  radioPermissions?: {
    radioId: string;
    permissions: (
      | "radio.listen"
      | "radio.control"
      | "radio.transmit"
      | "radio.configure"
      | "history.read"
      | "history.write"
      | "recording.export"
      | "incident.read"
      | "incident.manage"
      | "aprs.read"
      | "processing.manage"
      | "notifications.read"
      | "notifications.manage"
      | "instance.admin"
    )[];
  }[];
}

export interface ResetPasswordRequest {
  password: string;
}

export interface RefreshRequest {
  refreshToken?: string;
}

export interface ControlLease {
  grantId: string;
  radioId: string;
  ownerId: string;
  sessionId: string;
  generation: string;
  fencing: number;
  expiresAt: number;
}

export interface RecordingRecord {
  id: string;
  artifactId: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  state: "available" | "deleted" | "gap";
  gapReason?: string;
}

export interface TranscriptRevision {
  id: string;
  communicationId: string;
  revision: number;
  text: string;
  language?: string;
  source: "provider" | "human";
  provenance: {
    [k: string]: unknown;
  };
  createdAt: string;
}

export interface Conversation {
  id: string;
  instanceId: string;
  radioId: string;
  frequencyHz?: number;
  attribution: "confirmed" | "inferred" | "unknown";
  updatedAt: string;
}

export interface Communication {
  id: string;
  instanceId: string;
  radioId: string;
  conversationId: string;
  kind: "received_voice" | "transmitted_voice" | "transmitted_tts" | "digital" | "note";
  direction: "rx" | "tx" | "internal";
  startedAt: string;
  endedAt: string;
  frequencyHz?: number;
  frequencyAttribution: "confirmed" | "inferred" | "unknown";
  context: {
    [k: string]: unknown;
  };
  revision: number;
  recording?: {
    id: string;
    artifactId: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    state: "available" | "deleted" | "gap";
    gapReason?: string;
  };
  transcripts: {
    id: string;
    communicationId: string;
    revision: number;
    text: string;
    language?: string;
    source: "provider" | "human";
    provenance: {
      [k: string]: unknown;
    };
    createdAt: string;
  }[];
  notes: string[];
  tags: string[];
  retentionHold: boolean;
  deletedAt?: string;
}

export type Role = "listener" | "operator" | "administrator";

export type Permission =
  | "radio.listen"
  | "radio.control"
  | "radio.transmit"
  | "radio.configure"
  | "history.read"
  | "history.write"
  | "recording.export"
  | "incident.read"
  | "incident.manage"
  | "aprs.read"
  | "processing.manage"
  | "notifications.read"
  | "notifications.manage"
  | "instance.admin";

export interface RadioPermissionGrant {
  radioId: string;
  permissions: (
    | "radio.listen"
    | "radio.control"
    | "radio.transmit"
    | "radio.configure"
    | "history.read"
    | "history.write"
    | "recording.export"
    | "incident.read"
    | "incident.manage"
    | "aprs.read"
    | "processing.manage"
    | "notifications.read"
    | "notifications.manage"
    | "instance.admin"
  )[];
}

export interface PublicUser {
  id: string;
  username: string;
  role: "listener" | "operator" | "administrator";
  enabled: boolean;
  radioPermissions: {
    radioId: string;
    permissions: (
      | "radio.listen"
      | "radio.control"
      | "radio.transmit"
      | "radio.configure"
      | "history.read"
      | "history.write"
      | "recording.export"
      | "incident.read"
      | "incident.manage"
      | "aprs.read"
      | "processing.manage"
      | "notifications.read"
      | "notifications.manage"
      | "instance.admin"
    )[];
  }[];
}

export interface Principal {
  instanceId: string;
  userId: string;
  sessionId: string;
  username: string;
  role: "listener" | "operator" | "administrator";
  radioPermissions: {
    radioId: string;
    permissions: (
      | "radio.listen"
      | "radio.control"
      | "radio.transmit"
      | "radio.configure"
      | "history.read"
      | "history.write"
      | "recording.export"
      | "incident.read"
      | "incident.manage"
      | "aprs.read"
      | "processing.manage"
      | "notifications.read"
      | "notifications.manage"
      | "instance.admin"
    )[];
  }[];
}

export interface LoginRequest {
  username: string;
  password: string;
  sessionMode: "cookie" | "token";
}

export interface SessionTokens {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken?: string;
  csrfToken?: string;
  user: {
    id: string;
    username: string;
    role: "listener" | "operator" | "administrator";
    enabled: boolean;
    radioPermissions: {
      radioId: string;
      permissions: (
        | "radio.listen"
        | "radio.control"
        | "radio.transmit"
        | "radio.configure"
        | "history.read"
        | "history.write"
        | "recording.export"
        | "incident.read"
        | "incident.manage"
        | "aprs.read"
        | "processing.manage"
        | "notifications.read"
        | "notifications.manage"
        | "instance.admin"
      )[];
    }[];
  };
}

export interface BootstrapRequest {
  setupToken: string;
  username: string;
  password: string;
}

export interface RadioConfiguration {
  radioId: string;
  displayName: string;
  driverId: string;
  resourceGroupIds: string[];
  enabled: boolean;
  endpoint?: string;
  config: {
    [k: string]: unknown;
  };
}

export interface RadioMemory {
  memoryId: string;
  name: string;
  tuning: {
    rxHz: number;
    txHz?: number;
    mode: "FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL";
  };
}

export interface TxGrant {
  txGrantId: string;
  radioId: string;
  ownerId: string;
  sessionId: string;
  instanceId?: string;
  controlGrant: string;
  generation: string;
  fencing: number;
  tuningRevision: number;
  expiresAt: number;
  maxUntil: number;
}

export interface MediaSession {
  id: string;
  instanceId: string;
  radioId: string;
  sessionId: string;
  participantIdentity: string;
  serverUrl: string;
  token: string;
  expiresAt: string;
  mode: "listen" | "transmit";
}

export interface ApiError {
  code:
    | "INVALID_ARGUMENT"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "API_INCOMPATIBLE"
    | "INSTANCE_IDENTITY_CHANGED"
    | "CAPABILITY_UNSUPPORTED"
    | "CONTROL_BUSY"
    | "CONTROL_REQUIRED"
    | "STALE_REVISION"
    | "STALE_GENERATION"
    | "OPERATION_CONFLICT"
    | "DEADLINE_EXCEEDED"
    | "RADIO_UNAVAILABLE"
    | "RADIO_STATE_UNCERTAIN"
    | "TX_LIMIT_REACHED"
    | "PROVIDER_UNAVAILABLE"
    | "REQUIRES_CONFIGURATION"
    | "INTERNAL_ERROR";
  message: string;
  correlationId: string;
  retryable: boolean;
}

export interface ServerInfo {
  product: "SignalDock";
  instanceId: string;
  displayName: string;
  version: string;
  protocol: {
    min: number;
    max: number;
  };
  identity: {
    keyId: string;
    publicKey: string;
    algorithm: "Ed25519";
  };
  routes: {
    api: "api/v1";
    events: "api/v1/events";
    media: "api/v1/media";
  };
  features: {
    multiRadio: boolean;
    authentication: "unavailable" | "local";
    radioControl: boolean;
    liveAudio: boolean;
    pushRelay: "unavailable" | "optional";
  };
}

export interface Health {
  status: "ok";
  version: string;
}

export interface RadioCapabilities {
  memories?: {
    read: boolean;
    write: boolean;
    select: boolean;
  };
  tuning: {
    writable: boolean;
    /**
     * @minItems 1
     */
    ranges: [
      {
        minHz: number;
        maxHz: number;
      },
      ...{
        minHz: number;
        maxHz: number;
      }[]
    ];
    /**
     * @minItems 1
     */
    modes: ["FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL", ...("FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL")[]];
  };
  rxAudio: boolean;
  txAudio: boolean;
  ptt: "explicit" | "audio_coupled" | "unsupported";
  physicalTxObservation: boolean;
  independentlyReceivableChannels: number;
  verification: "simulated" | "experimental" | "hardware_verified";
}

export interface RadioSnapshot {
  selectedMemoryId?: string;
  radioId: string;
  generation: string;
  revision: number;
  connection: "disconnected" | "connecting" | "synchronizing" | "ready" | "degraded" | "recovering";
  observedTuning?: {
    rxHz: number;
    txHz?: number;
    mode: "FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL";
  };
  desiredTuning?: {
    rxHz: number;
    txHz?: number;
    mode: "FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL";
  };
  tuningConfidence: "confirmed" | "inferred" | "unknown";
  txState: "idle" | "preparing" | "tx_unconfirmed" | "transmitting" | "stopping" | "stop_unconfirmed" | "unknown";
}

export interface RadioDescriptor {
  radioId: string;
  displayName: string;
  driverId: string;
  /**
   * @maxItems 20
   */
  resourceGroupIds:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  capabilities: {
    memories?: {
      read: boolean;
      write: boolean;
      select: boolean;
    };
    tuning: {
      writable: boolean;
      /**
       * @minItems 1
       */
      ranges: [
        {
          minHz: number;
          maxHz: number;
        },
        ...{
          minHz: number;
          maxHz: number;
        }[]
      ];
      /**
       * @minItems 1
       */
      modes: ["FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL", ...("FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL")[]];
    };
    rxAudio: boolean;
    txAudio: boolean;
    ptt: "explicit" | "audio_coupled" | "unsupported";
    physicalTxObservation: boolean;
    independentlyReceivableChannels: number;
    verification: "simulated" | "experimental" | "hardware_verified";
  };
}

export interface RadioView {
  radioId: string;
  displayName: string;
  driverId: string;
  resourceGroupIds: string[];
  enabled: boolean;
  descriptor: {
    radioId: string;
    displayName: string;
    driverId: string;
    /**
     * @maxItems 20
     */
    resourceGroupIds:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ];
    capabilities: {
      memories?: {
        read: boolean;
        write: boolean;
        select: boolean;
      };
      tuning: {
        writable: boolean;
        /**
         * @minItems 1
         */
        ranges: [
          {
            minHz: number;
            maxHz: number;
          },
          ...{
            minHz: number;
            maxHz: number;
          }[]
        ];
        /**
         * @minItems 1
         */
        modes: ["FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL", ...("FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL")[]];
      };
      rxAudio: boolean;
      txAudio: boolean;
      ptt: "explicit" | "audio_coupled" | "unsupported";
      physicalTxObservation: boolean;
      independentlyReceivableChannels: number;
      verification: "simulated" | "experimental" | "hardware_verified";
    };
  } | null;
  snapshot: {
    selectedMemoryId?: string;
    radioId: string;
    generation: string;
    revision: number;
    connection: "disconnected" | "connecting" | "synchronizing" | "ready" | "degraded" | "recovering";
    observedTuning?: {
      rxHz: number;
      txHz?: number;
      mode: "FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL";
    };
    desiredTuning?: {
      rxHz: number;
      txHz?: number;
      mode: "FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL";
    };
    tuningConfidence: "confirmed" | "inferred" | "unknown";
    txState: "idle" | "preparing" | "tx_unconfirmed" | "transmitting" | "stopping" | "stop_unconfirmed" | "unknown";
  } | null;
  control: {
    grantId: string;
    radioId: string;
    ownerId: string;
    sessionId: string;
    generation: string;
    fencing: number;
    expiresAt: number;
  } | null;
  health: {
    state: "configured" | "connected" | "failed";
    errorCode?:
      | "INVALID_ARGUMENT"
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "API_INCOMPATIBLE"
      | "INSTANCE_IDENTITY_CHANGED"
      | "CAPABILITY_UNSUPPORTED"
      | "CONTROL_BUSY"
      | "CONTROL_REQUIRED"
      | "STALE_REVISION"
      | "STALE_GENERATION"
      | "OPERATION_CONFLICT"
      | "DEADLINE_EXCEEDED"
      | "RADIO_UNAVAILABLE"
      | "RADIO_STATE_UNCERTAIN"
      | "TX_LIMIT_REACHED"
      | "PROVIDER_UNAVAILABLE"
      | "REQUIRES_CONFIGURATION"
      | "INTERNAL_ERROR";
  };
}

export interface TuningCommand {
  context: {
    fencing?: number;
    ownerId?: string;
    sessionId?: string;
    operationId: string;
    radioId: string;
    generation: string;
    expectedRevision: number;
    deadline: string;
    controlGrant: string;
  };
  tuning: {
    rxHz: number;
    txHz?: number;
    mode: "FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL";
  };
}

export interface RadioSnapshotEvent {
  protocolVersion: 1;
  eventId: string;
  instanceId: string;
  radioId: string;
  streamGeneration: string;
  sequence: number;
  occurredAt: string;
  type: "radio.snapshot";
  payloadVersion: 1;
  correlationId?: string;
  payload: {
    selectedMemoryId?: string;
    radioId: string;
    generation: string;
    revision: number;
    connection: "disconnected" | "connecting" | "synchronizing" | "ready" | "degraded" | "recovering";
    observedTuning?: {
      rxHz: number;
      txHz?: number;
      mode: "FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL";
    };
    desiredTuning?: {
      rxHz: number;
      txHz?: number;
      mode: "FM" | "AM" | "USB" | "LSB" | "CW" | "DIGITAL";
    };
    tuningConfidence: "confirmed" | "inferred" | "unknown";
    txState: "idle" | "preparing" | "tx_unconfirmed" | "transmitting" | "stopping" | "stop_unconfirmed" | "unknown";
  };
}

export interface ConnectorManifest {
  connectorId: string;
  version: string;
  sdkVersion: 1;
  /**
   * @minItems 1
   */
  capabilities: [
    "stt.batch" | "stt.streaming" | "tts.synthesize" | "text.structured",
    ...("stt.batch" | "stt.streaming" | "tts.synthesize" | "text.structured")[]
  ];
  simulated: boolean;
  execution: "local" | "cloud";
}

export interface ProcessingConnection {
  connectionId: string;
  connectorId: string;
  instanceId: string;
  owner:
    | {
        kind: "instance";
      }
    | {
        kind: "user";
        userId: string;
      };
  credentialRef?: string;
}

export interface ProcessingProfile {
  task?: string;
  settings?: {
    [k: string]: unknown;
  };
  profileId: string;
  revision: number;
  connectionId: string;
  capability: "stt.batch" | "stt.streaming" | "tts.synthesize" | "text.structured";
  model: string;
  allowCloud: boolean;
}

export interface ProcessingRequest {
  instanceId: string;
  jobId: string;
  taskVersion: number;
  deadline: string;
  profileId: string;
  profileRevision: number;
  task: string;
  input:
    | {
        kind: "text";
        text: string;
        communicationIds: string[];
      }
    | {
        kind: "audio";
        artifactId: string;
        /**
         * @minItems 1
         */
        communicationIds: [string, ...string[]];
      };
}

export interface ProcessingResult {
  jobId: string;
  connectorId: string;
  profileRevision: number;
  simulated: boolean;
  output:
    | {
        kind: "summary";
        text: string;
        /**
         * @minItems 1
         */
        evidenceIds: [string, ...string[]];
      }
    | {
        kind: "transcript";
        text: string;
        artifactId: string;
      }
    | {
        kind: "audio";
        artifactId: string;
        contentType: string;
        byteLength: number;
        durationSeconds?: number;
      }
    | {
        kind: "extension";
        schemaId: string;
        schemaVersion: number;
        data: {
          [k: string]: unknown;
        };
        /**
         * @minItems 1
         */
        evidenceIds: [string, ...string[]];
      };
}

export interface RecentServer {
  baseUrl: string;
  alias: string;
  instanceId: string;
  identity: {
    keyId: string;
    publicKey: string;
    algorithm: "Ed25519";
  };
  lastConnectedAt: string;
}
