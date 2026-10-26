import type { DatabasePort } from '@signaldock/contracts';

/** Call while holding the history source lock. No network, artifact IO or new transaction occurs here. */
export async function removeProcessingSourceDerivatives(
  transaction: DatabasePort,
  instanceId: string,
  communicationId: string,
): Promise<{ domainJobsDeleted: number; sharedJobsCleared: number }> {
  const jobs = await transaction.query<{ id: string }>(
    "SELECT id FROM sd_processing_jobs WHERE instance_id=$1 AND (source->>'communicationId'=$2 OR (request->'input'->'communicationIds') ? $2)",
    [instanceId, communicationId],
  );
  const ids = jobs.rows.map((job) => job.id);
  // Shared queue locks precede domain-row locks, matching the terminal source → job → derivative order.
  const shared = await transaction.query<{ id: string }>(
    "SELECT id FROM sd_jobs WHERE instance_id=$1 AND kind='processing.execute' AND (id=ANY($3::uuid[]) OR source->>'communicationId'=$2) ORDER BY id FOR UPDATE",
    [instanceId, communicationId, ids],
  );
  const sharedIds = shared.rows.map((job) => job.id);
  if (sharedIds.length) {
    await transaction.query(
      "UPDATE sd_jobs SET result=NULL,error=NULL,payload=jsonb_build_object('processingJobId',id::text,'sourceRemoved',true),state=CASE WHEN state IN ('queued','running','retry_wait') THEN 'cancelled' ELSE state END,cancelled_at=COALESCE(cancelled_at,now()),updated_at=now() WHERE instance_id=$1 AND id=ANY($2::uuid[])",
      [instanceId, sharedIds],
    );
    await transaction.query(
      'UPDATE sd_job_attempts SET error=NULL WHERE instance_id=$1 AND job_id=ANY($2::uuid[])',
      [instanceId, sharedIds],
    );
  }
  const removed = await transaction.query(
    "DELETE FROM sd_processing_jobs WHERE instance_id=$1 AND (source->>'communicationId'=$2 OR (request->'input'->'communicationIds') ? $2)",
    [instanceId, communicationId],
  );
  return {
    domainJobsDeleted: removed.rowCount ?? 0,
    sharedJobsCleared: sharedIds.length,
  };
}
