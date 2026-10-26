// Generated from contract schemas. Run npm run generate:contracts.
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
  txState: "idle" | "preparing" | "transmitting" | "stopping" | "stop_unconfirmed" | "unknown";
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

export interface TuningCommand {
  context: {
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
    txState: "idle" | "preparing" | "transmitting" | "stopping" | "stop_unconfirmed" | "unknown";
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
        /**
         * @minItems 1
         */
        communicationIds: [string, ...string[]];
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
