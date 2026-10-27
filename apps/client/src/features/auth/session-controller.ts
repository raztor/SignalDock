import {
  ApiErrorSchema,
  BootstrapRequestSchema,
  LoginRequestSchema,
  SessionTokensSchema,
  SignalDockError,
  type ClientSession,
  type ServerInfo,
  type SessionTokens,
} from '@signaldock/contracts';
import { normalizeServerUrl, SignalDockClient } from '@signaldock/client-sdk';
import {
  credentialScopeKey,
  createMemoryCredentialStore,
  type CredentialScope,
  type RefreshCredentialStore,
} from './credentials';

export interface AuthServer {
  baseUrl: string;
  info: ServerInfo;
}
export interface AuthSnapshot {
  server?: AuthServer;
  status: 'signed_out' | 'signing_in' | 'signed_in';
  session?: ClientSession;
  bootstrapRequired?: boolean;
  error?: string;
}
export interface SessionControllerOptions {
  credentials?: RefreshCredentialStore;
  fetcher?: typeof fetch;
  modeForServer?: (baseUrl: string) => 'cookie' | 'token';
  readCsrfToken?: (instanceId: string) => string | undefined;
  runExclusive?: <T>(
    scope: CredentialScope,
    action: () => Promise<T>,
  ) => Promise<T>;
  onContextChanging?: () => void | Promise<void>;
}

export class SessionController {
  private state: AuthSnapshot = { status: 'signed_out' };
  private readonly listeners = new Set<() => void>();
  private readonly credentials: RefreshCredentialStore;
  private readonly fetcher: typeof fetch;
  private generation = 0;
  private contextAbort = new AbortController();
  private refreshPromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private accessExpiresAt = 0;
  constructor(private readonly options: SessionControllerOptions = {}) {
    this.credentials = options.credentials ?? createMemoryCredentialStore();
    this.fetcher =
      options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }
  getSnapshot = (): AuthSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async selectServer(baseUrl: string, info: ServerInfo): Promise<void> {
    const canonical = normalizeServerUrl(baseUrl);
    const generation = this.reset();
    this.publish({ status: 'signed_out' });
    await this.options.onContextChanging?.();
    if (generation !== this.generation) return;
    const server = { baseUrl: canonical, info };
    this.publish({ status: 'signed_out', server });
    try {
      await new SignalDockClient(canonical, this.fetcher).discover({
        signal: this.contextAbort.signal,
        expected: info,
      });
      const result = await this.request(server, 'auth/bootstrap', 'GET');
      if (
        typeof result !== 'object' ||
        result === null ||
        !('required' in result) ||
        typeof result.required !== 'boolean'
      )
        throw new SignalDockError(
          'API_INCOMPATIBLE',
          'The server returned an invalid setup state.',
        );
      if (generation !== this.generation) return;
      this.publish({
        status: 'signed_out',
        server,
        bootstrapRequired: Boolean((result as { required?: boolean }).required),
      });
    } catch (error) {
      if (generation === this.generation)
        this.publish({ ...this.state, error: this.message(error) });
    }
  }
  async signIn(username: string, password: string): Promise<void> {
    const server = this.server();
    const generation = this.reset();
    this.publish({ server, status: 'signing_in', bootstrapRequired: false });
    await this.options.onContextChanging?.();
    if (generation !== this.generation) return;
    try {
      await new SignalDockClient(server.baseUrl, this.fetcher).discover({
        signal: this.contextAbort.signal,
        expected: server.info,
      });
      const request = LoginRequestSchema.parse({
        username,
        password,
        sessionMode: this.mode(server),
      });
      const tokens = SessionTokensSchema.parse(
        await this.request(server, 'auth/login', 'POST', request),
      );
      if (
        tokens.user.username !== username.trim().toLowerCase() ||
        !tokens.user.enabled
      )
        throw new SignalDockError(
          'UNAUTHORIZED',
          'The server returned another account.',
        );
      await this.accept(server, tokens, generation);
    } catch (error) {
      if (generation === this.generation)
        this.publish({
          server,
          status: 'signed_out',
          error: this.message(error),
        });
      throw error;
    }
  }
  async bootstrap(
    setupToken: string,
    username: string,
    password: string,
  ): Promise<void> {
    const server = this.server();
    const generation = this.generation;
    const input = BootstrapRequestSchema.parse({
      setupToken,
      username,
      password,
    });
    await new SignalDockClient(server.baseUrl, this.fetcher).discover({
      signal: this.contextAbort.signal,
      expected: server.info,
    });
    if (generation !== this.generation)
      throw new SignalDockError(
        'STALE_GENERATION',
        'The server selection changed.',
      );
    await this.request(server, 'auth/bootstrap', 'POST', input);
    if (generation !== this.generation)
      throw new SignalDockError(
        'STALE_GENERATION',
        'The server selection changed.',
      );
    this.publish({ server, status: 'signed_out', bootstrapRequired: false });
    await this.signIn(username, password);
  }
  async restore(): Promise<void> {
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const server = this.server();
    const generation = this.generation;
    const expectedUser = this.state.session?.user.id;
    let attemptedRefresh: string | undefined;
    const run = async () => {
      if (generation !== this.generation) return;
      const scope = this.scope(server);
      const saved = await this.credentials.get(scope);
      if (generation !== this.generation) return;
      if (
        saved &&
        credentialScopeKey(saved.scope) !== credentialScopeKey(scope)
      )
        throw new SignalDockError(
          'UNAUTHORIZED',
          'The saved credential belongs to another server.',
        );
      attemptedRefresh = saved?.refreshToken;
      const csrf = this.options.readCsrfToken?.(server.info.instanceId);
      if (this.mode(server) === 'token' && !saved) return;
      if (this.mode(server) === 'cookie' && !csrf) return;
      await new SignalDockClient(server.baseUrl, this.fetcher).discover({
        signal: this.contextAbort.signal,
        expected: server.info,
      });
      const tokens = SessionTokensSchema.parse(
        await this.request(
          server,
          'auth/refresh',
          'POST',
          this.mode(server) === 'cookie'
            ? {}
            : { refreshToken: saved!.refreshToken },
          csrf,
        ),
      );
      if (
        (expectedUser && expectedUser !== tokens.user.id) ||
        (saved && saved.userId !== tokens.user.id)
      )
        throw new SignalDockError(
          'UNAUTHORIZED',
          'The saved session belongs to another account. Sign in again.',
        );
      await this.accept(server, tokens, generation);
    };
    const pending: Promise<void> = (
      this.options.runExclusive
        ? this.options.runExclusive(this.scope(server), run)
        : run()
    )
      .catch(async (error) => {
        if (generation === this.generation) {
          this.reset();
          this.publish({
            server,
            status: 'signed_out',
            error: this.message(error),
          });
          await this.options.onContextChanging?.();
          if (attemptedRefresh)
            await this.credentials.delete(this.scope(server), attemptedRefresh);
        }
        throw error;
      })
      .finally(() => {
        if (this.refreshPromise === pending) this.refreshPromise = undefined;
      });
    this.refreshPromise = pending;
    return pending;
  }
  async signOut(): Promise<void> {
    const server = this.server();
    const originalGeneration = this.generation;
    const accessToken = this.state.session?.accessToken;
    const saved = await this.credentials.get(this.scope(server));
    if (originalGeneration !== this.generation) return;
    const csrf = this.options.readCsrfToken?.(server.info.instanceId);
    const generation = this.reset();
    this.publish({ server, status: 'signed_out' });
    await this.options.onContextChanging?.();
    if (saved)
      await this.credentials.delete(this.scope(server), saved.refreshToken);
    if (generation !== this.generation) return;
    try {
      await this.request(
        server,
        'auth/logout',
        'POST',
        this.mode(server) === 'cookie'
          ? {}
          : { ...(saved ? { refreshToken: saved.refreshToken } : {}) },
        csrf,
        accessToken,
      );
    } catch (error) {
      if (generation === this.generation)
        this.publish({
          ...this.state,
          error:
            'Signed out on this device. The server could not confirm session revocation.',
        });
      throw error;
    }
  }
  async forgetServer(
    savedServer: Pick<ServerInfo, 'instanceId' | 'identity'> & {
      baseUrl: string;
    },
  ): Promise<void> {
    const baseUrl = normalizeServerUrl(savedServer.baseUrl);
    const scope: CredentialScope = {
      baseUrl,
      instanceId: savedServer.instanceId,
      keyId: savedServer.identity.keyId,
      publicKey: savedServer.identity.publicKey,
    };
    const saved = await this.credentials.get(scope);
    const csrf = this.options.readCsrfToken?.(savedServer.instanceId);
    if (
      this.state.server?.baseUrl === baseUrl &&
      this.state.server.info.instanceId === savedServer.instanceId
    ) {
      this.reset();
      this.publish({ status: 'signed_out' });
      await this.options.onContextChanging?.();
    }
    if (saved) await this.credentials.delete(scope, saved.refreshToken);
    if (!saved && !csrf) return;
    const info = await new SignalDockClient(baseUrl, this.fetcher).discover({
      expected: savedServer,
    });
    const server = { baseUrl, info };
    await this.request(
      server,
      'auth/logout',
      'POST',
      this.mode(server) === 'cookie'
        ? {}
        : { ...(saved ? { refreshToken: saved.refreshToken } : {}) },
      csrf,
    );
  }
  async refreshIfNeeded(): Promise<void> {
    if (this.state.session && Date.now() >= this.accessExpiresAt - 60000)
      await this.refresh();
  }
  dispose(): void {
    this.reset();
    this.listeners.clear();
  }
  private async accept(
    server: AuthServer,
    tokens: SessionTokens,
    generation: number,
  ): Promise<void> {
    if (
      !tokens.user.enabled ||
      Date.parse(tokens.accessExpiresAt) <= Date.now()
    )
      throw new SignalDockError(
        'UNAUTHORIZED',
        'The server returned an inactive session.',
      );
    if (this.mode(server) === 'token' && !tokens.refreshToken)
      throw new SignalDockError(
        'API_INCOMPATIBLE',
        'The server did not issue a refresh credential.',
      );
    if (this.mode(server) === 'cookie' && !tokens.csrfToken)
      throw new SignalDockError(
        'API_INCOMPATIBLE',
        'The server did not issue a CSRF proof.',
      );
    if (generation !== this.generation) return;
    const scope = this.scope(server);
    if (this.mode(server) === 'token' && tokens.refreshToken) {
      await this.credentials.set({
        scope,
        userId: tokens.user.id,
        refreshToken: tokens.refreshToken,
      });
      if (generation !== this.generation) {
        await this.credentials.delete(scope, tokens.refreshToken);
        return;
      }
    }
    if (generation !== this.generation) return;
    this.accessExpiresAt = Date.parse(tokens.accessExpiresAt);
    const session: ClientSession = {
      baseUrl: server.baseUrl,
      instanceId: server.info.instanceId,
      accessToken: tokens.accessToken,
      user: tokens.user,
      onUnauthorized: () => {
        if (
          generation !== this.generation ||
          this.state.session?.accessToken !== tokens.accessToken
        )
          return;
        this.reset();
        this.publish({
          server,
          status: 'signed_out',
          error: 'Your session expired or was revoked. Sign in again.',
        });
        void this.options.onContextChanging?.();
      },
    };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.refresh().catch(() => undefined);
      },
      Math.max(1000, this.accessExpiresAt - Date.now() - 60000),
    );
    this.publish({ server, status: 'signed_in', session });
  }
  private async request(
    server: AuthServer,
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    csrf?: string,
    accessToken?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const parentSignal = this.contextAbort.signal;
    const abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      if (parentSignal.aborted) controller.abort();
      const response = await this.fetcher(
        new URL(`api/v1/${path}`, server.baseUrl),
        {
          method,
          credentials: this.mode(server) === 'cookie' ? 'same-origin' : 'omit',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(
          await response.json().catch(() => null),
        );
        throw new SignalDockError(
          parsed.success ? parsed.data.code : 'INTERNAL_ERROR',
          parsed.success
            ? parsed.data.message
            : `Request failed (HTTP ${response.status}).`,
        );
      }
      return response.status === 204 ? undefined : await response.json();
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
    }
  }
  private server(): AuthServer {
    if (!this.state.server)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'Select a server first.',
      );
    return this.state.server;
  }
  private scope(server: AuthServer): CredentialScope {
    return {
      baseUrl: server.baseUrl,
      instanceId: server.info.instanceId,
      keyId: server.info.identity.keyId,
      publicKey: server.info.identity.publicKey,
    };
  }
  private mode(server: AuthServer): 'cookie' | 'token' {
    return this.options.modeForServer?.(server.baseUrl) ?? 'token';
  }
  private reset(): number {
    this.generation++;
    this.contextAbort.abort();
    this.contextAbort = new AbortController();
    this.refreshPromise = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.generation;
  }
  private publish(state: AuthSnapshot): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private message(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'The session operation failed.';
  }
}
