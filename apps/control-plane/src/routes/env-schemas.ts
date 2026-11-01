// 23-02: route schemas of the variables API at project, environment and service scope. Bodies are
// strict (an unknown key is a 400) and capped: bodyLimit covers a 32 KiB value written entirely as
// JSON \u escapes. The update body may resend the key; a different one is rejected (H2).
import { z } from 'zod';
import { MAX_ENV_KEY_LENGTH, MAX_ENV_VALUE_BYTES } from '@noodara/domain';
import {
  CreateVariableBodySchema,
  EffectiveVariableViewSchema,
  EnvironmentParamsSchema,
  ProjectIdParamSchema,
  ServiceParamsSchema,
  VariableViewSchema,
} from '@noodara/domain/api-contract';

export const ENV_ROUTE_BODY_LIMIT_BYTES = MAX_ENV_VALUE_BYTES * 6 + 4096;

export const ENV_INPUT_INVALID_STATUS = 422;

export const ProjectEnvParamsSchema = ProjectIdParamSchema;
export const EnvironmentEnvParamsSchema = EnvironmentParamsSchema;
export const ServiceEnvParamsSchema = ServiceParamsSchema;

const VariableIdParam = { variableId: z.uuid() };
export const ProjectVariableParamsSchema = ProjectIdParamSchema.extend(VariableIdParam);
export const EnvironmentVariableParamsSchema = EnvironmentParamsSchema.extend(VariableIdParam);
export const ServiceVariableParamsSchema = ServiceParamsSchema.extend(VariableIdParam);

export const CreateVariableRouteBodySchema = CreateVariableBodySchema;
export const UpdateVariableRouteBodySchema = z.strictObject({
  key: z.string().max(MAX_ENV_KEY_LENGTH).optional(),
  value: z.string().max(MAX_ENV_VALUE_BYTES),
});

export const EnvErrorBodySchema = z.strictObject({
  error: z.enum(['ENV_INPUT_INVALID', 'SECRET_NOT_FOUND']),
  message: z.string(),
  reason: z.string().optional(),
  reference: z.string().optional(),
});

export const VariableListResponseSchema = z.strictObject({ items: z.array(VariableViewSchema) });

export const EffectiveEnvResponseSchema = z.strictObject({
  items: z.array(EffectiveVariableViewSchema),
  differsFromRunning: z.boolean(),
});

export { VariableViewSchema };
