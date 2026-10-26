import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresDatabase,
  appendOutbox,
  foundationMigrations,
  migrate,
} from '@signaldock/database';
import { HistoryService, historyMigrations } from '@signaldock/history';
import { PostgresJobQueue } from '@signaldock/job-queue';
import {
  SignalDockError,
  type AuthenticationPort,
  type JobExecutionContext,
  type Principal,
} from '@signaldock/contracts';
import { incidentMigrations } from '../src/modules/incidents/migrations.js';
import { SqlIncidentRepository } from '../src/modules/incidents/repository.js';
import { IncidentService } from '../src/modules/incidents/service.js';
import { registerIncidentRoutes } from '../src/modules/incidents/incidents.routes.js';
import { configureHttp } from '../src/shared/http/configure-http.js';
import {
  createLocalTranscriptAnalysisHandler,
  createRuleAnalysisHandler,
} from '@signaldock/processing-tasks';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('incident source integrity on PostgreSQL', () => {
  const schema = `sd_incidents_${randomUUID().replaceAll('-', '')}`;
  let admin: PostgresDatabase;
  let db: PostgresDatabase;
  let repository: SqlIncidentRepository;
  let service: IncidentService;
  const instanceId = randomUUID();
  const radioId = randomUUID();
  const userId = randomUUID();
  const communicationId = randomUUID();
  const transcriptRevisionId = randomUUID();
  const principal: Principal = {
    instanceId,
    userId,
    sessionId: randomUUID(),
    username: 'operator',
    role: 'operator',
    radioPermissions: [
      {
        radioId,
        permissions: ['incident.read', 'incident.manage', 'history.read'],
      },
    ],
  };
  const auth: AuthenticationPort = {
    authenticate: async () => principal,
    authorize: async (actor, permission, resource) => {
      const allowed =
        permission === 'instance.admin'
          ? actor.role === 'administrator'
          : actor.radioPermissions.some(
              (grant) =>
                grant.radioId === resource &&
                grant.permissions.includes(permission),
            );
      if (!allowed)
        throw new SignalDockError('FORBIDDEN', 'Permission denied.');
    },
  };
  const reference = { instanceId, communicationId, transcriptRevisionId };
  const execution: JobExecutionContext = {
    commit: (write) => db.transaction(write),
  };

  beforeAll(async () => {
    admin = new PostgresDatabase({ connectionString: url! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new PostgresDatabase({
      connectionString: url!,
      options: `-c search_path=${schema},public`,
    });
    await migrate(db, foundationMigrations);
    await db.query(
      `CREATE TABLE sd_users(instance_id uuid,id uuid,enabled boolean NOT NULL,PRIMARY KEY(instance_id,id));`,
    );
    await migrate(db, [
      ...foundationMigrations,
      ...historyMigrations,
      ...incidentMigrations,
    ]);
    repository = new SqlIncidentRepository(db, appendOutbox);
    service = new IncidentService(repository, auth, { useDefaultRules: true });
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE sd_incident_evidence,sd_incident_actions,sd_incidents,sd_analysis_results,sd_incident_rules,
      sd_incident_rule_actions,sd_transcript_revisions,sd_communications,sd_frequency_conversations,sd_users,sd_event_outbox CASCADE`);
    await db.query(
      `INSERT INTO sd_users(instance_id,id,enabled) VALUES($1,$2,true)`,
      [instanceId, userId],
    );
    const conversationId = randomUUID();
    await db.query(
      `INSERT INTO sd_frequency_conversations(instance_id,id,radio_id,rx_hz,attribution)
      VALUES($1,$2,$3,145500000,'confirmed')`,
      [instanceId, conversationId, radioId],
    );
    await db.query(
      `INSERT INTO sd_communications(instance_id,id,radio_id,conversation_id,kind,direction,rx_hz,frequency_attribution,started_at,ended_at,context)
      VALUES($1,$2,$3,$4,'received_voice','rx',145500000,'confirmed',now(),now(),'{}')`,
      [instanceId, communicationId, radioId, conversationId],
    );
    await db.query(
      `INSERT INTO sd_transcript_revisions(instance_id,id,communication_id,revision,text,source,provenance)
      VALUES($1,$2,$3,1,'This is CE3ABC near Cerro Alto. Mayday, need help.','human','{}')`,
      [instanceId, transcriptRevisionId, communicationId],
    );
  });
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  });

  async function incident() {
    const result = await service.analyzeLocalTranscript(
      reference,
      new AbortController().signal,
      randomUUID(),
      execution,
    );
    return service.get(principal, result.incident.incidentId!);
  }
  async function count(table: string) {
    return Number(
      (await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0]![
        'count'
      ],
    );
  }
  async function revise(text: string) {
    const nextId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        `SELECT id FROM sd_communications WHERE instance_id=$1 AND id=$2 FOR UPDATE`,
        [instanceId, communicationId],
      );
      await tx.query(
        `UPDATE sd_communications SET revision=revision+1 WHERE instance_id=$1 AND id=$2`,
        [instanceId, communicationId],
      );
      await tx.query(
        `INSERT INTO sd_transcript_revisions(instance_id,id,communication_id,revision,text,source,provenance)
        VALUES($1,$2,$3,2,$4,'human','{}')`,
        [instanceId, nextId, communicationId, text],
      );
    });
    return { ...reference, transcriptRevisionId: nextId };
  }

  it('persists all four local tasks, source evidence and one transactional notification', async () => {
    const jobId = randomUUID();
    const first = await service.analyzeLocalTranscript(
      reference,
      new AbortController().signal,
      jobId,
      execution,
    );
    const record = await service.get(principal, first.incident.incidentId!);
    expect(record).toMatchObject({
      state: 'new',
      priority: 'high',
      retentionHold: true,
      radioId,
    });
    expect(record.evidence[0]).toMatchObject({
      communicationId,
      transcriptRevisionId,
    });
    expect(await count('sd_analysis_results')).toBe(4);
    expect(await count('sd_event_outbox')).toBe(1);
    await service.analyzeLocalTranscript(
      reference,
      new AbortController().signal,
      jobId,
      execution,
    );
    expect(await count('sd_analysis_results')).toBe(4);
    expect(await count('sd_event_outbox')).toBe(1);
    const stored = await service.sourceAnalyses(principal, communicationId);
    expect(stored.map((item) => item.taskId).sort()).toEqual([
      'callsign.extract',
      'conversation.summarize',
      'emergency.classify',
      'entities.extract',
    ]);
  });
  it('respects per-radio permissions even for an administrator', async () => {
    const record = await incident();
    const adminWithoutGrants = {
      ...principal,
      role: 'administrator' as const,
      radioPermissions: [],
    };
    expect(await service.list(adminWithoutGrants, { limit: 50 })).toEqual({
      items: [],
    });
    await expect(
      service.get(adminWithoutGrants, record.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.sourceAnalyses(adminWithoutGrants, communicationId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.get({ ...principal, instanceId: randomUUID() }, record.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('audits acknowledgement and serializes competing revision updates', async () => {
    const record = await incident();
    const updates = await Promise.allSettled([
      service.update(principal, record.id, {
        expectedRevision: record.revision,
        state: 'acknowledged',
      }),
      service.update(principal, record.id, {
        expectedRevision: record.revision,
        state: 'dismissed',
        note: 'Confirmed exercise.',
      }),
    ]);
    expect(updates.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const failure = updates.find(
      (item) => item.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: 'STALE_REVISION' });
    expect((await service.get(principal, record.id)).revision).toBe(2);
    expect(
      (await repository.actions(instanceId, record.id)).filter(
        (item) => item.actorUserId === userId,
      ),
    ).toHaveLength(1);
  });
  it('requires explicit resolution notes and rejects unauthorized modification', async () => {
    const record = await incident();
    await expect(
      service.update(principal, record.id, {
        expectedRevision: 1,
        state: 'resolved',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const listener = {
      ...principal,
      role: 'listener' as const,
      radioPermissions: [
        { radioId, permissions: ['incident.read', 'history.read'] as const },
      ],
    };
    await expect(
      service.update(
        {
          ...listener,
          radioPermissions: listener.radioPermissions.map((grant) => ({
            ...grant,
            permissions: [...grant.permissions],
          })),
        },
        record.id,
        { expectedRevision: 1, state: 'acknowledged' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('preserves an operator decision after a corrected transcript removes the detection', async () => {
    const record = await incident();
    await service.update(principal, record.id, {
      expectedRevision: 1,
      state: 'dismissed',
      note: 'An exercise, confirmed locally.',
    });
    const nextReference = await revise('The exercise ended. No emergency.');
    await service.analyzeLocalTranscript(
      nextReference,
      new AbortController().signal,
      randomUUID(),
      execution,
    );
    const updated = await service.get(principal, record.id);
    expect(updated.state).toBe('dismissed');
    expect(updated.evidence).toEqual(record.evidence);
    const assessments = await repository.assessments(instanceId, record.id);
    expect(assessments).toHaveLength(2);
    expect(assessments.at(-1)!.result.detected).toBe(false);
  });
  it('does not commit analysis from a superseded or deleted source', async () => {
    await revise('Clear reception.');
    await expect(
      service.analyzeLocalTranscript(
        reference,
        new AbortController().signal,
        randomUUID(),
        execution,
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(await count('sd_analysis_results')).toBe(0);
    await db.query(
      `UPDATE sd_communications SET deleted_at=now() WHERE instance_id=$1 AND id=$2`,
      [instanceId, communicationId],
    );
    expect(await repository.source(reference)).toBeNull();
  });
  it('performs no derivative writes before the terminal job guard admits them', async () => {
    let attempted = false;
    const denied: JobExecutionContext = {
      commit: async () => {
        attempted = true;
        throw new Error('Job was cancelled.');
      },
    };
    await expect(
      service.analyzeLocalTranscript(
        reference,
        new AbortController().signal,
        randomUUID(),
        denied,
      ),
    ).rejects.toThrow('cancelled');
    expect(attempted).toBe(true);
    expect(await count('sd_analysis_results')).toBe(0);
    expect(await count('sd_incidents')).toBe(0);
  });
  it('rolls back all task results and incident writes if the outbox cannot be committed', async () => {
    const broken = new IncidentService(
      new SqlIncidentRepository(db, async () => {
        throw new Error('Outbox is unavailable.');
      }),
      auth,
      { useDefaultRules: true },
    );
    await expect(
      broken.analyzeLocalTranscript(
        reference,
        new AbortController().signal,
        randomUUID(),
        execution,
      ),
    ).rejects.toThrow('Outbox is unavailable');
    expect(await count('sd_analysis_results')).toBe(0);
    expect(await count('sd_incidents')).toBe(0);
  });
  it('rejects invented provider evidence before entering the commit guard', async () => {
    let attempted = false;
    const guarded: JobExecutionContext = {
      commit: async () => {
        attempted = true;
        throw new Error('Must not enter.');
      },
    };
    await expect(
      service.acceptAssessment(
        reference,
        {
          analysisId: randomUUID(),
          connectorId: 'external.provider',
          profileRevision: 1,
          findings: {
            detected: true,
            priority: 'critical',
            reasons: [
              {
                description: 'Unsupported statement.',
                evidence: [
                  { communicationId, quote: 'invented', start: 0, end: 8 },
                ],
              },
            ],
          },
        },
        new AbortController().signal,
        guarded,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(attempted).toBe(false);
  });
  it('honors literal configured rules and audits their administration', async () => {
    const adminPrincipal = { ...principal, role: 'administrator' as const };
    const ruleId = randomUUID();
    await service.saveRule(adminPrincipal, {
      id: ruleId,
      name: 'Specific distress phrase',
      enabled: true,
      phrases: ['requires assistance'],
      priority: 'critical',
      radioIds: [radioId],
    });
    const configured = new IncidentService(repository, auth);
    const result = await configured.analyzeRules(
      reference,
      new AbortController().signal,
      randomUUID(),
      execution,
    );
    expect(result.detected).toBe(false);
    expect(await count('sd_incidents')).toBe(0);
    await service.removeRule(adminPrincipal, ruleId);
    expect(await count('sd_incident_rule_actions')).toBe(2);
    await expect(
      service.saveRule(principal, {
        id: randomUUID(),
        name: 'No',
        enabled: true,
        phrases: ['mayday'],
        priority: 'high',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('enforces authentication and optimistic revisions through the HTTP routes', async () => {
    const record = await incident();
    const app = Fastify();
    configureHttp(app);
    registerIncidentRoutes(app, { prefix: '/api/v1', auth, service });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/incidents' }))
          .statusCode,
      ).toBe(401);
      const headers = { authorization: 'Bearer operator-token' };
      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/incidents',
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items[0].id).toBe(record.id);
      const invalid = await app.inject({
        method: 'PATCH',
        url: `/api/v1/incidents/${record.id}`,
        headers,
        payload: { expectedRevision: 1, state: 'resolved' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe('INVALID_ARGUMENT');
      const changed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/incidents/${record.id}`,
        headers,
        payload: { expectedRevision: 1, state: 'acknowledged' },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().revision).toBe(2);
      const stale = await app.inject({
        method: 'PATCH',
        url: `/api/v1/incidents/${record.id}`,
        headers,
        payload: { expectedRevision: 1, state: 'in_progress' },
      });
      expect(stale.statusCode).toBe(409);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/incidents?cursor=malformed',
            headers,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('preserves held evidence, then removes derived quotes when history deletion is explicitly allowed', async () => {
    const record = await incident();
    const history = new HistoryService(db, {
      put: async () => {
        throw new Error('No recording is present in this fixture.');
      },
      read: async () => {
        throw new Error('No recording is present in this fixture.');
      },
      delete: async () => {},
    });
    await expect(
      history.delete(instanceId, communicationId, userId),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await count('sd_analysis_results')).toBe(4);
    await service.update(principal, record.id, {
      expectedRevision: 1,
      retentionHold: false,
      note: 'Retention release approved.',
    });
    await history.delete(instanceId, communicationId, userId);
    expect(await count('sd_analysis_results')).toBe(0);
    expect(await count('sd_incident_evidence')).toBe(0);
    expect(await count('sd_transcript_revisions')).toBe(0);
    expect((await service.get(principal, record.id)).evidence).toEqual([]);
    expect(
      (await repository.actions(instanceId, record.id)).some(
        (action) => action.note === 'Retention release approved.',
      ),
    ).toBe(true);
    expect(await repository.source(reference)).toBeNull();
    const empty = await service.get(principal, record.id);
    await expect(
      service.update(principal, record.id, {
        expectedRevision: empty.revision,
        retentionHold: true,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(
      service.analyzeLocalTranscript(
        reference,
        new AbortController().signal,
        randomUUID(),
        execution,
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });
  it('aggregates only positive assessments sharing radio and confirmed frequency', async () => {
    const first = await incident();
    async function added(
      text: string,
      attribution: 'confirmed' | 'unknown',
      sourceRadio = radioId,
    ) {
      const id = randomUUID(),
        transcript = randomUUID();
      const conversation = (
        await db.query<{ id: string }>(
          `INSERT INTO sd_frequency_conversations(instance_id,id,radio_id,rx_hz,attribution)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(instance_id,radio_id,rx_hz) DO UPDATE SET radio_id=excluded.radio_id RETURNING id`,
          [
            instanceId,
            randomUUID(),
            sourceRadio,
            attribution === 'confirmed' ? 145500000 : null,
            attribution,
          ],
        )
      ).rows[0]!.id;
      await db.query(
        `INSERT INTO sd_communications(instance_id,id,radio_id,conversation_id,kind,direction,rx_hz,frequency_attribution,started_at,ended_at,context)
        VALUES($1,$2,$3,$4,'received_voice','rx',$5,$6,now(),now(),'{}')`,
        [
          instanceId,
          id,
          sourceRadio,
          conversation,
          attribution === 'confirmed' ? 145500000 : null,
          attribution,
        ],
      );
      await db.query(
        `INSERT INTO sd_transcript_revisions(instance_id,id,communication_id,revision,text,source,provenance)
        VALUES($1,$2,$3,1,$4,'human','{}')`,
        [instanceId, transcript, id, text],
      );
      return service.analyzeLocalTranscript(
        { instanceId, communicationId: id, transcriptRevisionId: transcript },
        new AbortController().signal,
        randomUUID(),
        execution,
      );
    }
    expect(
      (await added('Mayday again.', 'confirmed')).incident.incidentId,
    ).toBe(first.id);
    const before = (await service.get(principal, first.id)).revision;
    expect(
      (await added('Routine contact.', 'confirmed')).incident.incidentId,
    ).toBeUndefined();
    expect((await service.get(principal, first.id)).revision).toBe(before);
    const unknown = (await added('Mayday.', 'unknown')).incident.incidentId;
    expect(unknown).not.toBe(first.id);
    expect((await added('Mayday.', 'unknown')).incident.incidentId).not.toBe(
      unknown,
    );
    expect(
      (await added('Mayday.', 'confirmed', randomUUID())).incident.incidentId,
    ).not.toBe(first.id);
  });
  it('requires versioned worker inputs and uses the real queue terminal source guard', async () => {
    const bossSchema = `${schema}_boss`;
    let release: () => void = () => {};
    let reached = false;
    const queue = new PostgresJobQueue(db, {
      connectionString: url!,
      schema: bossSchema,
      validateSource: async (job, tx) => {
        const source = job.source!;
        const row = (
          await tx.query<{ revision: number; deleted_at: Date | null }>(
            'SELECT revision,deleted_at FROM sd_communications WHERE instance_id=$1 AND id=$2 FOR SHARE',
            [job.instanceId, source.communicationId],
          )
        ).rows[0];
        return (
          row?.revision === source.communicationRevision &&
          row.deleted_at === null
        );
      },
    });
    const handler = createLocalTranscriptAnalysisHandler(service);
    queue.register('analysis.transcript', async (job, signal, terminal) =>
      handler(job, signal, {
        commit: async (write) => {
          reached = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return terminal.commit(write);
        },
      }),
    );
    const job = {
      instanceId,
      jobId: randomUUID(),
      kind: 'analysis.transcript',
      idempotencyKey: randomUUID(),
      deadline: new Date(Date.now() + 30000).toISOString(),
      maxAttempts: 1,
      payload: { communicationId, transcriptRevisionId },
      source: { communicationId, communicationRevision: 1 },
    };
    try {
      const rules = createRuleAnalysisHandler(service);
      await expect(
        rules(
          { ...job, source: { ...job.source, communicationId: randomUUID() } },
          new AbortController().signal,
          execution,
        ),
      ).rejects.toThrow('versioned');
      await queue.enqueue(job);
      await queue.start();
      const until = async (predicate: () => Promise<boolean>) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Queue did not reach the expected state.');
      };
      await until(async () => reached);
      await revise('A corrected non-emergency transcript.');
      release();
      await until(
        async () =>
          (await queue.get(instanceId, job.jobId))?.state === 'cancelled',
      );
      expect(await count('sd_analysis_results')).toBe(0);
      expect(await count('sd_incidents')).toBe(0);
    } finally {
      release();
      await queue.stop();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    }
  }, 25000);
});
