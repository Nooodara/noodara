// Zod-validated env, fail-fast at boot (INST-06, PITFALLS.md #1, RESEARCH "Zod-validated env,
// fail-fast at boot"). `parseEnv` is a pure function so the whole matrix is unit-testable with no
// process manipulation; `loadEnv` is the only place that touches `process.stderr`/`process.exit`;
// `env` at the bottom of this file is the only call site that reads `process.env`.
//
// Security-critical variables (NOODARA_MASTER_KEY, BETTER_AUTH_SECRET, DATABASE_URL, REDIS_URL,
// NOODARA_PUBLIC_URL) carry no `.default()`, no `??`, no `||` anywhere in this module — only the
// tuning knobs below may have defaults (D-05, D-07, D-08).

type EnvSource = Record<string, string | undefined>;

/**
 * A base64-encoded 32-byte master key that has passed `parseEnv`'s validation. Distinct from a
 * bare `string` per the noodara-security skill's rule that a secret is never a loose `string`.
 */
export type MasterKeyBase64 = string & { readonly __brand: 'MasterKeyBase64' };

export interface Env {
  NOODARA_MASTER_KEY: MasterKeyBase64;
  NOODARA_MASTER_KEY_PREVIOUS?: MasterKeyBase64;
  BETTER_AUTH_SECRET: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  NOODARA_PUBLIC_URL: string;
  NOODARA_ADMIN_EMAIL?: string;
  NOODARA_ADMIN_PASSWORD?: string;
  NOODARA_SESSION_SLIDING_SECONDS: number;
  NOODARA_SESSION_UPDATE_AGE_SECONDS: number;
  NOODARA_SESSION_ABSOLUTE_SECONDS: number;
  NOODARA_LOGIN_MAX_ATTEMPTS: number;
  NOODARA_LOGIN_WINDOW_SECONDS: number;
  NOODARA_LOGIN_BACKOFF_MAX_SECONDS: number;
  NOODARA_COOKIE_INSECURE: boolean;
  PORT: number;
  LOG_LEVEL: string;
}

/**
 * Never carries a `received` field: echoing a rejected secret into a failure report (stderr, CI
 * logs) is itself a leak (RESEARCH threat T-1-06).
 */
export interface EnvIssue {
  variable: string;
  requirement: string;
}

export type EnvParseResult = { ok: true; value: Env } | { ok: false; issues: EnvIssue[] };

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const WEAK_SECRETS = new Set(['changeme', 'secret', 'password', 'noodara']);
const WEAK_DB_PASSWORDS = new Set(['postgres', 'password', 'changeme']);

function isValidBase64(value: string): boolean {
  return value.length > 0 && BASE64_PATTERN.test(value);
}

function decodedByteLength(value: string): number {
  return Buffer.from(value, 'base64').length;
}

function validateMasterKey(
  variable: string,
  value: string | undefined,
  issues: EnvIssue[],
): MasterKeyBase64 | undefined {
  if (value === undefined || value.length === 0) {
    issues.push({ variable, requirement: `${variable} is required: 32 raw bytes, base64-encoded` });
    return undefined;
  }
  if (!isValidBase64(value)) {
    issues.push({ variable, requirement: `${variable} must be valid base64` });
    return undefined;
  }
  if (decodedByteLength(value) !== 32) {
    issues.push({ variable, requirement: `${variable} must decode to exactly 32 bytes` });
    return undefined;
  }
  return value as MasterKeyBase64;
}

function validateBetterAuthSecret(value: string | undefined, issues: EnvIssue[]): string | undefined {
  const variable = 'BETTER_AUTH_SECRET';
  if (value === undefined || value.length === 0) {
    issues.push({
      variable,
      requirement: `${variable} is required: at least 32 characters, not a known placeholder`,
    });
    return undefined;
  }
  if (WEAK_SECRETS.has(value.toLowerCase())) {
    issues.push({ variable, requirement: `${variable} must not be a placeholder value` });
    return undefined;
  }
  if (value.length < 32) {
    issues.push({ variable, requirement: `${variable} must be at least 32 characters` });
    return undefined;
  }
  return value;
}

function validateDatabaseUrl(value: string | undefined, issues: EnvIssue[]): string | undefined {
  const variable = 'DATABASE_URL';
  if (value === undefined || value.length === 0) {
    issues.push({
      variable,
      requirement: `${variable} is required: a valid connection string with a non-placeholder password`,
    });
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push({ variable, requirement: `${variable} must be a valid URL` });
    return undefined;
  }
  const password = decodeURIComponent(parsed.password);
  if (password.length === 0) {
    issues.push({ variable, requirement: `${variable} must include a non-empty password` });
    return undefined;
  }
  if (WEAK_DB_PASSWORDS.has(password.toLowerCase())) {
    issues.push({ variable, requirement: `${variable} must not use a placeholder password` });
    return undefined;
  }
  return value;
}

function validateRequiredString(
  variable: string,
  value: string | undefined,
  issues: EnvIssue[],
): string | undefined {
  if (value === undefined || value.length === 0) {
    issues.push({ variable, requirement: `${variable} is required` });
    return undefined;
  }
  return value;
}

function validateAdminPair(
  email: string | undefined,
  password: string | undefined,
  issues: EnvIssue[],
): void {
  const hasEmail = email !== undefined && email.length > 0;
  const hasPassword = password !== undefined && password.length > 0;
  if (hasEmail !== hasPassword) {
    const variable = hasEmail ? 'NOODARA_ADMIN_PASSWORD' : 'NOODARA_ADMIN_EMAIL';
    issues.push({
      variable,
      requirement: 'NOODARA_ADMIN_EMAIL and NOODARA_ADMIN_PASSWORD must both be set, or neither (D-04)',
    });
  }
}

function parseTuningInt(
  variable: string,
  value: string | undefined,
  fallback: number,
  issues: EnvIssue[],
): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    issues.push({ variable, requirement: `${variable} must be an integer` });
    return fallback;
  }
  return parsed;
}

function parseTuningBool(
  variable: string,
  value: string | undefined,
  fallback: boolean,
  issues: EnvIssue[],
): boolean {
  if (value === undefined || value.length === 0) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  issues.push({ variable, requirement: `${variable} must be "true" or "false"` });
  return fallback;
}

function parseTuningString(value: string | undefined, fallback: string): string {
  return value === undefined || value.length === 0 ? fallback : value;
}

/** Narrows `T | undefined` to `T` after the caller has already confirmed no issues were raised. */
function assertDefined<T>(value: T | undefined): T {
  return value as T;
}

export function parseEnv(source: EnvSource): EnvParseResult {
  const issues: EnvIssue[] = [];

  const masterKey = validateMasterKey('NOODARA_MASTER_KEY', source.NOODARA_MASTER_KEY, issues);
  const masterKeyPrevious =
    source.NOODARA_MASTER_KEY_PREVIOUS === undefined
      ? undefined
      : validateMasterKey('NOODARA_MASTER_KEY_PREVIOUS', source.NOODARA_MASTER_KEY_PREVIOUS, issues);
  const betterAuthSecret = validateBetterAuthSecret(source.BETTER_AUTH_SECRET, issues);
  const databaseUrl = validateDatabaseUrl(source.DATABASE_URL, issues);
  const redisUrl = validateRequiredString('REDIS_URL', source.REDIS_URL, issues);
  const publicUrl = validateRequiredString('NOODARA_PUBLIC_URL', source.NOODARA_PUBLIC_URL, issues);
  validateAdminPair(source.NOODARA_ADMIN_EMAIL, source.NOODARA_ADMIN_PASSWORD, issues);

  const sessionSliding = parseTuningInt(
    'NOODARA_SESSION_SLIDING_SECONDS',
    source.NOODARA_SESSION_SLIDING_SECONDS,
    604800,
    issues,
  );
  const sessionUpdateAge = parseTuningInt(
    'NOODARA_SESSION_UPDATE_AGE_SECONDS',
    source.NOODARA_SESSION_UPDATE_AGE_SECONDS,
    86400,
    issues,
  );
  const sessionAbsolute = parseTuningInt(
    'NOODARA_SESSION_ABSOLUTE_SECONDS',
    source.NOODARA_SESSION_ABSOLUTE_SECONDS,
    2592000,
    issues,
  );
  const loginMaxAttempts = parseTuningInt(
    'NOODARA_LOGIN_MAX_ATTEMPTS',
    source.NOODARA_LOGIN_MAX_ATTEMPTS,
    5,
    issues,
  );
  const loginWindowSeconds = parseTuningInt(
    'NOODARA_LOGIN_WINDOW_SECONDS',
    source.NOODARA_LOGIN_WINDOW_SECONDS,
    900,
    issues,
  );
  const loginBackoffMaxSeconds = parseTuningInt(
    'NOODARA_LOGIN_BACKOFF_MAX_SECONDS',
    source.NOODARA_LOGIN_BACKOFF_MAX_SECONDS,
    86400,
    issues,
  );
  const cookieInsecure = parseTuningBool(
    'NOODARA_COOKIE_INSECURE',
    source.NOODARA_COOKIE_INSECURE,
    false,
    issues,
  );
  const port = parseTuningInt('PORT', source.PORT, 3000, issues);
  const logLevel = parseTuningString(source.LOG_LEVEL, 'info');

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      NOODARA_MASTER_KEY: assertDefined(masterKey),
      ...(masterKeyPrevious !== undefined ? { NOODARA_MASTER_KEY_PREVIOUS: masterKeyPrevious } : {}),
      BETTER_AUTH_SECRET: assertDefined(betterAuthSecret),
      DATABASE_URL: assertDefined(databaseUrl),
      REDIS_URL: assertDefined(redisUrl),
      NOODARA_PUBLIC_URL: assertDefined(publicUrl),
      ...(source.NOODARA_ADMIN_EMAIL !== undefined ? { NOODARA_ADMIN_EMAIL: source.NOODARA_ADMIN_EMAIL } : {}),
      ...(source.NOODARA_ADMIN_PASSWORD !== undefined
        ? { NOODARA_ADMIN_PASSWORD: source.NOODARA_ADMIN_PASSWORD }
        : {}),
      NOODARA_SESSION_SLIDING_SECONDS: sessionSliding,
      NOODARA_SESSION_UPDATE_AGE_SECONDS: sessionUpdateAge,
      NOODARA_SESSION_ABSOLUTE_SECONDS: sessionAbsolute,
      NOODARA_LOGIN_MAX_ATTEMPTS: loginMaxAttempts,
      NOODARA_LOGIN_WINDOW_SECONDS: loginWindowSeconds,
      NOODARA_LOGIN_BACKOFF_MAX_SECONDS: loginBackoffMaxSeconds,
      NOODARA_COOKIE_INSECURE: cookieInsecure,
      PORT: port,
      LOG_LEVEL: logLevel,
    },
  };
}

/**
 * Parses `source`; on failure, writes one `NOODARA_CONFIG_ERROR <VAR>: <requirement>` line per
 * issue to stderr and exits the process before anything else (Fastify, the DB pool, etc.) starts.
 */
export function loadEnv(source: EnvSource): Env {
  const result = parseEnv(source);
  if (!result.ok) {
    for (const issue of result.issues) {
      process.stderr.write(`NOODARA_CONFIG_ERROR ${issue.variable}: ${issue.requirement}\n`);
    }
    process.exit(1);
  }
  return result.value;
}

export const env = loadEnv(process.env);
