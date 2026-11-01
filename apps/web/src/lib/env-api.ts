// 24-02: typed calls for the variables API (23-02) at project, environment and service scope, and
// the service's effective view. Same transport as domain-api.ts; ids are checked before they reach
// a URL and writes are sent as sensitive (a failure that echoes the value gets fixed copy).
// Responses are read field by field, so unknown fields are dropped and an unknown scope stays a
// plain string the UI renders with a fallback label.
import { deployApiGet, deployApiSend, type ApiResult, type DeployApiErrorCode } from './api-client';

export type EnvApiResult<T> = ApiResult<T, DeployApiErrorCode>;

export type EnvOwner =
  | { readonly scope: 'project'; readonly projectId: string }
  | { readonly scope: 'environment'; readonly projectId: string; readonly environmentId: string }
  | {
      readonly scope: 'service';
      readonly projectId: string;
      readonly serviceId: string;
      /** Only used to list the secrets visible from the service; never part of the URL. */
      readonly environmentId: string;
    };

export interface VariableRowView {
  readonly id: string;
  readonly scope: string;
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string | null;
}

export type EnvValueView =
  | { readonly kind: 'plain'; readonly value: string }
  | { readonly kind: 'secret_ref'; readonly name: string };

export interface EffectiveVariableRowView {
  readonly key: string;
  readonly origin: string;
  readonly value: EnvValueView;
  readonly shadowed: readonly { readonly origin: string; readonly value: EnvValueView }[];
}

export interface EffectiveEnvView {
  readonly items: readonly EffectiveVariableRowView[];
  readonly differsFromRunning: boolean;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

/** `/api/projects/:p[/environments/:e | /services/:s]`, or null when an id is not URL-safe. */
export function ownerPath(owner: EnvOwner): string | null {
  if (!isSafeId(owner.projectId)) return null;
  const project = `/api/projects/${owner.projectId}`;
  switch (owner.scope) {
    case 'project':
      return project;
    case 'environment':
      return isSafeId(owner.environmentId) ? `${project}/environments/${owner.environmentId}` : null;
    case 'service':
      return isSafeId(owner.serviceId) ? `${project}/services/${owner.serviceId}` : null;
  }
}

export function invalid<T>(): Promise<ApiResult<T, DeployApiErrorCode>> {
  return Promise.resolve({ ok: false, code: 'VALIDATION_FAILED', message: 'This link is not valid.', unauthorized: false });
}

export function malformed<T>(): ApiResult<T, DeployApiErrorCode> {
  return { ok: false, code: 'INTERNAL_ERROR', message: 'Unexpected response.', unauthorized: false };
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function toVariableRow(value: unknown): VariableRowView | null {
  const raw = record(value);
  const id = str(raw?.id);
  const key = str(raw?.key);
  const val = str(raw?.value);
  if (raw === null || id === null || key === null || val === null) return null;
  return { id, scope: str(raw.scope) ?? '', key, value: val, updatedAt: str(raw.updatedAt) };
}

function toValue(value: unknown): EnvValueView | null {
  const raw = record(value);
  if (raw?.kind === 'plain') {
    const plain = str(raw.value);
    return plain === null ? null : { kind: 'plain', value: plain };
  }
  if (raw?.kind === 'secret_ref') {
    const name = str(raw.name);
    return name === null ? null : { kind: 'secret_ref', name };
  }
  return null;
}

function toEffectiveRow(value: unknown): EffectiveVariableRowView | null {
  const raw = record(value);
  const key = str(raw?.key);
  const parsed = toValue(raw?.value);
  if (raw === null || key === null || parsed === null) return null;
  const shadowed = (Array.isArray(raw.shadowed) ? raw.shadowed : []).flatMap((entry: unknown) => {
    const r = record(entry);
    const v = toValue(r?.value);
    return v === null ? [] : [{ origin: str(r?.origin) ?? '', value: v }];
  });
  return { key, origin: str(raw.origin) ?? '', value: parsed, shadowed };
}

export function toEffectiveEnv(value: unknown): EffectiveEnvView | null {
  const raw = record(value);
  if (raw === null || !Array.isArray(raw.items)) return null;
  const items = raw.items.flatMap((entry: unknown) => {
    const row = toEffectiveRow(entry);
    return row === null ? [] : [row];
  });
  return { items, differsFromRunning: raw.differsFromRunning === true };
}

function mapRow(result: EnvApiResult<unknown>): EnvApiResult<VariableRowView> {
  if (!result.ok) return result;
  const row = toVariableRow(result.data);
  return row === null ? malformed() : { ok: true, data: row };
}

export async function listVariables(owner: EnvOwner): Promise<EnvApiResult<readonly VariableRowView[]>> {
  const path = ownerPath(owner);
  if (path === null) return invalid();
  const result = await deployApiGet<unknown>(`${path}/env`);
  if (!result.ok) return result;
  const raw = record(result.data);
  if (raw === null || !Array.isArray(raw.items)) return malformed();
  return {
    ok: true,
    data: raw.items.flatMap((entry: unknown) => {
      const row = toVariableRow(entry);
      return row === null ? [] : [row];
    }),
  };
}

export async function createVariable(owner: EnvOwner, key: string, value: string): Promise<EnvApiResult<VariableRowView>> {
  const path = ownerPath(owner);
  if (path === null) return invalid();
  return mapRow(await deployApiSend<unknown>('POST', `${path}/env`, { key, value }, { sensitive: true }));
}

export async function updateVariable(
  owner: EnvOwner,
  variableId: string,
  value: string,
): Promise<EnvApiResult<VariableRowView>> {
  const path = ownerPath(owner);
  if (path === null || !isSafeId(variableId)) return invalid();
  return mapRow(await deployApiSend<unknown>('PATCH', `${path}/env/${variableId}`, { value }, { sensitive: true }));
}

export async function deleteVariable(owner: EnvOwner, variableId: string): Promise<EnvApiResult<null>> {
  const path = ownerPath(owner);
  if (path === null || !isSafeId(variableId)) return invalid();
  const result = await deployApiSend<unknown>('DELETE', `${path}/env/${variableId}`);
  return result.ok ? { ok: true, data: null } : result;
}

export async function getEffectiveEnv(projectId: string, serviceId: string): Promise<EnvApiResult<EffectiveEnvView>> {
  if (!isSafeId(projectId) || !isSafeId(serviceId)) return invalid();
  const result = await deployApiGet<unknown>(`/api/projects/${projectId}/services/${serviceId}/env/effective`);
  if (!result.ok) return result;
  const view = toEffectiveEnv(result.data);
  return view === null ? malformed() : { ok: true, data: view };
}
