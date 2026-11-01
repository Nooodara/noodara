// 23-03: route schemas of the secrets API at project, environment and service scope. Bodies are
// strict (an unknown key is a 400), the value is a JSON string only, and bodyLimit covers a
// 64 KiB value written entirely as JSON \u escapes. Views are strict and value-free (hint only).
import { z } from 'zod';
import {
  CreateSecretBodySchema,
  EnvironmentParamsSchema,
  EnvScopeSchema,
  MAX_SECRET_VALUE_LENGTH,
  ProjectIdParamSchema,
  SecretViewSchema,
  ServiceParamsSchema,
  UpdateSecretBodySchema,
} from '@noodara/domain/api-contract';

export const SECRET_ROUTE_BODY_LIMIT_BYTES = MAX_SECRET_VALUE_LENGTH * 6 + 4096;

export const SECRET_INPUT_INVALID_STATUS = 422;

export const ProjectSecretsParamsSchema = ProjectIdParamSchema;
export const EnvironmentSecretsParamsSchema = EnvironmentParamsSchema;
export const ServiceSecretsParamsSchema = ServiceParamsSchema;

const SecretIdParam = { secretId: z.uuid() };
export const ProjectSecretParamsSchema = ProjectIdParamSchema.extend(SecretIdParam);
export const EnvironmentSecretParamsSchema = EnvironmentParamsSchema.extend(SecretIdParam);
export const ServiceSecretParamsSchema = ServiceParamsSchema.extend(SecretIdParam);

export const CreateSecretRouteBodySchema = CreateSecretBodySchema;
export const ReplaceSecretRouteBodySchema = UpdateSecretBodySchema;

export const SecretUsageSchema = z.strictObject({ scope: EnvScopeSchema, key: z.string() });

export const SecretErrorBodySchema = z.strictObject({
  error: z.enum(['ENV_INPUT_INVALID', 'ENV_VALUE_MULTILINE', 'SECRET_IN_USE']),
  message: z.string(),
  reason: z.string().optional(),
  usedBy: z.array(SecretUsageSchema).optional(),
});

export const SecretListResponseSchema = z.strictObject({ items: z.array(SecretViewSchema) });

export { SecretViewSchema };
