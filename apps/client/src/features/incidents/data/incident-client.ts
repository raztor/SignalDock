import { apiRequest } from '@signaldock/client-sdk';
import {
  IdSchema,
  IncidentRecordSchema,
  SignalDockError,
  type ClientSession,
  type IncidentRecord,
  type IncidentState,
} from '@signaldock/contracts';

export interface IncidentDetailView {
  incident: IncidentRecord;
  actions: {
    id: string;
    kind: string;
    note: string;
    occurredAt: string;
    actorUserId?: string;
  }[];
  assessments: {
    id: string;
    connectorId: string;
    transcriptRevisionId: string;
    createdAt: string;
    result: unknown;
  }[];
}
export interface RuleSummary {
  id: string;
  name: string;
  phrases: string[];
  enabled: boolean;
  priority: string;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('The server returned an invalid incident response.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('The server returned an invalid incident field.');
  return value;
}
function items(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error('The server returned an invalid incident list.');
  return value;
}

export class IncidentClient {
  constructor(private readonly session: ClientSession) {}
  private record(input: unknown): IncidentRecord {
    const incident = IncidentRecordSchema.parse(input);
    if (incident.instanceId !== this.session.instanceId)
      throw new SignalDockError(
        'FORBIDDEN',
        'The response belongs to another instance.',
      );
    return incident;
  }
  async list(
    input: { radioId?: string; state?: IncidentState; cursor?: string },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: '50', ...input });
    const data = object(
      await apiRequest<unknown>(
        this.session,
        `incidents?${query}`,
        signal ? { signal } : {},
      ),
    );
    return {
      items: items(data['items']).map((item) => this.record(item)),
      ...(typeof data['nextCursor'] === 'string'
        ? { nextCursor: data['nextCursor'] }
        : {}),
    };
  }
  async detail(id: string, signal?: AbortSignal): Promise<IncidentDetailView> {
    const data = object(
      await apiRequest<unknown>(
        this.session,
        `incidents/${IdSchema.parse(id)}`,
        signal ? { signal } : {},
      ),
    );
    return {
      incident: this.record(data['incident']),
      actions: items(data['actions']).map((item) => {
        const action = object(item);
        return {
          id: IdSchema.parse(action['id']),
          kind: text(action['kind']),
          note: text(action['note']),
          occurredAt: text(action['occurredAt']),
          ...(typeof action['actorUserId'] === 'string'
            ? { actorUserId: IdSchema.parse(action['actorUserId']) }
            : {}),
        };
      }),
      assessments: items(data['assessments']).map((item) => {
        const assessment = object(item);
        return {
          id: IdSchema.parse(assessment['id']),
          connectorId: text(assessment['connectorId']),
          transcriptRevisionId: IdSchema.parse(
            assessment['transcriptRevisionId'],
          ),
          createdAt: text(assessment['createdAt']),
          result: assessment['result'],
        };
      }),
    };
  }
  async update(
    id: string,
    input: {
      expectedRevision: number;
      state?: IncidentState;
      note?: string;
      retentionHold?: boolean;
      ownerUserId?: string | null;
    },
    signal?: AbortSignal,
  ) {
    return this.record(
      await apiRequest<unknown>(
        this.session,
        `incidents/${IdSchema.parse(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(input),
          ...(signal ? { signal } : {}),
        },
      ),
    );
  }
  async rules(signal?: AbortSignal): Promise<RuleSummary[]> {
    const data = object(
      await apiRequest<unknown>(
        this.session,
        'incidents/rules',
        signal ? { signal } : {},
      ),
    );
    return items(data['items']).map((item) => {
      const rule = object(item);
      return {
        id: IdSchema.parse(rule['id']),
        name: text(rule['name']),
        phrases: items(rule['phrases']).map(text),
        enabled: rule['enabled'] === true,
        priority: text(rule['priority']),
      };
    });
  }
  async saveRule(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    await apiRequest(this.session, 'incidents/rules', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
  }
  async removeRule(id: string, signal?: AbortSignal): Promise<void> {
    await apiRequest(this.session, `incidents/rules/${IdSchema.parse(id)}`, {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    });
  }
}
