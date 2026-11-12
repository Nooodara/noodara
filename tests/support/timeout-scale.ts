// 36-01 (QA-25): opt-in, test-only timeout multiplier for slow contributor machines.
//
// NOODARA_TEST_TIMEOUT_SCALE multiplies the *runner-level* timeout defaults of every Vitest config
// and of playwright.config.ts. Unset or empty means exactly 1, so CI budgets (which never set the
// variable -- tests/unit/scripts/timeout-scale-runners.test.ts enforces that) stay byte-for-byte
// unchanged. Product timeouts (SSH, Docker, Git, HTTP) never read this module or the variable.
//
// Deliberately dependency-free (no imports, erasable TypeScript only) so every runner config,
// Playwright worker and a plain `node` child process can load it identically.

export const TIMEOUT_SCALE_ENV = 'NOODARA_TEST_TIMEOUT_SCALE';
/** Set to the announcing runner's pid so its own workers/forks do not print the line again. */
export const TIMEOUT_SCALE_ANNOUNCED_ENV = 'NOODARA_TEST_TIMEOUT_SCALE_ANNOUNCED_PID';
export const TIMEOUT_SCALE_MIN = 1;
export const TIMEOUT_SCALE_MAX = 10;
/** Beyond this, Node's setTimeout fires immediately instead of waiting. */
export const NODE_TIMER_MAX_MS = 2_147_483_647;
/** Per-process cache slot on globalThis, so repeated config loads in one process agree. */
export const TIMEOUT_SCALE_CACHE_KEY: unique symbol = Symbol.for('noodara.testTimeoutScale');

/** Unscaled runner-level defaults. These are the values CI runs with. */
export const RUNNER_TIMEOUT_DEFAULTS = {
  // Vitest's own implicit defaults (node environment), made explicit.
  unit: { testTimeout: 5000, hookTimeout: 10_000 },
  integration: { testTimeout: 120_000, hookTimeout: 120_000 },
  installer: { testTimeout: 900_000, hookTimeout: 900_000 },
  aiEvals: { testTimeout: 30_000, hookTimeout: 120_000 },
  aiEvalsLive: { testTimeout: 4 * 3600_000, hookTimeout: 4 * 3600_000 },
  playwright: { timeout: 60_000, expectTimeout: 15_000 },
} as const;

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;
const MAX_ECHO_CHARS = 32;

function rangeText(): string {
  return `a plain decimal number in [${String(TIMEOUT_SCALE_MIN)}, ${String(TIMEOUT_SCALE_MAX)}]`;
}

function echo(raw: string): string {
  // Strip C0/C1 control characters so a rejected value cannot inject terminal escapes or lines,
  // then truncate: the echo exists to help spot a typo, not to reproduce arbitrary input.
  // eslint-disable-next-line no-control-regex
  const visible = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const truncated = visible.length > MAX_ECHO_CHARS;
  return `"${visible.slice(0, MAX_ECHO_CHARS)}"${truncated ? ' (truncated)' : ''}`;
}

function assertFactor(factor: number): void {
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < TIMEOUT_SCALE_MIN || factor > TIMEOUT_SCALE_MAX) {
    throw new Error(`${TIMEOUT_SCALE_ENV} factor must be ${rangeText()}`);
  }
}

/**
 * Parses the raw variable. Unset or empty is exactly 1; anything that is not plain decimal
 * notation within [1, 10] throws -- never a silent fallback, so a typo can neither shorten nor
 * unbound a timeout.
 */
export function parseTimeoutScale(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 1;
  const factor = PLAIN_DECIMAL.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(factor) || factor < TIMEOUT_SCALE_MIN || factor > TIMEOUT_SCALE_MAX) {
    throw new Error(`${TIMEOUT_SCALE_ENV} must be ${rangeText()} or unset (got ${echo(raw)})`);
  }
  return factor;
}

/** Scales `ms` by `factor`, rounding up; never below `ms`, never above the Node timer limit. */
export function scaleTimeout(ms: number, factor: number): number {
  assertFactor(factor);
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new Error('scaled(ms) needs a finite, non-negative number of ms');
  }
  const result = Math.max(Math.ceil(ms * factor), Math.ceil(ms));
  if (result > NODE_TIMER_MAX_MS) {
    throw new Error(
      `scaled timeout ${String(result)} ms exceeds the Node timer limit of ${String(NODE_TIMER_MAX_MS)} ms`,
    );
  }
  return result;
}

export interface TimeoutScale {
  readonly factor: number;
  scaled(ms: number): number;
}

export function createTimeoutScale(factor: number): TimeoutScale {
  assertFactor(factor);
  return Object.freeze({ factor, scaled: (ms: number) => scaleTimeout(ms, factor) });
}

interface CachedScale {
  readonly scale: TimeoutScale;
  announced: boolean;
}

export interface ResolveTimeoutScaleOptions {
  readonly env?: Record<string, string | undefined>;
  readonly store?: object;
  readonly pid?: number;
  readonly ppid?: number;
  readonly write?: (line: string) => void;
}

function defaultWrite(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Resolves the factor once per process (cached on globalThis), and -- when it is not 1 -- prints
 * one line naming the active factor, once per runner invocation. The announcing process records
 * its pid in the environment its workers inherit, so Playwright workers and Vitest forks resolve
 * the identical factor without printing it again. Throws on an invalid value, which aborts the
 * config load before any test, global setup, container or port is touched.
 */
export function resolveRunnerTimeoutScale(runner: string, options: ResolveTimeoutScaleOptions = {}): TimeoutScale {
  const env = options.env ?? process.env;
  const store = (options.store ?? globalThis) as Record<symbol, CachedScale | undefined>;
  let cached = store[TIMEOUT_SCALE_CACHE_KEY];
  if (cached === undefined) {
    cached = { scale: createTimeoutScale(parseTimeoutScale(env[TIMEOUT_SCALE_ENV])), announced: false };
    store[TIMEOUT_SCALE_CACHE_KEY] = cached;
  }
  if (cached.scale.factor !== 1 && !cached.announced) {
    cached.announced = true;
    const pid = String(options.pid ?? process.pid);
    const ppid = String(options.ppid ?? process.ppid);
    const marker = env[TIMEOUT_SCALE_ANNOUNCED_ENV];
    if (marker !== pid && marker !== ppid) {
      env[TIMEOUT_SCALE_ANNOUNCED_ENV] = pid;
      (options.write ?? defaultWrite)(
        `[${runner}] ${TIMEOUT_SCALE_ENV}=${String(cached.scale.factor)} active: runner timeouts are scaled; this is local evidence, not CI-equivalent`,
      );
    }
  }
  return cached.scale;
}
