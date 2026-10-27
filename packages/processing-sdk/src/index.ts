import {
  ConnectorManifestSchema,
  ProcessingConnectionSchema,
  ProcessingProfileSchema,
  ProcessingRequestSchema,
  ProcessingResultSchema,
  SignalDockError,
  type ConnectorManifest,
  type ProcessingConnection,
  type ProcessingProfile,
  type ProcessingRequest,
  type ProcessingResult,
} from '@signaldock/contracts';
import {
  builtinProcessingTasks,
  type ProcessingTaskDefinition,
} from './tasks.js';
import type { ProcessingExecutionContext } from './execution.js';
export type {
  ProcessingExecutionContext,
  ProcessingArtifact,
  ProviderAuthentication,
} from './execution.js';
export {
  builtinProcessingTasks,
  type ProcessingTaskDefinition,
} from './tasks.js';

export interface ProcessingConnector {
  describe(): ConnectorManifest;
  executionScope?(
    context: ProcessingExecutionContext | undefined,
  ): 'local' | 'cloud';
  execute(
    request: ProcessingRequest,
    connection: ProcessingConnection,
    profile: ProcessingProfile,
    signal: AbortSignal,
    context?: ProcessingExecutionContext,
  ): Promise<ProcessingResult>;
}

/** Resolves ownership/profile/capability before delegating to an installed connector. */
export class ProcessingRegistry {
  private readonly connectors = new Map<string, ProcessingConnector>();
  private readonly tasks = new Map<string, ProcessingTaskDefinition>();
  constructor(
    tasks: readonly ProcessingTaskDefinition[] = builtinProcessingTasks(),
  ) {
    for (const task of tasks) this.registerTask(task);
  }
  registerTask(task: ProcessingTaskDefinition): void {
    const key = `${task.taskId}@${task.version}`;
    if (this.tasks.has(key))
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'Task version is already registered.',
      );
    this.tasks.set(key, task);
  }
  register(connector: ProcessingConnector): void {
    const manifest = ConnectorManifestSchema.parse(connector.describe());
    if (this.connectors.has(manifest.connectorId))
      throw new SignalDockError(
        'OPERATION_CONFLICT',
        'Connector is already registered.',
      );
    this.connectors.set(manifest.connectorId, connector);
  }
  manifests(): ConnectorManifest[] {
    return [...this.connectors.values()].map((connector) =>
      ConnectorManifestSchema.parse(connector.describe()),
    );
  }
  taskDefinitions(): ReadonlyArray<
    Pick<ProcessingTaskDefinition, 'taskId' | 'version' | 'capability'>
  > {
    return [...this.tasks.values()].map(({ taskId, version, capability }) => ({
      taskId,
      version,
      capability,
    }));
  }
  async execute(
    input: ProcessingRequest,
    connectionInput: ProcessingConnection,
    profileInput: ProcessingProfile,
    actor: { instanceId: string; userId?: string },
    signal: AbortSignal,
    context?: ProcessingExecutionContext,
  ): Promise<ProcessingResult> {
    signal.throwIfAborted();
    const request = ProcessingRequestSchema.parse(input);
    const connection = ProcessingConnectionSchema.parse(connectionInput);
    const profile = ProcessingProfileSchema.parse(profileInput);
    if (
      request.instanceId !== actor.instanceId ||
      connection.instanceId !== actor.instanceId ||
      (connection.owner.kind === 'user' &&
        connection.owner.userId !== actor.userId)
    ) {
      throw new SignalDockError(
        'FORBIDDEN',
        'The processing connection belongs to another owner.',
      );
    }
    if (
      profile.connectionId !== connection.connectionId ||
      profile.profileId !== request.profileId ||
      profile.revision !== request.profileRevision
    ) {
      throw new SignalDockError(
        'STALE_REVISION',
        'The processing profile changed.',
      );
    }
    if (Date.parse(request.deadline) <= Date.now())
      throw new SignalDockError(
        'DEADLINE_EXCEEDED',
        'The processing job expired.',
      );
    const connector = this.connectors.get(connection.connectorId);
    if (!connector)
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'The connector is not installed.',
      );
    if (
      (connector.executionScope?.(context) ??
        connector.describe().execution) === 'cloud' &&
      !profile.allowCloud
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'This profile does not allow cloud processing.',
      );
    const task = this.tasks.get(`${request.task}@${request.taskVersion}`);
    if (!task)
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'The task version is not installed.',
      );
    task.validateInput(request);
    if (context && !context.capabilities.includes(task.capability))
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'The configured connection does not support this capability.',
      );
    if (
      context?.authentication.kind === 'oauth' &&
      (connection.owner.kind !== 'user' ||
        context.authentication.userId !== connection.owner.userId ||
        context.authentication.userId !== actor.userId)
    ) {
      throw new SignalDockError(
        'FORBIDDEN',
        'Subscription usage is restricted to its linked account owner.',
      );
    }
    const capability = task.capability;
    if (
      profile.capability !== capability ||
      !connector.describe().capabilities.includes(capability)
    ) {
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'The connector/profile does not support this task.',
      );
    }
    const timeout = AbortSignal.timeout(
      Math.max(
        1,
        Math.min(2147483647, Date.parse(request.deadline) - Date.now()),
      ),
    );
    const combined = AbortSignal.any([signal, timeout]);
    const result = ProcessingResultSchema.parse(
      await withCancellation(
        connector.execute(
          request,
          connection,
          profile,
          combined,
          context && {
            ...context,
            ...(task.describePrompt && task.normalizeOutput
              ? {
                  task: {
                    ...task.describePrompt(request),
                    normalizeOutput: task.normalizeOutput,
                  },
                }
              : {}),
          },
        ),
        combined,
      ),
    );
    combined.throwIfAborted();
    if (
      result.jobId !== request.jobId ||
      result.profileRevision !== profile.revision ||
      result.connectorId !== connection.connectorId ||
      result.simulated !== connector.describe().simulated
    ) {
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'Connector returned a mismatched result.',
      );
    }
    if (
      'evidenceIds' in result.output &&
      result.output.evidenceIds.some(
        (id) => !request.input.communicationIds.includes(id),
      )
    ) {
      throw new SignalDockError(
        'PROVIDER_UNAVAILABLE',
        'Connector cited an unrelated communication.',
      );
    }
    task.validateOutput(request, result);
    return result;
  }
}

async function withCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Fixture behavior only: this does not perform semantic analysis. */
export class FixtureTextConnector implements ProcessingConnector {
  describe(): ConnectorManifest {
    return {
      connectorId: 'fixture.text',
      version: '0.1.0',
      sdkVersion: 1,
      capabilities: ['text.structured'],
      simulated: true,
      execution: 'local',
    };
  }
  async execute(
    request: ProcessingRequest,
    _connection: ProcessingConnection,
    _profile: ProcessingProfile,
    signal: AbortSignal,
  ): Promise<ProcessingResult> {
    signal.throwIfAborted();
    if (
      request.input.kind !== 'text' ||
      request.task !== 'conversation.summarize'
    )
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'Text fixture requires a summary request.',
      );
    return {
      jobId: request.jobId,
      connectorId: this.describe().connectorId,
      profileRevision: request.profileRevision,
      simulated: true,
      output: {
        kind: 'summary',
        text: `[Fixture] ${request.input.text.slice(0, 120)}`,
        evidenceIds: request.input.communicationIds,
      },
    };
  }
}

/** Returns known transcripts by artifact ID; never opens files or decodes audio. */
export class FixtureTranscriptionConnector implements ProcessingConnector {
  constructor(private readonly transcripts: ReadonlyMap<string, string>) {}
  describe(): ConnectorManifest {
    return {
      connectorId: 'fixture.stt',
      version: '0.1.0',
      sdkVersion: 1,
      capabilities: ['stt.batch'],
      simulated: true,
      execution: 'local',
    };
  }
  async execute(
    request: ProcessingRequest,
    _connection: ProcessingConnection,
    _profile: ProcessingProfile,
    signal: AbortSignal,
  ): Promise<ProcessingResult> {
    signal.throwIfAborted();
    if (request.input.kind !== 'audio' || request.task !== 'speech.transcribe')
      throw new SignalDockError(
        'CAPABILITY_UNSUPPORTED',
        'STT fixture requires an audio reference.',
      );
    const text = this.transcripts.get(request.input.artifactId);
    if (!text)
      throw new SignalDockError(
        'NOT_FOUND',
        'No transcript fixture exists for this artifact.',
      );
    return {
      jobId: request.jobId,
      connectorId: this.describe().connectorId,
      profileRevision: request.profileRevision,
      simulated: true,
      output: {
        kind: 'transcript',
        text,
        artifactId: request.input.artifactId,
      },
    };
  }
}
