// SERV-01/ACT-01: registers a new server. Everything — the encrypted credential row, the PENDING
// server row and the D-16 `server.created` activity event — commits in one `db.transaction`, or
// nothing at all (T-3-23). `NAME_TAKEN` / `HOST_TAKEN` / `INVALID_CREDENTIAL` / `VALIDATION_FAILED`
// are returned as results (never thrown) per setup-service.ts's established transactional-service
// pattern; a Postgres unique violation is only a safety net behind the in-transaction pre-checks
// (D-10), never the primary defense.
import { and, eq, sql } from 'drizzle-orm';
import {
  validateHost,
  validateServerName,
  validateSshPort,
  validateSshUser,
} from '@noodara/domain/validators';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import { publishServerEvent } from '../events/server-event-publisher.js';
import { currentKeyVersion, encodeCredential, type CredentialInput } from './credential-store.js';
import type { ServerServicesDeps, ServiceActor } from './server-service-deps.js';
import { toServerView, type ServerView } from './server-view.js';

const DEFAULT_SSH_PORT = 22;
const DEFAULT_SSH_USER = 'root';

const NAME_UNIQUE_CONSTRAINT = 'servers_name_lower_unique_idx';
const HOST_PORT_UNIQUE_CONSTRAINT = 'servers_host_port_unique_idx';

export interface RegisterServerInput {
  readonly actor: ServiceActor;
  readonly name: string;
  readonly host: string;
  readonly sshPort?: number;
  readonly sshUser?: string;
  readonly credential: CredentialInput;
}

export type RegisterServerFailureCode =
  'VALIDATION_FAILED' | 'INVALID_CREDENTIAL' | 'NAME_TAKEN' | 'HOST_TAKEN';

export type RegisterServerResult =
  | { readonly ok: true; readonly server: ServerView }
  | {
      readonly ok: false;
      readonly code: RegisterServerFailureCode;
      readonly message: string;
    };

/** A raw Postgres unique-violation error, as drizzle-orm 0.45 wraps it (`DrizzleQueryError.cause`
 *  carries the original `pg` driver error, which is where `.code`/`.constraint` actually live). */
function uniqueViolationConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === '23505' ? cause.constraint : undefined;
}

/**
 * SERV-01: validates and defaults every field, encrypts the credential (D-15), then opens one
 * transaction that pre-checks both D-10 uniqueness rules, persists the credential and server rows,
 * and writes exactly one `server.created` event (D-16/D-17) attributed to `input.actor`.
 */
export async function registerServer(
  deps: ServerServicesDeps,
  input: RegisterServerInput,
): Promise<RegisterServerResult> {
  const sshPort = input.sshPort ?? DEFAULT_SSH_PORT;
  const sshUser = input.sshUser ?? DEFAULT_SSH_USER;

  const nameResult = validateServerName(input.name);
  if (!nameResult.ok) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: nameResult.message,
    };
  }
  const hostResult = validateHost(input.host);
  if (!hostResult.ok) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: hostResult.message,
    };
  }
  const portResult = validateSshPort(sshPort);
  if (!portResult.ok) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: portResult.message,
    };
  }
  const userResult = validateSshUser(sshUser);
  if (!userResult.ok) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: userResult.message,
    };
  }

  const name = nameResult.value;
  const host = hostResult.value;

  const keyVersion = await currentKeyVersion(deps.db);
  const encoded = encodeCredential(
    input.credential,
    { key: deps.masterKeys.current, version: keyVersion },
    deps.redactor,
  );
  if (!encoded.ok) {
    return { ok: false, code: 'INVALID_CREDENTIAL', message: encoded.message };
  }

  try {
    const result: RegisterServerResult = await deps.db.transaction(async (tx) => {
      const [existingByName] = await tx
        .select({ id: servers.id })
        .from(servers)
        .where(sql`lower(${servers.name}) = lower(${name})`)
        .limit(1);
      if (existingByName) {
        return {
          ok: false,
          code: 'NAME_TAKEN',
          message: `Server name "${name}" is already registered`,
        };
      }

      const [existingByHostPort] = await tx
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.host, host), eq(servers.sshPort, sshPort)))
        .limit(1);
      if (existingByHostPort) {
        return {
          ok: false,
          code: 'HOST_TAKEN',
          message: `A server already exists at ${host}:${sshPort.toString()}`,
        };
      }

      const [credentialRow] = await tx
        .insert(credentials)
        .values({
          type: encoded.type,
          encryptedValue: encoded.encryptedValue,
          keyVersion: encoded.keyVersion,
        })
        .returning();
      if (!credentialRow) {
        throw new Error('registerServer: credential insert returned no row');
      }

      const [serverRow] = await tx
        .insert(servers)
        .values({
          name,
          host,
          sshPort,
          sshUser,
          credentialId: credentialRow.id,
        })
        .returning();
      if (!serverRow) {
        throw new Error('registerServer: server insert returned no row');
      }

      const activityInput = {
        actorType: input.actor.type,
        actorId: input.actor.type === 'user' ? input.actor.id : null,
        entityType: 'server',
        entityId: serverRow.id,
        action: 'server.created',
        outcome: 'success',
        metadata: { name, host, sshPort, sshUser, credentialType: encoded.type },
      } as const;
      await writeActivityEvent(tx, activityInput, deps.now());

      return { ok: true, server: toServerView(serverRow, encoded.type) };
    });

    // D-04: publish only after the transaction has committed — a rolled-back registration never
    // reaches this line (the catch block below returns before it does).
    if (result.ok) {
      await publishServerEvent(deps.events, { type: 'server.updated', server: result.server });
    }
    return result;
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === NAME_UNIQUE_CONSTRAINT) {
      return {
        ok: false,
        code: 'NAME_TAKEN',
        message: `Server name "${name}" is already registered`,
      };
    }
    if (constraint === HOST_PORT_UNIQUE_CONSTRAINT) {
      return {
        ok: false,
        code: 'HOST_TAKEN',
        message: `A server already exists at ${host}:${sshPort.toString()}`,
      };
    }
    throw error;
  }
}
