import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
  GrpcRadioDriver,
  decodeSnapshot,
  simulationDescriptors,
} from '../src/index.js';
import { RadioSnapshotSchema as WireSnapshotSchema } from '../src/generated/signaldock/driver/v1/driver_pb.js';
import { SignalDockError } from '@signaldock/contracts';

const python =
  process.env['SIGNALDOCK_CODEGEN_PYTHON'] ??
  resolve('.venv-codegen/bin/python');
const descriptor = () => ({
  ...simulationDescriptors()[0]!,
  driverId: 'fixture.grpc',
});
describe('private driver transport configuration', () => {
  it('bounds the distinct connection timeout', () => {
    for (const connectTimeoutMs of [0, 30001, Number.NaN, 1.5])
      expect(
        () =>
          new GrpcRadioDriver({
            descriptor: descriptor(),
            endpoint: 'unix:/private/tmp/unused-timeout-fixture.sock',
            connectTimeoutMs,
          }),
      ).toThrow('connection timeout');
  });
  it('does not reconnect or admit a new controller when idle-confirmed disconnect fails', async () => {
    const driver = new GrpcRadioDriver({
      descriptor: descriptor(),
      endpoint: 'unix:/private/tmp/unused-recovery-fixture.sock',
    });
    const stop = vi
      .spyOn(driver, 'disconnect')
      .mockRejectedValue(
        new SignalDockError(
          'RADIO_STATE_UNCERTAIN',
          'Physical carrier stop is unconfirmed.',
        ),
      );
    const connect = vi.spyOn(driver, 'connect');
    try {
      await expect(driver.establishSession()).rejects.toMatchObject({
        code: 'RADIO_STATE_UNCERTAIN',
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(connect).not.toHaveBeenCalled();
      expect(driver.getSnapshot().connection).toBe('degraded');
    } finally {
      driver.close();
    }
  });
  it('refuses startup admission when reconnect readback is not physically idle', async () => {
    const driver = new GrpcRadioDriver({
      descriptor: descriptor(),
      endpoint: 'unix:/private/tmp/unused-recovery-fixture.sock',
    });
    const state = {
      ...driver.getSnapshot(),
      connection: 'ready' as const,
      txState: 'stop_unconfirmed' as const,
    };
    vi.spyOn(driver, 'disconnect').mockResolvedValue();
    vi.spyOn(driver, 'connect').mockResolvedValue(state);
    vi.spyOn(driver, 'reconcile').mockResolvedValue(state);
    try {
      await expect(driver.establishSession()).rejects.toMatchObject({
        code: 'RADIO_STATE_UNCERTAIN',
      });
      expect(driver.getSnapshot().connection).toBe('degraded');
    } finally {
      driver.close();
    }
  });
  it('requires authentication and TLS for remote endpoints', () => {
    expect(
      () =>
        new GrpcRadioDriver({
          descriptor: descriptor(),
          endpoint: 'radio.example:50051',
        }),
    ).toThrow('authenticated TLS');
    expect(
      () =>
        new GrpcRadioDriver({
          descriptor: descriptor(),
          endpoint: 'unix:relative.sock',
        }),
    ).toThrow('absolute path');
  });
  it('rejects driver integers that cannot be represented exactly by domain models', () => {
    const wire = create(WireSnapshotSchema, {
      radioId: descriptor().radioId,
      generation: crypto.randomUUID(),
      revision: 9007199254740993n,
      connection: 'ready',
      tuningConfidence: 'unknown',
      txState: 'idle',
    });
    expect(() => decodeSnapshot(wire)).toThrow('domain range');
  });
});

describe.skipIf(!existsSync(python))(
  'real Python gRPC driver interoperability',
  () => {
    let processHandle: ChildProcessWithoutNullStreams;
    let driver: GrpcRadioDriver;
    let endpoint: string;
    beforeAll(async () => {
      processHandle = spawn(
        python,
        ['packages/radio-driver-sdk/test/fixtures/python_server.py'],
        {
          env: {
            ...process.env,
            PYTHONPATH: resolve('packages/radio-driver-sdk/generated/python'),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      endpoint = await new Promise<string>((resolveEndpoint, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Python gRPC fixture did not start.')),
          5000,
        );
        let output = '';
        let errors = '';
        processHandle.stderr.on('data', (chunk: Buffer) => {
          errors += chunk.toString();
        });
        processHandle.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Python gRPC fixture exited ${code}: ${errors}`));
        });
        processHandle.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('\n')) {
            clearTimeout(timer);
            try {
              resolveEndpoint(
                (JSON.parse(output.split('\n')[0]!) as { endpoint: string })
                  .endpoint,
              );
            } catch (error) {
              reject(error);
            }
          }
        });
      });
      driver = new GrpcRadioDriver({
        descriptor: descriptor(),
        endpoint,
        token: 'fixture-token',
        allowInsecureLoopback: true,
      });
    });
    afterAll(async () => {
      driver?.close();
      processHandle?.kill('SIGTERM');
      if (processHandle && processHandle.exitCode === null)
        await new Promise<void>((resolveExit) =>
          processHandle.once('exit', () => resolveExit()),
        );
    });
    it('connects and applies a tuning command using generated TS and Python bindings', async () => {
      const before = await driver.connect();
      const after = await driver.applyTuning({
        context: {
          operationId: crypto.randomUUID(),
          radioId: before.radioId,
          generation: before.generation,
          expectedRevision: before.revision,
          controlGrant: crypto.randomUUID(),
          deadline: new Date(Date.now() + 5000).toISOString(),
        },
        tuning: { rxHz: 146000000, mode: 'FM' },
      });

      expect(after.observedTuning?.rxHz).toBe(146000000);
      expect(after.revision).toBe(before.revision + 1);
    });
    it('uses setup deadlines independently of short ordinary-operation deadlines', async () => {
      const bounded = new GrpcRadioDriver({
        descriptor: descriptor(),
        endpoint,
        token: 'fixture-token',
        allowInsecureLoopback: true,
        timeoutMs: 15,
        connectTimeoutMs: 1000,
      });
      try {
        expect((await bounded.establishSession()).connection).toBe('ready');
        await expect(bounded.reconcile()).rejects.toMatchObject({
          code: 'DEADLINE_EXCEEDED',
        });
      } finally {
        bounded.close();
      }
    });
    it('preserves typed driver rejection and rejects expired commands before dispatch', async () => {
      const state = await driver.reconcile();
      const command = {
        context: {
          operationId: crypto.randomUUID(),
          radioId: state.radioId,
          generation: state.generation,
          expectedRevision: 0,
          controlGrant: crypto.randomUUID(),
          deadline: new Date(Date.now() + 5000).toISOString(),
        },
        tuning: { rxHz: 146500000, mode: 'FM' as const },
      };
      await expect(driver.applyTuning(command)).rejects.toMatchObject({
        code: 'STALE_REVISION',
      });
      await expect(
        driver.applyTuning({
          ...command,
          context: { ...command.context, deadline: '2000-01-01T00:00:00Z' },
        }),
      ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
      expect((await driver.reconcile()).revision).toBe(state.revision);
    });
    it('authenticates the private connection and streams state and binary RX frames', async () => {
      const unauthorized = new GrpcRadioDriver({
        descriptor: descriptor(),
        endpoint,
        token: 'wrong-token',
        allowInsecureLoopback: true,
      });
      try {
        await expect(unauthorized.connect()).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
        });
      } finally {
        unauthorized.close();
      }
      for await (const event of driver.watchEvents()) {
        expect(event.radioId).toBe(descriptor().radioId);
        break;
      }
      const frames = [];
      for await (const frame of driver.openRxStream({
        streamId: 'fixture-stream',
        generation: driver.getSnapshot().generation,
      }))
        frames.push(frame);
      expect(frames).toHaveLength(3);
      expect(Array.from(frames[0]!.payload)).toEqual([0, 128, 255, 64]);
    });
  },
);
