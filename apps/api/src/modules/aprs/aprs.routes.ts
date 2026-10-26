import type { FastifyInstance } from 'fastify';
import type { AuthenticationPort } from '@signaldock/contracts';
import { requirePrincipal } from '../../shared/http/auth.js';
import type { AprsService } from './service.js';
import type { DigitalDecodingService } from './decoding.js';
import { SignalDockError } from '@signaldock/contracts';

export function registerAprsRoutes(
  app: FastifyInstance,
  options: {
    prefix: string;
    auth: AuthenticationPort;
    service: AprsService;
    decoding?: DigitalDecodingService;
  },
): void {
  const stringQuery = {
    radioId: { type: 'string', format: 'uuid' },
    callsign: { type: 'string', maxLength: 9 },
    source: { type: 'string', enum: ['native', 'recording', 'aprs_is'] },
  };
  app.get<{
    Querystring: {
      radioId?: string;
      callsign?: string;
      source?: string;
      limit?: number;
      cursor?: string;
    };
  }>(
    `${options.prefix}/packets`,
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...stringQuery,
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            cursor: { type: 'string', maxLength: 512 },
          },
        },
      },
    },
    async (request) =>
      options.service.listPackets(
        await requirePrincipal(request, options.auth),
        request.query,
      ),
  );
  app.get<{ Params: { id: string } }>(
    `${options.prefix}/packets/:id`,
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
          additionalProperties: false,
        },
      },
    },
    async (request) =>
      options.service.getPacket(
        await requirePrincipal(request, options.auth),
        request.params.id,
      ),
  );
  app.get<{
    Querystring: {
      radioId?: string;
      callsign?: string;
      source?: string;
      limit?: number;
      since?: string;
      maxAgeSeconds?: number;
    };
  }>(
    `${options.prefix}/positions`,
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...stringQuery,
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            since: { type: 'string', format: 'date-time' },
            maxAgeSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
          },
        },
      },
    },
    async (request) =>
      options.service.listPositions(
        await requirePrincipal(request, options.auth),
        request.query,
      ),
  );
  const decoding = () => {
    if (!options.decoding)
      throw new SignalDockError(
        'REQUIRES_CONFIGURATION',
        'Recording decoder jobs are not configured.',
      );
    return options.decoding;
  };
  app.post<{
    Body: {
      operationId: string;
      artifactId: string;
      mode: 'AFSK1200' | 'DTMF';
    };
  }>(
    `${options.prefix}/decodings`,
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['operationId', 'artifactId', 'mode'],
          properties: {
            operationId: { type: 'string', format: 'uuid' },
            artifactId: { type: 'string', format: 'uuid' },
            mode: { type: 'string', enum: ['AFSK1200', 'DTMF'] },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = await requirePrincipal(request, options.auth);
      return reply
        .code(202)
        .send(await decoding().create(principal, request.body));
    },
  );
  app.get<{ Params: { id: string } }>(
    `${options.prefix}/decodings/:id`,
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request) =>
      decoding().get(
        await requirePrincipal(request, options.auth),
        request.params.id,
      ),
  );
  app.delete<{ Params: { id: string } }>(
    `${options.prefix}/decodings/:id`,
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const principal = await requirePrincipal(request, options.auth);
      await decoding().cancel(principal, request.params.id);
      return reply.code(204).send();
    },
  );
}
