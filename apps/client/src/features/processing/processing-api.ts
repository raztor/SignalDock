import { apiFetch, apiRequest } from '@signaldock/client-sdk';
import {
  PublicUserSchema,
  type ClientSession,
  type Communication,
  type ProcessingBackgroundConsentView,
  type ProcessingConnectionView,
  type ProcessingJobView,
  type ProcessingProfile,
  type PublicUser,
} from '@signaldock/contracts';
import type {
  ConnectorManifestView,
  ConsentBody,
  CreateConnectionBody,
  CreateProfileBody,
  ProcessingTask,
} from './processing-model';

/** Existing processing routes (all under `/api/v1`, permission `processing.manage`). */
export const PROCESSING_ROUTES = {
  connectors: 'processing/connectors',
  connections: 'processing/connections',
  connection: (id: string) =>
    `processing/connections/${encodeURIComponent(id)}`,
  profiles: 'processing/profiles',
  jobs: 'processing/jobs',
  job: (id: string) => `processing/jobs/${encodeURIComponent(id)}`,
  jobAudio: (id: string) => `processing/jobs/${encodeURIComponent(id)}/audio`,
  background: 'processing/background',
  backgroundConsent: 'processing/background/consent',
  backgroundRadio: (radioId: string) =>
    `processing/background/${encodeURIComponent(radioId)}`,
  /** Requires `instance.admin`; the screen falls back to a user ID field. */
  users: 'admin/users',
  communications: (radioId: string) =>
    `communications?radioId=${encodeURIComponent(radioId)}`,
} as const;

export interface ProcessingData {
  connections: ProcessingConnectionView[];
  profiles: ProcessingProfile[];
  jobs: ProcessingJobView[];
  connectors: ConnectorManifestView[];
  tasks: ProcessingTask[];
  communications: Communication[];
  consents: ProcessingBackgroundConsentView[];
}

export const EMPTY_PROCESSING_DATA: ProcessingData = {
  connections: [],
  profiles: [],
  jobs: [],
  connectors: [],
  tasks: [],
  communications: [],
  consents: [],
};

export async function loadProcessingData(
  session: ClientSession,
  radioId: string | undefined,
  administrator: boolean,
  signal: AbortSignal,
): Promise<ProcessingData> {
  const [connections, profiles, jobs, catalog, communications, consents] =
    await Promise.all([
      apiRequest<{ connections: ProcessingConnectionView[] }>(
        session,
        PROCESSING_ROUTES.connections,
        { signal },
      ),
      apiRequest<{ profiles: ProcessingProfile[] }>(
        session,
        PROCESSING_ROUTES.profiles,
        { signal },
      ),
      fetchJobs(session, signal),
      apiRequest<{
        connectors: ConnectorManifestView[];
        tasks: ProcessingTask[];
      }>(session, PROCESSING_ROUTES.connectors, { signal }),
      radioId
        ? apiRequest<{ items: Communication[] }>(
            session,
            PROCESSING_ROUTES.communications(radioId),
            { signal },
          )
        : Promise.resolve({ items: [] as Communication[] }),
      administrator
        ? apiRequest<{ consents: ProcessingBackgroundConsentView[] }>(
            session,
            PROCESSING_ROUTES.background,
            { signal },
          )
        : Promise.resolve({
            consents: [] as ProcessingBackgroundConsentView[],
          }),
    ]);
  signal.throwIfAborted();
  return {
    connections: connections.connections,
    profiles: profiles.profiles,
    jobs,
    connectors: catalog.connectors,
    tasks: catalog.tasks,
    communications: communications.items.filter((item) => !item.deletedAt),
    consents: consents.consents,
  };
}

export async function fetchJobs(
  session: ClientSession,
  signal: AbortSignal,
): Promise<ProcessingJobView[]> {
  const result = await apiRequest<{ jobs: ProcessingJobView[] }>(
    session,
    PROCESSING_ROUTES.jobs,
    { signal },
  );
  return result.jobs;
}

export function createConnection(
  session: ClientSession,
  body: CreateConnectionBody,
  signal: AbortSignal,
): Promise<ProcessingConnectionView> {
  return apiRequest<ProcessingConnectionView>(
    session,
    PROCESSING_ROUTES.connections,
    { method: 'POST', signal, body: JSON.stringify(body) },
  );
}

export async function revokeConnection(
  session: ClientSession,
  connectionId: string,
  signal: AbortSignal,
): Promise<void> {
  await apiRequest(session, PROCESSING_ROUTES.connection(connectionId), {
    method: 'DELETE',
    signal,
  });
}

export function createProfile(
  session: ClientSession,
  body: CreateProfileBody,
  signal: AbortSignal,
): Promise<ProcessingProfile> {
  return apiRequest<ProcessingProfile>(session, PROCESSING_ROUTES.profiles, {
    method: 'POST',
    signal,
    body: JSON.stringify(body),
  });
}

export function submitJob(
  session: ClientSession,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ProcessingJobView> {
  return apiRequest<ProcessingJobView>(session, PROCESSING_ROUTES.jobs, {
    method: 'POST',
    signal,
    body: JSON.stringify(body),
  });
}

export async function cancelJob(
  session: ClientSession,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  await apiRequest(session, PROCESSING_ROUTES.job(jobId), {
    method: 'DELETE',
    signal,
  });
}

/** Authenticated blob; tokens never go into a media URL. */
export async function fetchPreviewAudio(
  session: ClientSession,
  jobId: string,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await apiFetch(session, PROCESSING_ROUTES.jobAudio(jobId), {
    signal,
  });
  return response.blob();
}

export async function fetchUsers(
  session: ClientSession,
  signal: AbortSignal,
): Promise<PublicUser[]> {
  // Same route and validation as Users & access: `{ users: PublicUser[] }`.
  // A response that does not match rejects, so the picker falls back.
  const result = await apiRequest<{ users: unknown }>(
    session,
    PROCESSING_ROUTES.users,
    { signal },
  );
  const users = PublicUserSchema.array().safeParse(result.users);
  if (!users.success)
    throw new Error('the server returned an unexpected user list');
  return users.data;
}

export async function enableAutomaticRx(
  session: ClientSession,
  body: ConsentBody,
  signal: AbortSignal,
): Promise<void> {
  await apiRequest(session, PROCESSING_ROUTES.backgroundConsent, {
    method: 'PUT',
    signal,
    body: JSON.stringify(body),
  });
}

export async function disableAutomaticRx(
  session: ClientSession,
  radioId: string,
  signal: AbortSignal,
): Promise<void> {
  await apiRequest(session, PROCESSING_ROUTES.backgroundRadio(radioId), {
    method: 'DELETE',
    signal,
  });
}
