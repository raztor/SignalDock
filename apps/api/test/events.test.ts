import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  SignalDockError,
  type AuthenticationPort,
  type DomainEvent,
  type Principal,
} from '@signaldock/contracts';
import { StationEvents } from '../src/app/events.js';
import { configureHttp } from '../src/shared/http/configure-http.js';

describe('authenticated station event stream', () => {
  it('filters other radios, preserves authorized streaming and terminates revoked sessions', async () => {
    const instanceId = crypto.randomUUID(),
      radioId = crypto.randomUUID();
    const principal: Principal = {
      instanceId,
      userId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      username: 'listener',
      role: 'listener',
      radioPermissions: [{ radioId, permissions: ['radio.listen'] }],
    };
    let revoked = false;
    const auth: AuthenticationPort = {
      async authenticate(token) {
        if (token !== 'fixture-token' || revoked)
          throw new SignalDockError('UNAUTHORIZED', 'Revoked fixture.');
        return principal;
      },
      async authorize(_principal, _permission, target) {
        if (revoked)
          throw new SignalDockError('UNAUTHORIZED', 'Revoked fixture.');
        if (target && target !== radioId)
          throw new SignalDockError('FORBIDDEN', 'Another radio.');
      },
    };
    const app = Fastify();
    configureHttp(app);
    const events = new StationEvents(auth, instanceId);
    events.register(app, '/prefix/api/v1');
    app.addHook('preClose', async () => events.close());
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing listener address.');
    const url = `http://127.0.0.1:${address.port}/prefix/api/v1/events`;
    const cancellation = new AbortController();
    try {
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, {
        headers: { Authorization: 'Bearer fixture-token' },
        signal: cancellation.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        ': connected',
      );
      const event: DomainEvent = {
        protocolVersion: 1,
        instanceId,
        radioId,
        eventId: crypto.randomUUID(),
        streamGeneration: crypto.randomUUID(),
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: 'radio.snapshot',
        payloadVersion: 1,
        payload: { revision: 2 },
      };
      await events.publish({ ...event, radioId: crypto.randomUUID() });
      await events.publish(event);
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toContain(event.eventId);
      expect(frame).toContain(radioId);
      revoked = true;
      events.revoke([principal.sessionId]);
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
    } finally {
      cancellation.abort();
      events.close();
      await app.close();
    }
  }, 10000);
});
