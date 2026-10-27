import type {
  ProcessingCapability,
  ProcessingRequest,
  ProcessingResult,
} from '@signaldock/contracts';

export type ProviderAuthentication =
  | { kind: 'none' }
  | { kind: 'api-key'; secret: string }
  | {
      kind: 'oauth';
      accessToken: string;
      userId: string;
      accountId: string;
      workspaceId: string;
    };

export interface ProcessingArtifact {
  artifactId: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Runtime-only resolved resources. Never serialize this object into a public API. */
export interface ProcessingExecutionContext {
  authentication: ProviderAuthentication;
  endpoint: string;
  capabilities: readonly ProcessingCapability[];
  configuration: Readonly<Record<string, unknown>>;
  settings: Readonly<Record<string, unknown>>;
  fetch?: typeof fetch;
  readArtifact?(
    artifactId: string,
    signal: AbortSignal,
  ): Promise<ProcessingArtifact>;
  writeArtifact?(
    input: { bytes: Uint8Array; contentType: string; jobId: string },
    signal: AbortSignal,
  ): Promise<{ artifactId: string }>;
  task?: {
    instruction: string;
    outputSchema?: Readonly<Record<string, unknown>>;
    normalizeOutput(
      request: ProcessingRequest,
      value: unknown,
    ): ProcessingResult['output'];
  };
}
