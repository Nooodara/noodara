// T-5-26/T-5-27 (05-07-PLAN.md threat register): the one fetch wrapper every screen in apps/web
// uses to reach the control plane. Two invariants are enforced here and nowhere else:
//
//   1. Every request targets a *relative* `/api/...` path, proxied same-origin by
//      next.config.ts's rewrites() to NOODARA_API_ORIGIN (docs/adr/0006). An absolute URL throws
//      before any fetch happens, so no call site can accidentally bypass the proxy and the Origin
//      guard's same-origin assumption (apps/control-plane/src/auth/origin-guard.ts).
//   2. A failure body is parsed defensively into ApiFailure's fixed vocabulary -- never the raw
//      response text, never a request body, never a caught exception's own message
//      (05-UI-SPEC.md SS10 Security-Relevant UI Rules). A malformed/non-JSON failure body degrades
//      to a generic INTERNAL_ERROR rather than leaking whatever the server (or an intermediary
//      proxy/gateway) actually sent.

/** The literal `ServiceErrorCode` union from apps/control-plane/src/routes/http-errors.ts, plus
 *  `NETWORK_ERROR` for a rejected `fetch` (offline, DNS failure, etc.) -- a case the server-side
 *  vocabulary has no code for. Hand-copied, not imported: apps/web must never import a
 *  control-plane-internal module into the browser bundle (05-PATTERNS.md). A server-side code
 *  added without a matching update here is a drift risk to catch in review, same discipline as
 *  ServerViewSchema below. */
export type ApiErrorCode =
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
  | 'NETWORK_ERROR';

export interface ApiIssue {
  readonly path: string;
  readonly message: string;
}

export interface ApiFailure {
  readonly ok: false;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly issues?: readonly ApiIssue[];
  readonly retryAfterSeconds?: number;
  /** True only for a 401 -- the flag callers use to redirect to /login. The client itself never
   *  navigates (05-UI-SPEC.md SS5.4 UNAUTHORIZED row). */
  readonly unauthorized: boolean;
}

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** apps/control-plane/src/services/server-view.ts's `ServerView`, hand-copied field by field --
 *  never imported from the control plane (the browser bundle must not depend on server-internal
 *  modules, same rule as ApiErrorCode above). A field added to/removed from
 *  `ServerView`/`ServerViewSchema`/`SERVER_VIEW_KEYS` without a matching update here is a drift
 *  risk to catch in code review; this file cannot assert it automatically across the fetch
 *  boundary the way `assertServerViewSchemaKeysMatch` does server-side. Dates are the JSON wire's
 *  ISO strings (a `Date` instance serializes through `Date.prototype.toJSON` on the way out) --
 *  never a real `Date` here. */
export interface ServerView {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly status: 'PENDING' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'UNREACHABLE' | 'ERROR';
  readonly hostFingerprint: string | null;
  readonly hostFingerprintCapturedAt: string | null;
  readonly pendingFingerprint: string | null;
  readonly pendingFingerprintSeenAt: string | null;
  readonly hostname: string | null;
  readonly osDistribution: string | null;
  readonly osVersion: string | null;
  readonly arch: string | null;
  readonly cpuCores: number | null;
  readonly ramMb: number | null;
  readonly diskTotalMb: number | null;
  readonly diskUsedMb: number | null;
  readonly uptimeSeconds: number | null;
  readonly dockerInstalled: boolean | null;
  readonly dockerVersion: string | null;
  readonly dockerComposeVersion: string | null;
  readonly lastSeenAt: string | null;
  readonly lastErrorCode:
    | 'AUTH_FAILED'
    | 'HOST_UNRESOLVED'
    | 'CONNECT_TIMEOUT'
    | 'COMMAND_TIMEOUT'
    | 'HOST_KEY_CHANGED'
    | 'CONNECTION_LOST'
    | 'UNSUPPORTED_OS'
    | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly credentialType: 'ssh_private_key' | 'ssh_password';
}

// T-5G-28-01 (05-28-PLAN.md): CLAUDE.md SS2.3 requires an explicit timeout on every remote
// operation, including this one browser->control-plane fetch wrapper. 15000ms is sized for the
// slowest real call the UI makes -- `GET /api/servers` against a cold control plane the worker
// hasn't warmed up -- while staying well under any human patience threshold (a hung request past
// 15s reads as broken regardless of what eventually happens). A single exported constant so every
// call site (GET and every apiSend method) shares the identical budget, never a magic number
// repeated per call.
export const API_REQUEST_TIMEOUT_MS = 15_000;

const API_PATH_PREFIX = '/api/';

function assertRelativeApiPath(path: string): void {
  if (!path.startsWith(API_PATH_PREFIX)) {
    throw new Error(`apiGet/apiSend paths must be relative and start with "${API_PATH_PREFIX}" (got "${path}")`);
  }
}

// T-5G-31-02 (05-31-PLAN.md): previously this was a second, hand-maintained string list next to
// `ApiErrorCode` above -- exactly the drift a real 409 `FINGERPRINT_MISMATCH`/`SERVER_NOT_TRUSTABLE`
// silently degrading to `INTERNAL_ERROR` came from (the codes existed in the union but not here).
// `API_ERROR_CODE_MARKER` closes that class of bug structurally, the same `satisfies Record<...>`
// exhaustiveness idiom `apps/control-plane/src/routes/http-errors.ts`'s `SERVICE_ERROR_STATUS`
// already uses: a fresh object literal checked against `Record<Exclude<ApiErrorCode,
// 'NETWORK_ERROR'>, true>` fails to compile both if a union member is missing as a key AND if an
// extra key is present that isn't in the union (TypeScript's excess-property check on a literal
// assigned via `satisfies`). `KNOWN_SERVICE_ERROR_CODES`/`ALL_KNOWN_SERVICE_ERROR_CODES` are both
// derived from this single source, so there is exactly one list to update when a new code is added.
const API_ERROR_CODE_MARKER = Object.freeze({
  VALIDATION_FAILED: true,
  INVALID_CREDENTIAL: true,
  UNAUTHORIZED: true,
  FORBIDDEN_ORIGIN: true,
  NOT_FOUND: true,
  NAME_TAKEN: true,
  HOST_TAKEN: true,
  SERVER_BUSY: true,
  ALREADY_CONNECTING: true,
  SERVER_NOT_CONNECTED: true,
  NO_PENDING_FINGERPRINT: true,
  FINGERPRINT_MISMATCH: true,
  SERVER_NOT_TRUSTABLE: true,
  CONFIRMATION_MISMATCH: true,
  QUEUE_UNAVAILABLE: true,
  SSE_LIMIT_REACHED: true,
  INTERNAL_ERROR: true,
} satisfies Record<Exclude<ApiErrorCode, 'NETWORK_ERROR'>, true>);

const KNOWN_SERVICE_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(API_ERROR_CODE_MARKER));

/** Test-only drift surface: every recognised code, typed back to the exact union it was derived
 *  from. `Object.keys` itself only returns `string[]` -- the cast is narrowing back to what
 *  `API_ERROR_CODE_MARKER`'s own `satisfies` clause already proved true of every one of its keys. */
export const ALL_KNOWN_SERVICE_ERROR_CODES = Object.keys(
  API_ERROR_CODE_MARKER,
) as readonly Exclude<ApiErrorCode, 'NETWORK_ERROR'>[];

function isKnownServiceErrorCode(value: unknown): value is Exclude<ApiErrorCode, 'NETWORK_ERROR'> {
  return typeof value === 'string' && KNOWN_SERVICE_ERROR_CODES.has(value);
}

function isApiIssueShape(value: unknown): value is ApiIssue {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === 'string' && typeof candidate.message === 'string';
}

function parseIssues(value: unknown): ApiIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: ApiIssue[] = [];
  for (const entry of value as unknown[]) {
    if (isApiIssueShape(entry)) {
      issues.push({ path: entry.path, message: entry.message });
    }
  }
  return issues;
}

/** `Retry-After` per RFC 9110 is always delta-seconds here (D-16's producers never send an
 *  HTTP-date form) -- a non-numeric or absent header simply yields no `retryAfterSeconds`. */
function parseRetryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

const GENERIC_FAILURE_MESSAGE = 'Something went wrong. Try again.';

interface RawFailureBody {
  readonly error?: unknown;
  readonly message?: unknown;
  readonly issues?: unknown;
}

async function toApiFailure(response: Response): Promise<ApiFailure> {
  const unauthorized = response.status === 401;
  const retryAfterSeconds = parseRetryAfterSeconds(response);

  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    // Non-JSON or empty body (an intermediary gateway's HTML error page, a truncated response,
    // etc.) -- never surfaced as-is; 05-UI-SPEC.md SS10 forbids rendering raw server output.
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: GENERIC_FAILURE_MESSAGE,
      unauthorized,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }

  const raw: RawFailureBody = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const code = isKnownServiceErrorCode(raw.error) ? raw.error : 'INTERNAL_ERROR';
  const message = typeof raw.message === 'string' ? raw.message : GENERIC_FAILURE_MESSAGE;
  const issues = parseIssues(raw.issues);

  return {
    ok: false,
    code,
    message,
    unauthorized,
    ...(issues === undefined ? {} : { issues }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

// A caller-supplied `init.signal` (none exists today, but a future call site might add one) must
// never be silently discarded once this timeout is added -- `AbortSignal.any` composes both so
// either one aborting the request still aborts it.
function composeSignal(callerSignal: AbortSignal | null | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(API_REQUEST_TIMEOUT_MS);
  if (callerSignal === null || callerSignal === undefined) {
    return timeoutSignal;
  }
  return AbortSignal.any([callerSignal, timeoutSignal]);
}

async function performRequest<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  assertRelativeApiPath(path);

  const signal = composeSignal(init.signal);

  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin', signal });
  } catch {
    // Never echo the rejected fetch's own Error.message -- it can carry environment-specific
    // detail (e.g. a resolver's internal hostname) that has no business reaching a rendered UI.
    // This also catches the AbortError `fetch` throws once `API_REQUEST_TIMEOUT_MS` elapses (or a
    // caller-supplied signal aborts) -- an abort is just another unreachable-server case from the
    // caller's point of view, never a distinct code or an echoed "AbortError" string.
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      message: 'Could not reach the server. Check your connection and try again.',
      unauthorized: false,
    };
  }

  if (!response.ok) {
    return toApiFailure(response);
  }

  const data = (await response.json()) as T;
  return { ok: true, data };
}

export function apiGet<T>(path: string): Promise<ApiResult<T>> {
  return performRequest<T>(path, { method: 'GET' });
}

export type ApiSendMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function apiSend<T>(method: ApiSendMethod, path: string, body?: unknown): Promise<ApiResult<T>> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return performRequest<T>(path, init);
}
