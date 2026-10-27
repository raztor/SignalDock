import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  FrequencyHzSchema,
  RadioSnapshotEventSchema,
  ServerInfoSchema,
} from '../src/index.js';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { AudioFrameSchema } from '@signaldock/radio-driver-sdk/wire';

describe('shared contract boundaries', () => {
  it('catalogs authenticated optional routes regardless of route filename', async () => {
    const catalog = JSON.parse(
      await readFile(
        new URL('../generated/openapi.json', import.meta.url),
        'utf8',
      ),
    );
    for (const path of [
      '/api/v1/notifications/{id}/foreground',
      '/api/v1/incidents',
      '/api/v1/processing/connections',
    ]) {
      expect(catalog.paths[path]).toBeDefined();
      const operations = Object.values(catalog.paths[path]) as Array<{
        security: unknown;
      }>;
      for (const operation of operations)
        expect(operation.security).toEqual([{ bearerAuth: [] }]);
    }
  });
  it.each([-1, 0, 145.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    'rejects invalid Hz %s',
    (value) => {
      expect(FrequencyHzSchema.safeParse(value).success).toBe(false);
    },
  );
  it('rejects a snapshot routed to another radio', () => {
    const radioId = crypto.randomUUID();
    const generation = crypto.randomUUID();
    expect(
      RadioSnapshotEventSchema.safeParse({
        protocolVersion: 1,
        eventId: crypto.randomUUID(),
        instanceId: crypto.randomUUID(),
        radioId,
        streamGeneration: generation,
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: 'radio.snapshot',
        payloadVersion: 1,
        payload: {
          radioId: crypto.randomUUID(),
          generation,
          revision: 1,
          connection: 'ready',
          tuningConfidence: 'unknown',
          txState: 'idle',
        },
      }).success,
    ).toBe(false);
  });
  it('does not accept an arbitrary credential destination in discovery', () => {
    expect(
      ServerInfoSchema.shape.routes.safeParse({
        api: 'https://other.invalid/api',
        events: 'api/v1/events',
        media: 'api/v1/media',
      }).success,
    ).toBe(false);
  });
  it('preserves binary audio and large media clocks through the generated driver wire format', () => {
    const frame = create(AudioFrameSchema, {
      streamId: crypto.randomUUID(),
      sequence: 12n,
      mediaTimeUs: 9007199254740993n,
      payload: new Uint8Array([0, 128, 255]),
      tuningRevision: 4n,
      attributionConfidence: 'unknown',
      discontinuity: true,
      format: { sampleRateHz: 32000, channels: 1, encoding: 'pcm_s16le' },
    });
    const decoded = fromBinary(
      AudioFrameSchema,
      toBinary(AudioFrameSchema, frame),
    );
    expect(decoded.mediaTimeUs).toBe(9007199254740993n);
    expect(decoded.payload).toEqual(frame.payload);
    expect(decoded.discontinuity).toBe(true);
  });
});
