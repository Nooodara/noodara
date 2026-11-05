// 28-02: BYOK AI provider settings, registered inside the guarded scope (api-scope.ts).
//   GET    /api/settings/ai  -> { settings: view | null } (provider, model, redacted hint only)
//   PUT    /api/settings/ai  -> validates the key with one bounded call, then stores it encrypted
//   DELETE /api/settings/ai  -> removes the settings and the key in one transaction
// No response, error body or log line carries the key (A1, A3, H1).
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { appRedactor } from '../activity/redaction.js';
import {
  AI_PROVIDER_INPUT_INVALID_STATUS,
  deleteAiProviderSettings,
  getAiProviderSettings,
  putAiProviderSettings,
  type AiSettingsFailure,
  type AiSettingsServiceDeps,
} from '../ai/settings/ai-settings-service.js';
import { createProviderKeyValidator } from '../ai/settings/provider-key-validator.js';
import { getDb } from '../db/client.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { masterKeysFromEnvironment } from '../services/service-credentials.js';
import { ErrorBodySchema, mapServiceCodeToStatus, toErrorBody, ValidationErrorBodySchema } from './http-errors.js';
import {
  AI_SETTINGS_BODY_LIMIT_BYTES,
  AiProviderSettingsResponseSchema,
  AiProviderSettingsViewSchema,
  AiSettingsInputErrorBodySchema,
  PutAiSettingsRouteBodySchema,
} from './ai-settings-schemas.js';

export interface AiSettingsRoutesOptions {
  /** Test seam: replaces the lazily built production deps. */
  readonly getDeps?: () => Promise<AiSettingsServiceDeps>;
}

function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) throw new Error('ai settings route reached with no actor — requireSession guard is not registered');
  return actor;
}

export function aiSettingsFailureStatus(failure: AiSettingsFailure): number {
  return failure.code === 'AI_PROVIDER_INPUT_INVALID' ? AI_PROVIDER_INPUT_INVALID_STATUS : mapServiceCodeToStatus(failure.code);
}

async function sendFailure(reply: FastifyReply, failure: AiSettingsFailure): Promise<void> {
  const body = {
    ...toErrorBody(failure.code, failure.message),
    ...('reason' in failure ? { reason: failure.reason } : {}),
  };
  await reply.code(aiSettingsFailureStatus(failure)).send(body);
}

function productionDeps(): () => Promise<AiSettingsServiceDeps> {
  let deps: Promise<AiSettingsServiceDeps> | undefined;
  const masterKeys = masterKeysFromEnvironment();
  return () =>
    (deps ??= Promise.all([getDb(), masterKeys()]).then(
      ([db, keys]): AiSettingsServiceDeps => ({
        db,
        now: () => new Date(),
        masterKeys: keys,
        redactor: appRedactor,
        validateKey: createProviderKeyValidator(),
      }),
    ));
}

const ERRORS = {
  400: z.union([ValidationErrorBodySchema, ErrorBodySchema]),
  401: ErrorBodySchema,
  404: ErrorBodySchema,
  413: ErrorBodySchema,
  422: z.union([AiSettingsInputErrorBodySchema, ErrorBodySchema]),
  429: ErrorBodySchema,
  503: ErrorBodySchema,
};

const aiSettingsRoutes: FastifyPluginCallback<AiSettingsRoutesOptions> = (fastify, opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const getDeps = opts.getDeps ?? productionDeps();

  app.route({
    method: 'GET',
    url: '/api/settings/ai',
    schema: { response: { 200: AiProviderSettingsResponseSchema, ...ERRORS } },
    handler: async (request, reply) => {
      requireActor(request.actor);
      await reply.send({ settings: await getAiProviderSettings(await getDeps()) });
    },
  });

  app.route({
    method: 'PUT',
    url: '/api/settings/ai',
    bodyLimit: AI_SETTINGS_BODY_LIMIT_BYTES,
    schema: { body: PutAiSettingsRouteBodySchema, response: { 200: AiProviderSettingsViewSchema, ...ERRORS } },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const result = await putAiProviderSettings(await getDeps(), { actor, ...request.body });
      if (!result.ok) return sendFailure(reply, result);
      await reply.send(result.settings);
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/settings/ai',
    bodyLimit: AI_SETTINGS_BODY_LIMIT_BYTES,
    schema: { response: { 204: z.null(), ...ERRORS } },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const result = await deleteAiProviderSettings(await getDeps(), { actor });
      if (!result.ok) return sendFailure(reply, result);
      await reply.code(204).send(null);
    },
  });

  done();
};

export default aiSettingsRoutes;
