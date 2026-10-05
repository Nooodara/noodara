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
  | 'INTERNAL_ERROR'
  | 'EMAIL_DOMAIN_UNRESOLVABLE'
  | 'EMAIL_DOMAIN_CHECK_UNAVAILABLE'
  | 'REAUTH_LOCKED'
  | 'SESSION_REVOKED_PASSWORD_CHANGED'
  | 'PROJECT_NAME_TAKEN'
  | 'ENVIRONMENT_NAME_TAKEN'
  | 'PROJECT_NOT_ARCHIVED'
  | 'DELETE_CONFIRMATION_MISMATCH';

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
  // D-02/D-03 (phase 9, 09-06): the profile-edit vocabulary this plan owns — every later phase 9
  // plan (09-09, 09-10) consumes these same four codes and must not add new ones of its own.
  EMAIL_DOMAIN_UNRESOLVABLE: 400,
  EMAIL_DOMAIN_CHECK_UNAVAILABLE: 503,
  REAUTH_LOCKED: 429,
  SESSION_REVOKED_PASSWORD_CHANGED: 401,
  // Phase 12 (12-07): projects and environments. A failed delete confirmation is 422 here, unlike
  // the server delete's CONFIRMATION_MISMATCH (409), and later delete routes reuse this code.
  PROJECT_NAME_TAKEN: 409,
  ENVIRONMENT_NAME_TAKEN: 409,
  PROJECT_NOT_ARCHIVED: 422,
  DELETE_CONFIRMATION_MISMATCH: 422,
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

const CLIENT_REQUEST_ERRORS: Readonly<Record<number, { error: string; message: string }>> = Object.freeze({
  413: { error: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
  415: { error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Request content type is not supported' },
});
const MALFORMED_REQUEST = { error: 'MALFORMED_REQUEST', message: 'Request could not be parsed' };

/**
 * A Fastify-owned request error (`FST_*` code with a 4xx status: malformed or empty JSON, an
 * oversized body, an unsupported content type) stays a 4xx with a fixed body. Its own message is
 * never forwarded, since a parser message can quote the submitted input. Anything else returns
 * `null` and falls through to the opaque 500.
 */
export function toClientRequestError(error: {
  readonly code?: unknown;
  readonly statusCode?: unknown;
  readonly message?: unknown;
}): { status: number; body: { error: string; message: string } } | null {
  const { code, statusCode } = error;
  if (typeof code !== 'string' || !code.startsWith('FST_')) return null;
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 499) {
    return null;
  }
  const known = CLIENT_REQUEST_ERRORS[statusCode] ?? MALFORMED_REQUEST;
  return { status: statusCode, body: toErrorBody(known.error, known.message) };
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
 *  client, so nothing else may pass through.
 *
 *  `code` (09-06) lets a field-tagged service failure (`INVALID_CREDENTIAL`,
 *  `EMAIL_DOMAIN_UNRESOLVABLE`, ...) reuse this exact shape while keeping `error` equal to its
 *  own service code instead of the fixed `'VALIDATION_FAILED'` literal — every existing caller
 *  (the global schema-validation handler, `activity.ts`'s cursor check) omits it and keeps the
 *  original behaviour unchanged. */
export function toValidationErrorBody<Code extends string = 'VALIDATION_FAILED'>(
  issues: readonly RawValidationIssue[],
  code: Code = 'VALIDATION_FAILED' as Code,
): {
  error: Code;
  message: string;
  issues: { path: string; message: string }[];
} {
  return {
    error: code,
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

/** Same wire shape as `ValidationErrorBodySchema` but with a non-literal `error` — for a
 *  field-tagged *service* failure (09-06's `INVALID_CREDENTIAL`/`EMAIL_DOMAIN_UNRESOLVABLE`,
 *  never a Zod schema-validation failure) whose `error` must equal its own service code, not the
 *  fixed `'VALIDATION_FAILED'` literal. Declaring `error` as `z.string()` here (not `.strict()`
 *  either) also keeps a plain `ErrorBodySchema` failure — same route, no `issues` — validating
 *  fine against a `z.union([FieldErrorBodySchema, ErrorBodySchema])` response entry. */
export const FieldErrorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
