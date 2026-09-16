// D-19: the one public server shape. This is the exact object phase 4's `GET /servers/:id` (and
// every mutating service in this phase) returns unchanged. Adding a credential-shaped field here
// (`credentialId`, `encryptedValue`, `keyVersion`, or anything else that could identify or reveal a
// stored credential) is a SEC-02 regression — `toServerView` is built as an explicit field-by-field
// allowlist, never `{ ...row }` with keys deleted afterwards, so a new `servers` column never leaks
// into the API surface just by existing on the row.
import type { ServerErrorCode, ServerStatus } from '@noodara/domain/server';
import type { servers } from '../db/schema/servers.js';

export type ServerRow = typeof servers.$inferSelect;

export type CredentialType = 'ssh_private_key' | 'ssh_password';

export interface ServerView {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly status: ServerStatus;
  readonly hostFingerprint: string | null;
  readonly hostFingerprintCapturedAt: Date | null;
  readonly pendingFingerprint: string | null;
  readonly pendingFingerprintSeenAt: Date | null;
  readonly hostname: string | null;
  readonly osDistribution: string | null;
  readonly osVersion: string | null;
  readonly arch: string | null;
  readonly cpuCores: number | null;
  readonly ramMb: number | null;
  readonly diskTotalMb: number | null;
  readonly diskUsedMb: number | null;
  readonly uptimeSeconds: number | null;
  readonly dockerInstalled: boolean | null;
  readonly dockerVersion: string | null;
  readonly dockerComposeVersion: string | null;
  readonly lastSeenAt: Date | null;
  readonly lastErrorCode: ServerErrorCode | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly credentialType: CredentialType;
  // Deliberately absent: credentialId, encryptedValue, keyVersion, or anything credential-shaped.
}

/** Frozen, single source of truth for `ServerView`'s key set — both this module's own callers and
 *  `server-view.test.ts` read from this tuple rather than duplicating the field list. */
export const SERVER_VIEW_KEYS = Object.freeze([
  'id',
  'name',
  'host',
  'sshPort',
  'sshUser',
  'status',
  'hostFingerprint',
  'hostFingerprintCapturedAt',
  'pendingFingerprint',
  'pendingFingerprintSeenAt',
  'hostname',
  'osDistribution',
  'osVersion',
  'arch',
  'cpuCores',
  'ramMb',
  'diskTotalMb',
  'diskUsedMb',
  'uptimeSeconds',
  'dockerInstalled',
  'dockerVersion',
  'dockerComposeVersion',
  'lastSeenAt',
  'lastErrorCode',
  'createdAt',
  'updatedAt',
  'credentialType',
] as const satisfies readonly (keyof ServerView)[]);

/**
 * Projects a `servers` row into its public `ServerView`, by explicit allowlist construction. Any
 * extra field present on `row` (e.g. a future `credentialId`-adjacent column, or a polluted test
 * fixture) is structurally absent from the result — it was never read, so it can never leak.
 */
export function toServerView(row: ServerRow, credentialType: CredentialType): ServerView {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    sshPort: row.sshPort,
    sshUser: row.sshUser,
    status: row.status,
    hostFingerprint: row.hostFingerprint,
    hostFingerprintCapturedAt: row.hostFingerprintCapturedAt,
    pendingFingerprint: row.pendingFingerprint,
    pendingFingerprintSeenAt: row.pendingFingerprintSeenAt,
    hostname: row.hostname,
    osDistribution: row.osDistribution,
    osVersion: row.osVersion,
    arch: row.arch,
    cpuCores: row.cpuCores,
    ramMb: row.ramMb,
    diskTotalMb: row.diskTotalMb,
    diskUsedMb: row.diskUsedMb,
    uptimeSeconds: row.uptimeSeconds,
    dockerInstalled: row.dockerInstalled,
    dockerVersion: row.dockerVersion,
    dockerComposeVersion: row.dockerComposeVersion,
    lastSeenAt: row.lastSeenAt,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    credentialType,
  };
}
