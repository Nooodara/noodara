// Zod request/response schemas for the services routes (12-08). Bodies are loose objects on
// purpose: only the shape of the envelope is checked here, and every service field (including an
// unknown one such as `buildArgs` or `env`) reaches `@noodara/domain`'s validators, which reject
// it by name as a 422 (H1). The route body cap bounds the work before them.
import { z } from 'zod';
import { SERVICE_STATUSES } from '@noodara/domain/deployment';

/** Route-level body cap: a service body is a handful of short strings and two ports. */
export const SERVICE_ROUTE_BODY_LIMIT_BYTES = 16 * 1024;

export const ServiceParamsSchema = z.object({ projectId: z.uuid(), serviceId: z.uuid() });

/** `environmentId` picks the target; the rest goes to `validateServiceCreateInput` untouched. */
export const CreateServiceBodySchema = z.looseObject({ environmentId: z.uuid() });

/** Every key goes to `validateServiceEditInput`, which also rejects `serverId` (no moves). */
export const UpdateServiceBodySchema = z.looseObject({});

export const ServiceViewSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  environmentId: z.uuid(),
  serverId: z.uuid(),
  name: z.string(),
  sourceType: z.enum(['git', 'image']),
  repositoryUrl: z.string().nullable(),
  branch: z.string().nullable(),
  buildContext: z.string().nullable(),
  dockerfilePath: z.string().nullable(),
  buildTarget: z.string().nullable(),
  imageRef: z.string().nullable(),
  internalPort: z.number().int(),
  publishedPort: z.number().int().nullable(),
  status: z.enum(SERVICE_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ListServicesResponseSchema = z.object({ items: z.array(ServiceViewSchema) });

export const UpdateServiceResponseSchema = z.object({
  service: ServiceViewSchema,
  requiresRedeploy: z.boolean(),
  changedFields: z.array(z.string()),
});

/** 422 for a domain validation failure: `reason` is the validator's own code. */
export const ServiceInputErrorBodySchema = z.object({
  error: z.literal('SERVICE_INPUT_INVALID'),
  message: z.string(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------------------------
// Credentials (12-09): write-only. Bodies are strict so a stray field is a 400, and lengths are
// bounded by the service's validators (fixed messages that never quote the value, H3).
// ---------------------------------------------------------------------------------------------

export const RepositoryCredentialBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('deploy_key') }),
  z.strictObject({ kind: z.literal('https_token'), token: z.string() }),
]);

export const RegistryCredentialBodySchema = z.strictObject({
  host: z.string().optional(),
  username: z.string(),
  password: z.string(),
});

const CredentialSummarySchema = z.object({
  type: z.enum(['git_deploy_key', 'git_https_token', 'registry_password']),
  /** The deploy key's public half; `null` for every other type. */
  publicKey: z.string().nullable(),
});

/** Only presence, type and the deploy key's public half: a secret never leaves the server (A1, A2). */
export const ServiceCredentialsResponseSchema = z.object({
  repository: CredentialSummarySchema.nullable(),
  registry: CredentialSummarySchema.nullable(),
});

/** 422 for a credential that failed validation: `reason` names the rule, never the value. */
export const ServiceCredentialErrorBodySchema = z.object({
  error: z.literal('SERVICE_CREDENTIAL_INVALID'),
  message: z.string(),
  reason: z.string(),
});

// 12-16: runtime container logs. `tail` stays a raw short string here so a bad value becomes the
// named 422 RUNTIME_LOG_TAIL_INVALID (resolveTail), not the generic 400; the cap bounds parsing.
export const RuntimeLogsQuerySchema = z.object({
  tail: z.string().max(16).optional(),
});

const RuntimeLogLineSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  timestamp: z.string().nullable(),
  text: z.string(),
});

export const RuntimeLogsResponseSchema = z.object({
  lines: z.array(RuntimeLogLineSchema),
  truncated: z.boolean(),
});
