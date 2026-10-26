import { createHash, randomUUID } from 'node:crypto';
import {
  SignalDockError,
  type DatabasePort,
  type IncidentRecord,
  type IncidentState,
  type SourceTranscript,
} from '@signaldock/contracts';
import {
  EmergencyFindingsSchema,
  EmergencyRuleSchema,
  type EmergencyFindings,
  type EmergencyRule,
} from '@signaldock/processing-tasks';

export interface IncidentAction {
  id: string;
  actorUserId?: string;
  kind: string;
  previousState?: IncidentState;
  nextState?: IncidentState;
  note: string;
  revision: number;
  occurredAt: string;
}
export interface IncidentAssessment {
  id: string;
  communicationId: string;
  transcriptRevisionId: string;
  connectorId: string;
  taskId: string;
  taskVersion: number;
  profileRevision: number;
  result: EmergencyFindings;
  createdAt: string;
}
export interface IncidentUpdate {
  expectedRevision: number;
  state?: IncidentState | undefined;
  ownerUserId?: string | null | undefined;
  retentionHold?: boolean | undefined;
  note?: string | undefined;
}
export interface IncidentPage {
  items: IncidentRecord[];
  nextCursor?: string;
}
export interface SourceAnalysis {
  id: string;
  communicationId: string;
  transcriptRevisionId: string;
  taskId: string;
  taskVersion: number;
  connectorId: string;
  profileRevision: number;
  result: unknown;
  createdAt: string;
}
export type IncidentOutboxWriter = (
  transaction: DatabasePort,
  event: {
    instanceId: string;
    id: string;
    type: string;
    radioId: string;
    payload: Record<string, unknown>;
  },
) => Promise<void>;
type Row = Record<string, unknown>;
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value);
const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;

export function mapIncident(row: Row): IncidentRecord {
  const record: IncidentRecord = {
    id: String(row['id']),
    instanceId: String(row['instance_id']),
    radioId: String(row['radio_id']),
    state: row['state'] as IncidentState,
    priority: row['priority'] as IncidentRecord['priority'],
    title: String(row['title']),
    retentionHold: Boolean(row['retention_hold']),
    revision: Number(row['revision']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    evidence: Array.isArray(row['evidence'])
      ? (row['evidence'] as IncidentRecord['evidence'])
      : [],
  };
  if (row['owner_user_id']) record.ownerUserId = String(row['owner_user_id']);
  return record;
}

const evidenceSelect = `(SELECT COALESCE(jsonb_agg(jsonb_build_object('communicationId',e.communication_id,
  'transcriptRevisionId',e.transcript_revision_id,'quote',e.quote) ORDER BY e.communication_id,e.transcript_revision_id),'[]'::jsonb)
  FROM sd_incident_evidence e WHERE e.instance_id=i.instance_id AND e.incident_id=i.id) AS evidence`;

export class SqlIncidentRepository {
  constructor(
    private readonly db: DatabasePort,
    private readonly emitOutbox: IncidentOutboxWriter,
  ) {}

  async list(
    instanceId: string,
    radioIds: readonly string[],
    options: {
      limit: number;
      state?: IncidentState;
      cursor?: { updatedAt: string; id: string };
    },
  ): Promise<IncidentPage> {
    if (!radioIds.length) return { items: [] };
    const result = await this.db.query(
      `SELECT i.*,${evidenceSelect} FROM sd_incidents i
      WHERE i.instance_id=$1 AND i.radio_id=ANY($2::uuid[]) AND ($3::text IS NULL OR i.state=$3)
      AND ($4::timestamptz IS NULL OR (i.updated_at,i.id)<($4::timestamptz,$5::uuid))
      ORDER BY i.updated_at DESC,i.id DESC LIMIT $6`,
      [
        instanceId,
        radioIds,
        options.state ?? null,
        options.cursor?.updatedAt ?? null,
        options.cursor?.id ?? null,
        options.limit + 1,
      ],
    );
    const items = result.rows.slice(0, options.limit).map(mapIncident);
    const last = items.at(-1);
    return {
      items,
      ...(result.rows.length > options.limit && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ updatedAt: last.updatedAt, id: last.id }),
            ).toString('base64url'),
          }
        : {}),
    };
  }

  async get(
    instanceId: string,
    id: string,
    tx = this.db,
  ): Promise<IncidentRecord | null> {
    const result = await tx.query(
      `SELECT i.*,${evidenceSelect} FROM sd_incidents i WHERE i.instance_id=$1 AND i.id=$2`,
      [instanceId, id],
    );
    return result.rows[0] ? mapIncident(result.rows[0]) : null;
  }

  async actions(
    instanceId: string,
    incidentId: string,
  ): Promise<IncidentAction[]> {
    const result = await this.db.query(
      `SELECT * FROM sd_incident_actions WHERE instance_id=$1 AND incident_id=$2 ORDER BY occurred_at,id`,
      [instanceId, incidentId],
    );
    return result.rows.map((row) => ({
      id: String(row['id']),
      kind: String(row['kind']),
      note: String(row['note']),
      revision: Number(row['revision']),
      occurredAt: iso(row['occurred_at']),
      ...(row['actor_user_id']
        ? { actorUserId: String(row['actor_user_id']) }
        : {}),
      ...(row['previous_state']
        ? { previousState: row['previous_state'] as IncidentState }
        : {}),
      ...(row['next_state']
        ? { nextState: row['next_state'] as IncidentState }
        : {}),
    }));
  }

  async assessments(
    instanceId: string,
    incidentId: string,
  ): Promise<IncidentAssessment[]> {
    const result = await this.db.query(
      `SELECT DISTINCT a.* FROM sd_analysis_results a
      JOIN sd_incident_evidence e ON e.instance_id=a.instance_id AND e.communication_id=a.communication_id
      WHERE e.instance_id=$1 AND e.incident_id=$2 AND a.task_id='emergency.classify' ORDER BY a.created_at,a.id`,
      [instanceId, incidentId],
    );
    return result.rows.map((row) => ({
      id: String(row['id']),
      communicationId: String(row['communication_id']),
      transcriptRevisionId: String(row['transcript_revision_id']),
      connectorId: String(row['connector_id']),
      taskId: String(row['task_id']),
      taskVersion: Number(row['task_version']),
      profileRevision: Number(row['profile_revision']),
      result: EmergencyFindingsSchema.parse(row['result']),
      createdAt: iso(row['created_at']),
    }));
  }

  async sourceRadio(
    instanceId: string,
    communicationId: string,
  ): Promise<string | null> {
    const result = await this.db.query(
      `SELECT radio_id FROM sd_communications WHERE instance_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [instanceId, communicationId],
    );
    return result.rows[0] ? String(result.rows[0]['radio_id']) : null;
  }

  async analyses(
    instanceId: string,
    communicationId: string,
  ): Promise<SourceAnalysis[]> {
    const result = await this.db.query(
      `SELECT a.* FROM sd_analysis_results a
      JOIN sd_communications c ON c.instance_id=a.instance_id AND c.id=a.communication_id
      WHERE a.instance_id=$1 AND a.communication_id=$2 AND c.deleted_at IS NULL ORDER BY a.created_at,a.id`,
      [instanceId, communicationId],
    );
    return result.rows.map((row) => ({
      id: String(row['id']),
      communicationId: String(row['communication_id']),
      transcriptRevisionId: String(row['transcript_revision_id']),
      taskId: String(row['task_id']),
      taskVersion: Number(row['task_version']),
      connectorId: String(row['connector_id']),
      profileRevision: Number(row['profile_revision']),
      result: row['result'],
      createdAt: iso(row['created_at']),
    }));
  }

  async recordTaskResult(
    input: {
      analysisId: string;
      source: SourceTranscript;
      taskId: string;
      taskVersion: number;
      connectorId: string;
      profileRevision: number;
      result: unknown;
    },
    signal: AbortSignal,
    transaction?: DatabasePort,
  ): Promise<void> {
    const write = async (tx: DatabasePort) => {
      signal.throwIfAborted();
      const source = await this.source(input.source, tx, true);
      if (!source || source.text !== input.source.text)
        throw new SignalDockError(
          'STALE_REVISION',
          'The analyzed source was deleted or superseded.',
        );
      const saved = await tx.query(
        `INSERT INTO sd_analysis_results(instance_id,id,communication_id,transcript_revision_id,task_id,task_version,connector_id,profile_revision,input_sha256,result)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(instance_id,id) DO NOTHING RETURNING id`,
        [
          source.instanceId,
          input.analysisId,
          source.communicationId,
          source.transcriptRevisionId,
          input.taskId,
          input.taskVersion,
          input.connectorId,
          input.profileRevision,
          createHash('sha256').update(source.text).digest('hex'),
          JSON.stringify(input.result),
        ],
      );
      if (!saved.rowCount) {
        const duplicate = await tx.query(
          `SELECT id FROM sd_analysis_results WHERE instance_id=$1 AND id=$2
          AND communication_id=$3 AND transcript_revision_id=$4 AND task_id=$5 AND task_version=$6 AND connector_id=$7
          AND profile_revision=$8 AND result=$9::jsonb`,
          [
            source.instanceId,
            input.analysisId,
            source.communicationId,
            source.transcriptRevisionId,
            input.taskId,
            input.taskVersion,
            input.connectorId,
            input.profileRevision,
            JSON.stringify(input.result),
          ],
        );
        if (!duplicate.rowCount)
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'An analysis ID was reused with different content.',
          );
      }
      signal.throwIfAborted();
    };
    if (transaction) await write(transaction);
    else await this.db.transaction(write);
  }

  async rules(instanceId: string): Promise<EmergencyRule[]> {
    const result = await this.db.query(
      `SELECT definition FROM sd_incident_rules WHERE instance_id=$1 ORDER BY id LIMIT 101`,
      [instanceId],
    );
    if (result.rows.length > 100)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'An instance supports at most 100 emergency rules.',
      );
    return result.rows.map((row) =>
      EmergencyRuleSchema.parse(row['definition']),
    );
  }

  async saveRule(
    instanceId: string,
    rule: EmergencyRule,
    actorUserId: string,
  ): Promise<EmergencyRule> {
    const parsed = EmergencyRuleSchema.parse(rule);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext('sd_incident_rules:' || $1))`,
        [instanceId],
      );
      const existing = await tx.query(
        `SELECT id FROM sd_incident_rules WHERE instance_id=$1 AND id=$2`,
        [instanceId, parsed.id],
      );
      if (!existing.rowCount) {
        const count = await tx.query<{ count: string }>(
          `SELECT count(*) AS count FROM sd_incident_rules WHERE instance_id=$1`,
          [instanceId],
        );
        if (Number(count.rows[0]!['count']) >= 100)
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'An instance supports at most 100 emergency rules.',
          );
      }
      await tx.query(
        `INSERT INTO sd_incident_rules(instance_id,id,definition,enabled) VALUES($1,$2,$3::jsonb,$4)
        ON CONFLICT(instance_id,id) DO UPDATE SET definition=excluded.definition,enabled=excluded.enabled,updated_at=now()`,
        [instanceId, parsed.id, JSON.stringify(parsed), parsed.enabled],
      );
      await tx.query(
        `INSERT INTO sd_incident_rule_actions(instance_id,id,rule_id,actor_user_id,kind,definition)
        VALUES($1,$2,$3,$4,'saved',$5::jsonb)`,
        [
          instanceId,
          randomUUID(),
          parsed.id,
          actorUserId,
          JSON.stringify(parsed),
        ],
      );
    });
    return parsed;
  }

  async removeRule(
    instanceId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const removed = await tx.query(
        `DELETE FROM sd_incident_rules WHERE instance_id=$1 AND id=$2 RETURNING definition`,
        [instanceId, id],
      );
      if (removed.rows[0])
        await tx.query(
          `INSERT INTO sd_incident_rule_actions(instance_id,id,rule_id,actor_user_id,kind,definition)
        VALUES($1,$2,$3,$4,'removed',$5::jsonb)`,
          [
            instanceId,
            randomUUID(),
            id,
            actorUserId,
            JSON.stringify(removed.rows[0]['definition']),
          ],
        );
    });
  }

  async source(
    reference: Pick<
      SourceTranscript,
      'instanceId' | 'communicationId' | 'transcriptRevisionId'
    >,
    tx = this.db,
    lock = false,
  ): Promise<SourceTranscript | null> {
    const result = await tx.query(
      `SELECT c.radio_id,c.rx_hz,c.frequency_attribution,c.started_at,t.text
      FROM sd_communications c JOIN sd_transcript_revisions t ON t.instance_id=c.instance_id AND t.communication_id=c.id
      WHERE c.instance_id=$1 AND c.id=$2 AND t.id=$3 AND c.deleted_at IS NULL
      AND t.revision=(SELECT max(tr.revision) FROM sd_transcript_revisions tr WHERE tr.instance_id=c.instance_id AND tr.communication_id=c.id)
      ${lock ? 'FOR SHARE OF c,t' : ''}`,
      [
        reference.instanceId,
        reference.communicationId,
        reference.transcriptRevisionId,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...reference,
      radioId: String(row['radio_id']),
      text: String(row['text']),
      capturedAt: iso(row['started_at']),
      ...(row['rx_hz'] !== null && row['frequency_attribution'] === 'confirmed'
        ? { frequencyHz: Number(row['rx_hz']) }
        : {}),
    };
  }

  async update(
    instanceId: string,
    incidentId: string,
    actorUserId: string,
    input: IncidentUpdate,
  ): Promise<IncidentRecord> {
    return this.db.transaction(async (tx) => {
      if (input.retentionHold === true) {
        // Source-first ordering also used by history deletion and analysis commits.
        const sources = await tx.query(
          `SELECT c.id FROM sd_communications c
          WHERE c.instance_id=$1 AND c.deleted_at IS NULL AND EXISTS(
            SELECT 1 FROM sd_incident_evidence e WHERE e.instance_id=c.instance_id
            AND e.communication_id=c.id AND e.incident_id=$2)
          ORDER BY c.id FOR SHARE OF c`,
          [instanceId, incidentId],
        );
        if (!sources.rowCount)
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'No current source evidence remains to hold.',
          );
      }
      const current = await tx.query(
        `SELECT * FROM sd_incidents WHERE instance_id=$1 AND id=$2 FOR UPDATE`,
        [instanceId, incidentId],
      );
      const row = current.rows[0];
      if (!row) throw new SignalDockError('NOT_FOUND', 'Incident not found.');
      if (Number(row['revision']) !== input.expectedRevision)
        throw new SignalDockError(
          'STALE_REVISION',
          'Incident changed; reload before updating.',
        );
      if (input.ownerUserId) {
        const assignee = await tx.query(
          `SELECT id FROM sd_users WHERE instance_id=$1 AND id=$2 AND enabled=true`,
          [instanceId, input.ownerUserId],
        );
        if (!assignee.rowCount)
          throw new SignalDockError(
            'INVALID_ARGUMENT',
            'The incident owner must be an enabled user of this instance.',
          );
      }
      const state = input.state ?? (row['state'] as IncidentState);
      await tx.query(
        `UPDATE sd_incidents SET state=$3, owner_user_id=$4,retention_hold=$5,revision=revision+1,updated_at=now()
        WHERE instance_id=$1 AND id=$2`,
        [
          instanceId,
          incidentId,
          state,
          input.ownerUserId === undefined
            ? row['owner_user_id']
            : input.ownerUserId,
          input.retentionHold ?? row['retention_hold'],
        ],
      );
      await tx.query(
        `INSERT INTO sd_incident_actions(instance_id,id,incident_id,actor_user_id,kind,previous_state,next_state,note,revision)
        VALUES($1,$2,$3,$4,'operator_update',$5,$6,$7,$8)`,
        [
          instanceId,
          randomUUID(),
          incidentId,
          actorUserId,
          row['state'],
          state,
          input.note ?? '',
          input.expectedRevision + 1,
        ],
      );
      await this.emitOutbox(tx, {
        instanceId,
        id: randomUUID(),
        type: 'incident.updated',
        radioId: String(row['radio_id']),
        payload: { incidentId, revision: input.expectedRevision + 1 },
      });
      return (await this.get(instanceId, incidentId, tx))!;
    });
  }

  async recordAssessment(
    input: {
      analysisId: string;
      source: SourceTranscript;
      findings: EmergencyFindings;
      connectorId: string;
      profileRevision: number;
      aggregationWindowMs: number;
    },
    signal: AbortSignal,
    transaction?: DatabasePort,
  ): Promise<{ incidentId?: string; duplicate: boolean }> {
    const write = async (
      tx: DatabasePort,
    ): Promise<{ incidentId?: string; duplicate: boolean }> => {
      signal.throwIfAborted();
      const source = await this.source(input.source, tx, true);
      if (!source || source.text !== input.source.text)
        throw new SignalDockError(
          'STALE_REVISION',
          'The analyzed source was deleted or superseded.',
        );
      const saved = await tx.query(
        `INSERT INTO sd_analysis_results(instance_id,id,communication_id,transcript_revision_id,task_id,task_version,connector_id,profile_revision,input_sha256,result)
        VALUES($1,$2,$3,$4,'emergency.classify',1,$5,$6,$7,$8::jsonb) ON CONFLICT(instance_id,id) DO NOTHING RETURNING id`,
        [
          source.instanceId,
          input.analysisId,
          source.communicationId,
          source.transcriptRevisionId,
          input.connectorId,
          input.profileRevision,
          createHash('sha256').update(source.text).digest('hex'),
          JSON.stringify(input.findings),
        ],
      );
      if (!saved.rowCount) {
        const priorResult = await tx.query(
          `SELECT id FROM sd_analysis_results WHERE instance_id=$1 AND id=$2
          AND communication_id=$3 AND transcript_revision_id=$4 AND task_id='emergency.classify' AND task_version=1
          AND connector_id=$5 AND profile_revision=$6 AND result=$7::jsonb`,
          [
            source.instanceId,
            input.analysisId,
            source.communicationId,
            source.transcriptRevisionId,
            input.connectorId,
            input.profileRevision,
            JSON.stringify(input.findings),
          ],
        );
        if (!priorResult.rowCount)
          throw new SignalDockError(
            'OPERATION_CONFLICT',
            'An analysis ID was reused with different content.',
          );
        return { duplicate: true };
      }
      // Serializes aggregation for this radio without blocking unrelated radios.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `${source.instanceId}:${source.radioId}`,
      ]);
      const prior = await tx.query(
        `SELECT i.* FROM sd_incidents i WHERE i.instance_id=$1 AND i.radio_id=$2 AND (
        EXISTS(SELECT 1 FROM sd_incident_evidence e WHERE e.instance_id=i.instance_id AND e.incident_id=i.id AND e.communication_id=$3)
        OR ($7::boolean AND $4::bigint IS NOT NULL AND i.frequency_hz=$4 AND i.state IN ('new','acknowledged','in_progress')
          AND i.last_source_at >= $5::timestamptz AND i.source_started_at <= $6::timestamptz))
        ORDER BY i.updated_at DESC LIMIT 1 FOR UPDATE`,
        [
          source.instanceId,
          source.radioId,
          source.communicationId,
          source.frequencyHz ?? null,
          new Date(
            Date.parse(source.capturedAt) - input.aggregationWindowMs,
          ).toISOString(),
          new Date(
            Date.parse(source.capturedAt) + input.aggregationWindowMs,
          ).toISOString(),
          input.findings.detected,
        ],
      );
      let row = prior.rows[0];
      if (!input.findings.detected && !row) return { duplicate: false };
      const id = row ? String(row['id']) : randomUUID();
      const createdNew = !row;
      if (!row) {
        const created = await tx.query(
          `INSERT INTO sd_incidents(instance_id,id,radio_id,state,priority,title,frequency_hz,source_started_at,last_source_at)
          VALUES($1,$2,$3,'new',$4,$5,$6,$7,$7) RETURNING *`,
          [
            source.instanceId,
            id,
            source.radioId,
            input.findings.priority,
            'Distress indication for review',
            source.frequencyHz ?? null,
            source.capturedAt,
          ],
        );
        row = created.rows[0]!;
      } else {
        const priority =
          rank[input.findings.priority] >
          rank[row['priority'] as IncidentRecord['priority']]
            ? input.findings.priority
            : row['priority'];
        const updated = await tx.query(
          `UPDATE sd_incidents SET priority=$3,revision=revision+1,updated_at=now(),
          source_started_at=LEAST(source_started_at,$4::timestamptz),last_source_at=GREATEST(last_source_at,$4::timestamptz)
          WHERE instance_id=$1 AND id=$2 RETURNING *`,
          [source.instanceId, id, priority, source.capturedAt],
        );
        row = updated.rows[0]!;
      }
      for (const reason of input.findings.reasons)
        for (const evidence of reason.evidence) {
          await tx.query(
            `INSERT INTO sd_incident_evidence(instance_id,incident_id,communication_id,transcript_revision_id,quote)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [
              source.instanceId,
              id,
              evidence.communicationId,
              source.transcriptRevisionId,
              evidence.quote,
            ],
          );
        }
      await tx.query(
        `INSERT INTO sd_incident_actions(instance_id,id,incident_id,kind,note,revision) VALUES($1,$2,$3,'assessment',$4,$5)`,
        [
          source.instanceId,
          randomUUID(),
          id,
          input.findings.detected
            ? 'New evidence added for human review.'
            : 'The latest transcript no longer contains a rule match; previous decisions are preserved.',
          row['revision'],
        ],
      );
      await this.emitOutbox(tx, {
        instanceId: source.instanceId,
        id: randomUUID(),
        type: createdNew ? 'incident.created' : 'incident.updated',
        radioId: source.radioId,
        payload: {
          incidentId: id,
          communicationId: source.communicationId,
          revision: Number(row['revision']),
        },
      });
      signal.throwIfAborted();
      return { incidentId: id, duplicate: false };
    };
    return transaction ? write(transaction) : this.db.transaction(write);
  }
}
