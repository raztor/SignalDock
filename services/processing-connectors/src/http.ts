import {
  SignalDockError,
  type ProcessingCapability,
  type ProcessingRequest,
  type ProcessingResult,
} from '@signaldock/contracts';
import type { ProcessingExecutionContext } from '@signaldock/processing-sdk';

export class ProviderRequestError extends SignalDockError {
  constructor(
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super('PROVIDER_UNAVAILABLE', `Provider request failed (HTTP ${status}).`);
    this.name = 'ProviderRequestError';
  }
}

export function requireContext(
  context: ProcessingExecutionContext | undefined,
  capability: ProcessingCapability,
): ProcessingExecutionContext {
  if (!context)
    throw new SignalDockError(
      'REQUIRES_CONFIGURATION',
      'The provider connection must be resolved before execution.',
    );
  if (!context.capabilities.includes(capability))
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'The configured endpoint does not declare this capability.',
    );
  return context;
}

export function endpoint(
  base: string,
  path: string,
  configuration: Readonly<Record<string, unknown>>,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'The provider endpoint is invalid.',
    );
  }
  const local = isLocalHost(parsed.hostname);
  const allowPrivate = configuration['allowPrivateNetwork'] === true;
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && local && allowPrivate)) ||
    (local && !allowPrivate) ||
    /^(169\.254\.|100\.100\.100\.200$|metadata\.)/i.test(parsed.hostname) ||
    /^\[fe[89ab]/i.test(parsed.hostname)
  ) {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'The provider endpoint violates the configured network policy.',
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/';
  return new URL(path.replace(/^\/+/, ''), parsed);
}

export function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^\[f[cd]/i.test(hostname) ||
    (!hostname.includes('.') && !hostname.includes(':') && hostname !== '')
  );
}

export function apiKey(context: ProcessingExecutionContext): string {
  if (
    context.authentication.kind !== 'api-key' ||
    !context.authentication.secret
  )
    throw new SignalDockError(
      'REQUIRES_CONFIGURATION',
      'This provider requires an API key.',
    );
  return context.authentication.secret;
}

export async function request(
  context: ProcessingExecutionContext,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const response = await (
    context.fetch ?? ((input, options) => globalThis.fetch(input, options))
  )(url, { ...init, redirect: 'error', credentials: 'omit', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderRequestError(
      response.status,
      response.headers.get('x-request-id') ??
        response.headers.get('request-id') ??
        undefined,
    );
  }
  return response;
}

export async function bodyBytes(
  response: Response,
  maximum = 8 * 1024 * 1024,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maximum) {
    await response.body?.cancel();
    throw new SignalDockError(
      'PROVIDER_UNAVAILABLE',
      'The provider response exceeds the configured limit.',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum)
        throw new SignalDockError(
          'PROVIDER_UNAVAILABLE',
          'The provider response exceeds the configured limit.',
        );
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function jsonBody(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    return object(
      JSON.parse(new TextDecoder().decode(await bodyBytes(response))),
    );
  } catch (error) {
    if (error instanceof SignalDockError) throw error;
    throw new SignalDockError(
      'PROVIDER_UNAVAILABLE',
      'The provider returned malformed JSON.',
    );
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SignalDockError(
      'PROVIDER_UNAVAILABLE',
      'The provider returned an invalid object.',
    );
  return value as Record<string, unknown>;
}
export function stringValue(
  value: unknown,
  name: string,
  maximum = 64000,
): string {
  if (typeof value !== 'string' || value.length > maximum)
    throw new SignalDockError(
      'PROVIDER_UNAVAILABLE',
      `The provider returned invalid ${name}.`,
    );
  return value;
}

export function textOutput(
  context: ProcessingExecutionContext,
  input: ProcessingRequest,
  text: string,
): ProcessingResult['output'] {
  if (!context.task)
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'The task has no registered structured-output definition.',
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SignalDockError(
      'PROVIDER_UNAVAILABLE',
      'The provider did not return the required structured JSON.',
    );
  }
  return context.task.normalizeOutput(input, value);
}
export function result(
  input: ProcessingRequest,
  connectorId: string,
  output: ProcessingResult['output'],
): ProcessingResult {
  return {
    jobId: input.jobId,
    connectorId,
    profileRevision: input.profileRevision,
    simulated: false,
    output,
  };
}
export function taskInstruction(context: ProcessingExecutionContext): string {
  if (!context.task)
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'A registered task instruction is required.',
    );
  return (
    context.task.instruction +
    (context.task.outputSchema
      ? `\nReturn only JSON conforming to this schema: ${JSON.stringify(context.task.outputSchema)}`
      : '')
  );
}
export function setting(
  context: ProcessingExecutionContext,
  name: string,
  required = false,
): string | undefined {
  const value = context.settings[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      `A valid ${name} setting is required.`,
    );
  return value;
}
export async function audioInput(
  context: ProcessingExecutionContext,
  input: ProcessingRequest,
  signal: AbortSignal,
) {
  if (input.input.kind !== 'audio' || !context.readArtifact)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'A readable audio artifact is required.',
    );
  const artifact = await context.readArtifact(input.input.artifactId, signal);
  if (
    artifact.artifactId !== input.input.artifactId ||
    !artifact.contentType.startsWith('audio/') ||
    artifact.bytes.length > 25 * 1024 * 1024 ||
    artifact.bytes.length === 0
  ) {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'The authorized audio artifact is invalid or exceeds the upload limit.',
    );
  }
  return artifact;
}
export async function saveAudio(
  context: ProcessingExecutionContext,
  input: ProcessingRequest,
  response: Response,
  signal: AbortSignal,
): Promise<ProcessingResult['output']> {
  if (!context.writeArtifact)
    throw new SignalDockError(
      'REQUIRES_CONFIGURATION',
      'An artifact writer is required for synthesized audio.',
    );
  const bytes = await bodyBytes(response, 25 * 1024 * 1024);
  signal.throwIfAborted();
  if (!bytes.length)
    throw new SignalDockError(
      'PROVIDER_UNAVAILABLE',
      'The provider returned empty audio.',
    );
  const contentType = (
    response.headers.get('content-type') ?? 'audio/wav'
  ).split(';')[0]!;
  if (
    !contentType.startsWith('audio/') &&
    contentType !== 'application/octet-stream'
  )
    throw new SignalDockError(
      'PROVIDER_UNAVAILABLE',
      'The provider returned an invalid audio content type.',
    );
  const stored = await context.writeArtifact(
    {
      bytes,
      contentType:
        contentType === 'application/octet-stream' ? 'audio/wav' : contentType,
      jobId: input.jobId,
    },
    signal,
  );
  return {
    kind: 'audio',
    artifactId: stored.artifactId,
    contentType:
      contentType === 'application/octet-stream' ? 'audio/wav' : contentType,
    byteLength: bytes.length,
  };
}
