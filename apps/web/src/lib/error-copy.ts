// 05-UI-SPEC.md's copy deck (SS5.1, SS5.4) turned into one exhaustive, tested map -- every
// user-facing error string in apps/web is sourced from this file, never invented ad hoc at a call
// site (this plan's own objective: "the single source of user-facing error text for the whole
// app"). `ServiceErrorCode` reuses api-client.ts's own hand-copied `ApiErrorCode` union (minus
// `NETWORK_ERROR`, a client-only case with no server-side code) rather than a second, independent
// copy of it, and never imports across the apps/web/apps/control-plane boundary -- api-client.ts's
// own documented rule (apps/web must never depend on a control-plane-internal module in the
// browser bundle) applies here too. `ServerErrorCode` is the real, importable union from
// `@noodara/domain/server` (pure, already an apps/web dependency), matching the precedent
// packages/ui/src/tone.ts already set for importing domain unions instead of re-typing them.
import type { ServerErrorCode } from '@noodara/domain/server';
import type { ApiErrorCode, ApiIssue } from './api-client';

export type ServiceErrorCode = Exclude<ApiErrorCode, 'NETWORK_ERROR'>;

// 05-UI-SPEC.md SS5.4, verbatim. Entries carrying a literal "{token}" placeholder (NAME_TAKEN,
// HOST_TAKEN, CONFIRMATION_MISMATCH) are returned unsubstituted -- the caller that has the real
// name/host/port value performs its own replacement (no call site in this plan needs one yet; the
// server sheet and destructive-dialog plans that do own that substitution). ALREADY_CONNECTING and
// SSE_LIMIT_REACHED are deliberately empty strings: SS5.4 marks both "not an error"/"not a
// blocking toast" with no fixed copy of their own (see 05-UI-SPEC.md SS6 Real-Time Behavior) --
// callers must not render either as a toast.
const SERVICE_ERROR_COPY = {
  VALIDATION_FAILED: 'Check the highlighted fields and try again.',
  INVALID_CREDENTIAL: 'This credential could not be parsed. Check the key format (or password) and try again.',
  UNAUTHORIZED: 'Your session ended. Sign in again.',
  FORBIDDEN_ORIGIN: 'Request blocked for security reasons. Reload the page and try again.',
  NOT_FOUND: 'This server no longer exists.',
  NAME_TAKEN: 'A server named "{name}" already exists.',
  HOST_TAKEN: 'A server at {host}:{port} is already registered.',
  SERVER_BUSY: 'This server has a connection or edit in progress. Try again in a moment.',
  ALREADY_CONNECTING: '',
  SERVER_NOT_CONNECTED: 'Connect the server before running discovery.',
  NO_PENDING_FINGERPRINT: "There's no fingerprint change to trust.",
  // Gap 6 / T-5G-31-04 (05-31-PLAN.md) -- 05-UI-SPEC.md SS5.4 has no row for either of these two
  // codes yet (they did not exist until plan 05-27's backend contract). Written in the same calm,
  // states-what-happened-and-what-to-do voice as the rest of this table; no fingerprint value, host
  // or "{token}" placeholder -- both render at the dialog/banner level, never inline.
  FINGERPRINT_MISMATCH: 'The observed fingerprint changed since you opened this dialog. Review the new value before trusting.',
  SERVER_NOT_TRUSTABLE: "There's nothing to trust in this server's current state.",
  CONFIRMATION_MISMATCH: 'That doesn\'t match. Type "{name}" exactly to continue.',
  QUEUE_UNAVAILABLE: 'The connection queue is temporarily unavailable. Try again in a few seconds.',
  SSE_LIMIT_REACHED: '',
  INTERNAL_ERROR: 'Something went wrong on our end. Try again, and check the server logs if it continues.',
} as const satisfies Record<ServiceErrorCode, string>;

/** The exact SS5.4 copy for `code` -- a table lookup only, never a switch with a `default` that
 *  would invent text for a code this file forgot to route. A new `ServiceErrorCode` is a
 *  compile-time error here (the `satisfies Record<...>` above), never a silent runtime fallback. */
export function copyForErrorCode(code: ServiceErrorCode): string {
  return SERVICE_ERROR_COPY[code];
}

export type ErrorFormField = 'name' | 'host' | 'credential';

// SS2.4's per-field routing: NAME_TAKEN/HOST_TAKEN/INVALID_CREDENTIAL are the only three
// ServiceErrorCodes with a fixed form-field destination -- every other code renders as a banner or
// toast, never inline under a specific field.
const ERROR_CODE_FIELD: Partial<Record<ServiceErrorCode, ErrorFormField>> = {
  NAME_TAKEN: 'name',
  HOST_TAKEN: 'host',
  INVALID_CREDENTIAL: 'credential',
};

/** Which form field `code` routes to, or `null` for a code with no fixed field (render it as a
 *  banner/toast instead). */
export function fieldForErrorCode(code: ServiceErrorCode): ErrorFormField | null {
  return ERROR_CODE_FIELD[code] ?? null;
}

// The full set of form-field keys any screen in this phase's forms can submit an issue against --
// `normalizeFieldPath` is the only place that turns a raw backend issue path into one of these
// keys. An issue that normalizes to a key not in this set (or to `null`) is dropped rather than
// rendered -- a future backend field must never surface under a field this UI never built
// (05-UI-SPEC.md SS10's "never echo raw input" discipline extended to validation issue paths, not
// just error bodies).
export const KNOWN_FORM_FIELD_PATHS: ReadonlySet<string> = new Set([
  'token',
  'email',
  'password',
  'name',
  'host',
  'sshPort',
  'sshUser',
  'credential',
]);

// The real control plane emits AJV-shaped `instancePath` issue paths (`toValidationErrorBody` in
// apps/control-plane/src/routes/http-errors.ts), never a bare field name: a top-level field is
// `/name`, and the nested credential discriminated union is `/credential/privateKey`,
// `/credential/passphrase`, `/credential/type`, or the bare `/credential` itself when the whole
// object fails. This is empirically confirmed (not guessed) by invoking the real
// `@fastify/type-provider-zod` `validatorCompiler` against `CreateServerBodySchema` directly, and
// matches `http-errors.test.ts`'s own literal fixtures.
//
// `CredentialFields.tsx` renders one shared inline error for the whole credential block --
// `ServerFormErrors` (apps/web/src/lib/server-form.ts) has a single `credential` key, never a
// separate `privateKey`/`passphrase`/`password` field -- so every backend path under
// `/credential` (bare, or with any nested segment) collapses onto that one form key.
const CREDENTIAL_PATH_PREFIX = 'credential';

/** Converts a backend `instancePath`-style issue path into the form field key that would render
 *  it, or `null` when this UI built no field for that path. Total (never throws) and
 *  intentionally not injective for the credential block only -- every other path segment maps
 *  1:1 onto its own form key. */
export function normalizeFieldPath(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const [first] = segments;
  if (first === undefined) return null;

  const candidate = first === CREDENTIAL_PATH_PREFIX ? CREDENTIAL_PATH_PREFIX : segments.length === 1 ? first : null;

  return candidate !== null && KNOWN_FORM_FIELD_PATHS.has(candidate) ? candidate : null;
}

/** Maps `ApiFailure.issues` (from a `VALIDATION_FAILED` body) to a `{ formKey: message }` record a
 *  `Field`'s `error` prop can read directly, routing every raw backend path through
 *  `normalizeFieldPath` first. The first message wins when two issues normalize to the same form
 *  key; an issue that normalizes to `null` is silently dropped, never rendered under a field the
 *  caller never built. */
export function fieldErrorsFromIssues(issues: readonly ApiIssue[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const issue of issues) {
    const field = normalizeFieldPath(issue.path);
    if (field === null) continue;
    if (field in result) continue;
    result[field] = issue.message;
  }

  return result;
}

// 05-UI-SPEC.md SS5.1, verbatim, with "{host}"/"{sshPort}" placeholders substituted by
// `copyForServerErrorCode` below. HOST_KEY_CHANGED carries no generic text here (an empty string
// is never returned to a caller -- `copyForServerErrorCode` throws instead of reaching this
// table's value for that one code) since SS5.1 requires it to always render the dedicated SS5.3
// banner, never this generic map.
const SERVER_ERROR_TEMPLATE = {
  AUTH_FAILED: 'Authentication failed. Check the SSH username and credential, then try again.',
  HOST_UNRESOLVED: 'Could not resolve {host}. Check the hostname or IP address and try again.',
  CONNECT_TIMEOUT: 'Connection timed out. Check that port {sshPort} is open on {host}.',
  COMMAND_TIMEOUT:
    'Discovery timed out while running a command. The server may be slow or unresponsive — try again.',
  HOST_KEY_CHANGED: '',
  CONNECTION_LOST: "The connection was lost while Noodara was working. Check the server's network and try again.",
  UNSUPPORTED_OS: 'Outside the supported matrix (Ubuntu 22.04/24.04). Some features may not work as expected.',
} as const satisfies Record<ServerErrorCode, string>;

export interface ServerErrorContext {
  readonly host: string;
  readonly sshPort: number;
}

/** The exact SS5.1 copy for `code`, with `{host}`/`{sshPort}` substituted from `context`. Throws
 *  for `HOST_KEY_CHANGED` -- SS5.1 marks it "see D-03 dedicated banner below -- never the generic
 *  banner", so this function signals that explicitly rather than ever returning empty/generic
 *  text a caller could accidentally render. */
export function copyForServerErrorCode(code: ServerErrorCode, context: ServerErrorContext): string {
  if (code === 'HOST_KEY_CHANGED') {
    throw new Error(
      'copyForServerErrorCode: HOST_KEY_CHANGED has no generic copy -- render the dedicated banner (05-UI-SPEC.md SS5.3) instead.',
    );
  }

  return SERVER_ERROR_TEMPLATE[code]
    .replaceAll('{host}', context.host)
    .replaceAll('{sshPort}', String(context.sshPort));
}

const RETRY_AFTER_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

const RETRY_AFTER_UNITS: readonly [unitSeconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [86400, 'day'],
  [3600, 'hour'],
  [60, 'minute'],
];

/** 05-UI-SPEC.md SS2.2's lockout banner ("Too many attempts. Try again {duration}.") -- renders a
 *  `Retry-After` seconds count as a relative duration ("in 2 minutes"), never the raw seconds
 *  count. Below a full minute renders whole seconds; non-finite or non-positive input degrades to
 *  a generic "in a moment" rather than a negative or nonsensical duration. A dedicated local
 *  formatter (not `@noodara/ui`'s `formatRelativeTime`, whose "just now" sub-60-second bucket
 *  would misrender a genuine wait as if no wait were needed at all). */
export function formatRetryAfterDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'in a moment';
  }

  const whole = Math.round(seconds);

  for (const [unitSeconds, unit] of RETRY_AFTER_UNITS) {
    if (whole >= unitSeconds) {
      return RETRY_AFTER_FORMATTER.format(Math.round(whole / unitSeconds), unit);
    }
  }

  return RETRY_AFTER_FORMATTER.format(whole, 'second');
}
