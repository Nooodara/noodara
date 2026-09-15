// Private key loading policy (D-01/D-02, SEC-03, T-2-23/T-2-24). Enforces format/type/size before
// any socket is opened — `loadPrivateKey` performs no I/O at all (no file reads, no network, no
// environment variables): the key already arrived as a `SecretValue`, decrypted by a caller
// outside this package. `utils.parseKey`'s own `Error.message` is read only to classify a failure
// (ADR 0004's A2 measurement: a wrong passphrase and a malformed key both come back as a plain
// `Error`, distinguishable only by message text) — it is never propagated to a caller, since
// 02-RESEARCH.md records it can carry partial key bytes or the key's comment.
import { createPublicKey } from 'node:crypto';
// `ssh2` is CommonJS; its `utils` property is not statically detected by Node's own CJS/ESM
// interop (cjs-module-lexer only picks up `Client`/`AgentProtocol`/`BaseAgent`/`createAgent`), so
// a named `import { utils } from 'ssh2'` throws under plain Node even though it type-checks and
// works under Vitest's resolver — see fingerprint.ts's fuller note. Destructuring off the default
// export works under both.
import ssh2, { type ParsedKey } from 'ssh2';
import { revealSecret, type Redactor } from '@noodara/domain/security';
import type { SshCredential } from './ssh-port.js';

const { utils } = ssh2;

export type PrivateKeyCredential = Extract<SshCredential, { kind: 'private_key' }>;

/**
 * Optional error class for a caller that prefers to throw rather than branch on
 * `LoadPrivateKeyResult` (declared per this plan's own artifact contract — `loadPrivateKey`
 * itself never throws it; every failure path returns a value). Carries only this module's own
 * fixed wording, exactly like the result union's `message` field — never the raw `ssh2` error.
 */
export class InvalidCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredentialError';
  }
}

/** The raw values this module reveals for every credential it loads (WR-02/WR-03) — carried on
 *  every result variant, success or failure, so a caller (`ssh2-adapter.ts`'s `attemptConnect`)
 *  can thread them into `buildConnectOptions` without revealing the same `SecretValue`s a second
 *  time, and can release them from the `Redactor` on every exit path without having to re-derive
 *  what was revealed. */
interface RevealedKeyMaterial {
  readonly rawKey: string;
  readonly rawPassphrase?: string;
}

export type LoadPrivateKeyResult =
  | ({ readonly ok: true; readonly key: ParsedKey; readonly keyType: string } & RevealedKeyMaterial)
  | ({ readonly ok: false; readonly kind: 'validation'; readonly message: string } & RevealedKeyMaterial)
  | ({
      readonly ok: false;
      readonly kind: 'auth';
      readonly errorCode: 'AUTH_FAILED';
      readonly message: string;
    } & RevealedKeyMaterial);

const ACCEPTED_KEY_TYPES = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
] as const;

const RSA_MIN_MODULUS_BITS = 2048;

/** ADR 0004 A2: `utils.parseKey`'s wrong-passphrase failure verbatim contains "bad passphrase?" —
 *  matched case-insensitively on the "passphrase" substring, never propagating the full message. */
function isWrongPassphraseMessage(message: string): boolean {
  return message.toLowerCase().includes('passphrase');
}

/** `ParsedKey` exposes no modulus size directly; read it from the key's own public form instead
 *  of inferring it from the encoded PEM/OpenSSH text length. */
function rsaModulusBits(key: ParsedKey): number | undefined {
  const publicKey = createPublicKey(key.getPublicPEM());
  return publicKey.asymmetricKeyDetails?.modulusLength;
}

/**
 * Validates and parses a `private_key`-kind `SshCredential` per D-01 (OpenSSH/PEM,
 * ed25519/ECDSA/RSA, RSA >=2048 bits) and D-02 (optional passphrase, wrong passphrase classified
 * as `AUTH_FAILED`). Registers the raw key and passphrase with `redactor` before parsing — the
 * registration itself, not anything this function's messages say, is what makes SEC-05's
 * redaction of any downstream log or error effective for this credential.
 */
export function loadPrivateKey(credential: PrivateKeyCredential, redactor: Redactor): LoadPrivateKeyResult {
  const rawKey = revealSecret(credential.privateKey, redactor);
  const rawPassphrase =
    credential.passphrase === undefined ? undefined : revealSecret(credential.passphrase, redactor);
  // Threaded onto every result variant below (WR-03) — never re-revealed by a caller that already
  // has this result, since `revealSecret` was already called, above, exactly once per field.
  const revealed: RevealedKeyMaterial = rawPassphrase === undefined ? { rawKey } : { rawKey, rawPassphrase };

  const parsed = utils.parseKey(rawKey, rawPassphrase);

  if (parsed instanceof Error) {
    if (isWrongPassphraseMessage(parsed.message)) {
      return {
        ok: false,
        kind: 'auth',
        errorCode: 'AUTH_FAILED',
        message: 'wrong passphrase for the provided private key',
        ...revealed,
      };
    }
    return { ok: false, kind: 'validation', message: 'unable to parse private key', ...revealed };
  }

  // @types/ssh2 declares this overload's return type as exactly `ParsedKey | Error` (never an
  // array) — a private-key credential is always exactly one key.
  const key = parsed;

  if (!(ACCEPTED_KEY_TYPES as readonly string[]).includes(key.type)) {
    return {
      ok: false,
      kind: 'validation',
      message: `unsupported key type "${key.type}" — only ed25519, ECDSA and RSA (>=2048 bits) are accepted`,
      ...revealed,
    };
  }

  if (key.type === 'ssh-rsa') {
    const modulusBits = rsaModulusBits(key);
    if (modulusBits === undefined || modulusBits < RSA_MIN_MODULUS_BITS) {
      return {
        ok: false,
        kind: 'validation',
        message: 'RSA key is smaller than the required 2048-bit minimum',
        ...revealed,
      };
    }
  }

  return { ok: true, key, keyType: key.type, ...revealed };
}
