// D-19: the Zod request/response schemas for the eight `/api/servers` routes, and the one
// wire-credential-to-`CredentialInput` mapping every mutating route needs. Nothing here decides
// an HTTP status or calls a service — this module only describes shapes and translates a wire
// vocabulary difference (see the `WireCredentialSchema` note below).
import { z } from 'zod';
import { DISCOVERY_CHECK_IDS, DISCOVERY_CHECK_STATUSES } from '@noodara/domain/discovery';
import { SERVER_ERROR_CODES, SERVER_STATUSES } from '@noodara/domain/server';
import type { CredentialInput } from '../services/credential-store.js';
import { SERVER_VIEW_KEYS } from '../services/server-view.js';

// D-19 fixes the wire shape as `type: 'ssh_private_key' | 'ssh_password'` — the same vocabulary
// `ServerView.credentialType` already returns. Phase 3's internal `CredentialInput` discriminates
// on `kind: 'private_key' | 'password'` instead; this module owns the one translation between the
// two, and `CredentialInput` itself is never changed to match the wire.
export const WireCredentialSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ssh_private_key'),
      privateKey: z.string().min(1),
      passphrase: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('ssh_password'),
      password: z.string().min(1),
    })
    .strict(),
]);

export type WireCredential = z.infer<typeof WireCredentialSchema>;

/** The one mapping from the wire's `type`/`ssh_*` vocabulary to Phase 3's `kind`/plain vocabulary
 *  — unit-tested both directions of the union. */
export function toCredentialInput(wire: WireCredential): CredentialInput {
  if (wire.type === 'ssh_password') {
    return { kind: 'password', password: wire.password };
  }
  return wire.passphrase === undefined
    ? { kind: 'private_key', privateKey: wire.privateKey }
    : { kind: 'private_key', privateKey: wire.privateKey, passphrase: wire.passphrase };
}

export const CreateServerBodySchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    sshPort: z.number().int().optional(),
    sshUser: z.string().min(1).optional(),
    credential: WireCredentialSchema,
  })
  .strict();

export type CreateServerBody = z.infer<typeof CreateServerBodySchema>;

/** Every field optional — exactly `EditServerInput`'s subset (phase 3 D-13): a partial body edits
 *  only the fields it names. */
export const UpdateServerBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    sshPort: z.number().int().optional(),
    sshUser: z.string().min(1).optional(),
    credential: WireCredentialSchema.optional(),
  })
  .strict();

export type UpdateServerBody = z.infer<typeof UpdateServerBodySchema>;

export const ServerIdParamSchema = z.object({ id: z.uuid() });

export const DeleteServerBodySchema = z.object({ confirmName: z.string().min(1) }).strict();

// Gap 6 / T-5G-27: binds the trust action to the exact fingerprint the admin saw (never a format
// regex beyond non-empty — comparison is byte-for-byte equality against the stored pending value,
// and a second, drift-prone format check would add nothing).
export const TrustFingerprintBodySchema = z.object({ fingerprint: z.string().min(1) }).strict();

// D-19: the 27 `ServerView` fields, listed explicitly (never derived by reflection) so a field
// added to `ServerView` without updating this schema fails a unit test rather than being silently
// dropped from every response. Dates are real `Date` instances (Drizzle's `timestamp` columns),
// serialized to their ISO string by `JSON.stringify`'s own `Date.prototype.toJSON` — `z.date()`
// here validates the value's *type* for the response serializer, it does not itself decide the
// wire format.
export const ServerViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  host: z.string(),
  sshPort: z.number().int(),
  sshUser: z.string(),
  status: z.enum(SERVER_STATUSES),
  hostFingerprint: z.string().nullable(),
  hostFingerprintCapturedAt: z.date().nullable(),
  pendingFingerprint: z.string().nullable(),
  pendingFingerprintSeenAt: z.date().nullable(),
  hostname: z.string().nullable(),
  osDistribution: z.string().nullable(),
  osVersion: z.string().nullable(),
  arch: z.string().nullable(),
  cpuCores: z.number().int().nullable(),
  ramMb: z.number().int().nullable(),
  diskTotalMb: z.number().int().nullable(),
  diskUsedMb: z.number().int().nullable(),
  uptimeSeconds: z.number().int().nullable(),
  dockerInstalled: z.boolean().nullable(),
  dockerVersion: z.string().nullable(),
  dockerComposeVersion: z.string().nullable(),
  lastSeenAt: z.date().nullable(),
  lastErrorCode: z.enum(SERVER_ERROR_CODES).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  credentialType: z.enum(['ssh_private_key', 'ssh_password']),
});

// Drift guard: a field added to `ServerView` without a matching entry here (or vice versa) is a
// SEC-02-relevant bug — this assertion is exercised by server-schemas.test.ts, not just declared.
export function assertServerViewSchemaKeysMatch(): boolean {
  return Object.keys(ServerViewSchema.shape).sort().join(',') === [...SERVER_VIEW_KEYS].sort().join(',');
}

// D-05/DISC-02: the wire shape of one discovery check, built directly from the domain's own
// frozen tuples — the eleven ids and four statuses are never re-typed by hand here.
export const DiscoveryCheckSchema = z.object({
  id: z.enum(DISCOVERY_CHECK_IDS),
  status: z.enum(DISCOVERY_CHECK_STATUSES),
  detail: z.string(),
  durationMs: z.number(),
});

// Drift guard, same discipline as `assertServerViewSchemaKeysMatch`: a check id or status added
// to (or removed from) the domain tuples without updating `DiscoveryCheckSchema` fails this
// assertion — exercised by server-schemas.test.ts, not just declared.
export function assertDiscoveryCheckSchemaLiteralsMatch(): boolean {
  const idsMatch =
    [...DiscoveryCheckSchema.shape.id.options].sort().join(',') === [...DISCOVERY_CHECK_IDS].sort().join(',');
  const statusesMatch =
    [...DiscoveryCheckSchema.shape.status.options].sort().join(',') ===
    [...DISCOVERY_CHECK_STATUSES].sort().join(',');
  return idsMatch && statusesMatch;
}

// D-05/DISC-02: `GET /api/servers/:id/discovery`'s response — the latest discovery run only
// (D-07 limits v0.1 to the latest run). `.strict()` so an accidental extra field (notably `facts`,
// T-5-18) is a serialization failure rather than a silent leak, mirroring `ServerViewSchema`'s
// explicit-allowlist discipline. `collectedAt` follows the same `z.date()` convention as every
// other timestamp in `ServerViewSchema` — a real `Date` instance validated here, serialized to its
// ISO string on the wire by `JSON.stringify`'s own `Date.prototype.toJSON`.
export const DiscoveryReadResponseSchema = z
  .object({
    collectedAt: z.date().nullable(),
    outcome: z.enum(['ok', 'partial', 'failed']).nullable(),
    checks: z.array(DiscoveryCheckSchema),
    warnings: z.array(z.enum(SERVER_ERROR_CODES)),
  })
  .strict();
