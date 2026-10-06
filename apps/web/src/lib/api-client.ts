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
  | "VALIDATION_FAILED"
  | "INVALID_CREDENTIAL"
  | "UNAUTHORIZED"
  | "FORBIDDEN_ORIGIN"
  | "NOT_FOUND"
  | "NAME_TAKEN"
  | "HOST_TAKEN"
  | "SERVER_BUSY"
  | "ALREADY_CONNECTING"
  | "SERVER_NOT_CONNECTED"
  | "NO_PENDING_FINGERPRINT"
  | "FINGERPRINT_MISMATCH"
  | "SERVER_NOT_TRUSTABLE"
  | "CONFIRMATION_MISMATCH"
  | "QUEUE_UNAVAILABLE"
  | "SSE_LIMIT_REACHED"
  | "INTERNAL_ERROR"
  // 09-10-PLAN.md Task 1 -- hand-copied from apps/control-plane/src/routes/http-errors.ts
  // (09-06/09-08/09-09's backend contracts), same drift discipline as every other code above.
  | "EMAIL_DOMAIN_UNRESOLVABLE"
  | "EMAIL_DOMAIN_CHECK_UNAVAILABLE"
  | "REAUTH_LOCKED"
  | "SESSION_REVOKED_PASSWORD_CHANGED"
  | "NETWORK_ERROR";

/** 13-05: the deploy-engine codes from the same http-errors.ts union (12-07..12-16) plus 13-01's
 *  ENVIRONMENT_NOT_EMPTY. A separate union on purpose: `ApiErrorCode` feeds error-copy.ts's
 *  exhaustive copy table and every existing screen, so only deploy-api.ts calls (deployApiGet /
 *  deployApiSend) can resolve to one of these; the core calls still fold them to INTERNAL_ERROR.
 *  api-client.test.ts asserts every server code is in one of the two lists. */
export type DeployEngineErrorCode =
  | "PROJECT_NAME_TAKEN"
  | "ENVIRONMENT_NAME_TAKEN"
  | "ENVIRONMENT_NOT_EMPTY"
  | "PROJECT_NOT_ARCHIVED"
  | "DELETE_CONFIRMATION_MISMATCH"
  | "SERVICE_INPUT_INVALID"
  | "SERVICE_NAME_TAKEN"
  | "PORT_IN_USE"
  | "SERVER_DOCKER_UNAVAILABLE"
  | "SERVER_BUILDKIT_UNAVAILABLE"
  | "CREDENTIAL_SOURCE_MISMATCH"
  | "SERVICE_CREDENTIAL_INVALID"
  | "SERVER_HAS_SERVICES"
  | "DEPLOYMENT_IN_PROGRESS"
  | "PROJECT_ARCHIVED"
  | "DEPLOYMENT_INPUT_INVALID"
  | "DEPLOYMENT_NOT_CANCELLABLE"
  | "SERVICE_OPERATION_INVALID"
  | "SERVICE_NOT_DEPLOYED"
  | "SERVICE_OPERATION_IN_PROGRESS"
  | "SERVER_UNREACHABLE"
  | "SERVICE_CLEANUP_FAILED"
  | "CONTAINER_NOT_FOUND"
  | "RUNTIME_LOG_TAIL_INVALID"
  | "RUNTIME_LOG_FOLLOW_LIMIT_REACHED"
  | "RUNTIME_LOGS_FAILED"
  | "RUNTIME_LOGS_TIMEOUT";

export type DeployApiErrorCode = ApiErrorCode | DeployEngineErrorCode;

export interface ApiIssue {
  readonly path: string;
  readonly message: string;
}

/** `C` widens to `DeployApiErrorCode` only for deploy-api.ts results; every existing screen keeps
 *  the default, so error-copy.ts's exhaustive table still covers every code it can receive. */
export interface ApiFailure<C extends string = ApiErrorCode> {
  readonly ok: false;
  readonly code: C;
  readonly message: string;
  readonly issues?: readonly ApiIssue[];
  readonly retryAfterSeconds?: number;
  /** A domain validator's rule code (422 SERVICE_INPUT_INVALID / SERVICE_CREDENTIAL_INVALID), kept
   *  only when it is a short token -- never free text. */
  readonly reason?: string;
  /** True only for a 401 -- the flag callers use to redirect to /login. The client itself never
   *  navigates (05-UI-SPEC.md SS5.4 UNAUTHORIZED row). */
  readonly unauthorized: boolean;
}

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export type ApiResult<T, C extends string = ApiErrorCode> =
  ApiSuccess<T> | ApiFailure<C>;

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
  readonly status:
    | "PENDING"
    | "CONNECTING"
    | "CONNECTED"
    | "DISCONNECTED"
    | "UNREACHABLE"
    | "ERROR";
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
    | "AUTH_FAILED"
    | "HOST_UNRESOLVED"
    | "CONNECT_TIMEOUT"
    | "COMMAND_TIMEOUT"
    | "HOST_KEY_CHANGED"
    | "CONNECTION_LOST"
    | "UNSUPPORTED_OS"
    | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly credentialType: "ssh_private_key" | "ssh_password";
}

// T-5G-28-01 (05-28-PLAN.md): CLAUDE.md SS2.3 requires an explicit timeout on every remote
// operation, including this one browser->control-plane fetch wrapper. 15000ms is sized for the
// slowest real call the UI makes -- `GET /api/servers` against a cold control plane the worker
// hasn't warmed up -- while staying well under any human patience threshold (a hung request past
// 15s reads as broken regardless of what eventually happens). A single exported constant so every
// call site (GET and every apiSend method) shares the identical budget, never a magic number
// repeated per call.
export const API_REQUEST_TIMEOUT_MS = 15_000;

const API_PATH_PREFIX = "/api/";

function assertRelativeApiPath(path: string): void {
  if (!path.startsWith(API_PATH_PREFIX)) {
    throw new Error(
      `apiGet/apiSend paths must be relative and start with "${API_PATH_PREFIX}" (got "${path}")`,
    );
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
  EMAIL_DOMAIN_UNRESOLVABLE: true,
  EMAIL_DOMAIN_CHECK_UNAVAILABLE: true,
  REAUTH_LOCKED: true,
  SESSION_REVOKED_PASSWORD_CHANGED: true,
} satisfies Record<Exclude<ApiErrorCode, "NETWORK_ERROR">, true>);

const DEPLOY_ENGINE_ERROR_CODE_MARKER = Object.freeze({
  PROJECT_NAME_TAKEN: true,
  ENVIRONMENT_NAME_TAKEN: true,
  ENVIRONMENT_NOT_EMPTY: true,
  PROJECT_NOT_ARCHIVED: true,
  DELETE_CONFIRMATION_MISMATCH: true,
  SERVICE_INPUT_INVALID: true,
  SERVICE_NAME_TAKEN: true,
  PORT_IN_USE: true,
  SERVER_DOCKER_UNAVAILABLE: true,
  SERVER_BUILDKIT_UNAVAILABLE: true,
  CREDENTIAL_SOURCE_MISMATCH: true,
  SERVICE_CREDENTIAL_INVALID: true,
  SERVER_HAS_SERVICES: true,
  DEPLOYMENT_IN_PROGRESS: true,
  PROJECT_ARCHIVED: true,
  DEPLOYMENT_INPUT_INVALID: true,
  DEPLOYMENT_NOT_CANCELLABLE: true,
  SERVICE_OPERATION_INVALID: true,
  SERVICE_NOT_DEPLOYED: true,
  SERVICE_OPERATION_IN_PROGRESS: true,
  SERVER_UNREACHABLE: true,
  SERVICE_CLEANUP_FAILED: true,
  CONTAINER_NOT_FOUND: true,
  RUNTIME_LOG_TAIL_INVALID: true,
  RUNTIME_LOG_FOLLOW_LIMIT_REACHED: true,
  RUNTIME_LOGS_FAILED: true,
  RUNTIME_LOGS_TIMEOUT: true,
} satisfies Record<DeployEngineErrorCode, true>);

const KNOWN_SERVICE_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.keys(API_ERROR_CODE_MARKER),
);
const KNOWN_DEPLOY_API_ERROR_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(API_ERROR_CODE_MARKER),
  ...Object.keys(DEPLOY_ENGINE_ERROR_CODE_MARKER),
]);

/** Test-only drift surface: every recognised code, typed back to the exact union it was derived
 *  from. `Object.keys` itself only returns `string[]` -- the cast is narrowing back to what
 *  `API_ERROR_CODE_MARKER`'s own `satisfies` clause already proved true of every one of its keys. */
export const ALL_KNOWN_SERVICE_ERROR_CODES = Object.keys(
  API_ERROR_CODE_MARKER,
) as readonly Exclude<ApiErrorCode, "NETWORK_ERROR">[];

/** Test-only drift surface for the deploy-engine list, same cast rationale as above. */
export const ALL_DEPLOY_ENGINE_ERROR_CODES = Object.keys(
  DEPLOY_ENGINE_ERROR_CODE_MARKER,
) as readonly DeployEngineErrorCode[];

/** Which code list a call parses failures against: `core` for the existing screens, `deploy` for
 *  deploy-api.ts. A code outside the list folds to INTERNAL_ERROR (or UNAUTHORIZED on a 401). */
type CodeVocabulary = "core" | "deploy";

function isKnownCode(
  value: unknown,
  vocabulary: CodeVocabulary,
): value is string {
  const known =
    vocabulary === "deploy"
      ? KNOWN_DEPLOY_API_ERROR_CODES
      : KNOWN_SERVICE_ERROR_CODES;
  return typeof value === "string" && known.has(value);
}

function isApiIssueShape(value: unknown): value is ApiIssue {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" && typeof candidate.message === "string"
  );
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
  const header = response.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

const GENERIC_FAILURE_MESSAGE = "Something went wrong. Try again.";
const NETWORK_FAILURE_MESSAGE =
  "Could not reach the server. Check your connection and try again.";
const GENERIC_ISSUE_MESSAGE = "This value is not valid.";

/** A validator rule code such as `token_too_long`: short, no spaces, never free text. */
const SAFE_REASON_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Shorter submitted strings are not treated as secrets when scrubbing (they would match almost
 *  any message); the server rejects credentials that short anyway. */
const MIN_SECRET_LENGTH = 4;

interface RawFailureBody {
  readonly error?: unknown;
  readonly message?: unknown;
  readonly issues?: unknown;
  readonly reason?: unknown;
}

export interface ApiRequestOptions {
  /** A caller's own cancellation; composed with the request timeout, never replacing it. */
  readonly signal?: AbortSignal;
  /** Set on credential writes (13-05 H1): the body is treated as secret, and any failure text that
   *  echoes one of its strings is replaced with fixed copy before it reaches the caller. */
  readonly sensitive?: boolean;
}

/** Every string leaf of a request body, for the sensitive-request echo check. Kept local to one
 *  call: never stored, logged or attached to a result. */
function collectSecretStrings(
  body: unknown,
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > 8) return out;
  if (typeof body === "string") {
    if (body.length >= MIN_SECRET_LENGTH) out.push(body);
  } else if (Array.isArray(body)) {
    for (const entry of body as unknown[])
      collectSecretStrings(entry, out, depth + 1);
  } else if (typeof body === "object" && body !== null) {
    for (const value of Object.values(body))
      collectSecretStrings(value, out, depth + 1);
  }
  return out;
}

function echoesSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => text.includes(secret));
}

/** Parses a non-2xx response into the fixed ApiFailure vocabulary. `secrets` (sensitive requests
 *  only) are the submitted strings: a message, issue or reason that contains one is replaced with
 *  fixed copy, so a server or proxy echoing the credential never reaches the UI. */
async function parseFailure(
  response: Response,
  secrets: readonly string[],
  vocabulary: CodeVocabulary,
): Promise<ApiFailure<string>> {
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
      code: unauthorized ? "UNAUTHORIZED" : "INTERNAL_ERROR",
      message: GENERIC_FAILURE_MESSAGE,
      unauthorized,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }

  const raw: RawFailureBody =
    typeof parsed === "object" && parsed !== null ? parsed : {};
  const code = isKnownCode(raw.error, vocabulary)
    ? raw.error
    : unauthorized
      ? "UNAUTHORIZED"
      : "INTERNAL_ERROR";
  const message =
    typeof raw.message === "string" && !echoesSecret(raw.message, secrets)
      ? raw.message
      : GENERIC_FAILURE_MESSAGE;
  const issues = parseIssues(raw.issues)?.map((issue) => ({
    path: echoesSecret(issue.path, secrets) ? "" : issue.path,
    message: echoesSecret(issue.message, secrets)
      ? GENERIC_ISSUE_MESSAGE
      : issue.message,
  }));
  const reason =
    typeof raw.reason === "string" &&
    SAFE_REASON_PATTERN.test(raw.reason) &&
    !echoesSecret(raw.reason, secrets)
      ? raw.reason
      : undefined;

  return {
    ok: false,
    code,
    message,
    unauthorized,
    ...(issues === undefined ? {} : { issues }),
    ...(reason === undefined ? {} : { reason }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

export function toApiFailure(
  response: Response,
  secrets: readonly string[] = [],
): Promise<ApiFailure> {
  return parseFailure(response, secrets, "core") as Promise<ApiFailure>;
}

/** toApiFailure against the deploy-engine vocabulary (runtime-log-stream.ts). */
export function toDeployApiFailure(
  response: Response,
  secrets: readonly string[] = [],
): Promise<ApiFailure<DeployApiErrorCode>> {
  return parseFailure(response, secrets, "deploy") as Promise<
    ApiFailure<DeployApiErrorCode>
  >;
}

/** The failure every unreachable-server case resolves to: offline, DNS, timeout, a dropped body. */
export function networkFailure(): ApiFailure {
  return {
    ok: false,
    code: "NETWORK_ERROR",
    message: NETWORK_FAILURE_MESSAGE,
    unauthorized: false,
  };
}

function internalFailure(): ApiFailure {
  return {
    ok: false,
    code: "INTERNAL_ERROR",
    message: GENERIC_FAILURE_MESSAGE,
    unauthorized: false,
  };
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

// A caller-supplied signal must never be silently discarded once this timeout is added --
// `AbortSignal.any` composes both so either one aborting the request still aborts it.
function composeSignal(
  callerSignal: AbortSignal | null | undefined,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(API_REQUEST_TIMEOUT_MS);
  if (callerSignal === null || callerSignal === undefined) {
    return timeoutSignal;
  }
  return AbortSignal.any([callerSignal, timeoutSignal]);
}

// Exactly one fetch per call: no retry on timeout, network failure or 401 (13-05 H2). A deploy or
// cancel POST is not idempotent, and a 401 is the caller's cue to send the user to /login.
async function performRequest<T>(
  path: string,
  init: RequestInit,
  options: ApiRequestOptions,
  secrets: readonly string[],
  vocabulary: CodeVocabulary,
): Promise<ApiResult<T, string>> {
  assertRelativeApiPath(path);

  const signal = composeSignal(options.signal);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal,
    });
  } catch {
    // Never echo the rejected fetch's own Error.message -- it can carry environment-specific
    // detail (e.g. a resolver's internal hostname) that has no business reaching a rendered UI.
    // This also catches the AbortError `fetch` throws once `API_REQUEST_TIMEOUT_MS` elapses (or a
    // caller-supplied signal aborts) -- an abort is just another unreachable-server case from the
    // caller's point of view, never a distinct code or an echoed "AbortError" string.
    return networkFailure();
  }

  if (!response.ok) {
    try {
      return await parseFailure(response, secrets, vocabulary);
    } catch {
      return networkFailure();
    }
  }

  try {
    const text = await response.text();
    const data = (text === "" ? undefined : JSON.parse(text)) as T;
    return { ok: true, data };
  } catch (error) {
    // A body cut mid-read (timeout, dropped connection) is unreachable; a 2xx that is not JSON is
    // a server fault. Neither escapes as a rejection.
    return isAbortLike(error) || error instanceof TypeError
      ? networkFailure()
      : internalFailure();
  }
}

export type ApiSendMethod = "POST" | "PUT" | "PATCH" | "DELETE";

async function sendRequest<T>(
  method: ApiSendMethod,
  path: string,
  body: unknown,
  options: ApiRequestOptions,
  vocabulary: CodeVocabulary,
): Promise<ApiResult<T, string>> {
  assertRelativeApiPath(path);
  const init: RequestInit = { method };
  if (body !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch {
      // A body that cannot be serialized is a caller bug; resolve, never reject, and never quote it.
      return internalFailure();
    }
    init.headers = { "Content-Type": "application/json" };
    init.body = serialized;
  }
  const secrets = options.sensitive === true ? collectSecretStrings(body) : [];
  return performRequest<T>(path, init, options, secrets, vocabulary);
}

export function apiGet<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
  return performRequest<T>(
    path,
    { method: "GET" },
    options,
    [],
    "core",
  ) as Promise<ApiResult<T>>;
}

export function apiSend<T>(
  method: ApiSendMethod,
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
  return sendRequest<T>(method, path, body, options, "core") as Promise<
    ApiResult<T>
  >;
}

/** apiGet for deploy-api.ts: same transport, failures parsed against `DeployApiErrorCode`. */
export function deployApiGet<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T, DeployApiErrorCode>> {
  return performRequest<T>(
    path,
    { method: "GET" },
    options,
    [],
    "deploy",
  ) as Promise<ApiResult<T, DeployApiErrorCode>>;
}

/** apiSend for deploy-api.ts: same transport, failures parsed against `DeployApiErrorCode`. */
export function deployApiSend<T>(
  method: ApiSendMethod,
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T, DeployApiErrorCode>> {
  return sendRequest<T>(method, path, body, options, "deploy") as Promise<
    ApiResult<T, DeployApiErrorCode>
  >;
}
