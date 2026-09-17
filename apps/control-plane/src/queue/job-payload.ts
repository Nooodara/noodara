import { z } from 'zod';
import type { ServiceActor } from '../services/server-service-deps.js';

// D-11: the connect-server job payload never carries host, ssh user, credential or fingerprint —
// the worker re-reads the row and decrypts the credential itself. `.strict()` on both the outer
// object and each actor arm is a security control, not style: it guarantees this contract holds
// even if a future caller tries to stuff extra context into the payload, and it makes a tampered
// Redis entry fail closed instead of silently accepting unknown fields.
export const ConnectServerJobPayloadSchema = z
  .object({
    serverId: z.uuid(),
    actor: z.discriminatedUnion('type', [
      z.object({ type: z.literal('user'), id: z.uuid() }).strict(),
      z.object({ type: z.literal('system') }).strict(),
    ]),
    requestedAt: z.iso.datetime(),
    trigger: z.enum(['connect', 'discover']),
  })
  .strict();

export type ConnectServerJobPayload = z.infer<typeof ConnectServerJobPayloadSchema>;

// Type-level proof that this schema's actor member never drifts from the one every service in
// server-service-deps.ts already shares (D-17) — a mismatch here is a compile error, not a
// runtime surprise discovered by the worker. Never called; its only purpose is to fail `tsc` if
// the two types diverge.
function _assertActorAssignableToServiceActor(actor: ConnectServerJobPayload['actor']): ServiceActor {
  return actor;
}

/**
 * Parses an unknown value (as read back from Redis) into a `ConnectServerJobPayload`. Never
 * throws: a malformed or tampered job in Redis is a handled outcome for the worker, not a crash.
 * The failure `message` names only the failing field paths — never the received value, which is
 * exactly what a tampered payload would use to smuggle content into the worker's logs.
 */
export function parseConnectServerJobPayload(
  data: unknown,
): { ok: true; payload: ConnectServerJobPayload } | { ok: false; message: string } {
  const result = ConnectServerJobPayloadSchema.safeParse(data);

  if (result.success) {
    return { ok: true, payload: result.data };
  }

  const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
  return { ok: false, message: `Invalid connect-server job payload: ${paths.join(', ')}` };
}
