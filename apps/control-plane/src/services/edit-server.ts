// SERV-02/ACT-01: edits an existing server. Field edits, an in-place credential replacement
// (D-13) and the two reason-gated transitions from phase 1's D-14 (`identity_changed` /
// `clean_close`, both from `CONNECTED` only) all commit inside one `deps.db.transaction`, gated
// behind a `SELECT ... FOR UPDATE` row lock so a concurrent `connectAndDiscover` cannot write
// state onto a row being edited (D-11, T-3-06).
//
// SERV-02's core prohibition: the existing credential is never read back. This file never
// selects the encrypted envelope column, never decrypts a stored credential, and never inserts a
// new row into that table on replacement — only an in-place UPDATE of the same row (D-13). The
// only column this file ever reads off that table is its type enum, needed to build the returned
// `ServerView`'s `credentialType`.
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  validateHost,
  validateServerName,
  validateSshPort,
  validateSshUser,
} from '@noodara/domain/validators';
import { classifyServerEdit, transition, type ServerStatus } from '@noodara/domain/server';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import {
  currentKeyVersion,
  encodeCredential,
  type CredentialInput,
  type CredentialType,
  type EncodedCredential,
} from './credential-store.js';
import type { ServerServicesDeps, ServiceActor } from './server-service-deps.js';
import { toServerView, type ServerView } from './server-view.js';

const NAME_UNIQUE_CONSTRAINT = 'servers_name_lower_unique_idx';
const HOST_PORT_UNIQUE_CONSTRAINT = 'servers_host_port_unique_idx';

export interface EditServerInput {
  readonly actor: ServiceActor;
  readonly serverId: string;
  readonly name?: string;
  readonly host?: string;
  readonly sshPort?: number;
  readonly sshUser?: string;
  readonly credential?: CredentialInput;
}

export type EditServerFailureCode =
  | 'NOT_FOUND'
  | 'SERVER_BUSY'
  | 'VALIDATION_FAILED'
  | 'INVALID_CREDENTIAL'
  | 'NAME_TAKEN'
  | 'HOST_TAKEN';

export type EditServerResult =
  | { readonly ok: true; readonly server: ServerView }
  | { readonly ok: false; readonly code: EditServerFailureCode; readonly message: string };

/** The only four fields an edit can report as changed (D-16: never a value, only a field name). */
type EditableField = 'host' | 'name' | 'sshPort' | 'sshUser';

/** A raw Postgres unique-violation error, as drizzle-orm 0.45 wraps it (`DrizzleQueryError.cause`
 *  carries the original `pg` driver error, which is where `.code`/`.constraint` actually live). */
function uniqueViolationConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === '23505' ? cause.constraint : undefined;
}

/** `select type from credentials where id = ...` — the one credential read this file ever
 *  performs, needed only to project `credentialType` onto the returned `ServerView`. */
async function fetchCredentialType(
  handle: ActivityWriteHandle,
  credentialId: string,
): Promise<CredentialType> {
  const [row] = await handle
    .select({ type: credentials.type })
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1);
  if (!row) {
    throw new Error(`editServer: credential ${credentialId} not found`);
  }
  return row.type;
}

/**
 * SERV-02: validates every supplied field, replaces the credential in place when one is supplied
 * (D-13), applies D-14's two reason-gated transitions when the server was `CONNECTED`, and writes
 * exactly one `server.updated` event (D-16) whose metadata is `{ changedFields, credentialReplaced
 * }` — never an old or new value.
 */
export async function editServer(
  deps: ServerServicesDeps,
  input: EditServerInput,
): Promise<EditServerResult> {
  try {
    return await deps.db.transaction(async (tx) => {
      // D-11/T-3-06: the row lock is what stops a concurrent connectAndDiscover from writing
      // status/fingerprint onto a row being edited.
      const [row] = await tx
        .select()
        .from(servers)
        .where(eq(servers.id, input.serverId))
        .for('update');
      if (!row) {
        return {
          ok: false,
          code: 'NOT_FOUND',
          message: `Server "${input.serverId}" not found`,
        };
      }
      if (row.status === 'CONNECTING') {
        return {
          ok: false,
          code: 'SERVER_BUSY',
          message: 'Server has a connection attempt in flight',
        };
      }

      let name = row.name;
      if (input.name !== undefined) {
        const result = validateServerName(input.name);
        if (!result.ok) return { ok: false, code: 'VALIDATION_FAILED', message: result.message };
        name = result.value;
      }
      let host = row.host;
      if (input.host !== undefined) {
        const result = validateHost(input.host);
        if (!result.ok) return { ok: false, code: 'VALIDATION_FAILED', message: result.message };
        host = result.value;
      }
      let sshPort = row.sshPort;
      if (input.sshPort !== undefined) {
        const result = validateSshPort(input.sshPort);
        if (!result.ok) return { ok: false, code: 'VALIDATION_FAILED', message: result.message };
        sshPort = result.value;
      }
      let sshUser = row.sshUser;
      if (input.sshUser !== undefined) {
        const result = validateSshUser(input.sshUser);
        if (!result.ok) return { ok: false, code: 'VALIDATION_FAILED', message: result.message };
        sshUser = result.value;
      }

      const changedFields: EditableField[] = [];
      if (name !== row.name) changedFields.push('name');
      if (host !== row.host) changedFields.push('host');
      if (sshPort !== row.sshPort) changedFields.push('sshPort');
      if (sshUser !== row.sshUser) changedFields.push('sshUser');
      changedFields.sort();

      const credentialReplaced = input.credential !== undefined;

      // D-15/SERV-02: never selects or decodes the existing credential — encodeCredential only
      // ever sees the *new* material the caller supplied.
      let credentialUpdate: EncodedCredential | undefined;
      if (input.credential !== undefined) {
        const keyVersion = await currentKeyVersion(tx);
        const encoded = encodeCredential(
          input.credential,
          { key: deps.masterKeys.current, version: keyVersion },
          deps.redactor,
        );
        if (!encoded.ok) {
          return { ok: false, code: 'INVALID_CREDENTIAL', message: encoded.message };
        }
        credentialUpdate = encoded;
      }

      // D-10: uniqueness pre-checks excluding the row itself; a 23505 is only the safety net
      // behind these (see the catch block below).
      if (changedFields.includes('name')) {
        const [existingByName] = await tx
          .select({ id: servers.id })
          .from(servers)
          .where(and(sql`lower(${servers.name}) = lower(${name})`, ne(servers.id, row.id)))
          .limit(1);
        if (existingByName) {
          return {
            ok: false,
            code: 'NAME_TAKEN',
            message: `Server name "${name}" is already registered`,
          };
        }
      }
      if (changedFields.includes('host') || changedFields.includes('sshPort')) {
        const [existingByHostPort] = await tx
          .select({ id: servers.id })
          .from(servers)
          .where(and(eq(servers.host, host), eq(servers.sshPort, sshPort), ne(servers.id, row.id)))
          .limit(1);
        if (existingByHostPort) {
          return {
            ok: false,
            code: 'HOST_TAKEN',
            message: `A server already exists at ${host}:${sshPort.toString()}`,
          };
        }
      }

      // D-14: only a server that was CONNECTED at edit time can transition; every other starting
      // status is a plain field update with no status literal ever assigned (transition() is the
      // only source of a new status).
      let statusPatch: Partial<
        Pick<
          typeof servers.$inferInsert,
          'status' | 'hostFingerprint' | 'hostFingerprintCapturedAt'
        >
      > = {};
      if (row.status === 'CONNECTED') {
        const classification = classifyServerEdit(
          { host: row.host, sshPort: row.sshPort, sshUser: row.sshUser, credentialReplaced: false },
          { host, sshPort, sshUser, credentialReplaced },
        );
        if (classification === 'identity') {
          const newStatus: ServerStatus = transition('CONNECTED', 'PENDING', {
            reason: 'identity_changed',
          });
          statusPatch = {
            status: newStatus,
            hostFingerprint: null,
            hostFingerprintCapturedAt: null,
          };
        } else if (classification === 'access') {
          const newStatus: ServerStatus = transition('CONNECTED', 'DISCONNECTED', {
            reason: 'clean_close',
          });
          statusPatch = { status: newStatus };
        }
      }

      // An empty edit is not an audit event (documented discretionary decision) — nothing is
      // written at all.
      if (changedFields.length === 0 && !credentialReplaced) {
        const credentialType = await fetchCredentialType(tx, row.credentialId);
        return { ok: true, server: toServerView(row, credentialType) };
      }

      if (credentialUpdate !== undefined) {
        await tx
          .update(credentials)
          .set({
            type: credentialUpdate.type,
            encryptedValue: credentialUpdate.encryptedValue,
            keyVersion: credentialUpdate.keyVersion,
            updatedAt: deps.now(),
          })
          .where(eq(credentials.id, row.credentialId));
      }

      const [updatedRow] = await tx
        .update(servers)
        .set({
          name,
          host,
          sshPort,
          sshUser,
          ...statusPatch,
          updatedAt: deps.now(),
        })
        .where(eq(servers.id, row.id))
        .returning();
      if (!updatedRow) {
        throw new Error('editServer: server update returned no row');
      }

      const activityInput = {
        actorType: input.actor.type,
        actorId: input.actor.type === 'user' ? input.actor.id : null,
        entityType: 'server',
        entityId: row.id,
        action: 'server.updated',
        outcome: 'success',
        metadata: { changedFields, credentialReplaced },
      } as const;
      await writeActivityEvent(tx, activityInput, deps.now());

      const credentialType =
        credentialUpdate?.type ?? (await fetchCredentialType(tx, updatedRow.credentialId));
      return { ok: true, server: toServerView(updatedRow, credentialType) };
    });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === NAME_UNIQUE_CONSTRAINT) {
      return {
        ok: false,
        code: 'NAME_TAKEN',
        message: 'Server name is already registered',
      };
    }
    if (constraint === HOST_PORT_UNIQUE_CONSTRAINT) {
      return {
        ok: false,
        code: 'HOST_TAKEN',
        message: 'A server already exists at that host and port',
      };
    }
    throw error;
  }
}
