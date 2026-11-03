import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InstalledDriverSchema,
  SignalDockError,
  type AuthenticationPort,
  type DatabasePort,
  type InstalledDriver,
  type Principal,
} from '@signaldock/contracts';
import { simulationDescriptors } from '@signaldock/radio-driver-sdk';
import {
  GRPC_DRIVER_CONFIG_SCHEMA,
  InstalledDriverRegistry,
  OPEN_CONFIG_SCHEMA,
  RadioApplicationService,
  createGrpcDriverFactory,
  createSimulatorRegistry,
  registerRadioRoutes,
  type InstalledDriverMetadata,
} from '../src/modules/radios/index.js';
import { configureHttp } from '../src/shared/http/configure-http.js';

const instanceId = crypto.randomUUID();
const administrator: Principal = {
  instanceId,
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  username: 'admin',
  role: 'administrator',
  radioPermissions: [],
};
const operator: Principal = {
  ...administrator,
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  username: 'operator',
  role: 'operator',
  radioPermissions: [
    {
      radioId: crypto.randomUUID(),
      permissions: ['radio.listen', 'radio.control', 'radio.configure'],
    },
  ],
};
const sessions: Record<string, Principal> = {
  'admin-session': administrator,
  'operator-session': operator,
};
const auth: AuthenticationPort = {
  async authenticate(token) {
    const principal = sessions[token];
    if (!principal)
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
/** No configuration is persisted by these tests; listing returns nothing. */
const emptyDatabase: DatabasePort = {
  async query<T extends Record<string, unknown>>() {
    return { rows: [] as T[], rowCount: 0 };
  },
  async transaction<T>(work: (database: DatabasePort) => Promise<T>) {
    return work(emptyDatabase);
  },
};
const grpcMetadata: InstalledDriverMetadata = {
  displayName: 'Bench gRPC driver',
  description: 'Private driver service used by this test.',
  transport: 'grpc',
  requiresEndpoint: true,
  verification: 'experimental',
  capabilitiesSummary: {
    rxAudio: true,
    txAudio: false,
    memories: true,
    tuningWritable: false,
    modes: ['FM'],
  },
  configSchema: GRPC_DRIVER_CONFIG_SCHEMA,
};

const active: RadioApplicationService[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((service) => service.close()));
});

describe('installed driver registry', () => {
  it('describes every simulator from its simulation descriptor', () => {
    const drivers = createSimulatorRegistry().list();
    const templates = simulationDescriptors();
    expect(drivers.map((driver) => driver.driverId)).toEqual(
      templates.map((template) => template.driverId),
    );
    for (const [index, driver] of drivers.entries()) {
      const template = templates[index]!;
      expect(InstalledDriverSchema.parse(driver)).toEqual(driver);
      expect(driver).toMatchObject({
        displayName: template.displayName,
        transport: 'simulator',
        requiresEndpoint: false,
        verification: 'simulated',
        capabilitiesSummary: {
          rxAudio: template.capabilities.rxAudio,
          txAudio: template.capabilities.txAudio,
          memories: Boolean(template.capabilities.memories?.read),
          tuningWritable: template.capabilities.tuning.writable,
          modes: template.capabilities.tuning.modes,
        },
      });
      expect(driver.configSchema.type).toBe('object');
      expect(Object.keys(driver.configSchema.properties ?? {})).toEqual([
        'memories',
      ]);
    }
    expect(drivers[0]?.description).toContain('144–148 MHz');
  });

  it('keeps validated metadata, gives undescribed drivers an open schema and copies on read', () => {
    const registry = new InstalledDriverRegistry();
    const factory = createGrpcDriverFactory();
    registry.register('bench.grpc', factory, grpcMetadata);
    registry.register('bench.plain', factory);
    const [described, plain] = registry.list();
    expect(described).toEqual({ ...grpcMetadata, driverId: 'bench.grpc' });
    expect(plain).toMatchObject({
      driverId: 'bench.plain',
      displayName: 'bench.plain',
      transport: 'other',
      configSchema: OPEN_CONFIG_SCHEMA,
    });
    described!.capabilitiesSummary.modes.push('AM');
    expect(registry.list()[0]?.capabilitiesSummary.modes).toEqual(['FM']);
    expect(() =>
      registry.register('bench.invalid', factory, {
        ...grpcMetadata,
        configSchema: { type: 'array' } as never,
      }),
    ).toThrow();
    expect(registry.list().map((driver) => driver.driverId)).toEqual([
      'bench.grpc',
      'bench.plain',
    ]);
    expect(() => registry.register('bench.grpc', factory)).toThrow(
      SignalDockError,
    );
  });

  it('describes only the settings the gRPC factory actually reads', () => {
    expect(Object.keys(GRPC_DRIVER_CONFIG_SCHEMA.properties ?? {})).toEqual([
      'credentialRef',
      'connectTimeoutMs',
    ]);
    expect(
      GRPC_DRIVER_CONFIG_SCHEMA.properties?.['credentialRef'],
    ).toMatchObject({ type: 'string', 'x-credential-ref': true });
    expect(
      GRPC_DRIVER_CONFIG_SCHEMA.properties?.['connectTimeoutMs'],
    ).toMatchObject({ type: 'integer', minimum: 1, maximum: 30000 });
  });
});

describe('GET radios/drivers', () => {
  async function app(installedDrivers?: () => readonly InstalledDriver[]) {
    const service = new RadioApplicationService({
      instanceId,
      database: emptyDatabase,
      auth,
      ...(installedDrivers ? { installedDrivers } : {}),
    });
    active.push(service);
    await service.start();
    const server = Fastify();
    configureHttp(server);
    registerRadioRoutes(server, { prefix: '/api/v1', auth, service });
    return server;
  }

  it('requires authentication and the same administrator permission as configurations', async () => {
    const server = await app();
    try {
      expect(
        (await server.inject({ url: '/api/v1/radios/drivers' })).statusCode,
      ).toBe(401);
      const forbidden = await server.inject({
        url: '/api/v1/radios/drivers',
        headers: { authorization: 'Bearer operator-session' },
      });
      expect(forbidden.statusCode).toBe(403);
      const configurations = await server.inject({
        url: '/api/v1/radios/configurations',
        headers: { authorization: 'Bearer operator-session' },
      });
      expect(configurations.statusCode).toBe(forbidden.statusCode);
      await expect(
        server.inject({
          url: '/api/v1/radios/drivers',
          headers: { authorization: 'Bearer admin-session' },
        }),
      ).resolves.toMatchObject({ statusCode: 200 });
      const otherInstance = {
        ...administrator,
        instanceId: crypto.randomUUID(),
      };
      sessions['foreign-session'] = otherInstance;
      expect(
        (
          await server.inject({
            url: '/api/v1/radios/drivers',
            headers: { authorization: 'Bearer foreign-session' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      delete sessions['foreign-session'];
      await server.close();
    }
  });

  it('returns installed drivers in the contract shape without secrets', async () => {
    const registry = createSimulatorRegistry();
    registry.register(
      'bench.grpc',
      createGrpcDriverFactory({
        resolveCredential: async () => 'never-exposed-token',
      }),
      grpcMetadata,
    );
    const server = await app(() => registry.list());
    try {
      const response = await server.inject({
        url: '/api/v1/radios/drivers',
        headers: { authorization: 'Bearer admin-session' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as unknown[];
      const drivers = body.map((entry) => InstalledDriverSchema.parse(entry));
      expect(drivers.map((driver) => driver.driverId)).toEqual([
        'simulator.tunable',
        'simulator.receiver',
        'bench.grpc',
      ]);
      expect(drivers[2]).toMatchObject({
        transport: 'grpc',
        requiresEndpoint: true,
        configSchema: { type: 'object' },
      });
      expect(response.body).not.toContain('never-exposed-token');
    } finally {
      await server.close();
    }
  });

  it('defaults to the simulator registry when no driver list is injected', async () => {
    const server = await app();
    try {
      const response = await server.inject({
        url: '/api/v1/radios/drivers',
        headers: { authorization: 'Bearer admin-session' },
      });
      expect(
        (response.json() as InstalledDriver[]).map((driver) => driver.driverId),
      ).toEqual(['simulator.tunable', 'simulator.receiver']);
    } finally {
      await server.close();
    }
  });
});
