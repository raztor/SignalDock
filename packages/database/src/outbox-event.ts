export interface OutboxEvent {
  instanceId: string;
  id: string;
  type: string;
  radioId?: string;
  payload: unknown;
  occurredAt: string;
}

export interface OutboxEventRow extends Record<string, unknown> {
  instance_id: string;
  id: string;
  type: string;
  radio_id: string | null;
  payload: unknown;
  occurred_at: Date;
}

export function outboxEvent(row: OutboxEventRow): OutboxEvent {
  return {
    instanceId: row.instance_id,
    id: row.id,
    type: row.type,
    ...(row.radio_id ? { radioId: row.radio_id } : {}),
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  };
}
