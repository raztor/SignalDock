import { z } from 'zod';

const id = z.uuid();
const timestamp = z.iso.datetime();
export const RoleSchema = z.enum(['listener', 'operator', 'administrator']);
export type Role = z.infer<typeof RoleSchema>;
export const PermissionSchema = z.enum([
  'radio.listen',
  'radio.control',
  'radio.transmit',
  'radio.configure',
  'history.read',
  'history.write',
  'recording.export',
  'incident.read',
  'incident.manage',
  'aprs.read',
  'processing.manage',
  'notifications.read',
  'notifications.manage',
  'instance.admin',
]);
export type Permission = z.infer<typeof PermissionSchema>;
export const RadioPermissionGrantSchema = z.strictObject({
  radioId: id,
  permissions: z.array(PermissionSchema),
});
export type RadioPermissionGrant = z.infer<typeof RadioPermissionGrantSchema>;
export const PublicUserSchema = z.strictObject({
  id,
  username: z.string().min(1).max(100),
  role: RoleSchema,
  enabled: z.boolean(),
  radioPermissions: z.array(RadioPermissionGrantSchema),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;
export const PrincipalSchema = z.strictObject({
  instanceId: id,
  userId: id,
  sessionId: id,
  username: z.string().min(1),
  role: RoleSchema,
  radioPermissions: z.array(RadioPermissionGrantSchema),
});
export type Principal = z.infer<typeof PrincipalSchema>;
export type AuthPrincipal = Principal;
export interface AuthenticationPort {
  authenticate(accessToken: string): Promise<Principal>;
  authorize(
    principal: Principal,
    permission: Permission,
    radioId?: string,
  ): Promise<void>;
}
export type AuthPort = AuthenticationPort;
export type NotificationAudience = Omit<Principal, 'sessionId'>;
export interface NotificationAudiencePort {
  resolveUser(userId: string): Promise<NotificationAudience | null>;
}
export const LoginRequestSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1024),
  sessionMode: z.enum(['cookie', 'token']),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export const SessionTokensSchema = z.strictObject({
  accessToken: z.string().min(1),
  accessExpiresAt: timestamp,
  refreshToken: z.string().min(1).optional(),
  csrfToken: z.string().min(1).optional(),
  user: PublicUserSchema,
});
export type SessionTokens = z.infer<typeof SessionTokensSchema>;
export const CreateUserRequestSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(12).max(1024),
  role: RoleSchema,
  radioPermissions: z.array(RadioPermissionGrantSchema).optional(),
});
export const UpdateUserRequestSchema = z.strictObject({
  role: RoleSchema.optional(),
  enabled: z.boolean().optional(),
  radioPermissions: z.array(RadioPermissionGrantSchema).optional(),
});
export const ResetPasswordRequestSchema = z.strictObject({
  password: z.string().min(12).max(1024),
});
export const RefreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export const ControlLeaseSchema = z.strictObject({
  grantId: id,
  radioId: id,
  ownerId: id,
  sessionId: id,
  generation: id,
  fencing: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});
export type ControlLease = z.infer<typeof ControlLeaseSchema>;
export interface ClientSession {
  baseUrl: string;
  instanceId: string;
  accessToken: string;
  user: PublicUser;
  onUnauthorized?: () => void;
}
export interface FeatureScreenProps {
  session: ClientSession;
  radioId?: string;
  onSelectRadio?: (radioId: string) => void;
}
export const BootstrapRequestSchema = z.strictObject({
  setupToken: z.string().min(1).max(512),
  username: z.string().min(1).max(100),
  password: z.string().min(12).max(1024),
});

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}
export interface DatabasePort {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  transaction<T>(action: (transaction: DatabasePort) => Promise<T>): Promise<T>;
}
export interface MigrationDefinition {
  id: string;
  sql: string;
}
export interface ArtifactMetadata {
  artifactId: string;
  instanceId: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  createdAt?: string;
}
export interface ArtifactReadResult {
  metadata: ArtifactMetadata;
  bytes: Uint8Array;
  totalBytes: number;
  start: number;
  end: number;
}
export interface ArtifactStoragePort {
  put(input: {
    instanceId: string;
    artifactId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<ArtifactMetadata>;
  read(
    instanceId: string,
    artifactId: string,
    range?: { start: number; end?: number },
  ): Promise<ArtifactReadResult>;
  delete(instanceId: string, artifactId: string): Promise<void>;
}
export type JobState =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'requires_configuration';
export interface JobInput {
  jobId: string;
  instanceId: string;
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  deadline: string;
  maxAttempts?: number;
  source?: {
    communicationId: string;
    communicationRevision: number;
    artifactId?: string;
  };
}
export interface JobSnapshot {
  jobId: string;
  instanceId: string;
  state: JobState;
  attempts: number;
  error?: string;
}
export type JobHandler = (
  job: JobInput,
  signal: AbortSignal,
) => Promise<unknown>;
export interface JobQueuePort {
  enqueue(input: JobInput): Promise<{ jobId: string; duplicate: boolean }>;
  cancel(instanceId: string, jobId: string): Promise<void>;
  get(instanceId: string, jobId: string): Promise<JobSnapshot | null>;
  register(kind: string, handler: JobHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface DomainEvent<T = unknown> {
  protocolVersion: 1;
  eventId: string;
  instanceId: string;
  radioId?: string;
  streamGeneration: string;
  sequence: number;
  occurredAt: string;
  type: string;
  payloadVersion: number;
  correlationId?: string;
  payload: T;
}
export interface EventPublisherPort {
  publish(event: DomainEvent): Promise<void>;
}

export const RadioConfigurationSchema = z.strictObject({
  radioId: id,
  displayName: z.string().min(1).max(100),
  driverId: z.string().min(1).max(100),
  resourceGroupIds: z.array(z.string().min(1)),
  enabled: z.boolean(),
  endpoint: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type RadioConfiguration = z.infer<typeof RadioConfigurationSchema>;
export const RadioMemorySchema = z.strictObject({
  memoryId: z.string().min(1),
  name: z.string(),
  tuning: z.strictObject({
    rxHz: z.number().int().positive(),
    txHz: z.number().int().positive().optional(),
    mode: z.enum(['FM', 'AM', 'USB', 'LSB', 'CW', 'DIGITAL']),
  }),
});
export type RadioMemory = z.infer<typeof RadioMemorySchema>;

export interface AudioFormat {
  encoding: 'pcm_s16le';
  sampleRateHz: number;
  channels: number;
}
export interface PcmAudioFrame {
  streamId: string;
  sequence: number;
  mediaTimeUs: number;
  format: AudioFormat;
  data: Uint8Array;
  tuningRevision: number;
  attributionConfidence: 'confirmed' | 'inferred' | 'unknown';
  discontinuity: boolean;
  endOfBurst?: boolean;
  capturedAt?: string;
}
export type PcmFrame = PcmAudioFrame;
// TX lease deadlines use epoch milliseconds; the private driver wire uses UTC strings.
export const TxGrantSchema = z.strictObject({
  txGrantId: id,
  radioId: id,
  ownerId: id,
  sessionId: id,
  instanceId: id.optional(),
  controlGrant: id,
  generation: id,
  fencing: z.number().int().nonnegative(),
  tuningRevision: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  maxUntil: z.number().int().positive(),
});
export type TxGrant = z.infer<typeof TxGrantSchema>;
export type TxState =
  | 'idle'
  | 'preparing'
  | 'granted'
  | 'transmitting'
  | 'stopping'
  | 'rejected'
  | 'failed_before_tx'
  | 'tx_unconfirmed'
  | 'stop_unconfirmed';
export const MediaSessionSchema = z.strictObject({
  id,
  instanceId: id,
  radioId: id,
  sessionId: id,
  participantIdentity: z.string().min(1),
  serverUrl: z.string().url(),
  token: z.string().min(1),
  expiresAt: timestamp,
  mode: z.enum(['listen', 'transmit']),
});
export type MediaSession = z.infer<typeof MediaSessionSchema>;

export interface SourceTranscript {
  instanceId: string;
  radioId: string;
  communicationId: string;
  transcriptRevisionId: string;
  text: string;
  frequencyHz?: number;
  capturedAt: string;
}
export type IncidentState =
  'new' | 'acknowledged' | 'in_progress' | 'resolved' | 'dismissed';
export interface IncidentEvidence {
  communicationId: string;
  transcriptRevisionId?: string;
  quote?: string;
}
export interface IncidentRecord {
  id: string;
  instanceId: string;
  radioId: string;
  state: IncidentState;
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  ownerUserId?: string;
  retentionHold: boolean;
  evidence: IncidentEvidence[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export type PacketSource = 'native' | 'recording' | 'aprs_is';
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
  source: PacketSource;
}
export interface PacketRecord {
  packetId: string;
  instanceId: string;
  radioId: string;
  receivedAt: string;
  source: PacketSource;
  rawFrameBase64?: string;
  rawText?: string;
  frequencyHz?: number;
  attribution: 'confirmed' | 'inferred' | 'unknown';
  parserVersion: string;
  callsign?: string;
  destination?: string;
  path: string[];
  kind: string;
  parsed?: Record<string, unknown>;
  position?: PositionRecord;
}
export type NotificationCategory =
  | 'communication'
  | 'transcript'
  | 'incident'
  | 'control'
  | 'radio'
  | 'storage'
  | 'processing';
export interface NotificationRecord {
  id: string;
  instanceId: string;
  userId: string;
  radioId?: string;
  eventId: string;
  category: NotificationCategory;
  createdAt: string;
  readAt?: string;
  deliveryState:
    | 'queued'
    | 'relay_accepted'
    | 'provider_accepted'
    | 'failed'
    | 'expired'
    | 'application_opened';
}
export interface NotificationPreference {
  categories: NotificationCategory[];
  radioIds: string[];
  frequencyHz?: number;
  quietHours?: { start: string; end: string; timeZone: string };
  cooldownSeconds: number;
  suppressWhileListening: boolean;
  enabled: boolean;
}
export interface NotificationEvent {
  instanceId: string;
  radioId?: string;
  eventId: string;
  category: NotificationCategory;
  occurredAt: string;
}

export const AttributionSchema = z.enum(['confirmed', 'inferred', 'unknown']);
export const RecordingRecordSchema = z.strictObject({
  id,
  artifactId: id,
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  state: z.enum(['available', 'deleted', 'gap']),
  gapReason: z.string().optional(),
});
export type RecordingRecord = z.infer<typeof RecordingRecordSchema>;
export const TranscriptRevisionSchema = z.strictObject({
  id,
  communicationId: id,
  revision: z.number().int().nonnegative(),
  text: z.string(),
  language: z.string().optional(),
  source: z.enum(['provider', 'human']),
  provenance: z.record(z.string(), z.unknown()),
  createdAt: timestamp,
});
export type TranscriptRevision = z.infer<typeof TranscriptRevisionSchema>;
export const ConversationSchema = z.strictObject({
  id,
  instanceId: id,
  radioId: id,
  frequencyHz: z.number().int().positive().optional(),
  attribution: AttributionSchema,
  updatedAt: timestamp,
});
export type Conversation = z.infer<typeof ConversationSchema>;
export const CommunicationSchema = z.strictObject({
  id,
  instanceId: id,
  radioId: id,
  conversationId: id,
  kind: z.enum([
    'received_voice',
    'transmitted_voice',
    'transmitted_tts',
    'digital',
    'note',
  ]),
  direction: z.enum(['rx', 'tx', 'internal']),
  startedAt: timestamp,
  endedAt: timestamp,
  frequencyHz: z.number().int().positive().optional(),
  frequencyAttribution: AttributionSchema,
  context: z.record(z.string(), z.unknown()),
  revision: z.number().int().nonnegative(),
  recording: RecordingRecordSchema.optional(),
  transcripts: z.array(TranscriptRevisionSchema),
  notes: z.array(z.string()),
  tags: z.array(z.string()),
  retentionHold: z.boolean(),
  deletedAt: timestamp.optional(),
});
export type Communication = z.infer<typeof CommunicationSchema>;
export interface HistoryQuery {
  radioId?: string;
  frequencyHz?: number;
  search?: string;
  direction?: 'rx' | 'tx' | 'internal';
  before?: { startedAt: string; id: string };
  limit?: number;
}

export const applicationSchemas = {
  CreateUserRequest: CreateUserRequestSchema,
  UpdateUserRequest: UpdateUserRequestSchema,
  ResetPasswordRequest: ResetPasswordRequestSchema,
  RefreshRequest: RefreshRequestSchema,
  ControlLease: ControlLeaseSchema,
  RecordingRecord: RecordingRecordSchema,
  TranscriptRevision: TranscriptRevisionSchema,
  Conversation: ConversationSchema,
  Communication: CommunicationSchema,
  Role: RoleSchema,
  Permission: PermissionSchema,
  RadioPermissionGrant: RadioPermissionGrantSchema,
  PublicUser: PublicUserSchema,
  Principal: PrincipalSchema,
  LoginRequest: LoginRequestSchema,
  SessionTokens: SessionTokensSchema,
  BootstrapRequest: BootstrapRequestSchema,
  RadioConfiguration: RadioConfigurationSchema,
  RadioMemory: RadioMemorySchema,
  TxGrant: TxGrantSchema,
  MediaSession: MediaSessionSchema,
};
