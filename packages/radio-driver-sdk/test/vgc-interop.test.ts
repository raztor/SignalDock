import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { create } from '@bufbuild/protobuf';
import { GrpcRadioDriver, simulationDescriptors } from '../src/index.js';
import { TxAudioRequestSchema } from '../src/generated/signaldock/driver/v1/driver_pb.js';

const python = process.env['SIGNALDOCK_VGC_PYTHON'];
const root = resolve(process.env['SIGNALDOCK_VGC_ROOT'] ?? '.');
const fixture = resolve(
  root,
  'services/drivers/vgc-benlink/test/rpc_fixture.py',
);

/** Runs the production VGC RPC implementation with synthetic Control/Audio only. */
describe.skipIf(!python || !existsSync(fixture))(
  'production VGC service over authenticated Unix gRPC (synthetic hardware)',
  () => {
    const radioId = crypto.randomUUID();
    const token = 'fixture-driver-token-with-at-least-32-characters';
    let directory: string;
    let processHandle: ChildProcessWithoutNullStreams;
    let driver: GrpcRadioDriver;
    let endpoint: string;
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'sd-vgc-wire-'));
      processHandle = spawn(
        python!,
        [
          fixture,
          '--socket',
          join(directory, 'driver.sock'),
          '--radio-id',
          radioId,
          '--token',
          token,
        ],
        {
          env: {
            ...process.env,
            PYTHONPATH: [
              resolve(root, 'services/drivers/vgc-benlink/src'),
              process.env['SIGNALDOCK_VGC_PYTHONPATH'],
            ]
              .filter(Boolean)
              .join(':'),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      endpoint = await new Promise<string>((resolveEndpoint, reject) => {
        let output = '';
        let errors = '';
        const timer = setTimeout(
          () =>
            reject(new Error(`VGC RPC fixture startup timed out: ${errors}`)),
          5000,
        );
        processHandle.stderr.on('data', (chunk: Buffer) => {
          errors += chunk.toString();
        });
        processHandle.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`VGC RPC fixture exited ${code}: ${errors}`));
        });
        processHandle.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        processHandle.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (!output.includes('\n')) return;
          clearTimeout(timer);
          try {
            resolveEndpoint(
              (JSON.parse(output.split('\n')[0]!) as { endpoint: string })
                .endpoint,
            );
          } catch (error) {
            reject(error);
          }
        });
      });
      driver = new GrpcRadioDriver({
        descriptor: {
          ...simulationDescriptors()[0]!,
          radioId,
          driverId: 'vgc-benlink',
        },
        endpoint,
        token,
      });
    });
    afterAll(async () => {
      if (driver) {
        try {
          await driver.disconnect();
        } catch {
          /* Transport teardown still closes the channel. */
        }
        driver.close();
      }
      processHandle?.kill('SIGTERM');
      if (processHandle && processHandle.exitCode === null)
        await once(processHandle, 'exit');
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    it('discovers capabilities, reads memories, tunes and ends a correctly attributed PCM transmission', async () => {
      let snapshot = await driver.connect();
      expect(driver.descriptor.driverId).toBe('vgc-benlink');
      expect(driver.descriptor.capabilities.ptt).toBe('audio_coupled');
      expect(
        (await driver.listMemories()).map((memory) => memory.memoryId),
      ).toContain('9');
      const ownerId = crypto.randomUUID(),
        sessionId = crypto.randomUUID(),
        controlGrant = crypto.randomUUID();
      const operation = () => ({
        operationId: crypto.randomUUID(),
        radioId,
        generation: snapshot.generation,
        expectedRevision: snapshot.revision,
        controlGrant,
        fencing: 1,
        ownerId,
        sessionId,
        deadline: new Date(Date.now() + 5000).toISOString(),
      });
      snapshot = await driver.applyTuning({
        context: operation(),
        tuning: { rxHz: 146550000, txHz: 146550000, mode: 'FM' },
      });
      expect(snapshot.observedTuning?.rxHz).toBe(146550000);
      const txGrantId = crypto.randomUUID();
      const context = operation();
      const prepared = await driver.prepareTransmission({
        context: {
          operationId: context.operationId,
          radioId,
          generation: snapshot.generation,
          expectedRevision: BigInt(snapshot.revision),
          deadlineUtc: context.deadline,
          controlGrant,
          fencing: 1n,
          ownerId,
          sessionId,
        },
        txGrantId,
        expiresAtUtc: new Date(Date.now() + 3000).toISOString(),
        maxUntilUtc: new Date(Date.now() + 5000).toISOString(),
        fencing: 1n,
        format: { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
      });
      expect(prepared.txGrantId).toBe(txGrantId);
      async function* frames() {
        yield create(TxAudioRequestSchema, {
          radioId,
          generation: snapshot.generation,
          txGrantId,
          fencing: 1n,
          frame: {
            streamId: 'fixture-pcm',
            sequence: 0n,
            mediaTimeUs: 0n,
            payload: new Uint8Array(1280),
            tuningRevision: BigInt(snapshot.revision),
            attributionConfidence: 'confirmed',
            format: { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
          },
        });
      }
      const ended = await driver.pushTxAudio(frames());
      expect(ended.state).toBe('idle');
      const observed = await driver.observeTransmission({
        radioId,
        generation: snapshot.generation,
        txGrantId,
      });
      expect(observed.state).toBe('idle');
      expect(observed.physicallyConfirmed).toBe(true);
    });
    it('establishes a new idle-confirmed controller epoch after a backend crash while the driver stays ready', async () => {
      const old = await driver.reconcile();
      const command = (
        snapshot: ReturnType<GrpcRadioDriver['getSnapshot']>,
        fencing: number,
      ) => ({
        context: {
          operationId: crypto.randomUUID(),
          radioId,
          generation: snapshot.generation,
          expectedRevision: snapshot.revision,
          controlGrant: crypto.randomUUID(),
          ownerId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          fencing,
          deadline: new Date(Date.now() + 5000).toISOString(),
        },
        tuning: { rxHz: 146562500, txHz: 146562500, mode: 'FM' as const },
      });
      const retained = await driver.applyTuning(command(old, 5));
      driver.close(); // Simulate process loss: no Disconnect was sent to the running service.
      driver = new GrpcRadioDriver({
        descriptor: {
          ...simulationDescriptors()[0]!,
          radioId,
          driverId: 'vgc-benlink',
        },
        endpoint,
        token,
      });
      const existing = await driver.connect();
      expect(existing.generation).toBe(retained.generation);
      await expect(
        driver.applyTuning(command(existing, 1)),
      ).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
      const recovered = await driver.establishSession();
      expect(recovered.generation).not.toBe(retained.generation);
      expect(recovered.txState).toBe('idle');
      expect(
        (await driver.applyTuning(command(recovered, 1))).observedTuning?.rxHz,
      ).toBe(146562500);
    });
  },
);
