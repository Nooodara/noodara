// 22-03: route schemas of `/api/projects/:projectId/services/:serviceId/domains`. The bodies are
// capped (bodyLimit + the hostname max length) and strict: the contract bodies are
// z.strictObject, so an unknown key is a 400 at the schema layer (H2, 22-08 A8).
// Responses are the strict DomainView allowlist: no server credential, no ACME internals.
import { z } from 'zod';
import {
  CreateDomainBodySchema,
  DnsInstructionsViewSchema,
  DomainParamsSchema,
  DomainViewSchema,
  ServiceParamsSchema,
  UpdateDomainBodySchema,
} from '@noodara/domain/api-contract';

/** A create body is one hostname (<= 253 chars) and a boolean; 4 KiB is ample. */
export const DOMAIN_ROUTE_BODY_LIMIT_BYTES = 4096;

export const DOMAIN_INPUT_INVALID_STATUS = 422;

export const DomainServiceParamsSchema = ServiceParamsSchema;
export const DomainItemParamsSchema = DomainParamsSchema;
export const CreateDomainRouteBodySchema = CreateDomainBodySchema;
export const UpdateDomainRouteBodySchema = UpdateDomainBodySchema;
/** The DNS check takes no input (an absent body reaches the schema as null). */
export const DnsCheckBodySchema = z.strictObject({}).nullish();

export const DomainInputErrorBodySchema = z.strictObject({
  error: z.literal('DOMAIN_INPUT_INVALID'),
  message: z.string(),
  reason: z.string(),
});

export const DomainListResponseSchema = z.strictObject({
  items: z.array(DomainViewSchema),
  dnsInstructions: z.array(DnsInstructionsViewSchema),
});

export { DomainViewSchema };
