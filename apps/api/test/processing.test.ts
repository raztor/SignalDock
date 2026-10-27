import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  SignalDockError,
  type AuthPort,
  type Principal,
} from '@signaldock/contracts';
import type { ProcessingRuntime } from '@signaldock/processing-connectors';
import {
  registerProcessingRoutes,
  type PreparedSpeechTransmitter,
} from '../src/modules/processing/processing.routes.js';
import { configureHttp } from '../src/shared/http/configure-http.js';

const actor: Principal = {
  instanceId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  username: 'operator',
  role: 'administrator',
  radioPermissions: [],
};
describe('processing API boundary', () => {
  it('requires authentication at a deployment prefix and rejects malformed secret imports', async () => {
    const app = Fastify({ logger: false });
    configureHttp(app);
    const auth: AuthPort = {
      authenticate: async () => actor,
      authorize: vi.fn(async () => undefined),
    };
    const importSubscription = vi.fn();
    const connections = vi.fn(async () => []);
    const processing = {
      connections,
      importSubscription,
    } as unknown as ProcessingRuntime;
    registerProcessingRoutes(app, {
      prefix: '/station/api/v1',
      auth,
      processing,
    });
    try {
      expect(
        (await app.inject('/station/api/v1/processing/connections')).statusCode,
      ).toBe(401);
      expect(connections).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/station/api/v1/processing/connections',
            headers: { authorization: 'Bearer fixture' },
          })
        ).json(),
      ).toEqual({ connections: [] });
      const invalid = await app.inject({
        method: 'POST',
        url: '/station/api/v1/processing/subscriptions/import',
        headers: { authorization: 'Bearer fixture' },
        payload: { accessToken: 'protected-secret' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain('protected-secret');
      expect(importSubscription).not.toHaveBeenCalled();
      expect(
        (await app.inject('/api/v1/processing/connections')).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('passes prepared speech through the injected authorized transmitter and fails closed on stale previews', async () => {
    const app = Fastify({ logger: false });
    configureHttp(app);
    const auth: AuthPort = {
      authenticate: async () => actor,
      authorize: async () => undefined,
    };
    const prepareTransmission = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2]),
      metadata: { contentType: 'audio/wav' },
    }));
    const validatePreparedTransmission = vi.fn(
      async () => 'immutable-artifact',
    );
    const transmitter = vi.fn<PreparedSpeechTransmitter>(
      async (
        _principal,
        _context,
        _artifact,
        _signal,
        validateBeforeTransmit,
      ) => {
        await validateBeforeTransmit();
        return { state: 'idle' };
      },
    );
    registerProcessingRoutes(app, {
      prefix: '/api/v1',
      auth,
      processing: {
        prepareTransmission,
        validatePreparedTransmission,
      } as unknown as ProcessingRuntime,
      transmitPreparedSpeech: transmitter,
    });
    const jobId = crypto.randomUUID();
    const radioId = crypto.randomUUID();
    const payload = {
      radioId,
      generation: crypto.randomUUID(),
      expectedRevision: 4,
      controlGrant: 'short-lived-control-grant',
    };
    try {
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/v1/processing/jobs/${jobId}/transmit`,
        headers: { authorization: 'Bearer fixture' },
        payload,
      });
      expect(accepted.statusCode).toBe(200);
      expect(prepareTransmission).toHaveBeenCalledWith(actor, jobId, radioId);
      expect(transmitter).toHaveBeenCalledWith(
        actor,
        payload,
        { bytes: new Uint8Array([1, 2]), contentType: 'audio/wav' },
        expect.any(AbortSignal),
        expect.any(Function),
      );
      prepareTransmission.mockRejectedValueOnce(
        new SignalDockError('STALE_REVISION', 'Preview changed.'),
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/processing/jobs/${jobId}/transmit`,
            headers: { authorization: 'Bearer fixture' },
            payload,
          })
        ).statusCode,
      ).toBe(409);
      expect(transmitter).toHaveBeenCalledOnce();
      validatePreparedTransmission.mockRejectedValueOnce(
        new SignalDockError('STALE_REVISION', 'Preview revoked during decode.'),
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/processing/jobs/${jobId}/transmit`,
            headers: { authorization: 'Bearer fixture' },
            payload,
          })
        ).statusCode,
      ).toBe(409);
      expect(transmitter).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
