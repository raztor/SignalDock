import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ProcessingCapabilitySchema,
  ProcessingProfileSchema,
  ProcessingRequestSchema,
  type AuthPort,
  type Principal,
} from '@signaldock/contracts';
import {
  type ProcessingRuntime,
  type SubscriptionRegistration,
} from '@signaldock/processing-connectors';
import { requirePrincipal } from '../../shared/http/auth.js';

const id = z.uuid();
const params = z.strictObject({ id });
const configuration = z.record(z.string(), z.unknown());
const createConnection = z.strictObject({
  connectorId: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  endpoint: z.url().max(1000),
  capabilities: z.array(ProcessingCapabilitySchema).min(1),
  configuration: configuration.optional(),
  apiKey: z.string().min(1).max(64000).optional(),
});
const registration = z.strictObject({
  issuer: z.literal('https://auth.openai.com'),
  subject: z.string().min(1).max(200),
  clientId: z.string().min(1).max(200),
  hostId: z.string().max(100),
  email: z.string().max(320).optional(),
  accessToken: z.string().min(1).max(64000),
  refreshToken: z.string().min(1).max(64000),
  idToken: z.string().min(1).max(64000),
  scopes: z.array(z.string().max(100)).max(30),
  expiresAt: z.number().finite(),
});

export type PreparedSpeechTransmitter = (
  principal: Principal,
  context: {
    radioId: string;
    generation: string;
    expectedRevision: number;
    controlGrant: string;
  },
  artifact: { bytes: Uint8Array; contentType: string },
  signal: AbortSignal,
  validateBeforeTransmit: () => Promise<void>,
) => Promise<unknown>;
export function registerProcessingRoutes(
  app: FastifyInstance,
  options: {
    prefix: string;
    auth: AuthPort;
    processing: ProcessingRuntime;
    transmitPreparedSpeech?: PreparedSpeechTransmitter;
  },
): void {
  const base = `${options.prefix}/processing`;
  const service = options.processing;
  const principal = (request: Parameters<typeof requirePrincipal>[0]) =>
    requirePrincipal(request, options.auth, 'processing.manage');
  app.get(`${base}/connectors`, async (request) => {
    await principal(request);
    return { connectors: service.manifests(), tasks: service.tasks() };
  });
  app.get(`${base}/connections`, async (request) => ({
    connections: await service.connections(await principal(request)),
  }));
  app.post(`${base}/credentials/rewrap`, async (request) =>
    service.rewrapCredentials(await principal(request)),
  );
  app.post(`${base}/connections`, async (request, reply) =>
    reply
      .code(201)
      .send(
        await service.createConnection(
          await principal(request),
          createConnection.parse(request.body),
        ),
      ),
  );
  app.post(
    `${base}/subscriptions/import`,
    { bodyLimit: 256000 },
    async (request, reply) => {
      const actor = await principal(request);
      const value = registration.parse(
        request.body,
      ) as SubscriptionRegistration;
      return reply
        .code(201)
        .send(
          await service.importSubscription(
            actor,
            value,
            AbortSignal.timeout(30_000),
          ),
        );
    },
  );
  app.delete(`${base}/connections/:id`, async (request, reply) => {
    await service.revokeConnection(
      await principal(request),
      params.parse(request.params).id,
      AbortSignal.timeout(30_000),
    );
    return reply.code(204).send();
  });
  app.get(`${base}/profiles`, async (request) => ({
    profiles: await service.profiles(await principal(request)),
  }));
  app.post(`${base}/profiles`, async (request, reply) => {
    const body = ProcessingProfileSchema.omit({
      profileId: true,
      revision: true,
    }).parse(request.body);
    return reply.code(201).send(
      await service.saveProfile(await principal(request), {
        ...body,
        profileId: randomUUID(),
        revision: 1,
      }),
    );
  });
  app.put(`${base}/profiles`, async (request) => {
    const body = z
      .strictObject({
        profile: ProcessingProfileSchema,
        expectedRevision: z.number().int().positive().optional(),
      })
      .parse(request.body);
    return service.saveProfile(
      await principal(request),
      body.profile,
      body.expectedRevision,
    );
  });
  app.get(`${base}/jobs`, async (request) => ({
    jobs: await service.jobs(await principal(request)),
  }));
  app.get(`${base}/background`, async (request) => ({
    consents: await service.backgroundConsents(await principal(request)),
  }));
  app.put(`${base}/background/consent`, async (request) =>
    service.consentToAutomaticRx(
      await principal(request),
      z
        .strictObject({
          radioId: id,
          profileId: id,
          profileRevision: z.number().int().positive(),
          endpoint: z.url().max(1000),
          serviceOwnerUserId: id,
          allowAutomaticUpload: z.literal(true),
        })
        .parse(request.body),
    ),
  );
  app.delete(`${base}/background/:id`, async (request, reply) => {
    await service.disableAutomaticRx(
      await principal(request),
      params.parse(request.params).id,
    );
    return reply.code(204).send();
  });
  app.post(`${base}/jobs`, async (request, reply) => {
    const body = z
      .strictObject({
        request: ProcessingRequestSchema.omit({
          jobId: true,
          instanceId: true,
        }).extend({ jobId: id.optional(), instanceId: id.optional() }),
        radioId: id.optional(),
        idempotencyKey: z.string().min(1).max(200),
        source: z
          .strictObject({
            communicationId: id,
            communicationRevision: z.number().int().nonnegative(),
            artifactId: id.optional(),
          })
          .optional(),
      })
      .parse(request.body);
    const actor = await principal(request);
    const source = body.source
      ? {
          communicationId: body.source.communicationId,
          communicationRevision: body.source.communicationRevision,
          ...(body.source.artifactId
            ? { artifactId: body.source.artifactId }
            : {}),
        }
      : undefined;
    return reply.code(202).send(
      await service.enqueue(
        actor,
        {
          ...body.request,
          instanceId: body.request.instanceId ?? actor.instanceId,
          jobId: body.request.jobId ?? randomUUID(),
        },
        body.idempotencyKey,
        body.radioId,
        source,
      ),
    );
  });
  app.delete(`${base}/jobs/:id`, async (request, reply) => {
    await service.cancel(
      await principal(request),
      params.parse(request.params).id,
    );
    return reply.code(204).send();
  });
  app.get(`${base}/jobs/:id/audio`, async (request, reply) => {
    const audio = await service.preview(
      await principal(request),
      params.parse(request.params).id,
    );
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .type(audio.metadata.contentType)
      .send(Buffer.from(audio.bytes));
  });
  if (options.transmitPreparedSpeech)
    app.post(`${base}/jobs/:id/transmit`, async (request, reply) => {
      const context = z
        .strictObject({
          radioId: id,
          generation: z.string().min(1),
          expectedRevision: z.number().int().nonnegative(),
          controlGrant: z.string().min(1).max(2000),
        })
        .parse(request.body);
      const actor = await principal(request);
      const signal = AbortSignal.timeout(35_000);
      const cancellation = new AbortController();
      const closed = () =>
        cancellation.abort(new Error('The transmitting client disconnected.'));
      request.raw.once('aborted', closed);
      reply.raw.once('close', closed);
      try {
        const artifact = await service.prepareTransmission(
          actor,
          params.parse(request.params).id,
          context.radioId,
        );
        return await options.transmitPreparedSpeech!(
          actor,
          context,
          { bytes: artifact.bytes, contentType: artifact.metadata.contentType },
          AbortSignal.any([signal, cancellation.signal]),
          async () => {
            await service.validatePreparedTransmission(
              actor,
              params.parse(request.params).id,
              context.radioId,
            );
          },
        );
      } finally {
        request.raw.removeListener('aborted', closed);
        reply.raw.removeListener('close', closed);
      }
    });
}
