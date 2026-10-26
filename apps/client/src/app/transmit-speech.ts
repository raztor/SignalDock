import { apiRequest } from '@signaldock/client-sdk';
import type {
  ClientSession,
  ControlLease,
  RadioView,
} from '@signaldock/contracts';

/** Prepared speech is an explicit bounded action using the same radio lease as microphone TX. */
export async function transmitPreparedSpeech(
  session: ClientSession,
  jobId: string,
  radioId: string,
  signal: AbortSignal,
) {
  const cancellation = new AbortController();
  const combined = AbortSignal.any([
    signal,
    cancellation.signal,
    AbortSignal.timeout(35000),
  ]);
  const grant = await apiRequest<ControlLease>(
    session,
    `radios/${radioId}/control`,
    { method: 'POST', signal: combined },
  );
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || combined.aborted) return;
    renewing = true;
    void apiRequest(session, `radios/${radioId}/control/renew`, {
      method: 'POST',
      signal: combined,
      body: JSON.stringify({
        controlGrant: grant.grantId,
        generation: grant.generation,
      }),
    })
      .catch((error: unknown) => cancellation.abort(error))
      .finally(() => {
        renewing = false;
      });
  }, 5000);
  try {
    const radio = await apiRequest<RadioView>(session, `radios/${radioId}`, {
      signal: combined,
    });
    if (!radio.snapshot || radio.snapshot.generation !== grant.generation)
      throw new Error('The radio changed while preparing speech.');
    await apiRequest(session, `processing/jobs/${jobId}/transmit`, {
      method: 'POST',
      signal: combined,
      body: JSON.stringify({
        radioId,
        generation: grant.generation,
        expectedRevision: radio.snapshot.revision,
        controlGrant: grant.grantId,
      }),
    });
  } finally {
    clearInterval(timer);
    cancellation.abort();
    const { onUnauthorized: _onUnauthorized, ...cleanupSession } = session;
    await apiRequest(cleanupSession, `radios/${radioId}/control`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(2500),
      body: JSON.stringify({
        controlGrant: grant.grantId,
        generation: grant.generation,
      }),
    }).catch(() => undefined);
  }
}
