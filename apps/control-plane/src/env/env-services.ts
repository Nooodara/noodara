// 23-02: the variables API's service layer. Create and update share one validator (H2): key
// format, single-line value, size, and `<secret:name>` syntax; a reference must name a secret
// visible from the owner (A2). Failures carry codes, a key or a reference name, never a value.
import {
  parseEnvValue,
  resolveEnv,
  resolveSecretRefs,
  validateEnvKey,
  type EnvDefinition,
  type EnvScope,
  type EnvValue,
  type RuntimeEnvEntry,
  type SecretsByScope,
} from '@noodara/domain';
import type { EffectiveVariableView, VariableView } from '@noodara/domain/api-contract';
import type { Database } from '../db/client.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { differsFromRunning, NO_RUNNING_DEPLOYMENT } from './env-diff.js';
import {
  deleteVariable,
  insertVariable,
  listChainVariables,
  listOwnedVariables,
  listVisibleSecrets,
  loadOwnerChain,
  loadRunningRuntimeConfig,
  updateVariableValue,
  type EnvOwner,
  type EnvStoreFailureCode,
  type VariableRow,
} from './env-store.js';

export interface EnvServiceDeps {
  readonly db: Database;
  readonly now: () => Date;
}

export type EnvFailureCode =
  | 'NOT_FOUND'
  | 'ENV_INPUT_INVALID'
  | 'ENV_VALUE_MULTILINE'
  | 'ENV_KEY_DUPLICATE'
  | 'ENV_LIMIT_REACHED'
  | 'SECRET_NOT_FOUND';

export interface EnvServiceFailure {
  readonly ok: false;
  readonly code: EnvFailureCode;
  readonly message: string;
  /** ENV_INPUT_INVALID: the validator's code (ENV_KEY_INVALID, ENV_KEY_IMMUTABLE, ...). */
  readonly reason?: string;
  /** SECRET_NOT_FOUND: the referenced name. */
  readonly reference?: string;
}

export type VariableResult = { readonly ok: true; readonly variable: VariableView } | EnvServiceFailure;
export type VariableListResult = { readonly ok: true; readonly items: VariableView[] } | EnvServiceFailure;
export type EffectiveResult =
  | { readonly ok: true; readonly items: EffectiveVariableView[]; readonly differsFromRunning: boolean }
  | EnvServiceFailure;

const SCOPE_LABEL: Readonly<Record<EnvScope, string>> = Object.freeze({
  project: 'this project',
  environment: 'this environment or its project',
  service: 'this service, its environment or its project',
});

const STORE_MESSAGES: Readonly<Record<Exclude<EnvStoreFailureCode, 'NOT_FOUND' | 'SECRET_NOT_FOUND'>, string>> =
  Object.freeze({
    ENV_KEY_DUPLICATE: 'A variable with this name already exists here.',
    ENV_LIMIT_REACHED: 'This scope already has the maximum number of variables.',
    ENV_KEY_IMMUTABLE: 'A variable name cannot be changed; delete it and create a new one.',
  });

const OWNER_LABEL: Readonly<Record<EnvScope, string>> = Object.freeze({
  project: 'Project',
  environment: 'Environment',
  service: 'Service',
});

function notFound(owner: EnvOwner): EnvServiceFailure {
  return { ok: false, code: 'NOT_FOUND', message: `${OWNER_LABEL[owner.scope]} or variable not found` };
}

export function toVariableView(row: VariableRow): VariableView {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    value: row.value,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One validator for create and update (H2). `key` is undefined only on an update that does not
 * resend it. Returns the reference name, or null for a plain value.
 */
export function validateVariableInput(
  key: string | undefined,
  value: string,
): { readonly ok: true; readonly secretRef: string | null } | EnvServiceFailure {
  if (key !== undefined) {
    const validKey = validateEnvKey(key);
    if (!validKey.ok) return { ok: false, code: 'ENV_INPUT_INVALID', message: validKey.message, reason: validKey.code };
  }
  const parsed = parseEnvValue(value, key);
  if (!parsed.ok) {
    return parsed.code === 'ENV_VALUE_MULTILINE'
      ? { ok: false, code: 'ENV_VALUE_MULTILINE', message: parsed.message }
      : { ok: false, code: 'ENV_INPUT_INVALID', message: parsed.message, reason: parsed.code };
  }
  return { ok: true, secretRef: parsed.value.kind === 'secret_ref' ? parsed.value.name : null };
}

function storeFailure(code: EnvStoreFailureCode, owner: EnvOwner, reference: string | null): EnvServiceFailure {
  switch (code) {
    case 'NOT_FOUND':
      return notFound(owner);
    case 'SECRET_NOT_FOUND':
      return {
        ok: false,
        code: 'SECRET_NOT_FOUND',
        message: `Secret ${reference ?? ''} does not exist in ${SCOPE_LABEL[owner.scope]}`,
        ...(reference === null ? {} : { reference }),
      };
    case 'ENV_KEY_IMMUTABLE':
      return { ok: false, code: 'ENV_INPUT_INVALID', message: STORE_MESSAGES[code], reason: code };
    default:
      return { ok: false, code, message: STORE_MESSAGES[code] };
  }
}

export async function listVariables(deps: EnvServiceDeps, owner: EnvOwner): Promise<VariableListResult> {
  const chain = await loadOwnerChain(deps.db, owner);
  if (chain === null) return notFound(owner);
  const rows = await listOwnedVariables(deps.db, owner);
  return { ok: true, items: rows.map(toVariableView) };
}

export async function createVariable(
  deps: EnvServiceDeps,
  input: { readonly actor: ServiceActor; readonly owner: EnvOwner; readonly body: { key: string; value: string } },
): Promise<VariableResult> {
  const valid = validateVariableInput(input.body.key, input.body.value);
  if (!valid.ok) return valid;
  const written = await insertVariable(deps.db, {
    actor: input.actor,
    owner: input.owner,
    key: input.body.key,
    value: input.body.value,
    secretRef: valid.secretRef,
    at: deps.now(),
  });
  return written.ok ? { ok: true, variable: toVariableView(written.row) } : storeFailure(written.code, input.owner, valid.secretRef);
}

export async function updateVariable(
  deps: EnvServiceDeps,
  input: {
    readonly actor: ServiceActor;
    readonly owner: EnvOwner;
    readonly variableId: string;
    readonly body: { key?: string | undefined; value: string };
  },
): Promise<VariableResult> {
  const valid = validateVariableInput(input.body.key, input.body.value);
  if (!valid.ok) return valid;
  const written = await updateVariableValue(deps.db, {
    actor: input.actor,
    owner: input.owner,
    variableId: input.variableId,
    key: input.body.key,
    value: input.body.value,
    secretRef: valid.secretRef,
    at: deps.now(),
  });
  return written.ok ? { ok: true, variable: toVariableView(written.row) } : storeFailure(written.code, input.owner, valid.secretRef);
}

export async function removeVariable(
  deps: EnvServiceDeps,
  input: { readonly actor: ServiceActor; readonly owner: EnvOwner; readonly variableId: string },
): Promise<{ readonly ok: true } | EnvServiceFailure> {
  const deleted = await deleteVariable(deps.db, { ...input, at: deps.now() });
  return deleted.ok ? { ok: true } : storeFailure(deleted.code, input.owner, null);
}

function storedValue(row: VariableRow): EnvValue {
  const parsed = parseEnvValue(row.value);
  // Rows are validated on write; an unparseable one is shown as the plain text it holds.
  return parsed.ok ? parsed.value : { kind: 'plain', value: row.value };
}

function viewValue(value: EnvValue): EffectiveVariableView['value'] {
  return value.kind === 'plain' ? { kind: 'plain', value: value.value } : { kind: 'secret_ref', name: value.name };
}

/** A3: the service's resolved env and whether it differs from the running release. */
export async function effectiveVariables(
  deps: EnvServiceDeps,
  scope: { readonly projectId: string; readonly serviceId: string },
): Promise<EffectiveResult> {
  const owner: EnvOwner = { scope: 'service', ...scope };
  const chain = await loadOwnerChain(deps.db, owner);
  if (chain === null) return notFound(owner);
  const [rows, secretRows, running] = await Promise.all([
    listChainVariables(deps.db, chain),
    listVisibleSecrets(deps.db, chain),
    loadRunningRuntimeConfig(deps.db, scope.serviceId),
  ]);

  const byScope: Record<EnvScope, EnvDefinition[]> = { project: [], environment: [], service: [] };
  for (const row of rows) byScope[row.scope].push({ key: row.key, value: storedValue(row) });
  const resolved = resolveEnv(byScope.project, byScope.environment, byScope.service);

  const secretsByScope: Record<EnvScope, { name: string; version: number }[]> = { project: [], environment: [], service: [] };
  for (const secret of secretRows) secretsByScope[secret.scope].push({ name: secret.name, version: secret.version });
  const bound = resolveSecretRefs(resolved, secretsByScope satisfies SecretsByScope);
  const current: RuntimeEnvEntry[] | null = bound.ok
    ? bound.value.map((binding) =>
        'value' in binding
          ? { key: binding.key, value: binding.value }
          : { key: binding.key, secretRef: binding.secretRef, secretVersion: binding.secretVersion },
      )
    : null;

  return {
    ok: true,
    items: resolved.map((entry) => ({
      key: entry.key,
      origin: entry.scope,
      value: viewValue(entry.value),
      shadowed: entry.shadowed.map((definition) => ({ origin: definition.scope, value: viewValue(definition.value) })),
    })),
    differsFromRunning: differsFromRunning(current, running.found ? running.runtimeConfig : NO_RUNNING_DEPLOYMENT),
  };
}
