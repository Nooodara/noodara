// 22-03: route schemas of `/api/projects/:projectId/services/:serviceId/domains`. The bodies are
// capped (bodyLimit + the hostname max length) and strict: the contract's loose shapes let
// unknown keys reach the domain validator, which names them in a 422 DOMAIN_INPUT_INVALID (H2).
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
/** The DNS check takes no input. */
export const DnsCheckBodySchema = z.strictObject({}).optional();

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
