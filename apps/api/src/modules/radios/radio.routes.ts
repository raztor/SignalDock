import type { FastifyInstance } from 'fastify';
import {
  IdSchema,
  OperationContextSchema,
  RadioConfigurationSchema,
  RadioMemorySchema,
  TuningCommandSchema,
  SignalDockError,
  type AuthenticationPort,
} from '@signaldock/contracts';
import { requirePrincipal } from '../../shared/http/auth.js';
import type { RadioApplicationService } from './radio.service.js';

export function registerRadioRoutes(
  app: FastifyInstance,
  options: {
    prefix: string;
    auth: AuthenticationPort;
    service: RadioApplicationService;
  },
): void {
  const { prefix, auth, service } = options;
  app.get(`${prefix}/radios`, async (request) =>
    service.list(await requirePrincipal(request, auth)),
  );
  app.get(`${prefix}/radios/configurations`, async (request) =>
    service.listConfigurations(await requirePrincipal(request, auth)),
  );
  app.post(`${prefix}/radios`, async (request, reply) => {
    const result = await service.configure(
      await requirePrincipal(request, auth),
      RadioConfigurationSchema.parse(request.body),
    );
    return reply.code(201).send(result);
  });
  app.put<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/configuration`,
    async (request) => {
      const configuration = RadioConfigurationSchema.parse(request.body);
      const radioId = IdSchema.parse(request.params.radioId);
      if (configuration.radioId !== radioId)
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Configuration body and route do not match.',
        );
      return service.configure(
        await requirePrincipal(request, auth),
        configuration,
      );
    },
  );
  app.get<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId`,
    async (request) =>
      service.get(
        await requirePrincipal(request, auth),
        IdSchema.parse(request.params.radioId),
      ),
  );
  app.get<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/state`,
    async (request) =>
      (
        await service.get(
          await requirePrincipal(request, auth),
          IdSchema.parse(request.params.radioId),
        )
      ).snapshot,
  );
  app.get<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/capabilities`,
    async (request) =>
      (
        await service.get(
          await requirePrincipal(request, auth),
          IdSchema.parse(request.params.radioId),
        )
      ).descriptor?.capabilities ?? null,
  );
  app.post<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/control`,
    async (request, reply) => {
      const result = await service.acquireControl(
        await requirePrincipal(request, auth),
        IdSchema.parse(request.params.radioId),
      );
      return reply.code(201).send(result);
    },
  );
  app.post<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/control/renew`,
    async (request) => {
      const body = leaseBody(request.body);
      return service.renewControl(
        await requirePrincipal(request, auth),
        IdSchema.parse(request.params.radioId),
        body.controlGrant,
        body.generation,
      );
    },
  );
  app.delete<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/control`,
    async (request, reply) => {
      const body = leaseBody(request.body);
      await service.releaseControl(
        await requirePrincipal(request, auth),
        IdSchema.parse(request.params.radioId),
        body.controlGrant,
        body.generation,
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/operations`,
    async (request) =>
      service.tune(
        await requirePrincipal(request, auth),
        IdSchema.parse(request.params.radioId),
        TuningCommandSchema.parse(request.body),
      ),
  );
  app.get<{ Params: { radioId: string } }>(
    `${prefix}/radios/:radioId/memories`,
    async (request) =>
      service.memories(
        await requirePrincipal(request, auth),
        IdSchema.parse(request.params.radioId),
      ),
  );
  app.post<{ Params: { radioId: string; memoryId: string } }>(
    `${prefix}/radios/:radioId/memories/:memoryId/select`,
    async (request) =>
      service.selectMemory(
        await requirePrincipal(request, auth),
        IdSchema.parse(request.params.radioId),
        request.params.memoryId,
        OperationContextSchema.parse(request.body),
      ),
  );
  app.put<{ Params: { radioId: string; memoryId: string } }>(
    `${prefix}/radios/:radioId/memories/:memoryId`,
    async (request) => {
      if (
        typeof request.body !== 'object' ||
        !request.body ||
        !('context' in request.body) ||
        !('memory' in request.body)
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'A memory and operation context are required.',
        );
      return service.writeMemory(
        await requirePrincipal(request, auth),
        IdSchema.parse(request.params.radioId),
        request.params.memoryId,
        OperationContextSchema.parse(request.body.context),
        RadioMemorySchema.parse(request.body.memory),
      );
    },
  );
}
function leaseBody(input: unknown): {
  controlGrant: string;
  generation: string;
} {
  if (
    typeof input !== 'object' ||
    !input ||
    !('controlGrant' in input) ||
    !('generation' in input)
  )
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'A control grant and generation are required.',
    );
  return {
    controlGrant: IdSchema.parse(input.controlGrant),
    generation: IdSchema.parse(input.generation),
  };
}
