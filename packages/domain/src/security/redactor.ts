// Single redaction module (SEC-01, T-1-09, noodara-security skill §3). Every log, error,
// ActivityEvent and API response is expected to route through one `Redactor` instance before
// leaving the process. `createRedactor()` is a factory — not a module-level singleton — so tests
// stay isolated and a future request-scoped redactor is possible without a shared global.

export interface Redactor {
  /** Registers `value` (e.g. a decrypted credential) as sensitive under `type` for this redactor. */
  register(value: string, type: string): void;
  /** Removes `value` from the live registry, so a long-lived process does not accumulate secrets. */
  release(value: string): void;
  /**
   * Replaces every registered value (exact, base64 and URL-encoded forms) and every structural
   * secret pattern with `[REDACTED:<type>]`. Strings are redacted directly; plain objects and
   * arrays are walked recursively and a new structure is returned. Any other leaf (number,
   * boolean, null, Date, ...) is returned unchanged.
   */
  redact<T>(input: T): T;
}

interface RegisteredSecret {
  type: string;
}

interface MatcherSet {
  pattern: RegExp | null;
  typeByMatch: ReadonlyMap<string, string>;
}

// Structural patterns applied unconditionally, regardless of registration (noodara-security §3).
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const GITHUB_TOKEN_PATTERN = /ghp_[A-Za-z0-9]{10,}/g;
const OPENAI_TOKEN_PATTERN = /sk-[A-Za-z0-9]{10,}/g;
const AWS_ACCESS_KEY_PATTERN = /AKIA[A-Z0-9]{10,}/g;
const POSTGRES_URL_PASSWORD_PATTERN = /(postgres:\/\/[^:@/\s]+:)[^@/\s]+@/g;
const BEARER_HEADER_PATTERN = /Authorization:\s*Bearer\s+\S+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyStructuralPatterns(input: string): string {
  return input
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED:private_key]')
    .replace(GITHUB_TOKEN_PATTERN, '[REDACTED:token]')
    .replace(OPENAI_TOKEN_PATTERN, '[REDACTED:token]')
    .replace(AWS_ACCESS_KEY_PATTERN, '[REDACTED:token]')
    .replace(POSTGRES_URL_PASSWORD_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED:password]@`)
    .replace(BEARER_HEADER_PATTERN, 'Authorization: Bearer [REDACTED:token]');
}

/** Narrows `T | undefined` to `T` once the caller has already guaranteed the value is present. */
function assertFound<T>(value: T | undefined): T {
  return value as T;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function createRedactor(): Redactor {
  const registry = new Map<string, RegisteredSecret>();

  function register(value: string, type: string): void {
    if (value.length === 0) return;
    registry.set(value, { type });
  }

  function release(value: string): void {
    registry.delete(value);
  }

  // Rebuilt on every `redact()` call so a `register()`/`release()` in between is honoured
  // immediately, and computed once per call (not once per string leaf) for performance.
  function buildMatchers(): MatcherSet {
    const entries: { text: string; type: string }[] = [];
    for (const [value, { type }] of registry) {
      entries.push({ text: value, type });
      entries.push({ text: Buffer.from(value, 'utf8').toString('base64'), type });
      entries.push({ text: encodeURIComponent(value), type });
    }
    // Longest-first: at any given position the regex engine tries alternatives in the order
    // they appear, so a longer secret that contains a shorter registered one as a substring is
    // matched (and consumed) whole, instead of leaving a partial fragment behind.
    entries.sort((a, b) => b.text.length - a.text.length);

    const typeByMatch = new Map<string, string>();
    const parts: string[] = [];
    for (const entry of entries) {
      if (entry.text.length === 0 || typeByMatch.has(entry.text)) continue;
      typeByMatch.set(entry.text, entry.type);
      parts.push(escapeRegExp(entry.text));
    }

    return {
      pattern: parts.length > 0 ? new RegExp(parts.join('|'), 'g') : null,
      typeByMatch,
    };
  }

  function redactString(input: string, matchers: MatcherSet): string {
    let output = input;
    if (matchers.pattern) {
      output = output.replace(
        matchers.pattern,
        // `match` always came from an alternative built exclusively from `typeByMatch`'s own
        // keys (see buildMatchers above), so the lookup can never miss — no fallback branch.
        (match) => `[REDACTED:${assertFound(matchers.typeByMatch.get(match))}]`,
      );
    }
    return applyStructuralPatterns(output);
  }

  function redactValue(value: unknown, matchers: MatcherSet): unknown {
    if (typeof value === 'string') return redactString(value, matchers);
    if (Array.isArray(value)) return value.map((item) => redactValue(item, matchers));
    if (value !== null && typeof value === 'object' && isPlainObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = redactValue(val, matchers);
      }
      return result;
    }
    return value;
  }

  function redact<T>(input: T): T {
    const matchers = buildMatchers();
    return redactValue(input, matchers) as T;
  }

  return { register, release, redact };
}
