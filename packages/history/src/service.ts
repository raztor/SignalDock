import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appendOutbox } from '@signaldock/database';
import {
  CommunicationSchema,
  ConversationSchema,
  IdSchema,
  SignalDockError,
  TimestampSchema,
  TranscriptRevisionSchema,
  type ArtifactMetadata,
  type ArtifactStoragePort,
  type Communication,
  type Conversation,
  type DatabasePort,
  type HistoryQuery,
  type JobInput,
  type TranscriptRevision,
} from '@signaldock/contracts';

type CommunicationRow = {
  instance_id: string;
  id: string;
  radio_id: string;
  conversation_id: string;
  kind: Communication['kind'];
  direction: Communication['direction'];
  started_at: Date;
  ended_at: Date;
  rx_hz: string | null;
  frequency_attribution: Communication['frequencyAttribution'];
  context: Record<string, unknown>;
  revision: number;
  notes: string[];
  tags: string[];
  retention_hold: boolean;
  deleted_at: Date | null;
};
type RecordingRow = {
  id: string;
  artifact_id: string;
  communication_id: string;
  radio_id: string;
  content_type: string;
  size_bytes: string;
  sha256: string;
  state: 'available' | 'deleted' | 'gap';
  gap_reason: string | null;
};
export type CaptureInput = Pick<
  Communication,
  | 'id'
  | 'instanceId'
  | 'radioId'
  | 'kind'
  | 'direction'
  | 'startedAt'
  | 'endedAt'
  | 'frequencyAttribution'
  | 'context'
> & {
  frequencyHz?: number;
  notes?: string[];
  tags?: string[];
};
export interface RecordingContext {
  communicationId: string;
  communicationRevision: number;
  radioId: string;
  startedAt: string;
  frequencyHz?: number;
  attribution: Communication['frequencyAttribution'];
}
export interface HistoryOptions {
  maxRecordingBytesPerRadio?: number;
  onDeleteSource?: (
    tx: DatabasePort,
    source: {
      instanceId: string;
      communicationId: string;
      artifactIds: string[];
    },
  ) => Promise<void>;
}

export class HistoryService {
  constructor(
    private readonly database: DatabasePort,
    private readonly artifacts: ArtifactStoragePort,
    private readonly options: HistoryOptions = {},
  ) {}

  async ingest(
    input: CaptureInput,
    audio?: { bytes: Uint8Array; contentType: string },
  ): Promise<Communication> {
    IdSchema.parse(input.instanceId);
    IdSchema.parse(input.radioId);
    IdSchema.parse(input.id);
    TimestampSchema.parse(input.startedAt);
    TimestampSchema.parse(input.endedAt);
    if (
      Date.parse(input.endedAt) < Date.parse(input.startedAt) ||
      !['confirmed', 'inferred', 'unknown'].includes(input.frequencyAttribution)
    )
      throw new SignalDockError('INVALID_ARGUMENT', 'Invalid capture context.');
    if (
      input.frequencyHz !== undefined &&
      (!Number.isSafeInteger(input.frequencyHz) || input.frequencyHz <= 0)
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Frequency must be integer Hz.',
      );
    if (Buffer.byteLength(JSON.stringify(input.context)) > 65536)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Capture context exceeds the limit.',
      );
    const notes = this.notes(input.notes ?? []);
    const tags = this.tags(input.tags ?? []);
    let writtenArtifact: string | undefined;
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtext('history:' || $1 || ':' || $2))",
          [input.instanceId, input.radioId],
        );
        const existing = await this.get(input.instanceId, input.id, tx, true);
        if (existing) {
          if (existing.deletedAt)
            throw new SignalDockError(
              'OPERATION_CONFLICT',
              'Deleted communication IDs cannot be reused.',
            );
          if (
            existing.radioId !== input.radioId ||
            existing.startedAt !== new Date(input.startedAt).toISOString() ||
            existing.endedAt !== new Date(input.endedAt).toISOString() ||
            existing.direction !== input.direction ||
            existing.kind !== input.kind ||
            existing.frequencyHz !== input.frequencyHz ||
            existing.frequencyAttribution !== input.frequencyAttribution ||
            !isDeepStrictEqual(existing.context, input.context) ||
            Boolean(existing.recording) !== Boolean(audio) ||
            (audio &&
              (existing.recording?.sha256 !==
                createHash('sha256').update(audio.bytes).digest('hex') ||
                existing.recording.contentType !== audio.contentType))
          )
            throw new SignalDockError(
              'OPERATION_CONFLICT',
              'Communication ID was reused with another capture.',
            );
          return existing;
        }
        const conversation = await this.conversation(
          tx,
          input.instanceId,
          input.radioId,
          input.frequencyHz,
          input.frequencyAttribution,
          input.endedAt,
        );
        await tx.query(
          'INSERT INTO sd_communications(instance_id,id,radio_id,conversation_id,kind,direction,started_at,ended_at,rx_hz,frequency_attribution,context,notes,tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [
            input.instanceId,
            input.id,
            input.radioId,
            conversation,
            input.kind,
            input.direction,
            input.startedAt,
            input.endedAt,
            input.frequencyHz ?? null,
            input.frequencyAttribution,
            JSON.stringify(input.context),
            JSON.stringify(notes),
            tags,
          ],
        );
        if (audio) {
          const artifactId = randomUUID();
          let metadata: ArtifactMetadata = {
            instanceId: input.instanceId,
            artifactId,
            sizeBytes: audio.bytes.byteLength,
            sha256: createHash('sha256').update(audio.bytes).digest('hex'),
            contentType: audio.contentType,
          };
          let gap: string | undefined;
          const used = await tx.query<{ bytes: string }>(
            "SELECT COALESCE(sum(r.size_bytes),0)::text AS bytes FROM sd_recordings r JOIN sd_communications c ON c.instance_id=r.instance_id AND c.id=r.communication_id WHERE c.instance_id=$1 AND c.radio_id=$2 AND r.state='available'",
            [input.instanceId, input.radioId],
          );
          if (
            Number(used.rows[0]!.bytes) + audio.bytes.byteLength >
            (this.options.maxRecordingBytesPerRadio ?? 1024 * 1024 * 1024)
          )
            gap = 'Recording quota reached.';
          else {
            try {
              metadata = await this.artifacts.put({
                instanceId: input.instanceId,
                artifactId,
                bytes: audio.bytes,
                contentType: audio.contentType,
              });
              writtenArtifact = artifactId;
            } catch {
              gap = 'Recording storage is unavailable.';
            }
          }
          await tx.query(
            'INSERT INTO sd_recordings(instance_id,id,communication_id,artifact_id,content_type,size_bytes,sha256,state,gap_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              input.instanceId,
              randomUUID(),
              input.id,
              artifactId,
              metadata.contentType,
              metadata.sizeBytes,
              metadata.sha256,
              gap ? 'gap' : 'available',
              gap ?? null,
            ],
          );
        }
        await appendOutbox(tx, {
          instanceId: input.instanceId,
          id: randomUUID(),
          radioId: input.radioId,
          type: 'communication.created',
          payload: { communicationId: input.id, conversationId: conversation },
        });
        return (await this.get(input.instanceId, input.id, tx))!;
      });
    } catch (error) {
      if (writtenArtifact)
        await this.artifacts
          .delete(input.instanceId, writtenArtifact)
          .catch(() => undefined);
      throw error;
    }
  }

  async get(
    instanceId: string,
    id: string,
    database: DatabasePort = this.database,
    includeDeleted = false,
  ): Promise<Communication | null> {
    const query = await database.query<CommunicationRow>(
      `SELECT * FROM sd_communications WHERE instance_id=$1 AND id=$2${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
      [instanceId, id],
    );
    return query.rows[0] ? this.map(database, query.rows[0]) : null;
  }
  async list(
    instanceId: string,
    query: HistoryQuery = {},
    allowedRadioIds?: readonly string[],
  ): Promise<{
    items: Communication[];
    nextCursor?: { startedAt: string; id: string };
  }> {
    const values: unknown[] = [instanceId];
    const conditions = ['c.instance_id=$1', 'c.deleted_at IS NULL'];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (allowedRadioIds) add('c.radio_id=ANY(?::uuid[])', allowedRadioIds);
    if (query.radioId) add('c.radio_id=?', query.radioId);
    if (query.frequencyHz !== undefined) add('c.rx_hz=?', query.frequencyHz);
    if (query.direction) add('c.direction=?', query.direction);
    if (query.search) {
      values.push(`%${query.search.slice(0, 2000)}%`);
      const bind = `$${values.length}`;
      conditions.push(
        `(c.notes::text ILIKE ${bind} OR c.tags::text ILIKE ${bind} OR EXISTS(SELECT 1 FROM sd_transcript_revisions t WHERE t.instance_id=c.instance_id AND t.communication_id=c.id AND t.text ILIKE ${bind}))`,
      );
    }
    if (query.before) {
      values.push(query.before.startedAt, query.before.id);
      conditions.push(
        `(c.started_at,c.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    const limit = Math.max(1, Math.min(100, query.limit ?? 50));
    if (!Number.isInteger(limit))
      throw new SignalDockError('INVALID_ARGUMENT', 'Invalid page limit.');
    values.push(limit + 1);
    const result = await this.database.query<CommunicationRow>(
      `SELECT c.* FROM sd_communications c WHERE ${conditions.join(' AND ')} ORDER BY c.started_at DESC,c.id DESC LIMIT $${values.length}`,
      values,
    );
    const items = await Promise.all(
      result.rows.slice(0, limit).map((row) => this.map(this.database, row)),
    );
    const last = items.at(-1);
    return {
      items,
      ...(result.rows.length > limit && last
        ? { nextCursor: { startedAt: last.startedAt, id: last.id } }
        : {}),
    };
  }
  async conversations(
    instanceId: string,
    allowedRadioIds?: readonly string[],
  ): Promise<Conversation[]> {
    const result = await this.database.query<{
      instance_id: string;
      id: string;
      radio_id: string;
      rx_hz: string | null;
      attribution: Conversation['attribution'];
      updated_at: Date;
    }>(
      `SELECT f.* FROM sd_frequency_conversations f WHERE instance_id=$1${allowedRadioIds ? ' AND radio_id=ANY($2::uuid[])' : ''} AND EXISTS(SELECT 1 FROM sd_communications c WHERE c.instance_id=f.instance_id AND c.conversation_id=f.id AND c.deleted_at IS NULL) ORDER BY updated_at DESC,id DESC LIMIT 200`,
      allowedRadioIds ? [instanceId, allowedRadioIds] : [instanceId],
    );
    return result.rows.map((row) =>
      ConversationSchema.parse({
        id: row.id,
        instanceId: row.instance_id,
        radioId: row.radio_id,
        ...(row.rx_hz ? { frequencyHz: Number(row.rx_hz) } : {}),
        attribution: row.attribution,
        updatedAt: row.updated_at.toISOString(),
      }),
    );
  }
  async appendTranscript(
    instanceId: string,
    id: string,
    input: {
      text: string;
      language?: string;
      source: 'provider' | 'human';
      provenance: Record<string, unknown>;
      expectedRevision: number;
    },
    transaction?: DatabasePort,
  ): Promise<TranscriptRevision> {
    if (
      Buffer.byteLength(JSON.stringify(input.provenance)) > 65536 ||
      input.text.length > 100000 ||
      (input.language && input.language.length > 100)
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Transcript exceeds the limit.',
      );
    const write = async (tx: DatabasePort) => {
      const source = await this.lock(
        tx,
        instanceId,
        id,
        input.expectedRevision,
      );
      const previous = await tx.query<{ revision: number }>(
        'SELECT COALESCE(max(revision),0)::int AS revision FROM sd_transcript_revisions WHERE instance_id=$1 AND communication_id=$2',
        [instanceId, id],
      );
      const transcript: TranscriptRevision = {
        id: randomUUID(),
        communicationId: id,
        revision: previous.rows[0]!.revision + 1,
        text: input.text,
        source: input.source,
        provenance: input.provenance,
        createdAt: new Date().toISOString(),
        ...(input.language ? { language: input.language } : {}),
      };
      TranscriptRevisionSchema.parse(transcript);
      await tx.query(
        'INSERT INTO sd_transcript_revisions(instance_id,id,communication_id,revision,text,language,source,provenance,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          instanceId,
          transcript.id,
          id,
          transcript.revision,
          input.text,
          input.language ?? null,
          input.source,
          JSON.stringify(input.provenance),
          transcript.createdAt,
        ],
      );
      await tx.query(
        'UPDATE sd_communications SET revision=revision+1 WHERE instance_id=$1 AND id=$2',
        [instanceId, id],
      );
      await appendOutbox(tx, {
        instanceId,
        id: randomUUID(),
        radioId: source.radio_id,
        type: 'transcript.created',
        payload: {
          communicationId: id,
          transcriptRevisionId: transcript.id,
          communicationRevision: source.revision + 1,
        },
      });
      return transcript;
    };
    return transaction ? write(transaction) : this.database.transaction(write);
  }
  async update(
    instanceId: string,
    id: string,
    input: {
      expectedRevision: number;
      notes?: string[];
      tags?: string[];
      retentionHold?: boolean;
      frequencyHz?: number;
      frequencyAttribution?: Communication['frequencyAttribution'];
    },
    actorUserId: string,
  ): Promise<Communication> {
    return this.database.transaction(async (tx) => {
      const current = await this.lock(
        tx,
        instanceId,
        id,
        input.expectedRevision,
      );
      const hz =
        input.frequencyHz ??
        (current.rx_hz ? Number(current.rx_hz) : undefined);
      const attribution =
        input.frequencyAttribution ?? current.frequency_attribution;
      if (hz !== undefined && (!Number.isSafeInteger(hz) || hz <= 0))
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Frequency must be integer Hz.',
        );
      const conversation = await this.conversation(
        tx,
        instanceId,
        current.radio_id,
        hz,
        attribution,
        current.ended_at.toISOString(),
      );
      await tx.query(
        'UPDATE sd_communications SET notes=$3,tags=$4,retention_hold=$5,rx_hz=$6,frequency_attribution=$7,conversation_id=$8,revision=revision+1 WHERE instance_id=$1 AND id=$2',
        [
          instanceId,
          id,
          JSON.stringify(input.notes ? this.notes(input.notes) : current.notes),
          input.tags ? this.tags(input.tags) : current.tags,
          input.retentionHold ?? current.retention_hold,
          hz ?? null,
          attribution,
          conversation,
        ],
      );
      await this.audit(
        tx,
        instanceId,
        id,
        actorUserId,
        'communication.updated',
        { revision: current.revision + 1 },
      );
      await appendOutbox(tx, {
        instanceId,
        id: randomUUID(),
        radioId: current.radio_id,
        type: 'communication.updated',
        payload: { communicationId: id },
      });
      return (await this.get(instanceId, id, tx))!;
    });
  }
  async delete(
    instanceId: string,
    id: string,
    actorUserId?: string,
  ): Promise<void> {
    const artifactIds = await this.database.transaction(async (tx) => {
      const prior = await this.get(instanceId, id, tx, true);
      if (prior?.deletedAt)
        return prior.recording ? [prior.recording.artifactId] : [];
      const source = await this.lock(tx, instanceId, id);
      await this.assertUnheld(tx, source);
      const recordings = await tx.query<{ artifact_id: string }>(
        'SELECT artifact_id FROM sd_recordings WHERE instance_id=$1 AND communication_id=$2 FOR UPDATE',
        [instanceId, id],
      );
      await tx.query(
        "UPDATE sd_jobs SET state='cancelled',cancelled_at=now(),updated_at=now() WHERE instance_id=$1 AND source->>'communicationId'=$2 AND state IN ('queued','running','retry_wait','requires_configuration')",
        [instanceId, id],
      );
      await this.options.onDeleteSource?.(tx, {
        instanceId,
        communicationId: id,
        artifactIds: recordings.rows.map((row) => row.artifact_id),
      });
      await this.removeDerived(tx, instanceId, id);
      await tx.query(
        'DELETE FROM sd_transcript_revisions WHERE instance_id=$1 AND communication_id=$2',
        [instanceId, id],
      );
      await tx.query(
        "UPDATE sd_recordings SET state='deleted' WHERE instance_id=$1 AND communication_id=$2",
        [instanceId, id],
      );
      await tx.query(
        "UPDATE sd_communications SET deleted_at=now(),revision=revision+1,notes='[]',tags='{}',context='{}' WHERE instance_id=$1 AND id=$2",
        [instanceId, id],
      );
      await this.audit(
        tx,
        instanceId,
        id,
        actorUserId,
        'communication.deleted',
        {},
      );
      await appendOutbox(tx, {
        instanceId,
        id: randomUUID(),
        radioId: source.radio_id,
        type: 'communication.deleted',
        payload: { communicationId: id },
      });
      return recordings.rows.map((row) => row.artifact_id);
    });
    for (const artifactId of artifactIds)
      await this.deleteArtifact(instanceId, artifactId);
  }
  /** Retry durable tombstones after storage outages; never publishes private paths. */
  async cleanupDeletedArtifacts(
    instanceId: string,
    limit = 50,
  ): Promise<number> {
    const rows = await this.database.query<{ artifact_id: string }>(
      "SELECT artifact_id FROM sd_recordings WHERE instance_id=$1 AND state='deleted' AND physical_deleted_at IS NULL LIMIT $2",
      [instanceId, Math.max(1, Math.min(limit, 500))],
    );
    let removed = 0;
    for (const row of rows.rows) {
      try {
        await this.deleteArtifact(instanceId, row.artifact_id);
        removed++;
      } catch {
        /* Remains durably pending for next sweep. */
      }
    }
    return removed;
  }
  /** Independent audio/text age limits; held communications and incident evidence survive. */
  async applyRetention(
    instanceId: string,
    policy: {
      audioBefore?: string;
      transcriptsBefore?: string;
      communicationsBefore?: string;
      limit?: number;
    },
  ): Promise<{ audio: number; transcripts: number; communications: number }> {
    for (const date of [
      policy.audioBefore,
      policy.transcriptsBefore,
      policy.communicationsBefore,
    ])
      if (date) TimestampSchema.parse(date);
    const values: unknown[] = [instanceId];
    const candidates: string[] = [];
    const cutoff = (at: string, filter: string) => {
      values.push(at);
      candidates.push(`(c.ended_at<$${values.length}::timestamptz${filter})`);
    };
    if (policy.communicationsBefore) cutoff(policy.communicationsBefore, '');
    if (policy.audioBefore)
      cutoff(
        policy.audioBefore,
        " AND EXISTS(SELECT 1 FROM sd_recordings r WHERE r.instance_id=c.instance_id AND r.communication_id=c.id AND r.state='available')",
      );
    if (policy.transcriptsBefore)
      cutoff(
        policy.transcriptsBefore,
        ' AND EXISTS(SELECT 1 FROM sd_transcript_revisions t WHERE t.instance_id=c.instance_id AND t.communication_id=c.id)',
      );
    if (!candidates.length)
      return { audio: 0, transcripts: 0, communications: 0 };
    const incidentFilter = (await this.table(
      this.database,
      'sd_incident_evidence',
    ))
      ? ' AND NOT EXISTS(SELECT 1 FROM sd_incident_evidence e JOIN sd_incidents i ON i.instance_id=e.instance_id AND i.id=e.incident_id WHERE e.instance_id=c.instance_id AND e.communication_id=c.id AND i.retention_hold=true)'
      : '';
    values.push(Math.max(1, Math.min(policy.limit ?? 100, 1000)));
    const rows = await this.database.query<{ id: string }>(
      `SELECT c.id FROM sd_communications c WHERE c.instance_id=$1 AND c.deleted_at IS NULL AND c.retention_hold=false AND (${candidates.join(' OR ')})${incidentFilter} ORDER BY c.ended_at,c.id LIMIT $${values.length}`,
      values,
    );
    const counts = { audio: 0, transcripts: 0, communications: 0 };
    for (const row of rows.rows) {
      try {
        const cleanup = await this.database.transaction(async (tx) => {
          const source = await this.lock(tx, instanceId, row.id);
          await this.assertUnheld(tx, source);
          const older = (at: string | undefined) =>
            at !== undefined && source.ended_at.getTime() < Date.parse(at);
          if (older(policy.communicationsBefore))
            return { delete: true, artifactIds: [] as string[] };
          const artifactIds: string[] = [];
          if (older(policy.audioBefore)) {
            const recordings = await tx.query<{ artifact_id: string }>(
              "UPDATE sd_recordings SET state='deleted' WHERE instance_id=$1 AND communication_id=$2 AND state='available' RETURNING artifact_id",
              [instanceId, row.id],
            );
            artifactIds.push(...recordings.rows.map((r) => r.artifact_id));
            await this.options.onDeleteSource?.(tx, {
              instanceId,
              communicationId: row.id,
              artifactIds,
            });
            counts.audio += recordings.rows.length;
          }
          if (older(policy.transcriptsBefore)) {
            await this.removeDerived(tx, instanceId, row.id);
            const deleted = await tx.query(
              'DELETE FROM sd_transcript_revisions WHERE instance_id=$1 AND communication_id=$2',
              [instanceId, row.id],
            );
            counts.transcripts += deleted.rowCount ?? 0;
          }
          if (artifactIds.length || older(policy.transcriptsBefore)) {
            await tx.query(
              'UPDATE sd_communications SET revision=revision+1 WHERE instance_id=$1 AND id=$2',
              [instanceId, row.id],
            );
            await this.audit(
              tx,
              instanceId,
              row.id,
              undefined,
              'retention.applied',
              {},
            );
          }
          return { delete: false, artifactIds };
        });
        if (cleanup.delete) {
          await this.delete(instanceId, row.id, undefined);
          counts.communications++;
        } else
          for (const artifactId of cleanup.artifactIds)
            await this.deleteArtifact(instanceId, artifactId);
      } catch (error) {
        if (
          error instanceof SignalDockError &&
          error.code === 'OPERATION_CONFLICT'
        )
          continue;
        throw error;
      }
    }
    return counts;
  }
  private async deleteArtifact(
    instanceId: string,
    artifactId: string,
  ): Promise<void> {
    await this.artifacts.delete(instanceId, artifactId);
    await this.database.query(
      "UPDATE sd_recordings SET physical_deleted_at=now() WHERE instance_id=$1 AND artifact_id=$2 AND state='deleted'",
      [instanceId, artifactId],
    );
  }
  async getRecordingContext(
    instanceId: string,
    artifactId: string,
    database: DatabasePort = this.database,
  ): Promise<RecordingContext | null> {
    const rows = await database.query<{
      id: string;
      revision: number;
      radio_id: string;
      started_at: Date;
      rx_hz: string | null;
      frequency_attribution: Communication['frequencyAttribution'];
    }>(
      "SELECT c.id,c.revision,c.radio_id,c.started_at,c.rx_hz,c.frequency_attribution FROM sd_recordings r JOIN sd_communications c ON c.instance_id=r.instance_id AND c.id=r.communication_id WHERE r.instance_id=$1 AND r.artifact_id=$2 AND r.state='available' AND c.deleted_at IS NULL",
      [instanceId, artifactId],
    );
    const row = rows.rows[0];
    return row
      ? {
          communicationId: row.id,
          communicationRevision: row.revision,
          radioId: row.radio_id,
          startedAt: row.started_at.toISOString(),
          ...(row.rx_hz ? { frequencyHz: Number(row.rx_hz) } : {}),
          attribution: row.frequency_attribution,
        }
      : null;
  }
  async recording(
    instanceId: string,
    id: string,
  ): Promise<RecordingRow | null> {
    const rows = await this.database.query<RecordingRow>(
      "SELECT r.*,c.radio_id FROM sd_recordings r JOIN sd_communications c ON c.instance_id=r.instance_id AND c.id=r.communication_id WHERE r.instance_id=$1 AND r.id=$2 AND r.state='available' AND c.deleted_at IS NULL",
      [instanceId, id],
    );
    return rows.rows[0] ?? null;
  }
  async readRecording(
    instanceId: string,
    id: string,
    range?: { start: number; end?: number },
  ) {
    const row = await this.recording(instanceId, id);
    if (!row)
      throw new SignalDockError('NOT_FOUND', 'Recording is unavailable.');
    const artifact = await this.artifacts.read(
      instanceId,
      row.artifact_id,
      range,
    );
    if (
      artifact.metadata.sha256 !== row.sha256 ||
      artifact.totalBytes !== Number(row.size_bytes) ||
      artifact.metadata.contentType !== row.content_type
    )
      throw new SignalDockError(
        'INTERNAL_ERROR',
        'Recording integrity verification failed.',
      );
    return artifact;
  }
  async validateJobSource(job: JobInput, tx: DatabasePort): Promise<boolean> {
    if (!job.source) return true;
    const rows = await tx.query<{ revision: number; deleted_at: Date | null }>(
      'SELECT revision,deleted_at FROM sd_communications WHERE instance_id=$1 AND id=$2 FOR UPDATE',
      [job.instanceId, job.source.communicationId],
    );
    const current = rows.rows[0];
    if (
      !current ||
      current.deleted_at ||
      current.revision !== job.source.communicationRevision
    )
      return false;
    if (job.source.artifactId) {
      const artifact = await tx.query<{ id: string }>(
        "SELECT id FROM sd_recordings WHERE instance_id=$1 AND communication_id=$2 AND artifact_id=$3 AND state='available' FOR UPDATE",
        [job.instanceId, job.source.communicationId, job.source.artifactId],
      );
      if (!artifact.rows.length) return false;
    }
    return true;
  }
  async coverage(
    instanceId: string,
    radioId: string,
  ): Promise<Record<string, unknown>[]> {
    return (
      await this.database.query(
        'SELECT id,radio_id,generation,rx_hz,attribution,started_at,ended_at,reason FROM sd_coverage_intervals WHERE instance_id=$1 AND radio_id=$2 ORDER BY started_at DESC LIMIT 200',
        [instanceId, radioId],
      )
    ).rows;
  }
  async openCoverage(input: {
    instanceId: string;
    radioId: string;
    generation: string;
    frequencyHz?: number;
    attribution: Communication['frequencyAttribution'];
    startedAt: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.query(
      'INSERT INTO sd_coverage_intervals(instance_id,id,radio_id,generation,rx_hz,attribution,started_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        input.instanceId,
        id,
        input.radioId,
        input.generation,
        input.frequencyHz ?? null,
        input.attribution,
        input.startedAt,
      ],
    );
    return id;
  }
  async closeCoverage(
    instanceId: string,
    id: string,
    endedAt: string,
    reason: string,
  ): Promise<void> {
    await this.database.query(
      'UPDATE sd_coverage_intervals SET ended_at=$3,reason=$4 WHERE instance_id=$1 AND id=$2 AND ended_at IS NULL',
      [instanceId, id, endedAt, reason],
    );
  }

  private notes(notes: string[]): string[] {
    if (
      notes.length > 200 ||
      notes.some((note) => typeof note !== 'string' || note.length > 10000)
    )
      throw new SignalDockError('INVALID_ARGUMENT', 'Notes exceed the limit.');
    return notes;
  }
  private tags(tags: string[]): string[] {
    if (
      tags.length > 50 ||
      tags.some((tag) => typeof tag !== 'string' || tag.length > 100)
    )
      throw new SignalDockError('INVALID_ARGUMENT', 'Tags exceed the limit.');
    return [...new Set(tags)];
  }
  private async lock(
    tx: DatabasePort,
    instanceId: string,
    id: string,
    revision?: number,
  ): Promise<CommunicationRow> {
    const rows = await tx.query<CommunicationRow>(
      'SELECT * FROM sd_communications WHERE instance_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
      [instanceId, id],
    );
    const current = rows.rows[0];
    if (!current)
      throw new SignalDockError('NOT_FOUND', 'Communication is unavailable.');
    if (revision !== undefined && revision !== current.revision)
      throw new SignalDockError('STALE_REVISION', 'The communication changed.');
    return current;
  }
  private async conversation(
    tx: DatabasePort,
    instanceId: string,
    radioId: string,
    hz: number | undefined,
    attribution: Conversation['attribution'],
    at: string,
  ): Promise<string> {
    const rows = await tx.query<{ id: string }>(
      'INSERT INTO sd_frequency_conversations(instance_id,id,radio_id,rx_hz,attribution,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(instance_id,radio_id,rx_hz) DO UPDATE SET updated_at=GREATEST(sd_frequency_conversations.updated_at,EXCLUDED.updated_at) RETURNING id',
      [
        instanceId,
        randomUUID(),
        radioId,
        attribution === 'unknown' ? null : (hz ?? null),
        attribution,
        at,
      ],
    );
    return rows.rows[0]!.id;
  }
  private async assertUnheld(
    tx: DatabasePort,
    source: CommunicationRow,
  ): Promise<void> {
    if (source.retention_hold)
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'Communication is under a retention hold.',
      );
    if (await this.table(tx, 'sd_incident_evidence')) {
      const held = await tx.query(
        'SELECT 1 FROM sd_incident_evidence e JOIN sd_incidents i ON i.instance_id=e.instance_id AND i.id=e.incident_id WHERE e.instance_id=$1 AND e.communication_id=$2 AND i.retention_hold=true LIMIT 1',
        [source.instance_id, source.id],
      );
      if (held.rows.length)
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'Incident evidence is under a retention hold.',
        );
    }
  }
  private async table(tx: DatabasePort, name: string): Promise<boolean> {
    return Boolean(
      (
        await tx.query<{ name: string | null }>(
          'SELECT to_regclass($1)::text AS name',
          [name],
        )
      ).rows[0]?.name,
    );
  }
  private async removeDerived(
    tx: DatabasePort,
    instanceId: string,
    id: string,
  ): Promise<void> {
    if (await this.table(tx, 'sd_analysis_results'))
      await tx.query(
        'DELETE FROM sd_analysis_results WHERE instance_id=$1 AND communication_id=$2',
        [instanceId, id],
      );
    if (await this.table(tx, 'sd_incident_evidence')) {
      const removed = await tx.query<{ incident_id: string }>(
        'DELETE FROM sd_incident_evidence WHERE instance_id=$1 AND communication_id=$2 RETURNING incident_id',
        [instanceId, id],
      );
      for (const incidentId of [
        ...new Set(removed.rows.map((row) => row.incident_id)),
      ].sort()) {
        const changed = await tx.query<{ revision: number; radio_id: string }>(
          'UPDATE sd_incidents SET revision=revision+1,updated_at=now() WHERE instance_id=$1 AND id=$2 RETURNING revision,radio_id',
          [instanceId, incidentId],
        );
        const incident = changed.rows[0];
        if (!incident) continue;
        await tx.query(
          "INSERT INTO sd_incident_actions(instance_id,id,incident_id,kind,revision) VALUES($1,$2,$3,'source_removed',$4)",
          [instanceId, randomUUID(), incidentId, incident.revision],
        );
        await appendOutbox(tx, {
          instanceId,
          id: randomUUID(),
          radioId: incident.radio_id,
          type: 'incident.updated',
          payload: {
            incidentId,
            revision: incident.revision,
            reason: 'source_removed',
          },
        });
      }
    }
  }
  private async audit(
    tx: DatabasePort,
    instanceId: string,
    communicationId: string,
    actorUserId: string | undefined,
    action: string,
    details: unknown,
  ) {
    await tx.query(
      'INSERT INTO sd_history_audit(instance_id,id,communication_id,actor_user_id,action,details) VALUES($1,$2,$3,$4,$5,$6)',
      [
        instanceId,
        randomUUID(),
        communicationId,
        actorUserId ?? null,
        action,
        JSON.stringify(details),
      ],
    );
  }
  private async map(
    database: DatabasePort,
    row: CommunicationRow,
  ): Promise<Communication> {
    const recordings = await database.query<RecordingRow>(
      'SELECT * FROM sd_recordings WHERE instance_id=$1 AND communication_id=$2',
      [row.instance_id, row.id],
    );
    const recording = recordings.rows[0];
    const transcripts = await database.query<{
      id: string;
      communication_id: string;
      revision: number;
      text: string;
      language: string | null;
      source: 'provider' | 'human';
      provenance: Record<string, unknown>;
      created_at: Date;
    }>(
      'SELECT * FROM sd_transcript_revisions WHERE instance_id=$1 AND communication_id=$2 ORDER BY revision',
      [row.instance_id, row.id],
    );
    return CommunicationSchema.parse({
      id: row.id,
      instanceId: row.instance_id,
      radioId: row.radio_id,
      conversationId: row.conversation_id,
      kind: row.kind,
      direction: row.direction,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at.toISOString(),
      ...(row.rx_hz ? { frequencyHz: Number(row.rx_hz) } : {}),
      frequencyAttribution: row.frequency_attribution,
      context: row.context,
      revision: row.revision,
      notes: row.notes,
      tags: row.tags,
      retentionHold: row.retention_hold,
      ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {}),
      ...(recording
        ? {
            recording: {
              id: recording.id,
              artifactId: recording.artifact_id,
              contentType: recording.content_type,
              sizeBytes: Number(recording.size_bytes),
              sha256: recording.sha256,
              state: recording.state,
              ...(recording.gap_reason
                ? { gapReason: recording.gap_reason }
                : {}),
            },
          }
        : {}),
      transcripts: transcripts.rows.map((t) => ({
        id: t.id,
        communicationId: t.communication_id,
        revision: t.revision,
        text: t.text,
        ...(t.language ? { language: t.language } : {}),
        source: t.source,
        provenance: t.provenance,
        createdAt: t.created_at.toISOString(),
      })),
    });
  }
}
