// 23-02: storage of environment variables at project, environment and service scope.
// - Every write runs in one transaction with its activity event (scope and key only).
// - create locks the owner row (FOR NO KEY UPDATE) so the per-owner count and the insert
//   serialize; the unique index on (owner, key) still decides a duplicate (H1).
// - A `<secret:name>` value is checked against the secrets visible from the owner by precedence,
//   locking the matched secret row FOR SHARE so a concurrent secret delete (which must lock it
//   FOR UPDATE before its in-use check, 23-03) cannot slip between the check and the commit.
// - Errors leave this module value-free: a Drizzle query error carries the bound parameters (the
//   value) in its message, so anything but a known unique violation is rethrown as EnvStoreError.
import { MAX_ENV_VARS_PER_SCOPE, type EnvScope } from '@noodara/domain';
import { mapUniqueViolation } from '@noodara/domain/api-contract';
import { and, asc, count, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { writeEnvVariableEvent } from '../activity/env-events.js';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { environmentVariables } from '../db/schema/environment-variables.js';
import { environments } from '../db/schema/environments.js';
import { projects } from '../db/schema/projects.js';
import { secrets } from '../db/schema/secrets.js';
import { services } from '../db/schema/services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { nextUpdatedAt } from '../services/updated-at.js';

export type EnvOwner =
  | { readonly scope: 'project'; readonly projectId: string }
  | { readonly scope: 'environment'; readonly projectId: string; readonly environmentId: string }
  | { readonly scope: 'service'; readonly projectId: string; readonly serviceId: string };

/** The owners whose secrets (and variables) an owner sees: itself and every scope above it. */
export interface OwnerChain {
  readonly owner: EnvOwner;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly serviceId: string | null;
}

export type VariableRow = typeof environmentVariables.$inferSelect;

export type EnvStoreFailureCode =
  | 'NOT_FOUND'
  | 'ENV_KEY_DUPLICATE'
  | 'ENV_KEY_IMMUTABLE'
  | 'ENV_LIMIT_REACHED'
  | 'SECRET_NOT_FOUND';

export type EnvWriteResult =
  | { readonly ok: true; readonly row: VariableRow }
  | { readonly ok: false; readonly code: EnvStoreFailureCode };

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Handle = Database | Tx;

/** A storage failure with no message from the driver (which would hold the bound value). */
export class EnvStoreError extends Error {
  constructor(readonly pgCode: string | null) {
    super(`environment variable storage failed${pgCode === null ? '' : ` (SQLSTATE ${pgCode})`}`);
    this.name = 'EnvStoreError';
  }
}

function pgCodeOf(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate === 'object' && candidate !== null) {
      const { code } = candidate as { code?: unknown };
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
  }
  return null;
}

async function valueFree<T>(work: () => Promise<T>, onDuplicate: () => T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (mapUniqueViolation(error) === 'ENV_KEY_DUPLICATE') return onDuplicate();
    if (error instanceof EnvStoreError) throw error;
    throw new EnvStoreError(pgCodeOf(error));
  }
}

/** Rows owned by exactly `owner`. */
export function ownedBy(owner: EnvOwner): SQL {
  const base = and(eq(environmentVariables.projectId, owner.projectId), eq(environmentVariables.scope, owner.scope));
  switch (owner.scope) {
    case 'project':
      return and(base, isNull(environmentVariables.environmentId), isNull(environmentVariables.serviceId)) as SQL;
    case 'environment':
      return and(base, eq(environmentVariables.environmentId, owner.environmentId)) as SQL;
    case 'service':
      return and(base, eq(environmentVariables.serviceId, owner.serviceId)) as SQL;
  }
}

/** Resolves (and optionally locks) the owner row; null when it is not in `projectId`. */
export async function loadOwnerChain(handle: Handle, owner: EnvOwner, lock = false): Promise<OwnerChain | null> {
  switch (owner.scope) {
    case 'project': {
      const query = handle.select({ id: projects.id }).from(projects).where(eq(projects.id, owner.projectId));
      const [row] = lock ? await query.for('no key update') : await query;
      return row ? { owner, projectId: row.id, environmentId: null, serviceId: null } : null;
    }
    case 'environment': {
      const query = handle
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.id, owner.environmentId), eq(environments.projectId, owner.projectId)));
      const [row] = lock ? await query.for('no key update') : await query;
      return row ? { owner, projectId: owner.projectId, environmentId: row.id, serviceId: null } : null;
    }
    case 'service': {
      const query = handle
        .select({ id: services.id, environmentId: services.environmentId })
        .from(services)
        .where(and(eq(services.id, owner.serviceId), eq(services.projectId, owner.projectId)));
      const [row] = lock ? await query.for('no key update') : await query;
      return row ? { owner, projectId: owner.projectId, environmentId: row.environmentId, serviceId: row.id } : null;
    }
  }
}

function visibleSecretsWhere(chain: OwnerChain): SQL {
  const levels: SQL[] = [eq(secrets.scope, 'project')];
  if (chain.environmentId !== null) {
    levels.push(and(eq(secrets.scope, 'environment'), eq(secrets.environmentId, chain.environmentId)) as SQL);
  }
  if (chain.serviceId !== null) {
    levels.push(and(eq(secrets.scope, 'service'), eq(secrets.serviceId, chain.serviceId)) as SQL);
  }
  return and(eq(secrets.projectId, chain.projectId), or(...levels)) as SQL;
}

/** A2: a secret of `name` visible from the chain's owner; locked FOR SHARE inside a write tx. */
async function secretVisible(tx: Tx, chain: OwnerChain, name: string): Promise<boolean> {
  const rows = await tx
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(visibleSecretsWhere(chain), eq(secrets.name, name)))
    .for('share');
  return rows.length > 0;
}

/** Names, versions and scopes of every secret visible from the chain (never a value). */
export async function listVisibleSecrets(
  handle: Handle,
  chain: OwnerChain,
): Promise<{ readonly scope: EnvScope; readonly name: string; readonly version: number }[]> {
  return handle
    .select({ scope: secrets.scope, name: secrets.name, version: secrets.version })
    .from(secrets)
    .where(visibleSecretsWhere(chain));
}

export async function listOwnedVariables(handle: Handle, owner: EnvOwner): Promise<VariableRow[]> {
  return handle
    .select()
    .from(environmentVariables)
    .where(ownedBy(owner))
    .orderBy(asc(environmentVariables.key));
}

/** Project, environment and service rows of one service's chain, by scope. */
export async function listChainVariables(handle: Handle, chain: OwnerChain): Promise<VariableRow[]> {
  const owners: SQL[] = [ownedBy({ scope: 'project', projectId: chain.projectId })];
  if (chain.environmentId !== null) {
    owners.push(ownedBy({ scope: 'environment', projectId: chain.projectId, environmentId: chain.environmentId }));
  }
  if (chain.serviceId !== null) {
    owners.push(ownedBy({ scope: 'service', projectId: chain.projectId, serviceId: chain.serviceId }));
  }
  return handle.select().from(environmentVariables).where(or(...owners));
}

/** The raw runtime config of the service's latest SUCCESS or ROLLED_BACK deployment. */
export async function loadRunningRuntimeConfig(
  handle: Handle,
  serviceId: string,
): Promise<{ readonly found: false } | { readonly found: true; readonly runtimeConfig: unknown }> {
  const [row] = await handle
    .select({ runtimeConfig: deployments.runtimeConfig })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ['SUCCESS', 'ROLLED_BACK'])))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(1);
  return row ? { found: true, runtimeConfig: row.runtimeConfig ?? null } : { found: false };
}

export interface VariableWrite {
  readonly actor: ServiceActor;
  readonly owner: EnvOwner;
  /** Set when the value is `<secret:name>`: the name must be visible from the owner. */
  readonly secretRef: string | null;
  readonly at: Date;
}

export function insertVariable(
  db: Database,
  input: VariableWrite & { readonly key: string; readonly value: string },
): Promise<EnvWriteResult> {
  return valueFree(
    () =>
      db.transaction(async (tx): Promise<EnvWriteResult> => {
        const chain = await loadOwnerChain(tx, input.owner, true);
        if (chain === null) return { ok: false, code: 'NOT_FOUND' };
        const [counted] = await tx.select({ value: count() }).from(environmentVariables).where(ownedBy(input.owner));
        if ((counted?.value ?? 0) >= MAX_ENV_VARS_PER_SCOPE) return { ok: false, code: 'ENV_LIMIT_REACHED' };
        if (input.secretRef !== null && !(await secretVisible(tx, chain, input.secretRef))) {
          return { ok: false, code: 'SECRET_NOT_FOUND' };
        }
        const { owner } = input;
        const [row] = await tx
          .insert(environmentVariables)
          .values({
            scope: owner.scope,
            projectId: owner.projectId,
            environmentId: owner.scope === 'environment' ? owner.environmentId : null,
            serviceId: owner.scope === 'service' ? owner.serviceId : null,
            key: input.key,
            value: input.value,
            createdAt: input.at,
            updatedAt: input.at,
          })
          .returning();
        if (!row) throw new EnvStoreError(null);
        await writeEnvVariableEvent(
          tx,
          { actor: input.actor, action: 'env.variable_created', variableId: row.id, scope: row.scope, key: row.key },
          input.at,
        );
        return { ok: true, row };
      }),
    () => ({ ok: false, code: 'ENV_KEY_DUPLICATE' }),
  );
}

async function lockVariable(tx: Tx, owner: EnvOwner, variableId: string): Promise<VariableRow | null> {
  const [row] = await tx
    .select()
    .from(environmentVariables)
    .where(and(eq(environmentVariables.id, variableId), ownedBy(owner)))
    .for('update');
  return row ?? null;
}

/** The key never changes (H2): a `key` that differs from the stored one is ENV_KEY_IMMUTABLE. */
export function updateVariableValue(
  db: Database,
  input: VariableWrite & { readonly variableId: string; readonly key: string | undefined; readonly value: string },
): Promise<EnvWriteResult> {
  return valueFree(
    () =>
      db.transaction(async (tx): Promise<EnvWriteResult> => {
        const chain = await loadOwnerChain(tx, input.owner);
        if (chain === null) return { ok: false, code: 'NOT_FOUND' };
        const current = await lockVariable(tx, input.owner, input.variableId);
        if (current === null) return { ok: false, code: 'NOT_FOUND' };
        if (input.key !== undefined && input.key !== current.key) return { ok: false, code: 'ENV_KEY_IMMUTABLE' };
        if (input.secretRef !== null && !(await secretVisible(tx, chain, input.secretRef))) {
          return { ok: false, code: 'SECRET_NOT_FOUND' };
        }
        const [row] = await tx
          .update(environmentVariables)
          .set({ value: input.value, updatedAt: nextUpdatedAt(current.updatedAt, input.at) })
          .where(eq(environmentVariables.id, current.id))
          .returning();
        if (!row) throw new EnvStoreError(null);
        await writeEnvVariableEvent(
          tx,
          { actor: input.actor, action: 'env.variable_updated', variableId: row.id, scope: row.scope, key: row.key },
          input.at,
        );
        return { ok: true, row };
      }),
    () => ({ ok: false, code: 'ENV_KEY_DUPLICATE' }),
  );
}

export function deleteVariable(
  db: Database,
  input: { readonly actor: ServiceActor; readonly owner: EnvOwner; readonly variableId: string; readonly at: Date },
): Promise<EnvWriteResult> {
  return valueFree(
    () =>
      db.transaction(async (tx): Promise<EnvWriteResult> => {
        const [row] = await tx
          .delete(environmentVariables)
          .where(and(eq(environmentVariables.id, input.variableId), ownedBy(input.owner)))
          .returning();
        if (!row) return { ok: false, code: 'NOT_FOUND' };
        await writeEnvVariableEvent(
          tx,
          { actor: input.actor, action: 'env.variable_deleted', variableId: row.id, scope: row.scope, key: row.key },
          input.at,
        );
        return { ok: true, row };
      }),
    () => ({ ok: false, code: 'ENV_KEY_DUPLICATE' }),
  );
}
