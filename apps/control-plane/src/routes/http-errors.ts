// D-16: the single service-code-to-HTTP-status map for every route this phase and every later
// phase writes. A route must never decide a status from its own knowledge of a code (no
// `reply.code(409)` sprinkled per route) — it always goes through `mapServiceCodeToStatus`.
//
// `SERVICE_ERROR_STATUS` is frozen and declared with `satisfies Record<ServiceErrorCode, number>`
// (the same frozen-table + `satisfies` idiom `packages/domain/src/server/server-state.ts`'s
// `TRANSITIONS` uses for literal-narrowing) so a missing key is a compile-time error, not a
// runtime surprise. `http-errors.test.ts`'s static exhaustiveness scan additionally proves every
// `...FailureCode` union declared anywhere under `services/*.ts` has a matching key here — that
// scan is what "statically exhaustive" actually cashes out to (a compile-time contract alone
// cannot catch a service that forgets to route a new code through this same union type).
import { z } from 'zod';

export type ServiceErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_CREDENTIAL'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND'
  | 'NAME_TAKEN'
  | 'HOST_TAKEN'
  | 'SERVER_BUSY'
  | 'ALREADY_CONNECTING'
  | 'SERVER_NOT_CONNECTED'
  | 'NO_PENDING_FINGERPRINT'
  | 'FINGERPRINT_MISMATCH'
  | 'SERVER_NOT_TRUSTABLE'
  | 'CONFIRMATION_MISMATCH'
  | 'QUEUE_UNAVAILABLE'
  | 'SSE_LIMIT_REACHED'
  | 'INTERNAL_ERROR';

export const SERVICE_ERROR_STATUS = Object.freeze({
  VALIDATION_FAILED: 400,
  INVALID_CREDENTIAL: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  NAME_TAKEN: 409,
  HOST_TAKEN: 409,
  SERVER_BUSY: 409,
  ALREADY_CONNECTING: 409,
  SERVER_NOT_CONNECTED: 409,
  NO_PENDING_FINGERPRINT: 409,
  FINGERPRINT_MISMATCH: 409,
  SERVER_NOT_TRUSTABLE: 409,
  CONFIRMATION_MISMATCH: 409,
  QUEUE_UNAVAILABLE: 503,
  SSE_LIMIT_REACHED: 503,
  INTERNAL_ERROR: 500,
} satisfies Record<ServiceErrorCode, number>);

const UNKNOWN_CODE_STATUS = 500;

/** Table lookup only — never throws, defaults to 500 for a code this map does not recognise
 *  (defensive: an unmapped code is always treated as a server error, never a 2xx/4xx guess). */
export function mapServiceCodeToStatus(code: string): number {
  const table: Record<string, number> = SERVICE_ERROR_STATUS;
  return table[code] ?? UNKNOWN_CODE_STATUS;
}

/** D-16's error body shape, built field by field — never a spread of an `Error` instance, which
 *  could otherwise leak a `stack` or `cause` property onto the wire. */
export function toErrorBody(code: string, message: string): { error: string; message: string } {
  return { error: code, message };
}

const VALIDATION_ERROR_MESSAGE = 'Request does not match the schema';

interface RawValidationIssue {
  readonly instancePath?: string;
  readonly path?: unknown;
  readonly message?: string;
}

function normalizeIssuePath(issue: RawValidationIssue): string {
  if (typeof issue.instancePath === 'string') return issue.instancePath;
  if (Array.isArray(issue.path)) return issue.path.join('.');
  return '';
}

/** Normalises Fastify's `@fastify/type-provider-zod` validation issues (AJV-shaped:
 *  `instancePath` + `message`, plus whatever else Zod's own issue carries) to D-16's shape.
 *  Copies only `path` and `message` from each issue — a raw Zod issue can carry `received`/
 *  `expected` values that echo submitted input (T-4-04), and this body is returned to the
 *  client, so nothing else may pass through. */
export function toValidationErrorBody(issues: readonly RawValidationIssue[]): {
  error: 'VALIDATION_FAILED';
  message: string;
  issues: { path: string; message: string }[];
} {
  return {
    error: 'VALIDATION_FAILED',
    message: VALIDATION_ERROR_MESSAGE,
    issues: issues.map((issue) => ({
      path: normalizeIssuePath(issue),
      message: typeof issue.message === 'string' ? issue.message : '',
    })),
  };
}

/** Shared response schema every route's 4xx/5xx `response` entries should reuse instead of
 *  redeclaring `z.object({ error: ..., message: ... })` per route. */
export const ErrorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
});

export const ValidationErrorBodySchema = z.object({
  error: z.literal('VALIDATION_FAILED'),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
