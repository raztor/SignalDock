import { z } from 'zod';
import { applicationSchemas } from './application.js';
export * from './application.js';

export const API_PROTOCOL_VERSION = 1 as const;
export const DRIVER_PROTOCOL_VERSION = 1 as const;
export const APPLICATION_VERSION = '0.1.0';
export const IdSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();
export const FrequencyHzSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const RevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const ErrorCodeSchema = z.enum([
  'INVALID_ARGUMENT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'API_INCOMPATIBLE',
  'INSTANCE_IDENTITY_CHANGED',
  'CAPABILITY_UNSUPPORTED',
  'CONTROL_BUSY',
  'CONTROL_REQUIRED',
  'STALE_REVISION',
  'STALE_GENERATION',
  'OPERATION_CONFLICT',
  'DEADLINE_EXCEEDED',
  'RADIO_UNAVAILABLE',
  'RADIO_STATE_UNCERTAIN',
  'TX_LIMIT_REACHED',
  'PROVIDER_UNAVAILABLE',
  'REQUIRES_CONFIGURATION',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const ApiErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(500),
  correlationId: z.string().min(1).max(128),
  retryable: z.boolean(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export class SignalDockError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignalDockError';
  }
}

export const PublicIdentitySchema = z.strictObject({
  keyId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  publicKey: z.string().min(1).max(2048),
  algorithm: z.literal('Ed25519'),
});
export const ServerInfoSchema = z.strictObject({
  product: z.literal('SignalDock'),
  instanceId: IdSchema,
  displayName: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  protocol: z
    .strictObject({
      min: z.number().int().positive(),
      max: z.number().int().positive(),
    })
    .refine((value) => value.min <= value.max, 'Protocol range is inverted.'),
  identity: PublicIdentitySchema,
  routes: z.strictObject({
    api: z.literal('api/v1'),
    events: z.literal('api/v1/events'),
    media: z.literal('api/v1/media'),
  }),
  features: z.strictObject({
    multiRadio: z.boolean(),
    authentication: z.enum(['unavailable', 'local']),
    radioControl: z.boolean(),
    liveAudio: z.boolean(),
    pushRelay: z.enum(['unavailable', 'optional']),
  }),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
export const HealthSchema = z.strictObject({
  status: z.literal('ok'),
  version: z.string(),
});

export const RadioCapabilitiesSchema = z
  .strictObject({
    tuning: z.strictObject({
      writable: z.boolean(),
      ranges: z
        .array(
          z
            .strictObject({
              minHz: FrequencyHzSchema,
              maxHz: FrequencyHzSchema,
            })
            .refine(
              (range) => range.minHz <= range.maxHz,
              'Frequency range is inverted.',
            ),
        )
        .min(1),
      modes: z
        .array(z.enum(['FM', 'AM', 'USB', 'LSB', 'CW', 'DIGITAL']))
        .min(1),
    }),
    rxAudio: z.boolean(),
    txAudio: z.boolean(),
    ptt: z.enum(['explicit', 'audio_coupled', 'unsupported']),
    physicalTxObservation: z.boolean(),
    independentlyReceivableChannels: z.number().int().positive(),
    verification: z.enum(['simulated', 'experimental', 'hardware_verified']),
  })
  .refine(
    (value) => value.ptt !== 'unsupported' || !value.txAudio,
    'TX audio requires a declared PTT mechanism.',
  );
export type RadioCapabilities = z.infer<typeof RadioCapabilitiesSchema>;
export const TuningSchema = z.strictObject({
  rxHz: FrequencyHzSchema,
  txHz: FrequencyHzSchema.optional(),
  mode: z.enum(['FM', 'AM', 'USB', 'LSB', 'CW', 'DIGITAL']),
});
export type Tuning = z.infer<typeof TuningSchema>;
export const RadioSnapshotSchema = z.strictObject({
  radioId: IdSchema,
  generation: IdSchema,
  revision: RevisionSchema,
  connection: z.enum([
    'disconnected',
    'connecting',
    'synchronizing',
    'ready',
    'degraded',
    'recovering',
  ]),
  observedTuning: TuningSchema.optional(),
  desiredTuning: TuningSchema.optional(),
  tuningConfidence: z.enum(['confirmed', 'inferred', 'unknown']),
  txState: z.enum([
    'idle',
    'preparing',
    'transmitting',
    'stopping',
    'stop_unconfirmed',
    'unknown',
  ]),
});
export type RadioSnapshot = z.infer<typeof RadioSnapshotSchema>;
export const RadioDescriptorSchema = z.strictObject({
  radioId: IdSchema,
  displayName: z.string().min(1).max(100),
  driverId: z.string().min(1).max(100),
  resourceGroupIds: z.array(z.string().min(1).max(100)).max(20),
  capabilities: RadioCapabilitiesSchema,
});
export type RadioDescriptor = z.infer<typeof RadioDescriptorSchema>;
export const OperationContextSchema = z.strictObject({
  operationId: IdSchema,
  radioId: IdSchema,
  generation: IdSchema,
  expectedRevision: RevisionSchema,
  deadline: TimestampSchema,
  controlGrant: IdSchema,
});
export type OperationContext = z.infer<typeof OperationContextSchema>;
export const TuningCommandSchema = z.strictObject({
  context: OperationContextSchema,
  tuning: TuningSchema,
});
export type TuningCommand = z.infer<typeof TuningCommandSchema>;

export const RadioSnapshotEventSchema = z
  .strictObject({
    protocolVersion: z.literal(API_PROTOCOL_VERSION),
    eventId: IdSchema,
    instanceId: IdSchema,
    radioId: IdSchema,
    streamGeneration: IdSchema,
    sequence: RevisionSchema,
    occurredAt: TimestampSchema,
    type: z.literal('radio.snapshot'),
    payloadVersion: z.literal(1),
    correlationId: IdSchema.optional(),
    payload: RadioSnapshotSchema,
  })
  .refine(
    (event) =>
      event.radioId === event.payload.radioId &&
      event.streamGeneration === event.payload.generation,
    'Event routing must match its snapshot.',
  );

export const ProcessingCapabilitySchema = z.enum([
  'stt.batch',
  'stt.streaming',
  'tts.synthesize',
  'text.structured',
]);
export type ProcessingCapability = z.infer<typeof ProcessingCapabilitySchema>;
export const ConnectorManifestSchema = z.strictObject({
  connectorId: z.string().min(1).max(100),
  version: z.string().min(1),
  sdkVersion: z.literal(1),
  capabilities: z.array(ProcessingCapabilitySchema).min(1),
  simulated: z.boolean(),
  execution: z.enum(['local', 'cloud']),
});
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;
export const ProcessingConnectionSchema = z.strictObject({
  connectionId: IdSchema,
  connectorId: z.string().min(1),
  instanceId: IdSchema,
  owner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('instance') }),
    z.strictObject({ kind: z.literal('user'), userId: IdSchema }),
  ]),
  credentialRef: z.string().min(1).optional(),
});
export type ProcessingConnection = z.infer<typeof ProcessingConnectionSchema>;
export const ProcessingProfileSchema = z.strictObject({
  profileId: IdSchema,
  revision: RevisionSchema,
  connectionId: IdSchema,
  capability: ProcessingCapabilitySchema,
  model: z.string().min(1),
  allowCloud: z.boolean(),
});
export type ProcessingProfile = z.infer<typeof ProcessingProfileSchema>;
export const ProcessingRequestSchema = z.strictObject({
  instanceId: IdSchema,
  jobId: IdSchema,
  taskVersion: z.number().int().positive(),
  deadline: TimestampSchema,
  profileId: IdSchema,
  profileRevision: RevisionSchema,
  task: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/),
  input: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('text'),
      text: z.string().min(1).max(64000),
      communicationIds: z.array(IdSchema).min(1),
    }),
    z.strictObject({
      kind: z.literal('audio'),
      artifactId: IdSchema,
      communicationIds: z.array(IdSchema).min(1),
    }),
  ]),
});
export type ProcessingRequest = z.infer<typeof ProcessingRequestSchema>;
export const ProcessingResultSchema = z.strictObject({
  jobId: IdSchema,
  connectorId: z.string().min(1),
  profileRevision: RevisionSchema,
  simulated: z.boolean(),
  output: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('summary'),
      text: z.string().min(1),
      evidenceIds: z.array(IdSchema).min(1),
    }),
    z.strictObject({
      kind: z.literal('transcript'),
      text: z.string().min(1),
      artifactId: IdSchema,
    }),
    z.strictObject({
      kind: z.literal('extension'),
      schemaId: z.string().min(1).max(100),
      schemaVersion: z.number().int().positive(),
      data: z.record(z.string(), z.unknown()),
      evidenceIds: z.array(IdSchema).min(1),
    }),
  ]),
});
export type ProcessingResult = z.infer<typeof ProcessingResultSchema>;

export const RecentServerSchema = z.strictObject({
  baseUrl: z.string().url(),
  alias: z.string().min(1).max(100),
  instanceId: IdSchema,
  identity: PublicIdentitySchema,
  lastConnectedAt: TimestampSchema,
});
export type RecentServer = z.infer<typeof RecentServerSchema>;
export const RecentServersSchema = z.array(RecentServerSchema).max(10);

export const contractSchemas = {
  ...applicationSchemas,
  ApiError: ApiErrorSchema,
  ServerInfo: ServerInfoSchema,
  Health: HealthSchema,
  RadioCapabilities: RadioCapabilitiesSchema,
  RadioSnapshot: RadioSnapshotSchema,
  RadioDescriptor: RadioDescriptorSchema,
  TuningCommand: TuningCommandSchema,
  RadioSnapshotEvent: RadioSnapshotEventSchema,
  ConnectorManifest: ConnectorManifestSchema,
  ProcessingConnection: ProcessingConnectionSchema,
  ProcessingProfile: ProcessingProfileSchema,
  ProcessingRequest: ProcessingRequestSchema,
  ProcessingResult: ProcessingResultSchema,
  RecentServer: RecentServerSchema,
};

export function toJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: 'draft-2020-12' });
}
