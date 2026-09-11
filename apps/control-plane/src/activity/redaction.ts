// Single application-level Redactor binding (SEC-01, T-1-09, T-1-22, noodara-security §3). This
// module is the one place `apps/control-plane` constructs a `Redactor` — every other file that
// needs to redact a secret (write-activity-event.ts, and any future route/service touching
// credentials) imports `appRedactor` from here rather than calling `createRedactor()` itself,
// so the master key and the auth secret are registered exactly once per process.
//
// This backstops pino's path-based `redact.paths` in logger.ts (STACK.md's "Structured Logging &
// Redaction" section: "any object passed to logger.info/error that contains a Server or
// SshCredential entity must go through a toLogSafe() mapper ... so a forgotten path in
// redact.paths isn't the only line of defense") and gates every write into `activity_events`
// (write-activity-event.ts).
import { createRedactor, SecretValue, type Redactor } from '@noodara/domain/security';
import { env } from '../env.js';

export const appRedactor: Redactor = createRedactor();

// Registered once at module load so the master key(s) and the Better Auth session secret are
// redacted from every activity-event metadata payload (and anything else that routes through
// `appRedactor.redact`) by default — no call site needs to remember to register them (D-12).
appRedactor.register(env.NOODARA_MASTER_KEY, 'master_key');
if (env.NOODARA_MASTER_KEY_PREVIOUS !== undefined) {
  appRedactor.register(env.NOODARA_MASTER_KEY_PREVIOUS, 'master_key');
}
appRedactor.register(env.BETTER_AUTH_SECRET, 'auth_secret');

// Field names that must never survive into a log-safe view of any entity, regardless of table
// shape (noodara-domain-model §7 / noodara-security §3's "redact by shape, not by variable name"
// principle applied to entity fields rather than free-form metadata).
const FORBIDDEN_ENTITY_KEYS = new Set([
  'password',
  'secret',
  'token',
  'credential',
  'privatekey',
  'sshpassword',
  'masterkey',
]);

/**
 * A `credentials` table row is recognised structurally (it always carries `encryptedValue` and
 * `keyVersion`) rather than by an import of the Drizzle table type, so `toLogSafe` stays decoupled
 * from the schema module and works the same for a row fetched via raw SQL.
 */
function isCredentialsRow(entity: Record<string, unknown>): boolean {
  return 'encryptedValue' in entity && 'keyVersion' in entity && 'type' in entity;
}

/**
 * Maps a `servers`/`credentials` row (or any similarly-shaped entity) to a log-safe plain object.
 *
 * A `credentials` row is allowlisted down to exactly `{ id, type, keyVersion }` — its
 * `encryptedValue` column never appears in the result, even though it is already an opaque AES-
 * GCM envelope string, not a raw secret. Every other entity has `credentialId` and any
 * forbidden-named field dropped; any value that is a `SecretValue` instance is dropped outright
 * rather than returned (even in its already-`[REDACTED:...]` serialised form), so `toLogSafe`'s
 * output can never contain a `SecretValue` reference.
 */
export function toLogSafe(entity: Record<string, unknown>): Record<string, unknown> {
  if (isCredentialsRow(entity)) {
    return { id: entity.id, type: entity.type, keyVersion: entity.keyVersion };
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    if (key === 'credentialId') continue;
    if (FORBIDDEN_ENTITY_KEYS.has(key.toLowerCase())) continue;
    if (value instanceof SecretValue) continue;
    result[key] = value;
  }
  return result;
}
