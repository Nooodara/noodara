// 24-02: typed calls for the secrets API (23-03). Views are value-free (name, scope, hint, version,
// updatedAt) and read field by field, so a value field a future server sent would be dropped here.
// Create and replace are sent as sensitive. Delete reads the 409 SECRET_IN_USE `usedBy` list (scope
// and key only), which the shared failure parser does not keep. There is no read-value call.
import {
  API_REQUEST_TIMEOUT_MS,
  deployApiGet,
  deployApiSend,
  networkFailure,
  toDeployApiFailure,
  type ApiFailure,
  type DeployApiErrorCode,
} from './api-client';
import { invalid, isSafeId, malformed, ownerPath, record, str, type EnvApiResult, type EnvOwner } from './env-api';

export interface SecretRowView {
  readonly id: string;
  readonly scope: string;
  readonly name: string;
  readonly hint: string;
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface SecretUsage {
  readonly scope: string;
  readonly key: string;
}

export type SecretDeleteFailure = ApiFailure<DeployApiErrorCode> & { readonly usedBy?: readonly SecretUsage[] };
export type SecretDeleteResult = { readonly ok: true; readonly data: null } | SecretDeleteFailure;

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function toSecretRow(value: unknown): SecretRowView | null {
  const raw = record(value);
  const id = str(raw?.id);
  const name = str(raw?.name);
  if (raw === null || id === null || name === null) return null;
  const version = typeof raw.version === 'number' && Number.isInteger(raw.version) ? raw.version : 1;
  return { id, scope: str(raw.scope) ?? '', name, hint: str(raw.hint) ?? '', version, updatedAt: str(raw.updatedAt) };
}

/** `usedBy` entries with a well-formed key only, so a stray string never renders as a key. */
export function toUsages(value: unknown): readonly SecretUsage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const raw = record(entry);
    const key = str(raw?.key);
    return key === null || !KEY_PATTERN.test(key) ? [] : [{ scope: str(raw?.scope) ?? '', key }];
  });
}

function mapRow(result: EnvApiResult<unknown>): EnvApiResult<SecretRowView> {
  if (!result.ok) return result;
  const row = toSecretRow(result.data);
  return row === null ? malformed() : { ok: true, data: row };
}

export async function listSecrets(owner: EnvOwner): Promise<EnvApiResult<readonly SecretRowView[]>> {
  const path = ownerPath(owner);
  if (path === null) return invalid();
  const result = await deployApiGet<unknown>(`${path}/secrets`);
  if (!result.ok) return result;
  const raw = record(result.data);
  if (raw === null || !Array.isArray(raw.items)) return malformed();
  return {
    ok: true,
    data: raw.items.flatMap((entry: unknown) => {
      const row = toSecretRow(entry);
      return row === null ? [] : [row];
    }),
  };
}

/** The owners whose secrets a variable at `owner` may reference: itself and its ancestors. */
export function visibleOwners(owner: EnvOwner): readonly EnvOwner[] {
  const project: EnvOwner = { scope: 'project', projectId: owner.projectId };
  if (owner.scope === 'project') return [project];
  const environment: EnvOwner = { scope: 'environment', projectId: owner.projectId, environmentId: owner.environmentId };
  return owner.scope === 'environment' ? [environment, project] : [owner, environment, project];
}

/** Secrets visible from `owner`, nearest scope first; a name defined twice keeps the nearest. */
export async function listVisibleSecrets(owner: EnvOwner): Promise<EnvApiResult<readonly SecretRowView[]>> {
  const results = await Promise.all(visibleOwners(owner).map((entry) => listSecrets(entry)));
  const seen = new Set<string>();
  const rows: SecretRowView[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    for (const row of result.data) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      rows.push(row);
    }
  }
  return { ok: true, data: rows };
}

export async function createSecret(owner: EnvOwner, name: string, value: string): Promise<EnvApiResult<SecretRowView>> {
  const path = ownerPath(owner);
  if (path === null) return invalid();
  return mapRow(await deployApiSend<unknown>('POST', `${path}/secrets`, { name, value }, { sensitive: true }));
}

export async function replaceSecret(owner: EnvOwner, secretId: string, value: string): Promise<EnvApiResult<SecretRowView>> {
  const path = ownerPath(owner);
  if (path === null || !isSafeId(secretId)) return invalid();
  return mapRow(await deployApiSend<unknown>('PUT', `${path}/secrets/${secretId}`, { value }, { sensitive: true }));
}

export async function deleteSecret(owner: EnvOwner, secretId: string): Promise<SecretDeleteResult> {
  const path = ownerPath(owner);
  if (path === null || !isSafeId(secretId)) return invalid();
  let response: Response;
  try {
    response = await fetch(`${path}/secrets/${secretId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return networkFailure();
  }
  if (response.ok) return { ok: true, data: null };
  try {
    const copy = response.clone();
    const failure = await toDeployApiFailure(response);
    if (failure.code !== 'SECRET_IN_USE') return failure;
    let body: unknown = null;
    try {
      body = (await copy.json()) as unknown;
    } catch {
      body = null;
    }
    return { ...failure, usedBy: toUsages(record(body)?.usedBy) };
  } catch {
    return networkFailure();
  }
}
