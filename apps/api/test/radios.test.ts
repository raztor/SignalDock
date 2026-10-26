import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SignalDockError,
  type AuthenticationPort,
  type DatabasePort,
  type Principal,
  type RadioConfiguration,
  type RadioView,
} from '@signaldock/contracts';
import {
  RadioApplicationService,
  registerRadioRoutes,
} from '../src/modules/radios/index.js';
import { configureHttp } from '../src/shared/http/configure-http.js';

const instanceId = crypto.randomUUID();
const radioId = crypto.randomUUID();
const principal: Principal = {
  instanceId,
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  username: 'operator',
  role: 'administrator',
  radioPermissions: [
    { radioId, permissions: ['radio.listen', 'radio.control'] },
  ],
};
const auth: AuthenticationPort = {
  async authenticate(token) {
    if (token !== 'test-session')
      throw new SignalDockError('UNAUTHORIZED', 'Invalid session.');
    return principal;
  },
  async authorize(user, permission, id) {
    if (permission === 'instance.admin' && user.role === 'administrator')
      return;
    if (
      !user.radioPermissions.some(
        (entry) =>
          entry.radioId === id && entry.permissions.includes(permission),
      )
    )
      throw new SignalDockError('FORBIDDEN', 'Permission required.');
  },
};
/** Test fixture implements only the parameterized queries used by RadioRepository. */
class FixtureDatabase implements DatabasePort {
  readonly rows: Record<string, unknown>[] = [];
  async query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ) {
    if (sql.startsWith('INSERT')) {
      const [instance, id, name, driver, endpoint, config, groups, enabled] =
        values;
      const row = {
        instance_id: instance,
        id,
        display_name: name,
        driver_id: driver,
        endpoint,
        configuration: JSON.parse(String(config)),
        resource_group_ids: JSON.parse(String(groups)),
        enabled,
      };
      const index = this.rows.findIndex(
        (entry) => entry['instance_id'] === instance && entry['id'] === id,
      );
      if (index < 0) this.rows.push(row);
      else this.rows[index] = row;
      return { rows: [] as T[], rowCount: 1 };
    }
    return {
      rows: this.rows.filter(
        (entry) => entry['instance_id'] === values[0],
      ) as T[],
      rowCount: this.rows.length,
    };
  }
  async transaction<T>(
    work: (database: DatabasePort) => Promise<T>,
  ): Promise<T> {
    return work(this);
  }
}
const active: RadioApplicationService[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((service) => service.close()));
});
async function service(database: DatabasePort = new FixtureDatabase()) {
  const result = new RadioApplicationService({ instanceId, database, auth });
  active.push(result);
  await result.start();
  return result;
}
const configuration: RadioConfiguration = {
  radioId,
  displayName: 'Test transceiver',
  driverId: 'simulator.tunable',
  resourceGroupIds: [],
  enabled: true,
  config: {},
};
describe('persisted radio administration and scoped APIs', () => {
  it('starts empty, persists explicit configuration and reloads across service restart', async () => {
    const database = new FixtureDatabase();
    const first = await service(database);
    expect(await first.list(principal)).toEqual([]);
    await first.configure(principal, configuration);
    await vi.waitFor(async () =>
      expect((await first.get(principal, radioId)).snapshot?.connection).toBe(
        'ready',
      ),
    );
    expect((await first.list(principal))[0]?.snapshot?.connection).toBe(
      'ready',
    );
    const second = await service(database);
    expect((await second.listConfigurations(principal))[0]).toEqual(
      configuration,
    );
    expect(await second.list({ ...principal, radioPermissions: [] })).toEqual(
      [],
    );
    await expect(
      second.list({ ...principal, instanceId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects inline credentials and exposes failed installed-driver configuration without private transport details', async () => {
    const app = await service();
    await expect(
      app.configure(principal, {
        ...configuration,
        config: { token: 'secret' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await app.configure(principal, {
      ...configuration,
      driverId: 'unknown.driver',
      endpoint: 'unix:/private/radio.sock',
    });
    const view = await app.get(principal, radioId);
    await vi.waitFor(async () =>
      expect((await app.get(principal, radioId)).health.state).toBe('failed'),
    );
    expect(view).not.toHaveProperty('endpoint');
    expect(view).not.toHaveProperty('config');
  });
  it('authenticates routes, scopes grants to sessions, rejects stale/routed contexts and applies tuning', async () => {
    const domain = await service();
    await domain.configure(principal, configuration);
    await vi.waitFor(async () =>
      expect((await domain.get(principal, radioId)).snapshot?.connection).toBe(
        'ready',
      ),
    );
    const app = Fastify();
    configureHttp(app);
    registerRadioRoutes(app, { prefix: '/api/v1', auth, service: domain });
    try {
      expect((await app.inject({ url: '/api/v1/radios' })).statusCode).toBe(
        401,
      );
      const headers = { authorization: 'Bearer test-session' };
      const listing = await app.inject({ url: '/api/v1/radios', headers });
      const radio = (listing.json() as RadioView[])[0]!;
      const leaseResponse = await app.inject({
        method: 'POST',
        url: `/api/v1/radios/${radioId}/control`,
        headers,
      });
      expect(leaseResponse.statusCode).toBe(201);
      const lease = leaseResponse.json() as {
        grantId: string;
        fencing: number;
      };
      await expect(
        domain.acquireControl(
          { ...principal, sessionId: crypto.randomUUID() },
          radioId,
        ),
      ).rejects.toMatchObject({ code: 'CONTROL_BUSY' });
      const context = {
        operationId: crypto.randomUUID(),
        radioId,
        generation: radio.snapshot!.generation,
        expectedRevision: radio.snapshot!.revision,
        controlGrant: lease.grantId,
        fencing: lease.fencing,
        deadline: new Date(Date.now() + 5000).toISOString(),
      };
      const payload = { context, tuning: { rxHz: 146000000, mode: 'FM' } };
      const changed = await app.inject({
        method: 'POST',
        url: `/api/v1/radios/${radioId}/operations`,
        headers,
        payload,
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().observedTuning.rxHz).toBe(146000000);
      const repeated = await app.inject({
        method: 'POST',
        url: `/api/v1/radios/${radioId}/operations`,
        headers,
        payload,
      });
      expect(repeated.json()).toEqual(changed.json());
      const stale = await app.inject({
        method: 'POST',
        url: `/api/v1/radios/${radioId}/operations`,
        headers,
        payload: {
          ...payload,
          context: { ...context, operationId: crypto.randomUUID() },
        },
      });
      expect(stale.json().code).toBe('STALE_REVISION');
      const mismatch = await app.inject({
        method: 'POST',
        url: `/api/v1/radios/${radioId}/operations`,
        headers,
        payload: {
          ...payload,
          context: { ...context, radioId: crypto.randomUUID() },
        },
      });
      expect(mismatch.json().code).toBe('FORBIDDEN');
    } finally {
      await app.close();
    }
  });
});
