// Zod-validated env, fail-fast at boot (INST-06, PITFALLS.md #1, RESEARCH "Zod-validated env,
// fail-fast at boot"). `parseEnv` is a pure function so the whole matrix is unit-testable with no
// process manipulation; `loadEnv` is the only place that touches `process.stderr`/`process.exit`;
// `env` at the bottom of this file is the only call site that reads `process.env`.
//
// Security-critical variables (NOODARA_MASTER_KEY, BETTER_AUTH_SECRET, DATABASE_URL, REDIS_URL,
// NOODARA_PUBLIC_URL) carry no `.default()`, no `??`, no `||` anywhere in this module — only the
// tuning knobs below may have defaults (D-05, D-07, D-08).

import { DEPLOY_MAX_MS_DEFAULT, DEPLOY_MAX_MS_RANGE } from './queue/deploy-job-budget.js';

type EnvSource = Record<string, string | undefined>;

/**
 * Per-line cap applied before a build-log line is persisted (research: 16 KiB, UTF-8-safe
 * truncation in the domain chunker). Bounds NOODARA_DEPLOY_LOG_FLUSH_BYTES from above and
 * NOODARA_DEPLOY_LOG_MAX_BYTES from below.
 */
export const DEPLOY_LOG_LINE_MAX_BYTES = 16_384;

/** Phase 12 deploy-engine knobs; each one is in turbo.json passThroughEnv and .env.example. */
export const DEPLOY_ENV_KNOBS = [
  'NOODARA_DEPLOY_MAX_MS',
  'NOODARA_DEPLOY_IDLE_MS',
  'NOODARA_DEPLOY_CONCURRENCY',
  'NOODARA_DEPLOY_LOG_MAX_BYTES',
  'NOODARA_DEPLOY_LOG_FLUSH_MS',
  'NOODARA_DEPLOY_LOG_FLUSH_BYTES',
  'NOODARA_DEPLOY_LOG_RETENTION_DAYS',
  'NOODARA_RECONCILE_INTERVAL_MS',
  'NOODARA_RUNTIME_LOG_TAIL',
  'NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS',
  'NOODARA_DEPLOY_QUEUED_STALE_MS',
] as const;

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
  // T-1-40: the per-IP login-lockout counter (Plan 01-13) only honours a forwarded-address header
  // when this is explicitly enabled — otherwise it is attacker-controlled and would let a
  // distributed attacker rotate through fake X-Forwarded-For values to dodge the per-IP scope.
  NOODARA_TRUST_PROXY: boolean;
  // D-08/D-09: the three SSH adapter timeout knobs (packages/ssh's SshTimeouts). Validated here
  // with explicit ranges and passed to the adapter by parameter — packages/ssh never reads
  // process.env itself.
  NOODARA_SSH_CONNECT_TIMEOUT_MS: number;
  NOODARA_SSH_COMMAND_TIMEOUT_MS: number;
  NOODARA_SSH_DISCOVERY_TIMEOUT_MS: number;
  // D-24: global worker concurrency for the BullMQ `servers` queue. Per-server concurrency is
  // guaranteed by the row lock in connectAndDiscover (fase 3 D-05) plus the deterministic jobId
  // (D-09), not by this knob.
  NOODARA_WORKER_CONCURRENCY: number;
  // D-07: max simultaneous SSE connections per API process; exceeding it returns 503 rather than
  // accumulating unbounded open sockets.
  NOODARA_SSE_MAX_CONNECTIONS: number;
  // Phase 12 deploy engine (D15 timeouts, D16 concurrency, D8 runtime logs). Research defaults,
  // to be confirmed by measurement in 12-19.
  NOODARA_DEPLOY_MAX_MS: number;
  NOODARA_DEPLOY_IDLE_MS: number;
  NOODARA_DEPLOY_CONCURRENCY: number;
  NOODARA_DEPLOY_LOG_MAX_BYTES: number;
  NOODARA_DEPLOY_LOG_FLUSH_MS: number;
  NOODARA_DEPLOY_LOG_FLUSH_BYTES: number;
  NOODARA_DEPLOY_LOG_RETENTION_DAYS: number;
  NOODARA_RECONCILE_INTERVAL_MS: number;
  NOODARA_RUNTIME_LOG_TAIL: number;
  NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS: number;
  NOODARA_DEPLOY_QUEUED_STALE_MS: number;
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

interface TuningIntRange {
  readonly min: number;
  readonly max: number;
  /** Replaces the generic message when the value is below `min` (a named rule, e.g. a cap). */
  readonly belowMinRequirement?: string;
  /** Replaces the generic message when the value is above `max` (a named rule, e.g. a cap). */
  readonly aboveMaxRequirement?: string;
}

function parseTuningInt(
  variable: string,
  value: string | undefined,
  fallback: number,
  issues: EnvIssue[],
  range?: TuningIntRange,
): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    issues.push({
      variable,
      requirement:
        range === undefined
          ? `${variable} must be an integer`
          : `${variable} must be an integer between ${String(range.min)} and ${String(range.max)}`,
    });
    return fallback;
  }
  if (range !== undefined && (parsed < range.min || parsed > range.max)) {
    const named = parsed < range.min ? range.belowMinRequirement : range.aboveMaxRequirement;
    issues.push({
      variable,
      requirement: named ?? `${variable} must be between ${String(range.min)} and ${String(range.max)}`,
    });
    return fallback;
  }
  return parsed;
}

/**
 * D15: the idle timeout (no output → BUILD_STALLED) only means something inside the hard max
 * (→ BUILD_TIMEOUT); an idle budget longer than the whole run would never fire. Reported against
 * the idle variable, since it is the one that must fit inside the max.
 */
function validateDeployTimeoutCoherence(deployMaxMs: number, deployIdleMs: number, issues: EnvIssue[]): void {
  if (deployIdleMs > deployMaxMs) {
    issues.push({
      variable: 'NOODARA_DEPLOY_IDLE_MS',
      requirement: 'NOODARA_DEPLOY_IDLE_MS must be less than or equal to NOODARA_DEPLOY_MAX_MS (D15)',
    });
  }
}

/**
 * D-08's three-level timeout scheme is incoherent if a single command may run longer than the
 * whole discovery run it belongs to — this cross-field rule (in the same style as
 * `validateAdminPair`) rejects that combination against the discovery variable, since the
 * discovery budget is the one that must accommodate the command budget, not the other way round.
 */
function validateSshTimeoutCoherence(
  commandTimeoutMs: number,
  discoveryTimeoutMs: number,
  issues: EnvIssue[],
): void {
  if (discoveryTimeoutMs < commandTimeoutMs) {
    issues.push({
      variable: 'NOODARA_SSH_DISCOVERY_TIMEOUT_MS',
      requirement:
        'NOODARA_SSH_DISCOVERY_TIMEOUT_MS must be greater than or equal to NOODARA_SSH_COMMAND_TIMEOUT_MS (D-08)',
    });
  }
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
  const trustProxy = parseTuningBool('NOODARA_TRUST_PROXY', source.NOODARA_TRUST_PROXY, false, issues);
  const sshConnectTimeoutMs = parseTuningInt(
    'NOODARA_SSH_CONNECT_TIMEOUT_MS',
    source.NOODARA_SSH_CONNECT_TIMEOUT_MS,
    10000,
    issues,
    { min: 1000, max: 120000 },
  );
  const sshCommandTimeoutMs = parseTuningInt(
    'NOODARA_SSH_COMMAND_TIMEOUT_MS',
    source.NOODARA_SSH_COMMAND_TIMEOUT_MS,
    30000,
    issues,
    { min: 1000, max: 300000 },
  );
  const sshDiscoveryTimeoutMs = parseTuningInt(
    'NOODARA_SSH_DISCOVERY_TIMEOUT_MS',
    source.NOODARA_SSH_DISCOVERY_TIMEOUT_MS,
    60000,
    issues,
    { min: 5000, max: 600000 },
  );
  validateSshTimeoutCoherence(sshCommandTimeoutMs, sshDiscoveryTimeoutMs, issues);
  const workerConcurrency = parseTuningInt(
    'NOODARA_WORKER_CONCURRENCY',
    source.NOODARA_WORKER_CONCURRENCY,
    5,
    issues,
    { min: 1, max: 20 },
  );
  const sseMaxConnections = parseTuningInt(
    'NOODARA_SSE_MAX_CONNECTIONS',
    source.NOODARA_SSE_MAX_CONNECTIONS,
    32,
    issues,
    { min: 1, max: 1000 },
  );
  const deployMaxMs = parseTuningInt(
    'NOODARA_DEPLOY_MAX_MS',
    source.NOODARA_DEPLOY_MAX_MS,
    DEPLOY_MAX_MS_DEFAULT,
    issues,
    DEPLOY_MAX_MS_RANGE,
  );
  const deployIdleMs = parseTuningInt('NOODARA_DEPLOY_IDLE_MS', source.NOODARA_DEPLOY_IDLE_MS, 300_000, issues, {
    min: 10_000,
    max: 3_600_000,
  });
  validateDeployTimeoutCoherence(deployMaxMs, deployIdleMs, issues);
  const deployConcurrency = parseTuningInt(
    'NOODARA_DEPLOY_CONCURRENCY',
    source.NOODARA_DEPLOY_CONCURRENCY,
    1,
    issues,
    { min: 1, max: 10 },
  );
  // Per-phase cap (build and runtime phases tracked separately). Its floor is the per-line cap so
  // one full capped line always fits before the truncation notice.
  const deployLogMaxBytes = parseTuningInt(
    'NOODARA_DEPLOY_LOG_MAX_BYTES',
    source.NOODARA_DEPLOY_LOG_MAX_BYTES,
    10_485_760,
    issues,
    {
      min: DEPLOY_LOG_LINE_MAX_BYTES,
      max: 104_857_600,
      belowMinRequirement: `NOODARA_DEPLOY_LOG_MAX_BYTES must be greater than or equal to the per-line cap (${String(DEPLOY_LOG_LINE_MAX_BYTES)} bytes)`,
    },
  );
  const deployLogFlushMs = parseTuningInt(
    'NOODARA_DEPLOY_LOG_FLUSH_MS',
    source.NOODARA_DEPLOY_LOG_FLUSH_MS,
    250,
    issues,
    { min: 50, max: 5000 },
  );
  // A flush batch never exceeds one capped line, which keeps every published chunk far below the
  // 1 MiB per-connection SSE buffer.
  const deployLogFlushBytes = parseTuningInt(
    'NOODARA_DEPLOY_LOG_FLUSH_BYTES',
    source.NOODARA_DEPLOY_LOG_FLUSH_BYTES,
    16_384,
    issues,
    {
      min: 1024,
      max: DEPLOY_LOG_LINE_MAX_BYTES,
      aboveMaxRequirement: `NOODARA_DEPLOY_LOG_FLUSH_BYTES must be less than or equal to the per-line cap (${String(DEPLOY_LOG_LINE_MAX_BYTES)} bytes)`,
    },
  );
  const deployLogRetentionDays = parseTuningInt(
    'NOODARA_DEPLOY_LOG_RETENTION_DAYS',
    source.NOODARA_DEPLOY_LOG_RETENTION_DAYS,
    30,
    issues,
    { min: 1, max: 365 },
  );
  const reconcileIntervalMs = parseTuningInt(
    'NOODARA_RECONCILE_INTERVAL_MS',
    source.NOODARA_RECONCILE_INTERVAL_MS,
    30_000,
    issues,
    { min: 5000, max: 600_000 },
  );
  const runtimeLogTail = parseTuningInt('NOODARA_RUNTIME_LOG_TAIL', source.NOODARA_RUNTIME_LOG_TAIL, 1000, issues, {
    min: 1,
    max: 10_000,
  });
  const runtimeLogFollowMaxMs = parseTuningInt(
    'NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS',
    source.NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS,
    600_000,
    issues,
    { min: 10_000, max: 3_600_000 },
  );
  // 14-08 (H1): a QUEUED deployment without a BullMQ job older than this ends ENQUEUE_FAILED. The
  // minimum stays far above the bounded enqueue timeout (deploy jobs run with attempts 1, so there
  // is no retry backoff); the maximum keeps a stuck service lock from lasting more than an hour.
  const deployQueuedStaleMs = parseTuningInt(
    'NOODARA_DEPLOY_QUEUED_STALE_MS',
    source.NOODARA_DEPLOY_QUEUED_STALE_MS,
    120_000,
    issues,
    {
      min: 30_000,
      max: 3_600_000,
      belowMinRequirement:
        'NOODARA_DEPLOY_QUEUED_STALE_MS must be at least 30000 ms, above the longest legitimate enqueue-to-pickup delay',
    },
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
      NOODARA_TRUST_PROXY: trustProxy,
      NOODARA_SSH_CONNECT_TIMEOUT_MS: sshConnectTimeoutMs,
      NOODARA_SSH_COMMAND_TIMEOUT_MS: sshCommandTimeoutMs,
      NOODARA_SSH_DISCOVERY_TIMEOUT_MS: sshDiscoveryTimeoutMs,
      NOODARA_WORKER_CONCURRENCY: workerConcurrency,
      NOODARA_SSE_MAX_CONNECTIONS: sseMaxConnections,
      NOODARA_DEPLOY_MAX_MS: deployMaxMs,
      NOODARA_DEPLOY_IDLE_MS: deployIdleMs,
      NOODARA_DEPLOY_CONCURRENCY: deployConcurrency,
      NOODARA_DEPLOY_LOG_MAX_BYTES: deployLogMaxBytes,
      NOODARA_DEPLOY_LOG_FLUSH_MS: deployLogFlushMs,
      NOODARA_DEPLOY_LOG_FLUSH_BYTES: deployLogFlushBytes,
      NOODARA_DEPLOY_LOG_RETENTION_DAYS: deployLogRetentionDays,
      NOODARA_RECONCILE_INTERVAL_MS: reconcileIntervalMs,
      NOODARA_RUNTIME_LOG_TAIL: runtimeLogTail,
      NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS: runtimeLogFollowMaxMs,
      NOODARA_DEPLOY_QUEUED_STALE_MS: deployQueuedStaleMs,
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
