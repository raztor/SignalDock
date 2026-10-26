import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { PostgresDatabase, migrate } from '@signaldock/database';
import { SignalDockError } from '@signaldock/contracts';
import {
  IdentityService,
  type AccessRevocation,
} from '../src/modules/identity/identity.service.js';
import { SqlIdentityRepository } from '../src/modules/identity/identity.repository.js';
import { identityMigrations } from '../src/modules/identity/identity.migrations.js';
import {
  createArgon2idHasher,
  type PasswordHasher,
} from '../src/modules/identity/passwords.js';
import {
  registerIdentityRoutes,
  identityCookieNames,
} from '../src/modules/identity/identity.routes.js';
import { recoverAdministratorPassword } from '../src/modules/identity/recovery.js';
import { configureHttp } from '../src/shared/http/configure-http.js';

const connectionString =
  process.env['SIGNALDOCK_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const fixturePasswords: PasswordHasher = {
  hash: async (value) =>
    'fixture:' + createHash('sha256').update(value).digest('hex'),
  verify: async (hash, value) => hash === (await fixturePasswords.hash(value)),
};
const password = 'a long test password 123';
const setupToken = 'fixture-only-setup-token-long-enough';
const schema = 'sd_identity_' + randomUUID().replaceAll('-', '');
let db: PostgresDatabase;
let maintenance: PostgresDatabase;
const instanceId = randomUUID();
const radioId = randomUUID();
const otherRadioId = randomUUID();
let now = Date.now();
let service: IdentityService;
let events: AccessRevocation[] = [];
async function admin(assignRadio = false) {
  const user = await service.bootstrap({
    setupToken,
    username: 'Admin',
    password,
  });
  let tokens = await service.login({
    username: 'admin',
    password,
    sessionMode: 'token',
  });
  if (assignRadio) {
    await service.updateUser(
      await service.authenticate(tokens.accessToken),
      user.id,
      {
        radioPermissions: [
          {
            radioId,
            permissions: [
              'radio.listen',
              'radio.control',
              'radio.transmit',
              'history.read',
            ],
          },
        ],
      },
    );
    tokens = await service.login({
      username: 'admin',
      password,
      sessionMode: 'token',
    });
  }
  return {
    user,
    tokens,
    principal: await service.authenticate(tokens.accessToken),
  };
}

describe('Argon2id password adapter', () => {
  it('uses Argon2id and rejects the wrong password', async () => {
    const hasher = createArgon2idHasher();
    const hash = await hasher.hash(password);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(password);
    expect(await hasher.verify(hash, password)).toBe(true);
    expect(await hasher.verify(hash, 'wrong password')).toBe(false);
  });
});

describe.skipIf(!connectionString)(
  'PostgreSQL-backed identity and HTTP sessions',
  () => {
    beforeAll(async () => {
      maintenance = new PostgresDatabase({
        connectionString: connectionString!,
      });
      await maintenance.query(`CREATE SCHEMA ${schema}`);
      db = new PostgresDatabase({
        connectionString: connectionString!,
        options: `-c search_path=${schema},public`,
      });
      await migrate(db, identityMigrations);
    });
    afterAll(async () => {
      await db?.close();
      if (maintenance) {
        await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await maintenance.close();
      }
    });
    beforeEach(async () => {
      await db.query('TRUNCATE sd_users CASCADE');
      events = [];
      now = Date.now();
      service = new IdentityService({
        instanceId,
        repository: new SqlIdentityRepository(db, instanceId),
        passwords: fixturePasswords,
        setupToken,
        now: () => now,
        onAccessRevoked: async (event) => {
          events.push(event);
        },
      });
    });
    it('serializes administrator bootstrap and never exposes password hashes', async () => {
      const outcomes = await Promise.allSettled([
        service.bootstrap({ setupToken, username: 'admin', password }),
        service.bootstrap({ setupToken, username: 'other', password }),
      ]);
      expect(
        outcomes.filter((value) => value.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await service.bootstrapRequired()).toBe(false);
      const row = (await db.query('SELECT password_hash FROM sd_users'))
        .rows[0]!;
      expect(row['password_hash']).not.toBe(password);
      const result = outcomes.find((value) => value.status === 'fulfilled');
      if (result?.status === 'fulfilled')
        expect(result.value).not.toHaveProperty('passwordHash');
    });
    it('uses the same generic failure for unknown users, wrong passwords, and disabled users', async () => {
      const a = await admin();
      for (const input of [
        { username: 'missing', password },
        { username: 'admin', password: 'not the password' },
      ]) {
        await expect(
          service.login({ ...input, sessionMode: 'token' }),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
      const user = await service.createUser(a.principal, {
        username: 'listener',
        password,
        role: 'listener',
      });
      await service.updateUser(a.principal, user.id, { enabled: false });
      await expect(
        service.login({ username: 'listener', password, sessionMode: 'token' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
    it.each(['password_reset', 'permissions', 'sessions'] as const)(
      'rejects a verified login completed after %s invalidated its user version',
      async (change) => {
        const a = await admin();
        const user = await service.createUser(a.principal, {
          username: 'pending-user',
          password,
          role: 'operator',
        });
        let entered!: () => void;
        let release!: () => void;
        const verificationEntered = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const verificationRelease = new Promise<void>((resolve) => {
          release = resolve;
        });
        const delayedPasswords: PasswordHasher = {
          ...fixturePasswords,
          verify: async (hash, value) => {
            const valid = await fixturePasswords.verify(hash, value);
            entered();
            await verificationRelease;
            return valid;
          },
        };
        const delayed = new IdentityService({
          instanceId,
          repository: new SqlIdentityRepository(db, instanceId),
          passwords: delayedPasswords,
          now: () => now,
        });
        const login = delayed.login({
          username: user.username,
          password,
          sessionMode: 'token',
        });
        await verificationEntered;
        if (change === 'password_reset')
          await service.resetPassword(
            a.principal,
            user.id,
            'replacement password 123',
          );
        if (change === 'permissions')
          await service.updateUser(a.principal, user.id, { role: 'listener' });
        if (change === 'sessions')
          await service.revokeUserSessions(a.principal, user.id);
        release();
        await expect(login).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        const rows = await db.query(
          'SELECT id FROM sd_sessions WHERE instance_id=$1 AND user_id=$2 AND revoked_at IS NULL',
          [instanceId, user.id],
        );
        expect(rows.rows).toHaveLength(0);
      },
    );
    it('serializes duplicate usernames and returns a domain conflict', async () => {
      const a = await admin();
      const results = await Promise.allSettled([
        service.createUser(a.principal, {
          username: 'duplicate',
          password,
          role: 'listener',
        }),
        service.createUser(a.principal, {
          username: 'duplicate',
          password,
          role: 'listener',
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected')
        expect(failure.reason).toMatchObject({ code: 'OPERATION_CONFLICT' });
    });
    it('clips issued access expiry to the absolute refresh-family expiry', async () => {
      await admin();
      const short = new IdentityService({
        instanceId,
        repository: new SqlIdentityRepository(db, instanceId),
        passwords: fixturePasswords,
        now: () => now,
        accessLifetimeMs: 10000,
        refreshLifetimeMs: 1000,
      });
      const tokens = await short.login({
        username: 'admin',
        password,
        sessionMode: 'token',
      });
      expect(Date.parse(tokens.accessExpiresAt)).toBe(now + 1000);
    });
    it('requires explicit radio scopes even for administrator and rejects listener TX', async () => {
      const a = await admin();
      await expect(
        service.authorize(a.principal, 'radio.transmit', radioId),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await service.authorize(a.principal, 'instance.admin');
      const listener = await service.createUser(a.principal, {
        username: 'listener',
        password,
        role: 'listener',
        radioPermissions: [
          {
            radioId,
            permissions: ['radio.listen', 'history.read', 'incident.read'],
          },
        ],
      });
      const tokens = await service.login({
        username: listener.username,
        password,
        sessionMode: 'token',
      });
      const actor = await service.authenticate(tokens.accessToken);
      await service.authorize(actor, 'radio.listen', radioId);
      await expect(
        service.authorize(actor, 'radio.transmit', radioId),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.authorize(actor, 'radio.listen', otherRadioId),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.createUser(a.principal, {
          username: 'badlistener',
          password,
          role: 'listener',
          radioPermissions: [{ radioId, permissions: ['radio.transmit'] }],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });
    it('rotates refresh credentials and commits whole-session revocation on reuse', async () => {
      const a = await admin();
      const rotated = await service.refresh(a.tokens.refreshToken!, {
        mode: 'token',
      });
      await expect(
        service.authenticate(a.tokens.accessToken),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect((await service.authenticate(rotated.accessToken)).userId).toBe(
        a.user.id,
      );
      await expect(
        service.refresh(a.tokens.refreshToken!, { mode: 'token' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(
        service.authenticate(rotated.accessToken),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(events.at(-1)?.reason).toBe('refresh_reuse');
      expect(
        (await db.query('SELECT revoked_at FROM sd_sessions')).rows[0]![
          'revoked_at'
        ],
      ).not.toBeNull();
    });
    it('prevents concurrent refreshes from producing two usable successor sessions', async () => {
      const a = await admin();
      const outcomes = await Promise.allSettled([
        service.refresh(a.tokens.refreshToken!, { mode: 'token' }),
        service.refresh(a.tokens.refreshToken!, { mode: 'token' }),
      ]);
      expect(
        outcomes.filter((value) => value.status === 'fulfilled'),
      ).toHaveLength(1);
      const success = outcomes.find((value) => value.status === 'fulfilled');
      if (success?.status === 'fulfilled')
        await expect(
          service.authenticate(success.value.accessToken),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
    it('rejects cookie refresh without valid CSRF and does not consume its token', async () => {
      await admin();
      const tokens = await service.login({
        username: 'admin',
        password,
        sessionMode: 'cookie',
      });
      await expect(
        service.refresh(tokens.refreshToken!, { mode: 'cookie' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        service.refresh(tokens.refreshToken!, { mode: 'token' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      const rotated = await service.refresh(tokens.refreshToken!, {
        mode: 'cookie',
        csrfToken: tokens.csrfToken!,
      });
      expect(await service.authenticate(rotated.accessToken)).toMatchObject({
        username: 'admin',
      });
    });
    it('revokes sessions immediately after grant changes and publishes invalidation', async () => {
      const a = await admin(true);
      await service.updateUser(a.principal, a.user.id, {
        radioPermissions: [],
      });
      await expect(
        service.authorize(a.principal, 'radio.transmit', radioId),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(events.at(-1)).toMatchObject({
        userId: a.user.id,
        reason: 'access_changed',
      });
    });
    it('isolates colliding usernames and token scope across instances', async () => {
      const a = await admin();
      const secondId = randomUUID();
      const second = new IdentityService({
        instanceId: secondId,
        repository: new SqlIdentityRepository(db, secondId),
        passwords: fixturePasswords,
        setupToken,
      });
      const user = await second.bootstrap({
        setupToken,
        username: 'admin',
        password,
      });
      expect(user.id).not.toBe(a.user.id);
      await expect(
        second.authenticate(a.tokens.accessToken),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
    it('blocks disabling the last administrator and supports local password recovery', async () => {
      const a = await admin();
      await expect(
        service.updateUser(a.principal, a.user.id, { enabled: false }),
      ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
      await recoverAdministratorPassword({
        repository: new SqlIdentityRepository(db, instanceId),
        passwords: fixturePasswords,
        username: 'admin',
        password: 'replacement password 1234',
      });
      await expect(
        service.authenticate(a.tokens.accessToken),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(
        service.login({
          username: 'admin',
          password: 'replacement password 1234',
          sessionMode: 'token',
        }),
      ).resolves.toHaveProperty('accessToken');
    });
    it('expires access while retaining bounded refresh validity', async () => {
      const short = new IdentityService({
        instanceId,
        repository: new SqlIdentityRepository(db, instanceId),
        passwords: fixturePasswords,
        setupToken,
        now: () => now,
        accessLifetimeMs: 1000,
        refreshLifetimeMs: 5000,
      });
      await short.bootstrap({ setupToken, username: 'admin', password });
      const tokens = await short.login({
        username: 'admin',
        password,
        sessionMode: 'token',
      });
      now += 1100;
      await expect(
        short.authenticate(tokens.accessToken),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      const rotated = await short.refresh(tokens.refreshToken!, {
        mode: 'token',
      });
      now += 5000;
      await expect(
        short.refresh(rotated.refreshToken!, { mode: 'token' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
    it('resolves notification audience from enabled users without inventing sessions', async () => {
      const a = await admin(true);
      const audience = await service.resolveUser(a.user.id);
      expect(audience).not.toHaveProperty('sessionId');
      expect(audience?.radioPermissions).toHaveLength(1);
      expect(await service.resolveUser(randomUUID())).toBeNull();
    });
    it('issues scoped HttpOnly refresh cookies and enforces same-origin CSRF', async () => {
      const app = Fastify();
      configureHttp(app);
      registerIdentityRoutes(app, {
        prefix: '/station/api/v1',
        service,
        cookieOrigin: 'http://localhost:3000',
        secureCookies: false,
      });
      try {
        await service.bootstrap({ setupToken, username: 'admin', password });
        const denied = await app.inject({
          method: 'POST',
          url: '/station/api/v1/auth/login',
          headers: { origin: 'https://other.example' },
          payload: { username: 'admin', password, sessionMode: 'cookie' },
        });
        expect(denied.statusCode).toBe(403);
        const login = await app.inject({
          method: 'POST',
          url: '/station/api/v1/auth/login',
          headers: { origin: 'http://localhost:3000' },
          payload: { username: 'admin', password, sessionMode: 'cookie' },
        });
        expect(login.statusCode).toBe(200);
        expect(login.json()).not.toHaveProperty('refreshToken');
        const cookies = login.cookies;
        const names = identityCookieNames(instanceId);
        expect(
          cookies.find((value) => value.name === names.refresh)?.httpOnly,
        ).toBe(true);
        const cookieHeader = cookies
          .map((value) => `${value.name}=${value.value}`)
          .join('; ');
        const missing = await app.inject({
          method: 'POST',
          url: '/station/api/v1/auth/refresh',
          headers: { origin: 'http://localhost:3000', cookie: cookieHeader },
          payload: {},
        });
        expect(missing.statusCode).toBe(403);
        const refreshed = await app.inject({
          method: 'POST',
          url: '/station/api/v1/auth/refresh',
          headers: {
            origin: 'http://localhost:3000',
            cookie: cookieHeader,
            'x-csrf-token': login.json().csrfToken,
          },
          payload: {},
        });
        expect(refreshed.statusCode).toBe(200);
        const sessionCookie = refreshed.cookies
          .map((value) => `${value.name}=${value.value}`)
          .join('; ');
        const logout = await app.inject({
          method: 'POST',
          url: '/station/api/v1/auth/logout',
          headers: {
            origin: 'http://localhost:3000',
            cookie: sessionCookie,
            'x-csrf-token': refreshed.json().csrfToken,
          },
          payload: {},
        });
        expect(logout.statusCode).toBe(204);
        await expect(
          service.authenticate(refreshed.json().accessToken),
        ).rejects.toBeInstanceOf(SignalDockError);
      } finally {
        await app.close();
      }
    });
  },
);
