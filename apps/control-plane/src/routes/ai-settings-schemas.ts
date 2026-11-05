// 28-02: wire schemas for /api/settings/ai. The body checks only shape and the model allowlist;
// key length and charset are checked by the service so a bad key gets a 422 that never echoes it
// (a schema error message could otherwise quote the input).
import { z } from 'zod';
import { AI_PROVIDER_MODELS, AiProviderSettingsResponseSchema, AiProviderSettingsViewSchema } from '@noodara/domain/api-contract';

/** Far above the key cap (512) plus provider and model; anything larger is refused with 413. */
export const AI_SETTINGS_BODY_LIMIT_BYTES = 8 * 1024;

export const PutAiSettingsRouteBodySchema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('anthropic'), model: z.enum(AI_PROVIDER_MODELS.anthropic), apiKey: z.string() }),
  z.strictObject({ provider: z.literal('openai'), model: z.enum(AI_PROVIDER_MODELS.openai), apiKey: z.string() }),
]);

export const AiSettingsInputErrorBodySchema = z.strictObject({
  error: z.literal('AI_PROVIDER_INPUT_INVALID'),
  message: z.string(),
  reason: z.enum(['too_short', 'too_long', 'invalid_characters', 'model_not_allowed']),
});

export { AiProviderSettingsResponseSchema, AiProviderSettingsViewSchema };
