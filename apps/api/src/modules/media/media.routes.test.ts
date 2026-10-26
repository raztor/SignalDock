import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  SignalDockError,
  type AuthenticationPort,
  type Principal,
} from '@signaldock/contracts';
import type { MediaService } from '@signaldock/media-gateway';
import { registerMediaRoutes } from './media.routes.js';

function fixture() {
  const principal: Principal = {
    instanceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    username: 'operator',
    role: 'operator',
    radioPermissions: [],
  };
  const radioId = crypto.randomUUID(),
    id = crypto.randomUUID();
  let denied = false;
  const auth: AuthenticationPort = {
    authenticate: async (token) => {
      if (token !== 'valid')
        throw new SignalDockError('UNAUTHORIZED', 'Invalid token.');
      return principal;
    },
    authorize: async () => {
      if (denied) throw new SignalDockError('FORBIDDEN', 'Permission revoked.');
    },
  };
  const stopTx = vi.fn(async () => ({ state: 'idle' }));
  const startTx = vi.fn();
  const media = {
    startTx,
    stopTx,
    txStatus: () => ({ grant: { radioId } }),
  } as unknown as MediaService;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as SignalDockError;
    reply
      .code(
        failure.code === 'UNAUTHORIZED'
          ? 401
          : failure.code === 'FORBIDDEN'
            ? 403
            : 400,
      )
      .send({ code: failure.code });
  });
  registerMediaRoutes(app, '/api/v1', { auth, media });
  return {
    app,
    radioId,
    id,
    stopTx,
    startTx,
    deny: () => {
      denied = true;
    },
  };
}
describe('media admission routes', () => {
  it('requires authentication for every TX operation', async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/radios/${f.radioId}/tx-sessions/${f.id}`,
    });
    expect(response.statusCode).toBe(401);
    expect(f.stopTx).not.toHaveBeenCalled();
    await f.app.close();
  });
  it('allows an authenticated owner to stop after transmit permission is revoked', async () => {
    const f = fixture();
    f.deny();
    const response = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/radios/${f.radioId}/tx-sessions/${f.id}`,
      headers: { authorization: 'Bearer valid' },
    });
    expect(response.statusCode).toBe(200);
    expect(f.stopTx).toHaveBeenCalledOnce();
    await f.app.close();
  });
  it('rejects unscoped permissions before creating a grant', async () => {
    const f = fixture();
    f.deny();
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/radios/${f.radioId}/tx-sessions`,
      headers: { authorization: 'Bearer valid' },
      payload: {
        generation: crypto.randomUUID(),
        controlGrant: crypto.randomUUID(),
        expectedRevision: 4,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(f.startTx).not.toHaveBeenCalled();
    await f.app.close();
  });
  it('does not accept a client-supplied owner or session identity', async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/radios/${f.radioId}/tx-sessions`,
      headers: { authorization: 'Bearer valid' },
      payload: {
        generation: crypto.randomUUID(),
        controlGrant: crypto.randomUUID(),
        expectedRevision: 4,
        ownerId: crypto.randomUUID(),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(f.startTx).not.toHaveBeenCalled();
    await f.app.close();
  });
});
