// Deterministic env precedence (ENV-02): service > environment > project. `resolveEnv` merges the
// three scopes; `resolveSecretRefs` binds each `<secret:name>` reference to a secret version with
// the same precedence. Neither touches a secret value: references stay names until the deploy
// execution layer decrypts them.

import { type EnvFailure, type EnvResult, type EnvValue, type UnresolvedSecretRef } from './env-value.js';

/** Scopes from lowest to highest precedence. */
export const ENV_SCOPES = Object.freeze(['project', 'environment', 'service'] as const);

export type EnvScope = (typeof ENV_SCOPES)[number];

/** Highest precedence first. */
const PRECEDENCE: readonly EnvScope[] = ['service', 'environment', 'project'];

export interface EnvDefinition {
  readonly key: string;
  readonly value: EnvValue;
}

export interface ShadowedEnvDefinition {
  readonly scope: EnvScope;
  readonly value: EnvValue;
}

export interface ResolvedEnvEntry {
  readonly key: string;
  readonly value: EnvValue;
  /** Scope the winning definition comes from. */
  readonly scope: EnvScope;
  /** Lower-precedence definitions of the same key, highest first. */
  readonly shadowed: readonly ShadowedEnvDefinition[];
}

export interface SecretDescriptor {
  readonly name: string;
  readonly version: number;
}

export type SecretsByScope = Partial<Record<EnvScope, readonly SecretDescriptor[]>>;

export type EnvBinding =
  | { readonly key: string; readonly value: string }
  | {
      readonly key: string;
      readonly secretRef: string;
      readonly secretVersion: number;
      readonly secretScope: EnvScope;
    };

/** Code-unit order, locale-independent. Keys come from a Set, so equality never occurs. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : 1;
}

function indexScope(scope: EnvScope, definitions: readonly EnvDefinition[]): Map<string, EnvValue> {
  const byKey = new Map<string, EnvValue>();
  for (const definition of definitions) {
    if (byKey.has(definition.key)) {
      // Storage enforces one key per scope; reaching this is a programmer error.
      throw new Error(`Duplicate env key ${definition.key} in ${scope} scope`);
    }
    byKey.set(definition.key, definition.value);
  }
  return byKey;
}

export function resolveEnv(
  project: readonly EnvDefinition[],
  environment: readonly EnvDefinition[],
  service: readonly EnvDefinition[],
): ResolvedEnvEntry[] {
  const scopes: Record<EnvScope, Map<string, EnvValue>> = {
    project: indexScope('project', project),
    environment: indexScope('environment', environment),
    service: indexScope('service', service),
  };
  const keys = new Set<string>();
  for (const scope of ENV_SCOPES) for (const key of scopes[scope].keys()) keys.add(key);

  const resolved: ResolvedEnvEntry[] = [];
  for (const key of [...keys].sort(compareKeys)) {
    const definitions: ShadowedEnvDefinition[] = [];
    for (const scope of PRECEDENCE) {
      const value = scopes[scope].get(key);
      if (value !== undefined) definitions.push({ scope, value });
    }
    const [winner, ...shadowed] = definitions as [ShadowedEnvDefinition, ...ShadowedEnvDefinition[]];
    resolved.push({ key, value: winner.value, scope: winner.scope, shadowed });
  }
  return resolved;
}

function findSecret(
  name: string,
  secretsByScope: SecretsByScope,
): { readonly scope: EnvScope; readonly version: number } | null {
  for (const scope of PRECEDENCE) {
    const secret = secretsByScope[scope]?.find((candidate) => candidate.name === name);
    if (secret) return { scope, version: secret.version };
  }
  return null;
}

/**
 * Binds every reference in `resolved` (already key-sorted) to the highest-precedence secret of
 * that name. A miss is SECRET_UNRESOLVED naming the first key and reference, plus every miss.
 */
export function resolveSecretRefs(
  resolved: readonly ResolvedEnvEntry[],
  secretsByScope: SecretsByScope,
): EnvResult<EnvBinding[]> {
  const bindings: EnvBinding[] = [];
  const unresolved: UnresolvedSecretRef[] = [];
  for (const entry of resolved) {
    if (entry.value.kind === 'plain') {
      bindings.push({ key: entry.key, value: entry.value.value });
      continue;
    }
    const found = findSecret(entry.value.name, secretsByScope);
    if (found) {
      bindings.push({
        key: entry.key,
        secretRef: entry.value.name,
        secretVersion: found.version,
        secretScope: found.scope,
      });
    }
    else unresolved.push({ key: entry.key, reference: entry.value.name });
  }
  const [first] = unresolved;
  if (first) {
    const failure: EnvFailure = {
      ok: false,
      code: 'SECRET_UNRESOLVED',
      message: `Variable ${first.key} references secret ${first.reference}, which does not exist in this service, its environment or its project`,
      key: first.key,
      reference: first.reference,
      unresolved,
    };
    return failure;
  }
  return { ok: true, value: bindings };
}
