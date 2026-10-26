import { createHash } from 'node:crypto';
import {
  IdSchema,
  SignalDockError,
  type AuthenticationPort,
  type IncidentRecord,
  type IncidentState,
  type Principal,
  type SourceTranscript,
  type JobExecutionContext,
  type DatabasePort,
} from '@signaldock/contracts';
import {
  EmergencyFindingsSchema,
  EmergencyRuleSchema,
  assertTextEvidence,
  defaultEmergencyRules,
  detectEmergency,
  extractCallsigns,
  extractEntities,
  summarizeExtractively,
  type EmergencyFindings,
  type EmergencyRule,
} from '@signaldock/processing-tasks';
import type { IncidentUpdate, SqlIncidentRepository } from './repository.js';

export type IncidentRepositoryPort = Pick<
  SqlIncidentRepository,
  | 'list'
  | 'get'
  | 'actions'
  | 'assessments'
  | 'rules'
  | 'saveRule'
  | 'removeRule'
  | 'source'
  | 'update'
  | 'recordAssessment'
  | 'sourceRadio'
  | 'analyses'
  | 'recordTaskResult'
>;
type SourceReference = Pick<
  SourceTranscript,
  'instanceId' | 'communicationId' | 'transcriptRevisionId'
>;
const transitions: Record<IncidentState, readonly IncidentState[]> = {
  new: ['acknowledged', 'in_progress', 'resolved', 'dismissed'],
  acknowledged: ['in_progress', 'resolved', 'dismissed'],
  in_progress: ['resolved', 'dismissed'],
  resolved: ['acknowledged'],
  dismissed: ['acknowledged'],
};

export class IncidentService {
  constructor(
    private readonly repository: IncidentRepositoryPort,
    private readonly auth: AuthenticationPort,
    private readonly options: {
      aggregationWindowMs?: number;
      useDefaultRules?: boolean;
    } = {},
  ) {}

  async list(
    principal: Principal,
    input: {
      limit: number;
      radioId?: string;
      state?: IncidentState;
      cursor?: { updatedAt: string; id: string };
    },
  ) {
    const radioIds = input.radioId
      ? [IdSchema.parse(input.radioId)]
      : principal.radioPermissions
          .filter(
            (grant) =>
              grant.permissions.includes('incident.read') &&
              grant.permissions.includes('history.read'),
          )
          .map((grant) => grant.radioId);
    for (const radioId of radioIds)
      await this.authorizeSource(principal, radioId);
    return this.repository.list(
      principal.instanceId,
      [...new Set(radioIds)],
      input,
    );
  }

  async get(principal: Principal, incidentId: string): Promise<IncidentRecord> {
    const incident = await this.repository.get(
      principal.instanceId,
      IdSchema.parse(incidentId),
    );
    if (!incident)
      throw new SignalDockError('NOT_FOUND', 'Incident not found.');
    await this.authorizeSource(principal, incident.radioId);
    return incident;
  }

  async detail(principal: Principal, incidentId: string) {
    const incident = await this.get(principal, incidentId);
    const [actions, assessments] = await Promise.all([
      this.repository.actions(principal.instanceId, incidentId),
      this.repository.assessments(principal.instanceId, incidentId),
    ]);
    return { incident, actions, assessments };
  }

  async sourceAnalyses(principal: Principal, communicationId: string) {
    const radioId = await this.repository.sourceRadio(
      principal.instanceId,
      IdSchema.parse(communicationId),
    );
    if (!radioId)
      throw new SignalDockError('NOT_FOUND', 'Communication not found.');
    await this.auth.authorize(principal, 'history.read', radioId);
    return this.repository.analyses(principal.instanceId, communicationId);
  }

  async update(
    principal: Principal,
    incidentId: string,
    input: IncidentUpdate,
  ): Promise<IncidentRecord> {
    const current = await this.get(principal, incidentId);
    await this.auth.authorize(principal, 'incident.manage', current.radioId);
    if (
      input.state &&
      input.state !== current.state &&
      !transitions[current.state].includes(input.state)
    ) {
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'The requested incident transition is not allowed.',
      );
    }
    if (
      input.state &&
      input.state !== current.state &&
      ['resolved', 'dismissed'].includes(input.state) &&
      !input.note?.trim()
    ) {
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Resolution or dismissal requires a note.',
      );
    }
    if (input.ownerUserId && input.ownerUserId !== principal.userId)
      await this.auth.authorize(principal, 'instance.admin');
    const update = {
      ...input,
      ...((input.state === 'acknowledged' || input.state === 'in_progress') &&
      !current.ownerUserId &&
      input.ownerUserId === undefined
        ? { ownerUserId: principal.userId }
        : {}),
    };
    return this.repository.update(
      principal.instanceId,
      incidentId,
      principal.userId,
      update,
    );
  }

  async rules(principal: Principal): Promise<EmergencyRule[]> {
    await this.auth.authorize(principal, 'instance.admin');
    return this.repository.rules(principal.instanceId);
  }

  async saveRule(principal: Principal, input: unknown): Promise<EmergencyRule> {
    await this.auth.authorize(principal, 'instance.admin');
    const rule = EmergencyRuleSchema.parse(input);
    IdSchema.parse(rule.id);
    return this.repository.saveRule(
      principal.instanceId,
      rule,
      principal.userId,
    );
  }

  async removeRule(principal: Principal, ruleId: string): Promise<void> {
    await this.auth.authorize(principal, 'instance.admin');
    await this.repository.removeRule(
      principal.instanceId,
      IdSchema.parse(ruleId),
      principal.userId,
    );
  }

  /** Worker-only entry point: always reloads the canonical, current transcript. */
  async analyzeRules(
    reference: SourceReference,
    signal: AbortSignal,
    analysisId: string,
    execution: JobExecutionContext,
  ) {
    signal.throwIfAborted();
    const source = await this.repository.source(reference);
    if (!source)
      throw new SignalDockError(
        'STALE_REVISION',
        'Transcript no longer exists or was superseded.',
      );
    const configured = await this.repository.rules(reference.instanceId);
    const rules = configured.length
      ? configured
      : this.options.useDefaultRules === true
        ? defaultEmergencyRules
        : [];
    const findings = detectEmergency(
      source.text,
      source.communicationId,
      rules,
      {
        radioId: source.radioId,
        capturedAt: source.capturedAt,
        ...(source.frequencyHz !== undefined
          ? { frequencyHz: source.frequencyHz }
          : {}),
      },
    );
    return execution.commit((tx) =>
      this.recordAssessment(
        source,
        {
          analysisId,
          findings,
          connectorId: 'local.analysis',
          profileRevision: 0,
        },
        signal,
        tx,
      ),
    );
  }

  async analyzeLocalTranscript(
    reference: SourceReference,
    signal: AbortSignal,
    jobId: string,
    execution: JobExecutionContext,
  ) {
    signal.throwIfAborted();
    const source = await this.repository.source(reference);
    if (!source)
      throw new SignalDockError(
        'STALE_REVISION',
        'Transcript no longer exists or was superseded.',
      );
    const results: { taskId: string; result: unknown }[] = [
      {
        taskId: 'callsign.extract',
        result: extractCallsigns(source.text, source.communicationId),
      },
      {
        taskId: 'entities.extract',
        result: extractEntities(source.text, source.communicationId),
      },
    ];
    if (source.text.trim())
      results.push({
        taskId: 'conversation.summarize',
        result: {
          text: summarizeExtractively(source.text),
          evidenceIds: [source.communicationId],
        },
      });
    const configured = await this.repository.rules(reference.instanceId);
    const rules = configured.length
      ? configured
      : this.options.useDefaultRules === true
        ? defaultEmergencyRules
        : [];
    const findings = detectEmergency(
      source.text,
      source.communicationId,
      rules,
      {
        radioId: source.radioId,
        capturedAt: source.capturedAt,
        ...(source.frequencyHz !== undefined
          ? { frequencyHz: source.frequencyHz }
          : {}),
      },
    );
    return execution.commit(async (tx) => {
      for (const item of results) {
        signal.throwIfAborted();
        await this.repository.recordTaskResult(
          {
            analysisId: childAnalysisId(jobId, item.taskId),
            source,
            taskId: item.taskId,
            taskVersion: 1,
            connectorId: 'local.analysis',
            profileRevision: 0,
            result: item.result,
          },
          signal,
          tx,
        );
      }
      const incident = await this.recordAssessment(
        source,
        {
          analysisId: childAnalysisId(jobId, 'emergency.classify'),
          findings,
          connectorId: 'local.analysis',
          profileRevision: 0,
        },
        signal,
        tx,
      );
      return {
        completedTasks: [
          ...results.map((item) => item.taskId),
          'emergency.classify',
        ],
        incident,
      };
    });
  }

  /** Provider processing uses the same source/evidence checks and never authorizes actions. */
  async acceptAssessment(
    reference: SourceReference,
    input: {
      analysisId: string;
      findings: unknown;
      connectorId: string;
      profileRevision: number;
    },
    signal: AbortSignal,
    execution: JobExecutionContext,
  ) {
    signal.throwIfAborted();
    const source = await this.repository.source(reference);
    if (!source)
      throw new SignalDockError(
        'STALE_REVISION',
        'Transcript no longer exists or was superseded.',
      );
    const findings = EmergencyFindingsSchema.parse(input.findings);
    for (const reason of findings.reasons)
      assertTextEvidence(
        source.text,
        [source.communicationId],
        reason.evidence,
      );
    return execution.commit((tx) =>
      this.recordAssessment(source, { ...input, findings }, signal, tx),
    );
  }

  private async recordAssessment(
    source: SourceTranscript,
    input: {
      analysisId: string;
      findings: EmergencyFindings;
      connectorId: string;
      profileRevision: number;
    },
    signal: AbortSignal,
    transaction: DatabasePort,
  ) {
    IdSchema.parse(input.analysisId);
    for (const reason of input.findings.reasons)
      assertTextEvidence(
        source.text,
        [source.communicationId],
        reason.evidence,
      );
    const result = await this.repository.recordAssessment(
      {
        ...input,
        source,
        aggregationWindowMs: this.options.aggregationWindowMs ?? 300000,
      },
      signal,
      transaction,
    );
    return {
      ...result,
      analysisId: input.analysisId,
      detected: input.findings.detected,
    };
  }

  private async authorizeSource(
    principal: Principal,
    radioId: string,
  ): Promise<void> {
    await this.auth.authorize(principal, 'incident.read', radioId);
    await this.auth.authorize(principal, 'history.read', radioId);
  }
}

/** Stable child IDs deduplicate task writes when the same transcript job is retried. */
function childAnalysisId(jobId: string, taskId: string): string {
  const hash = createHash('sha256').update(`${jobId}:${taskId}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
