import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BootstrapRequestSchema,
  LoginRequestSchema,
  SessionTokensSchema,
  SignalDockError,
  IdSchema,
  CreateUserRequestSchema,
  UpdateUserRequestSchema,
  ResetPasswordRequestSchema,
  RefreshRequestSchema,
} from '@signaldock/contracts';
import { requirePrincipal } from '../../shared/http/auth.js';
import { IdentityService, roleRadioPermissions } from './identity.service.js';

export interface IdentityRoutesOptions {
  prefix: string;
  service: IdentityService;
  cookieOrigin?: string;
  secureCookies?: boolean;
}
export function identityCookieNames(instanceId: string) {
  return { refresh: `sd-refresh-${instanceId}`, csrf: `sd-csrf-${instanceId}` };
}
function body<T>(
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false };
  },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'The request body is invalid.',
    );
  return result.data;
}
function cookie(request: FastifyRequest, name: string): string | undefined {
  const item = request.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + '='));
  if (!item) return undefined;
  try {
    return decodeURIComponent(item.slice(name.length + 1));
  } catch {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'The request cookie is invalid.',
    );
  }
}
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Only public authentication routes accept cookies; domain APIs require bearer access. */
export function registerIdentityRoutes(
  app: FastifyInstance,
  options: IdentityRoutesOptions,
): void {
  const { prefix, service } = options;
  const names = identityCookieNames(service.instanceId);
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)+$/.test(prefix))
    throw new Error('Identity route prefix is invalid.');
  const cookieOrigin = options.cookieOrigin
    ? new URL(options.cookieOrigin).origin
    : undefined;
  const secure = options.secureCookies ?? true;
  if (!secure && cookieOrigin) {
    const parsed = new URL(cookieOrigin);
    if (
      parsed.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    )
      throw new Error(
        'Insecure cookies are allowed only for loopback development.',
      );
  }
  const cookiePath = `${prefix}/auth`;
  const origin = (request: FastifyRequest) => {
    if (!cookieOrigin || request.headers.origin !== cookieOrigin)
      throw new SignalDockError(
        'FORBIDDEN',
        'Cookie sessions require the configured same-origin web client.',
      );
  };
  const setCookies = (
    reply: FastifyReply,
    refresh: string,
    csrf: string,
    clear = false,
  ) => {
    const flags = `; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${clear ? 0 : 30 * 24 * 60 * 60}`;
    reply.header('Set-Cookie', [
      `${names.refresh}=${encodeURIComponent(refresh)}; Path=${cookiePath}; HttpOnly${flags}`,
      `${names.csrf}=${encodeURIComponent(csrf)}; Path=/${flags}`,
    ]);
  };
  const issued = (
    reply: FastifyReply,
    tokens: Awaited<ReturnType<IdentityService['login']>>,
    mode: 'cookie' | 'token',
  ) => {
    if (mode === 'token') return SessionTokensSchema.parse(tokens);
    setCookies(reply, tokens.refreshToken!, tokens.csrfToken!);
    const { refreshToken: _refresh, ...publicTokens } = tokens;
    return SessionTokensSchema.parse(publicTokens);
  };
  const attempts = new Map<string, { count: number; until: number }>();
  const limit = (request: FastifyRequest, group: string, max: number) => {
    const key = `${group}:${request.ip}`;
    const now = Date.now();
    for (const [id, value] of attempts)
      if (value.until <= now) attempts.delete(id);
    const value = attempts.get(key) ?? { count: 0, until: now + 60000 };
    value.count++;
    attempts.set(key, value);
    if (attempts.size > 4096) attempts.delete(attempts.keys().next().value!);
    if (value.count > max)
      throw new SignalDockError(
        'FORBIDDEN',
        'Too many authentication attempts. Try again later.',
      );
  };
  app.get(`${prefix}/auth/bootstrap`, async () => ({
    required: await service.bootstrapRequired(),
  }));
  app.post(`${prefix}/auth/bootstrap`, async (request, reply) => {
    limit(request, 'bootstrap', 5);
    const input = body(BootstrapRequestSchema, request.body);
    return reply.code(201).send(await service.bootstrap(input));
  });
  app.post(`${prefix}/auth/login`, async (request, reply) => {
    limit(request, 'login', 30);
    const input = body(LoginRequestSchema, request.body);
    if (input.sessionMode === 'cookie') origin(request);
    const tokens = await service.login({
      ...input,
      label: header(request, 'x-signaldock-client') ?? '',
    });
    return issued(reply, tokens, input.sessionMode);
  });
  app.post(`${prefix}/auth/refresh`, async (request, reply) => {
    limit(request, 'refresh', 60);
    const input = body(RefreshRequestSchema, request.body ?? {});
    const fromCookie = cookie(request, names.refresh);
    if (fromCookie && input.refreshToken)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Use one refresh transport.',
      );
    if (fromCookie) {
      origin(request);
      const csrfToken = header(request, 'x-csrf-token');
      const tokens = await service.refresh(fromCookie, {
        mode: 'cookie',
        ...(csrfToken ? { csrfToken } : {}),
      });
      return issued(reply, tokens, 'cookie');
    }
    if (!input.refreshToken)
      throw new SignalDockError(
        'UNAUTHORIZED',
        'A refresh credential is required.',
      );
    return issued(
      reply,
      await service.refresh(input.refreshToken, { mode: 'token' }),
      'token',
    );
  });
  app.post(`${prefix}/auth/logout`, async (request, reply) => {
    const input = body(RefreshRequestSchema, request.body ?? {});
    const fromCookie = cookie(request, names.refresh);
    if (fromCookie && input.refreshToken)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Use one refresh transport.',
      );
    const csrfToken = header(request, 'x-csrf-token');
    if (fromCookie) {
      origin(request);
      await service.logoutRefresh(fromCookie, {
        mode: 'cookie',
        ...(csrfToken ? { csrfToken } : {}),
      });
      setCookies(reply, '', '', true);
    } else if (input.refreshToken)
      await service.logoutRefresh(input.refreshToken, { mode: 'token' });
    else {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer '))
        throw new SignalDockError(
          'UNAUTHORIZED',
          'A session credential is required.',
        );
      await service.logoutAccess(authorization.slice(7), csrfToken);
    }
    return reply.code(204).send();
  });
  app.get(`${prefix}/me`, async (request) =>
    service.me(await requirePrincipal(request, service)),
  );
  app.get(`${prefix}/auth/sessions`, async (request) => ({
    sessions: await service.listSessions(
      await requirePrincipal(request, service),
    ),
  }));
  app.delete<{ Params: { id: string } }>(
    `${prefix}/auth/sessions/:id`,
    async (request, reply) => {
      const id = IdSchema.safeParse(request.params.id);
      if (!id.success)
        throw new SignalDockError('INVALID_ARGUMENT', 'Session ID is invalid.');
      await service.revokeSession(
        await requirePrincipal(request, service),
        id.data,
      );
      return reply.code(204).send();
    },
  );
  app.get(`${prefix}/admin/users`, async (request) => ({
    users: await service.listUsers(
      await requirePrincipal(request, service, 'instance.admin'),
    ),
  }));
  app.get(`${prefix}/admin/role-permissions`, async (request) => {
    await requirePrincipal(request, service, 'instance.admin');
    return { roles: roleRadioPermissions };
  });
  app.post(`${prefix}/admin/users`, async (request, reply) => {
    const input = body(CreateUserRequestSchema, request.body);
    return reply
      .code(201)
      .send(
        await service.createUser(
          await requirePrincipal(request, service, 'instance.admin'),
          input,
        ),
      );
  });
  app.patch<{ Params: { id: string } }>(
    `${prefix}/admin/users/:id`,
    async (request) => {
      const input = body(UpdateUserRequestSchema, request.body);
      const id = IdSchema.safeParse(request.params.id);
      if (!id.success)
        throw new SignalDockError('INVALID_ARGUMENT', 'User ID is invalid.');
      return service.updateUser(
        await requirePrincipal(request, service, 'instance.admin'),
        id.data,
        input,
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    `${prefix}/admin/users/:id/revoke-sessions`,
    async (request) => {
      const id = IdSchema.safeParse(request.params.id);
      if (!id.success)
        throw new SignalDockError('INVALID_ARGUMENT', 'User ID is invalid.');
      return {
        revoked: await service.revokeUserSessions(
          await requirePrincipal(request, service, 'instance.admin'),
          id.data,
        ),
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    `${prefix}/admin/users/:id/password`,
    async (request, reply) => {
      const input = body(ResetPasswordRequestSchema, request.body);
      const id = IdSchema.safeParse(request.params.id);
      if (!id.success)
        throw new SignalDockError('INVALID_ARGUMENT', 'User ID is invalid.');
      await service.resetPassword(
        await requirePrincipal(request, service, 'instance.admin'),
        id.data,
        input.password,
      );
      return reply.code(204).send();
    },
  );
}
