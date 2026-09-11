import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

// SEC-01/D-10: SSH credentials at rest. `encryptedValue` holds the AES-256-GCM envelope produced
// by `packages/domain/src/security/envelope.ts` (`v<version>:<nonce_b64>:<ciphertext_b64>:
// <tag_b64>`) — no plaintext column exists here, ever (T-1-16).
export const credentialTypeEnum = pgEnum('credential_type', ['ssh_private_key', 'ssh_password']);

export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  type: credentialTypeEnum('type').notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  // D-10: every encrypted row carries the master-key version used to encrypt it, so
  // `noodara secrets rotate` (D-11) can re-encrypt row by row without ambiguity.
  keyVersion: integer('key_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
