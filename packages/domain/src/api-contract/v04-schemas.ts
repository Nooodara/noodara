// Zod schemas for the v0.4 routes (domains, proxy, variables, secrets), 21-05 A3. Request bodies
// bound sizes only; the domain validators (hostname, env key/value, secret name) decide validity
// and answer 422 by name. Views are strict so a server-side leak (an extra key such as a secret
// value) fails the contract test instead of reaching the UI.
import { z } from "zod";
import { CERT_FAILURE_CAUSES, CERT_STATUSES, DNS_OUTCOMES } from "../domain/index.js";
import { ENV_SCOPES, MAX_ENV_KEY_LENGTH, MAX_ENV_VALUE_BYTES, MAX_SECRET_NAME_LENGTH } from "../env/index.js";
import { PROXY_STATUSES } from "../proxy/index.js";

const MAX_HOSTNAME_LENGTH = 253;
const MAX_EMAIL_LENGTH = 254;
/** 64 KiB: certificates and keys go in as base64, a single line. */
export const MAX_SECRET_VALUE_LENGTH = 64 * 1024;

const Timestamp = z.string();

// ---- domains ----------------------------------------------------------------------------------

/** Whether the proxy route of a domain is live on its server. */
export const DOMAIN_APPLY_STATUSES = Object.freeze(["PENDING", "APPLIED", "FAILED"] as const);
export type DomainApplyStatus = (typeof DOMAIN_APPLY_STATUSES)[number];

/** Loose on purpose: unknown keys reach `validateDomainCreateInput`, which names them (422). */
export const CreateDomainBodySchema = z.looseObject({
  hostname: z.string().max(MAX_HOSTNAME_LENGTH),
  httpsRedirect: z.boolean().optional(),
});

export const UpdateDomainBodySchema = z.looseObject({
  httpsRedirect: z.boolean().optional(),
});

export const DomainParamsSchema = z.object({
  projectId: z.uuid(),
  serviceId: z.uuid(),
  domainId: z.uuid(),
});

export const DomainViewSchema = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid(),
  serviceId: z.uuid(),
  hostname: z.string(),
  httpsRedirect: z.boolean(),
  certStatus: z.enum(CERT_STATUSES),
  certNotAfter: Timestamp.nullable(),
  certErrorCode: z.enum(CERT_FAILURE_CAUSES).nullable(),
  dnsStatus: z.enum(DNS_OUTCOMES).nullable(),
  dnsCheckedAt: Timestamp.nullable(),
  applyStatus: z.enum(DOMAIN_APPLY_STATUSES),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type DomainView = z.infer<typeof DomainViewSchema>;

export const ListDomainsResponseSchema = z.object({ items: z.array(DomainViewSchema) });

export const DnsInstructionsViewSchema = z.strictObject({
  hostname: z.string(),
  records: z.array(z.strictObject({ type: z.enum(["A", "AAAA"]), name: z.string(), value: z.string() })),
  cnameAlternative: z.strictObject({ type: z.literal("CNAME"), name: z.string(), target: z.string().nullable() }),
});
export type DnsInstructionsView = z.infer<typeof DnsInstructionsViewSchema>;

// ---- proxy ------------------------------------------------------------------------------------

/** The proxy error codes a server's proxy row can hold; route and in-use failures belong to a
 *  domain or a request. */
export const SERVER_PROXY_ERROR_CODES = Object.freeze([
  "PROXY_PORT_IN_USE",
  "PROXY_INSTALL_FAILED",
  "PROXY_UNAVAILABLE",
] as const);
export type ServerProxyErrorCode = (typeof SERVER_PROXY_ERROR_CODES)[number];

export const ProxyViewSchema = z.strictObject({
  serverId: z.uuid(),
  status: z.enum(PROXY_STATUSES),
  errorCode: z.enum(SERVER_PROXY_ERROR_CODES).nullable(),
  acmeEmail: z.string().nullable(),
  installedAt: Timestamp.nullable(),
});
export type ProxyView = z.infer<typeof ProxyViewSchema>;

export const InstallProxyBodySchema = z.strictObject({
  acmeEmail: z.email().max(MAX_EMAIL_LENGTH),
});

// ---- variables --------------------------------------------------------------------------------

export const EnvScopeSchema = z.enum(ENV_SCOPES);

/** Character bounds only; `validateEnvKey` / `validateEnvValue` check the format and UTF-8 bytes. */
export const CreateVariableBodySchema = z.strictObject({
  key: z.string().max(MAX_ENV_KEY_LENGTH),
  value: z.string().max(MAX_ENV_VALUE_BYTES),
});

export const UpdateVariableBodySchema = z.strictObject({
  value: z.string().max(MAX_ENV_VALUE_BYTES),
});

export const VariableViewSchema = z.strictObject({
  id: z.uuid(),
  scope: EnvScopeSchema,
  key: z.string(),
  value: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type VariableView = z.infer<typeof VariableViewSchema>;

export const ListVariablesResponseSchema = z.object({ items: z.array(VariableViewSchema) });

/** A secret reference is a name only: the strict object rejects any value next to it. */
const EnvValueViewSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plain"), value: z.string() }),
  z.strictObject({ kind: z.literal("secret_ref"), name: z.string() }),
]);

export const EffectiveVariableViewSchema = z.strictObject({
  key: z.string(),
  origin: EnvScopeSchema,
  value: EnvValueViewSchema,
  /** Lower-precedence definitions of the same key, highest first. */
  shadowed: z.array(z.strictObject({ origin: EnvScopeSchema, value: EnvValueViewSchema })),
});
export type EffectiveVariableView = z.infer<typeof EffectiveVariableViewSchema>;

export const EffectiveVariablesResponseSchema = z.object({ items: z.array(EffectiveVariableViewSchema) });

// ---- secrets ----------------------------------------------------------------------------------

export const CreateSecretBodySchema = z.strictObject({
  name: z.string().max(MAX_SECRET_NAME_LENGTH),
  value: z.string().max(MAX_SECRET_VALUE_LENGTH),
});

export const UpdateSecretBodySchema = z.strictObject({
  value: z.string().max(MAX_SECRET_VALUE_LENGTH),
});

/** Strict and value-free (H1): a secret is never returned, only its masked hint. */
export const SecretViewSchema = z.strictObject({
  id: z.uuid(),
  scope: EnvScopeSchema,
  name: z.string(),
  version: z.number().int().min(1),
  hint: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SecretView = z.infer<typeof SecretViewSchema>;

export const ListSecretsResponseSchema = z.object({ items: z.array(SecretViewSchema) });
