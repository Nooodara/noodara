// Branded secret type (SEC-01, T-1-09, noodara-security skill §1). A secret is never a bare
// string outside this module: `toString`, `toJSON` and the Node inspect symbol all return the
// same redacted marker, so JSON.stringify, template interpolation and console.log/util.inspect
// of a containing object cannot leak the raw value by accident.

const INSPECT_SYMBOL = Symbol.for('nodejs.util.inspect.custom');

/**
 * Every kind of credential/secret this domain currently handles. Widening this union is the
 * only change needed to teach the whole redaction surface (SecretValue, Redactor, pino) about a
 * new secret category.
 */
export type SecretKind =
  | 'ssh_password'
  | 'ssh_private_key'
  | 'master_key'
  | 'session_secret'
  | 'setup_token'
  | 'api_key';

/**
 * Anything that can receive a raw secret value for later redaction. `redactor.ts`'s `Redactor`
 * satisfies this structurally — this module never imports `redactor.ts`, so `createRedactor()`
 * stays a plain factory rather than a singleton this module would otherwise need to reach into.
 */
export interface SecretRegistry {
  register(value: string, type: string): void;
}

/**
 * A credential or secret value. The raw string lives in a true private class field (`#raw`),
 * reachable only from code inside this class body — `revealSecret` is the sole external escape
 * hatch, and every other read path (`toString`, `toJSON`, `util.inspect`) returns
 * `[REDACTED:<kind>]` instead.
 */
export class SecretValue {
  readonly #raw: string;
  readonly kind: SecretKind;

  private constructor(raw: string, kind: SecretKind) {
    this.#raw = raw;
    this.kind = kind;
  }

  static from(raw: string, kind: SecretKind): SecretValue {
    return new SecretValue(raw, kind);
  }

  /** Only `revealSecret` (below) calls this — kept out of the public API surface. */
  static reveal(secret: SecretValue): string {
    return secret.#raw;
  }

  toString(): string {
    return `[REDACTED:${this.kind}]`;
  }

  toJSON(): string {
    return this.toString();
  }

  [INSPECT_SYMBOL](): string {
    return this.toString();
  }
}

/** Wraps `raw` as a `SecretValue` of the given `kind`. Never call this with an already-derived value. */
export function secretValue(raw: string, kind: SecretKind): SecretValue {
  return SecretValue.from(raw, kind);
}

/**
 * The only way to obtain the raw string behind a `SecretValue`. When `registry` is supplied
 * (typically an active `Redactor`), the raw value is registered under `secret.kind` before being
 * returned, so any subsequent `redactor.redact(...)` call scrubs it from logs/errors/output.
 */
export function revealSecret(secret: SecretValue, registry?: SecretRegistry): string {
  const raw = SecretValue.reveal(secret);
  registry?.register(raw, secret.kind);
  return raw;
}
