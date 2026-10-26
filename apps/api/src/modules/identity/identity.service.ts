import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  IdSchema,
  PermissionSchema,
  PublicUserSchema,
  RoleSchema,
  SignalDockError,
  type AuthenticationPort,
  type Permission,
  type Principal,
  type PublicUser,
  type RadioPermissionGrant,
  type Role,
  type SessionTokens,
  type NotificationAudience,
  type NotificationAudiencePort,
  type CreateUserRequest,
  type UpdateUserRequest,
} from '@signaldock/contracts';
import type { PasswordHasher } from './passwords.js';
import type {
  IdentityRepository,
  IdentitySessionRecord,
  IdentityUserRecord,
} from './identity.repository.js';

export interface AccessRevocation {
  instanceId: string;
  userId: string;
  sessionIds: string[];
  reason:
    | 'logout'
    | 'refresh_reuse'
    | 'access_changed'
    | 'administrator'
    | 'password_reset';
}
export interface IdentityServiceOptions {
  instanceId: string;
  repository: IdentityRepository;
  passwords: PasswordHasher;
  setupToken?: string;
  now?: () => number;
  accessLifetimeMs?: number;
  refreshLifetimeMs?: number;
  onAccessRevoked?: (event: AccessRevocation) => Promise<void>;
}
export type CreateIdentityUser = CreateUserRequest;
export type UpdateIdentityUser = UpdateUserRequest;
export const roleRadioPermissions: Record<Role, readonly Permission[]> = {
  listener: [
    'radio.listen',
    'history.read',
    'incident.read',
    'aprs.read',
    'notifications.read',
  ],
  operator: [
    'radio.listen',
    'radio.control',
    'radio.transmit',
    'history.read',
    'history.write',
    'recording.export',
    'incident.read',
    'incident.manage',
    'aprs.read',
    'notifications.read',
  ],
  administrator: [
    'radio.listen',
    'radio.control',
    'radio.transmit',
    'radio.configure',
    'history.read',
    'history.write',
    'recording.export',
    'incident.read',
    'incident.manage',
    'aprs.read',
    'notifications.read',
  ],
};
const globalAdminPermissions = new Set<Permission>([
  'instance.admin',
  'radio.configure',
  'processing.manage',
  'notifications.manage',
]);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const matches = (value: string, hash: string) =>
  timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));
const unauthorized = () =>
  new SignalDockError(
    'UNAUTHORIZED',
    'The credentials or session are invalid.',
  );

export class IdentityService
  implements AuthenticationPort, NotificationAudiencePort
{
  readonly instanceId: string;
  private readonly repository: IdentityRepository;
  private readonly passwords: PasswordHasher;
  private readonly now: () => number;
  private readonly accessLifetime: number;
  private readonly refreshLifetime: number;
  private readonly dummyHash: Promise<string>;
  constructor(private readonly options: IdentityServiceOptions) {
    this.instanceId = IdSchema.parse(options.instanceId);
    this.repository = options.repository;
    this.passwords = options.passwords;
    if (options.setupToken && options.setupToken.length < 24)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'The administrator setup token must contain at least 24 characters.',
      );
    this.now = options.now ?? Date.now;
    this.accessLifetime = options.accessLifetimeMs ?? 15 * 60 * 1000;
    this.refreshLifetime =
      options.refreshLifetimeMs ?? 30 * 24 * 60 * 60 * 1000;
    this.dummyHash = this.passwords.hash(randomBytes(32).toString('base64url'));
  }
  async resolveUser(userId: string): Promise<NotificationAudience | null> {
    if (!IdSchema.safeParse(userId).success) return null;
    const user = await this.repository.findUser(userId);
    if (!user?.enabled) return null;
    const { sessionId: _sessionId, ...audience } = this.principal(
      user,
      user.id,
    );
    return audience;
  }
  async bootstrapRequired(): Promise<boolean> {
    return !(await this.repository.hasUsers());
  }
  async bootstrap(input: {
    setupToken: string;
    username: string;
    password: string;
  }): Promise<PublicUser> {
    if (!this.options.setupToken)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'Administrator setup is not configured.',
      );
    if (!matches(input.setupToken, digest(this.options.setupToken)))
      throw unauthorized();
    const username = this.username(input.username);
    this.password(input.password);
    const passwordHash = await this.passwords.hash(input.password);
    const now = this.timestamp();
    const user: IdentityUserRecord = {
      id: randomUUID(),
      instanceId: this.instanceId,
      username,
      passwordHash,
      role: 'administrator',
      enabled: true,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
      radioPermissions: [],
    };
    await this.repository.transaction(async (repository) => {
      await repository.lockBootstrap();
      if (await repository.hasUsers())
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'Administrator setup has already completed.',
        );
      await repository.createUser(user);
    });
    return this.publicUser(user);
  }
  async login(input: {
    username: string;
    password: string;
    sessionMode: 'cookie' | 'token';
    label?: string;
  }): Promise<SessionTokens> {
    const user = await this.repository.findUserByName(
      this.username(input.username),
    );
    const valid = await this.passwords.verify(
      user?.passwordHash ?? (await this.dummyHash),
      input.password,
    );
    if (!valid || !user?.enabled) throw unauthorized();
    return this.repository.transaction(async (repository) => {
      const current = await repository.lockUser(user.id);
      if (
        !current?.enabled ||
        current.authVersion !== user.authVersion ||
        current.passwordHash !== user.passwordHash
      )
        throw unauthorized();
      const { session, tokens, refreshHash } = this.issue(
        current,
        input.sessionMode,
        input.label ?? '',
      );
      await repository.createSession(session, refreshHash);
      return tokens;
    });
  }
  async refresh(
    refreshToken: string,
    input: { mode: 'cookie' | 'token'; csrfToken?: string },
  ): Promise<SessionTokens> {
    this.checkToken(refreshToken, 'r');
    const now = this.timestamp();
    const outcome = await this.repository.transaction(async (repository) => {
      const found = await repository.lockRefresh(digest(refreshToken));
      if (!found || found.session.mode !== input.mode)
        return { kind: 'invalid' } as const;
      if (
        input.mode === 'cookie' &&
        (!input.csrfToken ||
          !matches(input.csrfToken, found.session.csrfTokenHash))
      ) {
        throw new SignalDockError(
          'FORBIDDEN',
          'The refresh CSRF proof is invalid.',
        );
      }
      if (found.usedAt !== null) {
        await repository.revokeSession(found.session.id, now);
        return { kind: 'reused', session: found.session } as const;
      }
      if (
        !this.active(found.session, false) ||
        Date.parse(found.expiresAt) <= this.now()
      )
        return { kind: 'invalid' } as const;
      const user = await repository.findUser(found.session.userId);
      if (!user?.enabled) return { kind: 'invalid' } as const;
      const issued = this.issue(
        user,
        found.session.mode,
        found.session.label,
        found.session,
      );
      await repository.rotateSession(
        issued.session,
        digest(refreshToken),
        issued.refreshHash,
        now,
      );
      return { kind: 'issued', tokens: issued.tokens } as const;
    });
    if (outcome.kind === 'reused') {
      await this.revoked(
        outcome.session.userId,
        [outcome.session.id],
        'refresh_reuse',
      );
      throw unauthorized();
    }
    if (outcome.kind === 'invalid') throw unauthorized();
    return outcome.tokens;
  }
  async authenticate(accessToken: string): Promise<Principal> {
    this.checkToken(accessToken, 'a');
    const session = await this.repository.findAccess(digest(accessToken));
    if (!session || !this.active(session)) throw unauthorized();
    const user = await this.repository.findUser(session.userId);
    if (!user?.enabled) throw unauthorized();
    return this.principal(user, session.id);
  }
  async authorize(
    principal: Principal,
    permission: Permission,
    radioId?: string,
  ): Promise<void> {
    if (principal.instanceId !== this.instanceId) throw unauthorized();
    const session = await this.repository.findSession(principal.sessionId);
    const user = await this.repository.findUser(principal.userId);
    if (
      !session ||
      session.userId !== principal.userId ||
      !this.active(session) ||
      !user?.enabled
    )
      throw unauthorized();
    this.assertPermission(user, permission, radioId);
  }
  async authorizeUser(
    userId: string,
    permission: Permission,
    radioId?: string,
  ): Promise<void> {
    const user = await this.repository.findUser(IdSchema.parse(userId));
    if (!user?.enabled) throw unauthorized();
    this.assertPermission(user, permission, radioId);
  }
  private assertPermission(
    user: IdentityUserRecord,
    permission: Permission,
    radioId?: string,
  ): void {
    if (user.role === 'administrator' && globalAdminPermissions.has(permission))
      return;
    if (permission === 'notifications.read' && !radioId) return;
    if (
      !radioId ||
      !user.radioPermissions.some(
        (grant) =>
          grant.radioId === radioId && grant.permissions.includes(permission),
      )
    ) {
      throw new SignalDockError(
        'FORBIDDEN',
        'This operation is not permitted for this radio.',
      );
    }
  }
  async me(principal: Principal): Promise<PublicUser> {
    const current = await this.currentUser(principal);
    return this.publicUser(current);
  }
  async logoutAccess(accessToken: string, csrfToken?: string): Promise<void> {
    const principal = await this.authenticate(accessToken);
    const session = await this.repository.findSession(principal.sessionId);
    if (!session) throw unauthorized();
    if (
      session.mode === 'cookie' &&
      (!csrfToken || !matches(csrfToken, session.csrfTokenHash))
    )
      throw new SignalDockError(
        'FORBIDDEN',
        'The logout CSRF proof is invalid.',
      );
    await this.repository.revokeSession(session.id, this.timestamp());
    await this.revoked(principal.userId, [session.id], 'logout');
  }
  async logoutRefresh(
    refreshToken: string,
    input: { mode: 'cookie' | 'token'; csrfToken?: string },
  ): Promise<void> {
    this.checkToken(refreshToken, 'r');
    const session = await this.repository.transaction(async (repository) => {
      const found = await repository.lockRefresh(digest(refreshToken));
      if (!found || found.session.mode !== input.mode) throw unauthorized();
      if (
        input.mode === 'cookie' &&
        (!input.csrfToken ||
          !matches(input.csrfToken, found.session.csrfTokenHash))
      )
        throw new SignalDockError(
          'FORBIDDEN',
          'The logout CSRF proof is invalid.',
        );
      await repository.revokeSession(found.session.id, this.timestamp());
      return found.session;
    });
    await this.revoked(session.userId, [session.id], 'logout');
  }
  async listSessions(principal: Principal) {
    await this.currentUser(principal);
    return (await this.repository.listSessions(principal.userId)).map(
      (session) => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        refreshExpiresAt: session.refreshExpiresAt,
        revokedAt: session.revokedAt,
        label: session.label,
        current: session.id === principal.sessionId,
      }),
    );
  }
  async revokeSession(principal: Principal, sessionId: string): Promise<void> {
    await this.currentUser(principal);
    IdSchema.parse(sessionId);
    const session = await this.repository.findSession(sessionId);
    if (!session || session.userId !== principal.userId)
      throw new SignalDockError('NOT_FOUND', 'Unknown session.');
    await this.repository.revokeSession(sessionId, this.timestamp());
    await this.revoked(principal.userId, [sessionId], 'logout');
  }
  async listUsers(principal: Principal): Promise<PublicUser[]> {
    await this.authorize(principal, 'instance.admin');
    return (await this.repository.listUsers()).map((user) =>
      this.publicUser(user),
    );
  }
  async createUser(
    principal: Principal,
    input: CreateIdentityUser,
  ): Promise<PublicUser> {
    await this.authorize(principal, 'instance.admin');
    const username = this.username(input.username);
    this.password(input.password);
    const role = RoleSchema.parse(input.role);
    const now = this.timestamp();
    const user: IdentityUserRecord = {
      id: randomUUID(),
      instanceId: this.instanceId,
      username,
      passwordHash: await this.passwords.hash(input.password),
      role,
      enabled: true,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
      radioPermissions: this.grants(role, input.radioPermissions ?? []),
    };
    await this.repository.transaction(async (repository) => {
      await repository.lockBootstrap();
      if (await repository.findUserByName(username))
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'That username is already in use.',
        );
      await repository.createUser(user);
    });
    return this.publicUser(user);
  }
  async updateUser(
    principal: Principal,
    userId: string,
    input: UpdateIdentityUser,
  ): Promise<PublicUser> {
    await this.authorize(principal, 'instance.admin');
    IdSchema.parse(userId);
    const outcome = await this.repository.transaction(async (repository) => {
      const administrators = await repository.lockAdministrators();
      const current = await repository.lockUser(userId);
      if (!current) throw new SignalDockError('NOT_FOUND', 'Unknown user.');
      const role = RoleSchema.parse(input.role ?? current.role);
      const enabled = input.enabled ?? current.enabled;
      if (
        current.role === 'administrator' &&
        current.enabled &&
        (role !== 'administrator' || !enabled) &&
        administrators.length <= 1
      ) {
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'The last enabled administrator cannot be disabled or demoted.',
        );
      }
      const user = {
        ...current,
        role,
        enabled,
        radioPermissions: this.grants(
          role,
          input.radioPermissions ??
            current.radioPermissions.map((grant) => ({
              ...grant,
              permissions: grant.permissions.filter((permission) =>
                roleRadioPermissions[role].includes(permission),
              ),
            })),
        ),
        authVersion: current.authVersion + 1,
        updatedAt: this.timestamp(),
      };
      await repository.updateUser(user);
      const sessionIds = await repository.revokeUserSessions(
        userId,
        this.timestamp(),
      );
      return { user, sessionIds };
    });
    await this.revoked(userId, outcome.sessionIds, 'access_changed');
    return this.publicUser(outcome.user);
  }
  async revokeUserSessions(
    principal: Principal,
    userId: string,
  ): Promise<number> {
    await this.authorize(principal, 'instance.admin');
    IdSchema.parse(userId);
    const sessionIds = await this.repository.transaction(async (repository) => {
      const user = await repository.lockUser(userId);
      if (!user) throw new SignalDockError('NOT_FOUND', 'Unknown user.');
      await repository.updateUser({
        ...user,
        authVersion: user.authVersion + 1,
        updatedAt: this.timestamp(),
      });
      return repository.revokeUserSessions(userId, this.timestamp());
    });
    await this.revoked(userId, sessionIds, 'administrator');
    return sessionIds.length;
  }
  async resetPassword(
    principal: Principal,
    userId: string,
    password: string,
  ): Promise<void> {
    await this.authorize(principal, 'instance.admin');
    IdSchema.parse(userId);
    this.password(password);
    const hash = await this.passwords.hash(password);
    const sessionIds = await this.repository.transaction(async (repository) => {
      const user = await repository.lockUser(userId);
      if (!user) throw new SignalDockError('NOT_FOUND', 'Unknown user.');
      await repository.updateUser({
        ...user,
        passwordHash: hash,
        authVersion: user.authVersion + 1,
        updatedAt: this.timestamp(),
      });
      return repository.revokeUserSessions(userId, this.timestamp());
    });
    await this.revoked(userId, sessionIds, 'password_reset');
  }
  private async currentUser(principal: Principal): Promise<IdentityUserRecord> {
    if (principal.instanceId !== this.instanceId) throw unauthorized();
    const session = await this.repository.findSession(principal.sessionId);
    const user = await this.repository.findUser(principal.userId);
    if (
      !session ||
      session.userId !== principal.userId ||
      !this.active(session) ||
      !user?.enabled
    )
      throw unauthorized();
    return user;
  }
  private issue(
    user: IdentityUserRecord,
    mode: 'cookie' | 'token',
    label: string,
    existing?: IdentitySessionRecord,
  ) {
    const accessToken = this.token('a');
    const refreshToken = this.token('r');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = this.timestamp();
    const refreshExpiresAt =
      existing?.refreshExpiresAt ??
      new Date(this.now() + this.refreshLifetime).toISOString();
    const accessExpiresAt = new Date(
      Math.min(this.now() + this.accessLifetime, Date.parse(refreshExpiresAt)),
    ).toISOString();
    const session: IdentitySessionRecord = {
      id: existing?.id ?? randomUUID(),
      instanceId: this.instanceId,
      userId: user.id,
      accessTokenHash: digest(accessToken),
      csrfTokenHash: digest(csrfToken),
      mode,
      accessExpiresAt,
      refreshExpiresAt,
      revokedAt: null,
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
      label: label.slice(0, 100),
    };
    const tokens: SessionTokens = {
      accessToken,
      accessExpiresAt,
      refreshToken,
      csrfToken,
      user: this.publicUser(user),
    };
    return { session, tokens, refreshHash: digest(refreshToken) };
  }
  private active(session: IdentitySessionRecord, access = true): boolean {
    return (
      !session.revokedAt &&
      Date.parse(session.refreshExpiresAt) > this.now() &&
      (!access || Date.parse(session.accessExpiresAt) > this.now())
    );
  }
  private token(kind: 'a' | 'r'): string {
    return `sd1${kind}.${this.instanceId}.${randomBytes(32).toString('base64url')}`;
  }
  private checkToken(value: string, kind: 'a' | 'r'): void {
    const parts = value.split('.');
    if (
      parts.length !== 3 ||
      parts[0] !== `sd1${kind}` ||
      parts[1] !== this.instanceId ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? '')
    )
      throw unauthorized();
  }
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  private username(input: string): string {
    const value = input.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value))
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Username must have 3–64 letters, numbers, dots, underscores, or hyphens.',
      );
    return value;
  }
  private password(input: string): void {
    if (input.length < 12 || input.length > 1024)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Password must contain 12–1024 characters.',
      );
  }
  private grants(
    role: Role,
    input: RadioPermissionGrant[],
  ): RadioPermissionGrant[] {
    if (input.length > 256)
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Too many radio assignments.',
      );
    const seen = new Set<string>();
    return input.map((grant) => {
      IdSchema.parse(grant.radioId);
      if (seen.has(grant.radioId))
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Duplicate radio assignment.',
        );
      seen.add(grant.radioId);
      const permissions = [
        ...new Set(
          grant.permissions.map((value) => PermissionSchema.parse(value)),
        ),
      ];
      if (
        permissions.some(
          (permission) => !roleRadioPermissions[role].includes(permission),
        )
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'The role does not permit an assigned capability.',
        );
      return { radioId: grant.radioId, permissions };
    });
  }
  private publicUser(user: IdentityUserRecord): PublicUser {
    return PublicUserSchema.parse({
      id: user.id,
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      radioPermissions: user.radioPermissions,
    });
  }
  private principal(user: IdentityUserRecord, sessionId: string): Principal {
    const publicUser = this.publicUser(user);
    return {
      instanceId: this.instanceId,
      userId: user.id,
      sessionId,
      username: user.username,
      role: user.role,
      radioPermissions: publicUser.radioPermissions,
    };
  }
  private async revoked(
    userId: string,
    sessionIds: string[],
    reason: AccessRevocation['reason'],
  ): Promise<void> {
    if (this.options.onAccessRevoked)
      await this.options.onAccessRevoked({
        instanceId: this.instanceId,
        userId,
        sessionIds,
        reason,
      });
  }
}
