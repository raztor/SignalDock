import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgresDatabase, migrate } from '@signaldock/database';
import {
  SignalDockError,
  type AuthenticationPort,
  type Principal,
  type RadioConfiguration,
} from '@signaldock/contracts';
import {
  RadioApplicationService,
  radioMigrations,
} from '../src/modules/radios/index.js';
import {
  IdentityService,
  SqlIdentityRepository,
  createArgon2idHasher,
  identityMigrations,
} from '../src/modules/identity/index.js';

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('radio configuration on real PostgreSQL', () => {
  const schema = `sd_radios_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: url });
  let database: PostgresDatabase;
  const services: RadioApplicationService[] = [];
  const revoked = new Set<string>();
  const users = new Map<string, Principal>();
  const instanceId = crypto.randomUUID(),
    otherInstanceId = crypto.randomUUID(),
    radioId = crypto.randomUUID(),
    otherRadioId = crypto.randomUUID();
  const administrator: Principal = {
    instanceId,
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    username: 'admin',
    role: 'administrator',
    radioPermissions: [],
  };
  const operator: Principal = {
    instanceId,
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    username: 'operator',
    role: 'operator',
    radioPermissions: [
      { radioId, permissions: ['radio.listen', 'radio.control'] },
    ],
  };
  const auth: AuthenticationPort = {
    async authenticate(token) {
      const user = users.get(token);
      if (!user || revoked.has(user.sessionId))
        throw new SignalDockError('UNAUTHORIZED', 'Revoked session.');
      return user;
    },
    async authorize(principal, permission, id) {
      if (revoked.has(principal.sessionId))
        throw new SignalDockError('UNAUTHORIZED', 'Revoked session.');
      if (permission === 'instance.admin' && principal.role === 'administrator')
        return;
      if (
        !principal.radioPermissions.some(
          (entry) =>
            entry.radioId === id && entry.permissions.includes(permission),
        )
      )
        throw new SignalDockError(
          'FORBIDDEN',
          'Explicit radio permission required.',
        );
    },
  };
  const configuration: RadioConfiguration = {
    radioId,
    displayName: 'Persisted transceiver',
    driverId: 'simulator.tunable',
    resourceGroupIds: [],
    enabled: true,
    config: {},
  };
  async function createService(instance = instanceId) {
    const service = new RadioApplicationService({
      instanceId: instance,
      database,
      auth,
    });
    services.push(service);
    await service.start();
    return service;
  }
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    database = new PostgresDatabase({
      connectionString: url,
      options: `-c search_path=${schema},public`,
    });
    await migrate(database, [...identityMigrations, ...radioMigrations]);
    users.set('operator', operator);
  });
  afterAll(async () => {
    await Promise.all(services.map((service) => service.close()));
    await database?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  it('persists configuration and grants no operating permissions to the configuring administrator', async () => {
    const service = await createService();
    await service.configure(administrator, configuration);
    expect(await service.list(administrator)).toEqual([]);
    await expect(
      service.acquireControl(administrator, radioId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await service.listConfigurations(administrator)).toEqual([
      configuration,
    ]);
    const restarted = await createService();
    expect((await restarted.get(operator, radioId)).snapshot?.connection).toBe(
      'ready',
    );
    const stored = await database.query<{ id: string; configuration: unknown }>(
      'SELECT id,configuration FROM sd_radios WHERE instance_id=$1',
      [instanceId],
    );
    expect(stored.rows).toEqual([{ id: radioId, configuration: {} }]);
  });
  it('keeps colliding radio IDs isolated between instances and rejects cross-instance principals', async () => {
    const service = await createService(otherInstanceId);
    const otherAdmin = { ...administrator, instanceId: otherInstanceId };
    await service.configure(otherAdmin, {
      ...configuration,
      displayName: 'Other instance transceiver',
    });
    expect((await service.listConfigurations(otherAdmin))[0]?.displayName).toBe(
      'Other instance transceiver',
    );
    await expect(
      service.listConfigurations(administrator),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const original = await createService();
    expect(
      (await original.listConfigurations(administrator))[0]?.displayName,
    ).toBe(configuration.displayName);
    expect(
      (await database.query('SELECT id FROM sd_radios WHERE id=$1', [radioId]))
        .rows,
    ).toHaveLength(2);
  });
  it('stores credential references, rejects nested inline secrets, and masks configuration in operational views', async () => {
    const service = await createService();
    await expect(
      service.configure(administrator, {
        ...configuration,
        config: { nested: { apiKey: 'never-store-me' } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await service.configure(administrator, {
      ...configuration,
      endpoint: 'unix:/private/connector.sock',
      config: { credentialRef: 'vault:radio-test' },
    });
    const view = await service.get(operator, radioId);
    expect(view).not.toHaveProperty('endpoint');
    expect(view).not.toHaveProperty('config');
    expect(JSON.stringify(view)).not.toContain('vault:radio-test');
    const stored = await database.query<{
      configuration: Record<string, string>;
    }>('SELECT configuration FROM sd_radios WHERE instance_id=$1 AND id=$2', [
      instanceId,
      radioId,
    ]);
    expect(stored.rows[0]?.configuration).toEqual({
      credentialRef: 'vault:radio-test',
    });
  });
  it('enforces radio scope, invalidates revoked session grants, and prevents the revoked principal from reacquiring', async () => {
    const service = await createService();
    await service.configure(administrator, {
      ...configuration,
      radioId: otherRadioId,
      displayName: 'Unassigned receiver',
      driverId: 'simulator.receiver',
    });
    expect(
      (await service.list(operator)).map((entry) => entry.radioId),
    ).toEqual([radioId]);
    await expect(service.get(operator, otherRadioId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      service.acquireControl(operator, otherRadioId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const lease = await service.acquireControl(operator, radioId);
    revoked.add(operator.sessionId);
    service.runtime.revokeSession(operator.sessionId);
    expect(service.runtime.currentControl(radioId)).toBeNull();
    await expect(auth.authenticate('operator')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      service.renewControl(operator, radioId, lease.grantId, lease.generation),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      service.acquireControl(operator, radioId),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('uses persisted identity sessions and revocation callbacks to fence an existing operator grant', async () => {
    const identityInstance = crypto.randomUUID();
    const configuredRadio = crypto.randomUUID();
    let radioService: RadioApplicationService;
    const identity = new IdentityService({
      instanceId: identityInstance,
      repository: new SqlIdentityRepository(database, identityInstance),
      passwords: createArgon2idHasher(),
      setupToken: 'isolated-radio-setup-token-for-test',
      onAccessRevoked: async (event) => {
        for (const sessionId of event.sessionIds)
          radioService.runtime.revokeSession(sessionId);
      },
    });
    await identity.bootstrap({
      setupToken: 'isolated-radio-setup-token-for-test',
      username: 'Admin',
      password: 'long isolated password 1234',
    });
    const adminTokens = await identity.login({
      username: 'admin',
      password: 'long isolated password 1234',
      sessionMode: 'token',
    });
    const owner = await identity.authenticate(adminTokens.accessToken);
    radioService = new RadioApplicationService({
      instanceId: identityInstance,
      database,
      auth: identity,
    });
    services.push(radioService);
    await radioService.start();
    await radioService.configure(owner, {
      ...configuration,
      radioId: configuredRadio,
    });
    expect(await radioService.list(owner)).toEqual([]);
    await expect(
      radioService.acquireControl(owner, configuredRadio),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const user = await identity.createUser(owner, {
      username: 'operator',
      password: 'long isolated password 5678',
      role: 'operator',
      radioPermissions: [
        {
          radioId: configuredRadio,
          permissions: ['radio.listen', 'radio.control'],
        },
      ],
    });
    const tokens = await identity.login({
      username: 'operator',
      password: 'long isolated password 5678',
      sessionMode: 'token',
    });
    const authenticated = await identity.authenticate(tokens.accessToken);
    expect(
      (await radioService.list(authenticated)).map((entry) => entry.radioId),
    ).toEqual([configuredRadio]);
    const grant = await radioService.acquireControl(
      authenticated,
      configuredRadio,
    );
    await identity.revokeUserSessions(owner, user.id);
    expect(radioService.runtime.currentControl(configuredRadio)).toBeNull();
    await expect(
      identity.authenticate(tokens.accessToken),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      radioService.renewControl(
        authenticated,
        configuredRadio,
        grant.grantId,
        grant.generation,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
