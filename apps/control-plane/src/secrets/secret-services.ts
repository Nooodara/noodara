// 23-03: the secrets API's service layer, at project, environment and service scope.
// - A value enters only as a JSON string, is checked (non-empty, single line, well-formed UTF-8,
//   at most MAX_SECRET_VALUE_LENGTH bytes) before it is wrapped and encrypted, and never leaves:
//   views carry the hint only and there is no reveal path (A1, H1).
// - Every write runs in one transaction with its activity event (scope and name only).
// - Delete locks the secret FOR UPDATE before its in-use check, which pairs with the FOR SHARE
//   lock env-store takes on a referenced secret, so a reference cannot appear between the check
//   and the commit (A2).
// - Errors leave this module value-free: anything but a known unique violation or a closed store
//   code is rethrown as SecretServiceError carrying the SQLSTATE only.
import { MAX_SECRETS_PER_SCOPE, validateSecretName, type EnvScope } from '@noodara/domain';
import { mapUniqueViolation, MAX_SECRET_VALUE_LENGTH, type SecretView } from '@noodara/domain/api-contract';
import { secretValue } from '@noodara/domain/security';
import { and, asc, count, eq, isNull, type SQL } from 'drizzle-orm';
import { writeSecretEvent } from '../activity/secret-events.js';
import type { Database } from '../db/client.js';
import { environmentVariables } from '../db/schema/environment-variables.js';
import { secrets } from '../db/schema/secrets.js';
import { services } from '../db/schema/services.js';
import { loadOwnerChain, type EnvOwner } from '../env/env-store.js';
import type { MasterKeys, ServiceActor } from '../services/server-service-deps.js';
import { createSecret, replaceSecret, SecretStoreError, type SecretRecord } from './secret-store.js';

export interface SecretServiceDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly masterKeys: MasterKeys;
}

export type SecretFailureCode =
  | 'NOT_FOUND'
  | 'ENV_INPUT_INVALID'
  | 'ENV_VALUE_MULTILINE'
  | 'SECRET_NAME_DUPLICATE'
  | 'SECRET_LIMIT_REACHED'
  | 'SECRET_IN_USE';

/** A variable that would resolve to the secret being deleted. */
export interface SecretUsage {
  readonly scope: EnvScope;
  readonly key: string;
}

export interface SecretServiceFailure {
  readonly ok: false;
  readonly code: SecretFailureCode;
  readonly message: string;
  /** ENV_INPUT_INVALID: the validator's code (SECRET_NAME_INVALID, SECRET_VALUE_REQUIRED, ...). */
  readonly reason?: string;
  /** SECRET_IN_USE: the referencing variables. */
  readonly usedBy?: readonly SecretUsage[];
}

export type SecretResult = { readonly ok: true; readonly secret: SecretView } | SecretServiceFailure;
export type SecretListResult = { readonly ok: true; readonly items: SecretView[] } | SecretServiceFailure;

/** A storage failure with no message from the driver (which may hold bound parameters). */
export class SecretServiceError extends Error {
  constructor(readonly pgCode: string | null) {
    super(`secret storage failed${pgCode === null ? '' : ` (SQLSTATE ${pgCode})`}`);
    this.name = 'SecretServiceError';
  }
}

const OWNER_LABEL: Readonly<Record<EnvScope, string>> = Object.freeze({
  project: 'Project',
  environment: 'Environment',
  service: 'Service',
});

const SCOPE_ORDER: Readonly<Record<EnvScope, number>> = Object.freeze({ project: 0, environment: 1, service: 2 });

function notFound(owner: EnvOwner): SecretServiceFailure {
  return { ok: false, code: 'NOT_FOUND', message: `${OWNER_LABEL[owner.scope]} or secret not found` };
}

function invalid(reason: string, message: string): SecretServiceFailure {
  return { ok: false, code: 'ENV_INPUT_INVALID', message, reason };
}

export function toSecretView(record: SecretRecord): SecretView {
  return {
    id: record.id,
    scope: record.scope,
    name: record.name,
    version: record.version,
    hint: record.hint,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * H1: the value check, run before the value is wrapped or encrypted. A NUL counts as a line break
 * (it would end the line in the env file), as for variables. Failures name a reason and
 * never quote the value.
 */
export function validateSecretValue(value: unknown): { readonly ok: true; readonly value: string } | SecretServiceFailure {
  if (typeof value !== 'string') return invalid('SECRET_VALUE_INVALID', 'Secret value must be a string');
  if (value.length === 0) return invalid('SECRET_VALUE_REQUIRED', 'Secret value is required');
  if (value.length > MAX_SECRET_VALUE_LENGTH) return tooLarge();
  if (/[\r\n\0]/.test(value)) {
    return { ok: false, code: 'ENV_VALUE_MULTILINE', message: 'Secret value must be a single line' };
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) {
    return invalid('SECRET_VALUE_INVALID_UTF8', 'Secret value must be valid UTF-8');
  }
  if (bytes.byteLength > MAX_SECRET_VALUE_LENGTH) return tooLarge();
  return { ok: true, value };
}

function tooLarge(): SecretServiceFailure {
  return invalid('SECRET_VALUE_TOO_LARGE', `Secret value must be at most ${String(MAX_SECRET_VALUE_LENGTH)} bytes`);
}

function validateName(name: string): SecretServiceFailure | null {
  const valid = validateSecretName(name);
  return valid.ok ? null : invalid(valid.code, valid.message);
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
    if (mapUniqueViolation(error) === 'SECRET_NAME_DUPLICATE') return onDuplicate();
    if (error instanceof SecretServiceError) throw error;
    if (error instanceof SecretStoreError) throw new SecretServiceError(null);
    throw new SecretServiceError(pgCodeOf(error));
  }
}

function allOf(...conditions: SQL[]): SQL {
  const combined = and(...conditions);
  if (combined === undefined) throw new Error('allOf needs at least one condition');
  return combined;
}

/** Secret rows owned by exactly `owner`. */
export function secretsOwnedBy(owner: EnvOwner): SQL {
  const base = allOf(eq(secrets.projectId, owner.projectId), eq(secrets.scope, owner.scope));
  switch (owner.scope) {
    case 'project':
      return allOf(base, isNull(secrets.environmentId), isNull(secrets.serviceId));
    case 'environment':
      return allOf(base, eq(secrets.environmentId, owner.environmentId));
    case 'service':
      return allOf(base, eq(secrets.serviceId, owner.serviceId));
  }
}

/** Value-free columns only: the envelope is never selected here. */
const RECORD_COLUMNS = {
  id: secrets.id,
  scope: secrets.scope,
  projectId: secrets.projectId,
  environmentId: secrets.environmentId,
  serviceId: secrets.serviceId,
  name: secrets.name,
  version: secrets.version,
  hint: secrets.hint,
  createdAt: secrets.createdAt,
  updatedAt: secrets.updatedAt,
} as const;

// ---- in-use guard (A2) -------------------------------------------------------------------------

export interface SecretPlacement {
  readonly id: string;
  readonly scope: EnvScope;
  readonly environmentId: string | null;
  readonly serviceId: string | null;
}

export interface ReferencingVariable {
  readonly scope: EnvScope;
  readonly key: string;
  readonly environmentId: string | null;
  readonly serviceId: string | null;
}

export interface ServicePlacement {
  readonly id: string;
  readonly environmentId: string;
}

interface ResolutionContext {
  readonly environmentId: string | null;
  readonly serviceId: string | null;
}

/** The secret of one name a context resolves to: service, then environment, then project. */
function nearestSecret(named: readonly SecretPlacement[], context: ResolutionContext): string | null {
  const at = (scope: EnvScope, match: (secret: SecretPlacement) => boolean): SecretPlacement | undefined =>
    named.find((secret) => secret.scope === scope && match(secret));
  const found =
    (context.serviceId === null ? undefined : at('service', (s) => s.serviceId === context.serviceId)) ??
    (context.environmentId === null ? undefined : at('environment', (s) => s.environmentId === context.environmentId)) ??
    at('project', () => true);
  return found?.id ?? null;
}

/** Where a variable is read: its own owner and every service below it. */
function contextsOf(variable: ReferencingVariable, projectServices: readonly ServicePlacement[]): ResolutionContext[] {
  switch (variable.scope) {
    case 'project':
      return [
        { environmentId: null, serviceId: null },
        ...projectServices.map((service) => ({ environmentId: service.environmentId, serviceId: service.id })),
      ];
    case 'environment':
      return [
        { environmentId: variable.environmentId, serviceId: null },
        ...projectServices
          .filter((service) => service.environmentId === variable.environmentId)
          .map((service) => ({ environmentId: service.environmentId, serviceId: service.id })),
      ];
    case 'service': {
      const service = projectServices.find((candidate) => candidate.id === variable.serviceId);
      return [{ environmentId: service?.environmentId ?? null, serviceId: variable.serviceId }];
    }
  }
}

/**
 * A2: the variables (scope and key, deduplicated, project first then by key) that reference the
 * target's name and resolve to the target in at least one place they are read. `named` holds
 * every secret of that name in the project, the target included.
 */
export function secretUsages(
  targetId: string,
  variables: readonly ReferencingVariable[],
  named: readonly SecretPlacement[],
  projectServices: readonly ServicePlacement[],
): SecretUsage[] {
  const seen = new Map<string, SecretUsage>();
  for (const variable of variables) {
    const resolvesToTarget = contextsOf(variable, projectServices).some(
      (context) => nearestSecret(named, context) === targetId,
    );
    if (resolvesToTarget) seen.set(`${variable.scope}\u0000${variable.key}`, { scope: variable.scope, key: variable.key });
  }
  return [...seen.values()].sort(
    (a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

// ---- operations ----------------------------------------------------------------------------------

export async function listSecrets(deps: SecretServiceDeps, owner: EnvOwner): Promise<SecretListResult> {
  const chain = await loadOwnerChain(deps.db, owner);
  if (chain === null) return notFound(owner);
  const rows = await deps.db.select(RECORD_COLUMNS).from(secrets).where(secretsOwnedBy(owner)).orderBy(asc(secrets.name));
  return { ok: true, items: rows.map(toSecretView) };
}

export async function getSecret(deps: SecretServiceDeps, owner: EnvOwner, secretId: string): Promise<SecretResult> {
  const [row] = await deps.db
    .select(RECORD_COLUMNS)
    .from(secrets)
    .where(and(secretsOwnedBy(owner), eq(secrets.id, secretId)));
  return row === undefined ? notFound(owner) : { ok: true, secret: toSecretView(row) };
}

export async function createSecretForOwner(
  deps: SecretServiceDeps,
  input: { readonly actor: ServiceActor; readonly owner: EnvOwner; readonly body: { name: string; value: unknown } },
): Promise<SecretResult> {
  const badName = validateName(input.body.name);
  if (badName !== null) return badName;
  const valid = validateSecretValue(input.body.value);
  if (!valid.ok) return valid;
  const { owner } = input;
  const at = deps.now();
  return valueFree(
    () =>
      deps.db.transaction(async (tx): Promise<SecretResult> => {
        const chain = await loadOwnerChain(tx, owner, true);
        if (chain === null) return notFound(owner);
        const [counted] = await tx.select({ value: count() }).from(secrets).where(secretsOwnedBy(owner));
        if ((counted?.value ?? 0) >= MAX_SECRETS_PER_SCOPE) {
          return { ok: false, code: 'SECRET_LIMIT_REACHED', message: 'This scope already has the maximum number of secrets.' };
        }
        const record = await createSecret(
          tx,
          { owner, name: input.body.name, value: secretValue(valid.value, 'app_secret') },
          deps.masterKeys,
        );
        await writeSecretEvent(
          tx,
          { actor: input.actor, action: 'secret.created', secretId: record.id, scope: record.scope, name: record.name },
          at,
        );
        return { ok: true, secret: toSecretView(record) };
      }),
    () => ({ ok: false, code: 'SECRET_NAME_DUPLICATE', message: 'A secret with this name already exists here.' }),
  );
}

export async function replaceSecretValue(
  deps: SecretServiceDeps,
  input: {
    readonly actor: ServiceActor;
    readonly owner: EnvOwner;
    readonly secretId: string;
    readonly body: { value: unknown };
  },
): Promise<SecretResult> {
  const valid = validateSecretValue(input.body.value);
  if (!valid.ok) return valid;
  const { owner } = input;
  const at = deps.now();
  return valueFree(
    () =>
      deps.db.transaction(async (tx): Promise<SecretResult> => {
        const [owned] = await tx
          .select({ id: secrets.id })
          .from(secrets)
          .where(and(secretsOwnedBy(owner), eq(secrets.id, input.secretId)))
          .for('update');
        if (owned === undefined) return notFound(owner);
        let record: SecretRecord;
        try {
          record = await replaceSecret(tx, owned.id, secretValue(valid.value, 'app_secret'), deps.masterKeys);
        } catch (error) {
          if (error instanceof SecretStoreError && error.code === 'SECRET_NOT_FOUND') return notFound(owner);
          throw error;
        }
        await writeSecretEvent(
          tx,
          { actor: input.actor, action: 'secret.replaced', secretId: record.id, scope: record.scope, name: record.name },
          at,
        );
        return { ok: true, secret: toSecretView(record) };
      }),
    () => ({ ok: false, code: 'SECRET_NAME_DUPLICATE', message: 'A secret with this name already exists here.' }),
  );
}

export async function removeSecret(
  deps: SecretServiceDeps,
  input: { readonly actor: ServiceActor; readonly owner: EnvOwner; readonly secretId: string },
): Promise<{ readonly ok: true } | SecretServiceFailure> {
  const { owner } = input;
  const at = deps.now();
  return valueFree(
    () =>
      deps.db.transaction(async (tx): Promise<{ readonly ok: true } | SecretServiceFailure> => {
        const [target] = await tx
          .select({ id: secrets.id, scope: secrets.scope, name: secrets.name, projectId: secrets.projectId })
          .from(secrets)
          .where(and(secretsOwnedBy(owner), eq(secrets.id, input.secretId)))
          .for('update');
        if (target === undefined) return notFound(owner);

        const variables = await tx
          .select({
            scope: environmentVariables.scope,
            key: environmentVariables.key,
            environmentId: environmentVariables.environmentId,
            serviceId: environmentVariables.serviceId,
          })
          .from(environmentVariables)
          .where(
            and(
              eq(environmentVariables.projectId, target.projectId),
              eq(environmentVariables.value, `<secret:${target.name}>`),
            ),
          );
        if (variables.length > 0) {
          const named = await tx
            .select({
              id: secrets.id,
              scope: secrets.scope,
              environmentId: secrets.environmentId,
              serviceId: secrets.serviceId,
            })
            .from(secrets)
            .where(and(eq(secrets.projectId, target.projectId), eq(secrets.name, target.name)));
          const projectServices = await tx
            .select({ id: services.id, environmentId: services.environmentId })
            .from(services)
            .where(eq(services.projectId, target.projectId));
          const usedBy = secretUsages(target.id, variables, named, projectServices);
          if (usedBy.length > 0) {
            return {
              ok: false,
              code: 'SECRET_IN_USE',
              message: `Secret ${target.name} is referenced by ${String(usedBy.length)} variable${usedBy.length === 1 ? '' : 's'}.`,
              usedBy,
            };
          }
        }

        await tx.delete(secrets).where(eq(secrets.id, target.id));
        await writeSecretEvent(
          tx,
          { actor: input.actor, action: 'secret.deleted', secretId: target.id, scope: target.scope, name: target.name },
          at,
        );
        return { ok: true };
      }),
    () => ({ ok: false, code: 'SECRET_NAME_DUPLICATE', message: 'A secret with this name already exists here.' }),
  );
}
