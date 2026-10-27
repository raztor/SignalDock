import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type {
  PcmAudioFrame,
  RadioDescriptor,
  RadioSnapshot,
} from '@signaldock/contracts';
import { BoundedAudioQueue, pcmBytes, pcmSamples } from '../src/pcm.js';
import { LiveKitCredentials, radioRoom } from '../src/livekit.js';
import {
  normalizeWireAudio,
  safeWireInteger,
  createGrpcTxDriver,
  type WireRadioAudioClient,
} from '../src/grpc.js';
import { decodePreparedAudio, preparedPcmFrames } from '../src/decode-audio.js';

describe('media boundary', () => {
  it('keeps public browser credentials separate from internal Node and room-service traffic', async () => {
    let route = '';
    const server = createServer((request, response) => {
      route = request.url ?? '';
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener.');
    try {
      const internalServerUrl = `ws://127.0.0.1:${address.port}`;
      const credentials = new LiveKitCredentials({
        serverUrl: 'wss://public-media.example.invalid',
        internalServerUrl,
        apiKey: 'test',
        apiSecret: 'synthetic-secret-for-tests',
      });
      const session = await credentials.issue({
        id: crypto.randomUUID(),
        instanceId: crypto.randomUUID(),
        radioId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        mode: 'listen',
      });
      expect(session.serverUrl).toBe('wss://public-media.example.invalid');
      expect(credentials.bridgeUrl).toBe(`${internalServerUrl}/`);
      await credentials.revoke(session);
      expect(route).toContain('RoomService/RemoveParticipant');
      expect(
        new LiveKitCredentials({
          serverUrl: 'wss://public-media.example.invalid',
          internalServerUrl: 'ws://livekit:7880',
          apiKey: 'test',
          apiSecret: 'synthetic-secret-for-tests',
        }).bridgeUrl,
      ).toBe('ws://livekit:7880/');
      for (const invalid of [
        'https://livekit:7880',
        'ws://user:pass@livekit:7880',
        'ws://livekit:7880?token=bad',
        'ws://livekit:7880#fragment',
      ])
        expect(
          () =>
            new LiveKitCredentials({
              serverUrl: 'wss://public-media.example.invalid',
              internalServerUrl: invalid,
              apiKey: 'test',
              apiSecret: 'synthetic-secret-for-tests',
            }),
        ).toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('uses only capability-declared fresh raw reconciliation for current-epoch idle proof', async () => {
    const radioId = crypto.randomUUID(),
      generation = crypto.randomUUID();
    const raw: RadioSnapshot = {
      radioId,
      generation,
      revision: 1,
      connection: 'ready',
      tuningConfidence: 'unknown',
      txState: 'idle',
    };
    const descriptor = {
      radioId,
      capabilities: { physicalTxObservation: false },
    } as RadioDescriptor;
    const reconcile = vi.fn(async () => raw);
    const client = { descriptor, reconcile } as unknown as WireRadioAudioClient;
    const adapter = createGrpcTxDriver(client);
    expect(
      await adapter.observeCurrent!({ radioId, generation }),
    ).toMatchObject({ state: 'unknown', physicallyConfirmed: false });
    expect(reconcile).not.toHaveBeenCalled();
    descriptor.capabilities.physicalTxObservation = true;
    expect(await adapter.observeCurrent!({ radioId, generation })).toEqual({
      radioId,
      generation,
      state: 'idle',
      physicallyConfirmed: true,
    });
    expect(reconcile).toHaveBeenCalledOnce();
    raw.connection = 'degraded';
    expect(
      await adapter.observeCurrent!({ radioId, generation }),
    ).toMatchObject({ state: 'unknown', physicallyConfirmed: false });
    raw.connection = 'ready';
    raw.generation = crypto.randomUUID();
    await expect(
      adapter.observeCurrent!({ radioId, generation }),
    ).rejects.toMatchObject({ code: 'STALE_GENERATION' });
  });
  it('preserves little-endian samples from a sliced buffer', () => {
    const source = new Uint8Array([55, 66, 0, 128, 255, 127, 255, 255, 77, 88]);
    const frame = {
      format: { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
      data: source.subarray(2, 8),
    } as PcmAudioFrame;
    expect([...pcmSamples(frame)]).toEqual([-32768, 32767, -1]);
    expect([...pcmBytes(pcmSamples(frame))]).toEqual([
      0, 128, 255, 127, 255, 255,
    ]);
  });
  it('fails closed on queued latency and discards unsent audio at release', async () => {
    const queue = new BoundedAudioQueue<number>(2);
    queue.push(1);
    queue.push(2);
    expect(() => queue.push(3)).toThrow();
    queue.close();
    expect(await queue[Symbol.asyncIterator]().next()).toEqual({
      value: undefined,
      done: true,
    });
    expect(() => queue.push(4)).toThrow();
  });
  it('rejects unsafe wire timestamps rather than rounding destination context', () => {
    expect(() => safeWireInteger(9007199254740992n, 'timestamp')).toThrow();
    expect(() => safeWireInteger(-1n, 'sequence')).toThrow();
    expect(() =>
      normalizeWireAudio({
        sequence: 0n,
        mediaTimeUs: 0n,
        tuningRevision: 1n,
        payload: new Uint8Array(2),
      } as never),
    ).toThrow();
  });
  it('issues short per-radio credentials with separate listen and microphone scopes', async () => {
    const credentials = new LiveKitCredentials({
      serverUrl: 'ws://127.0.0.1:7885',
      apiKey: 'test',
      apiSecret: 'synthetic-secret-for-tests',
    });
    const instanceId = crypto.randomUUID(),
      radioId = crypto.randomUUID(),
      sessionId = crypto.randomUUID();
    const listen = await credentials.issue({
      id: crypto.randomUUID(),
      instanceId,
      radioId,
      sessionId,
      mode: 'listen',
    });
    const tx = await credentials.issue({
      id: crypto.randomUUID(),
      instanceId,
      radioId,
      sessionId,
      mode: 'transmit',
    });
    const claims = (token: string) =>
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
        video: {
          room: string;
          canPublish: boolean;
          canSubscribe: boolean;
          canPublishData: boolean;
          canPublishSources: string[];
        };
        exp: number;
        nbf: number;
      };
    expect(claims(listen.token).video).toMatchObject({
      room: radioRoom(instanceId, radioId),
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(claims(tx.token).video).toMatchObject({
      canPublish: true,
      canSubscribe: false,
      canPublishSources: ['microphone'],
    });
    expect(claims(tx.token).exp - claims(tx.token).nbf).toBeLessThanOrEqual(60);
    expect(radioRoom(instanceId, crypto.randomUUID())).not.toBe(
      radioRoom(instanceId, radioId),
    );
    expect(
      () =>
        new LiveKitCredentials({
          serverUrl: 'ws://192.0.2.1',
          apiKey: 'test',
          apiSecret: 'synthetic-secret-for-tests',
        }),
    ).toThrow();
  });
});

function wav(): Uint8Array {
  const samples = 1440;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(
      Math.round(6000 * Math.sin((i * Math.PI) / 12)),
      44 + i * 2,
    );
  return data;
}
describe('prepared audio', () => {
  it('decodes and resamples RIFF24k before creating bounded paced radio frames', async () => {
    const signal = new AbortController().signal;
    const bytes = await decodePreparedAudio(
      { bytes: wav(), contentType: 'audio/wav' },
      signal,
    );
    expect(bytes.length).toBe(3840);
    expect(bytes.subarray(0, 4)).not.toEqual(
      new Uint8Array(Buffer.from('RIFF')),
    );
    const frames = [];
    for await (const frame of preparedPcmFrames(bytes, 17, signal))
      frames.push(frame);
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.mediaTimeUs)).toEqual([0, 20000, 40000]);
    expect(
      frames.every(
        (frame) => frame.data.length === 1280 && frame.tuningRevision === 17,
      ),
    ).toBe(true);
  });
  it('rejects unbounded, malformed and cancelled input before transmission', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    expect(() =>
      decodePreparedAudio(
        { bytes: wav(), contentType: 'audio/wav' },
        controller.signal,
      ),
    ).toThrow('cancelled');
    await expect(
      decodePreparedAudio(
        { bytes: new Uint8Array(4), contentType: 'application/octet-stream' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(
      decodePreparedAudio(
        { bytes: new Uint8Array(4), contentType: 'audio/wav' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
