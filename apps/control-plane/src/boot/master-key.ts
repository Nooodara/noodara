import { createHash } from 'node:crypto';

const MASTER_KEY_BYTE_LENGTH = 32;
const FINGERPRINT_HEX_LENGTH = 16;

export class InvalidMasterKeyError extends Error {
  constructor(reason: string) {
    super(`Invalid master key: ${reason}`);
    this.name = 'InvalidMasterKeyError';
  }
}

/**
 * Decodes a base64-encoded master key into its raw bytes. Never returns, logs or stringifies the
 * base64 form itself — only the decoded `Buffer` leaves this function.
 */
export function decodeMasterKey(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== MASTER_KEY_BYTE_LENGTH) {
    throw new InvalidMasterKeyError(`must decode to exactly ${MASTER_KEY_BYTE_LENGTH.toString()} bytes`);
  }
  return decoded;
}

/**
 * SHA-256 fingerprint of the raw key bytes, truncated to 16 lowercase hex characters (D-12). Safe
 * to log: it is a one-way digest of the key, never the key or its base64 encoding.
 */
export function masterKeyFingerprint(keyBytes: Buffer): string {
  return createHash('sha256').update(keyBytes).digest('hex').slice(0, FINGERPRINT_HEX_LENGTH);
}

const MASTER_KEY_BACKUP_WARNING =
  'Back up NOODARA_MASTER_KEY; credentials are unrecoverable without it';

// Minimal structural type instead of importing pino's `Logger`: satisfied by both a raw pino
// instance (unit tests) and Fastify's `FastifyBaseLogger` (app.ts), which is the same object at
// runtime once a pino instance is passed as Fastify's `logger` option.
export interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Emits the fixed D-12 backup warning at `warn` level on every boot, with the key's fingerprint
 * and never the key material itself.
 */
export function logMasterKeyWarning(logger: WarnLogger, keyBytes: Buffer): void {
  logger.warn({ keyFingerprint: masterKeyFingerprint(keyBytes) }, MASTER_KEY_BACKUP_WARNING);
}
