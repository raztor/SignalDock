import {
  API_PROTOCOL_VERSION,
  RecentServersSchema,
  ServerInfoSchema,
  SignalDockError,
  type RecentServer,
  type ServerInfo,
} from '@signaldock/contracts';

export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Enter a complete server URL.',
    );
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'Use HTTPS without credentials, query parameters, or fragments. HTTP is allowed only on loopback for development.',
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}

export class SignalDockClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {
    this.baseUrl = normalizeServerUrl(baseUrl);
  }

  async discover(
    options: {
      signal?: AbortSignal;
      expected?: Pick<ServerInfo, 'instanceId' | 'identity'>;
    } = {},
  ): Promise<ServerInfo> {
    const response = await this.fetcher(
      new URL('api/v1/server-info', this.baseUrl),
      {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok)
      throw new SignalDockError(
        'RADIO_UNAVAILABLE',
        `Server discovery failed (HTTP ${response.status}).`,
      );
    const parsed = ServerInfoSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new SignalDockError(
        'API_INCOMPATIBLE',
        'The server returned an unsupported discovery document.',
      );
    const info = parsed.data;
    if (
      info.protocol.min > API_PROTOCOL_VERSION ||
      info.protocol.max < API_PROTOCOL_VERSION
    ) {
      throw new SignalDockError(
        'API_INCOMPATIBLE',
        'This server requires another client protocol version.',
      );
    }
    if (
      options.expected &&
      (options.expected.instanceId !== info.instanceId ||
        options.expected.identity.keyId !== info.identity.keyId ||
        options.expected.identity.publicKey !== info.identity.publicKey)
    ) {
      throw new SignalDockError(
        'INSTANCE_IDENTITY_CHANGED',
        'The identity at this URL changed. Remove the saved server and verify its identity before reconnecting.',
      );
    }
    return info;
  }
}

export interface RecentServerStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export class RecentServerStore {
  private readonly key = 'signaldock.recent-servers.v1';
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: RecentServerStorage) {}

  async list(): Promise<RecentServer[]> {
    const raw = await this.storage.getItem(this.key);
    if (!raw) return [];
    try {
      const parsed = RecentServersSchema.parse(JSON.parse(raw));
      return parsed.map((server) => ({
        ...server,
        baseUrl: normalizeServerUrl(server.baseUrl),
      }));
    } catch {
      return [];
    }
  }

  remember(baseUrl: string, info: ServerInfo): Promise<void> {
    return this.update(async () => {
      const canonical = normalizeServerUrl(baseUrl);
      const recent = await this.list();
      const existing = recent.find((server) => server.baseUrl === canonical);
      if (
        existing &&
        (existing.instanceId !== info.instanceId ||
          existing.identity.keyId !== info.identity.keyId ||
          existing.identity.publicKey !== info.identity.publicKey)
      ) {
        throw new SignalDockError(
          'INSTANCE_IDENTITY_CHANGED',
          'Remove the saved server before replacing its identity.',
        );
      }
      const entry: RecentServer = {
        baseUrl: canonical,
        alias: info.displayName,
        instanceId: info.instanceId,
        identity: info.identity,
        lastConnectedAt: new Date().toISOString(),
      };
      await this.storage.setItem(
        this.key,
        JSON.stringify(
          RecentServersSchema.parse(
            [
              entry,
              ...recent.filter((server) => server.baseUrl !== canonical),
            ].slice(0, 10),
          ),
        ),
      );
    });
  }

  remove(baseUrl: string): Promise<void> {
    return this.update(async () => {
      const canonical = normalizeServerUrl(baseUrl);
      await this.storage.setItem(
        this.key,
        JSON.stringify(
          (await this.list()).filter((server) => server.baseUrl !== canonical),
        ),
      );
    });
  }

  private update(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
