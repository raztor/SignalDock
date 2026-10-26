import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  AuthenticationPort,
  DomainEvent,
  EventPublisherPort,
  Principal,
  Permission,
} from '@signaldock/contracts';
import { SignalDockError } from '@signaldock/contracts';
import { requirePrincipal } from '../shared/http/auth.js';

/** Bounded authenticated refresh events. Clients reconnect explicitly; events never replay commands. */
export class StationEvents implements EventPublisherPort {
  private readonly clients = new Set<{
    principal: Principal;
    reply: FastifyReply;
  }>();
  constructor(
    private readonly auth: AuthenticationPort,
    private readonly instanceId: string,
  ) {}
  async publish(event: DomainEvent): Promise<void> {
    if (event.instanceId !== this.instanceId) return;
    const permission: Permission = event.type.startsWith('radio.')
      ? 'radio.listen'
      : event.type.startsWith('incident.')
        ? 'incident.read'
        : 'history.read';
    await Promise.all(
      [...this.clients].map(async (client) => {
        try {
          await this.auth.authorize(
            client.principal,
            permission,
            event.radioId,
          );
          if (
            !client.reply.raw.write(
              `id: ${event.eventId}\nevent: station\ndata: ${JSON.stringify(event)}\n\n`,
            )
          )
            client.reply.raw.end();
        } catch (error) {
          if (error instanceof SignalDockError && error.code === 'FORBIDDEN')
            return;
          client.reply.raw.end();
        }
      }),
    );
  }
  revoke(sessionIds: readonly string[]): void {
    for (const client of this.clients)
      if (sessionIds.includes(client.principal.sessionId))
        client.reply.raw.end();
  }
  register(app: FastifyInstance, prefix: string): void {
    app.get(`${prefix}/events`, async (request, reply) => {
      const principal = await requirePrincipal(request, this.auth);
      if (principal.instanceId !== this.instanceId)
        throw new SignalDockError(
          'FORBIDDEN',
          'This session belongs to another instance.',
        );
      if (this.clients.size >= 128)
        throw new SignalDockError(
          'OPERATION_CONFLICT',
          'The event connection limit has been reached.',
        );
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(': connected\n\n');
      const client = { principal, reply };
      this.clients.add(client);
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void this.auth
          .authorize(principal, 'notifications.read')
          .then(
            () => {
              if (!reply.raw.write(': heartbeat\n\n')) reply.raw.end();
            },
            () => reply.raw.end(),
          )
          .finally(() => {
            checking = false;
          });
      }, 2000);
      timer.unref();
      reply.raw.once('close', () => {
        clearInterval(timer);
        this.clients.delete(client);
      });
    });
  }
  close(): void {
    for (const client of this.clients) client.reply.raw.end();
    this.clients.clear();
  }
}
