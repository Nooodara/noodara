// 24-01: typed calls for a service's domains (22-03) and the server proxy retry (22-02). Same
// transport as webhook-api.ts (relative paths, 15s timeout, fixed failure vocabulary); ids are
// checked before they reach a URL. Responses are read field by field (`toDomainRow`,
// `readProxy`), so unknown fields are dropped and a status this build does not know stays a plain
// string that the panel renders with a fallback pill.
import { deployApiGet, deployApiSend, type ApiResult, type DeployApiErrorCode } from './api-client';

export type DomainApiResult<T> = ApiResult<T, DeployApiErrorCode>;

export interface DomainRowView {
  readonly id: string;
  readonly hostname: string;
  readonly httpsRedirect: boolean;
  readonly certStatus: string;
  readonly certNotAfter: string | null;
  readonly certErrorCode: string | null;
  readonly dnsStatus: string | null;
  readonly dnsCheckedAt: string | null;
  readonly applyStatus: string;
}

export interface DnsRecordView {
  readonly type: string;
  readonly name: string;
  readonly value: string;
}

export interface DnsInstructionsView {
  readonly hostname: string;
  readonly records: readonly DnsRecordView[];
  readonly cnameAlternative: { readonly name: string; readonly target: string | null } | null;
}

export interface DomainList {
  readonly items: readonly DomainRowView[];
  readonly dnsInstructions: readonly DnsInstructionsView[];
}

export interface ProxyState {
  readonly status: string;
  readonly errorCode: string | null;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function invalid<T>(): Promise<DomainApiResult<T>> {
  return Promise.resolve({ ok: false, code: 'VALIDATION_FAILED', message: 'This link is not valid.', unauthorized: false });
}

function malformed<T>(): DomainApiResult<T> {
  return { ok: false, code: 'INTERNAL_ERROR', message: 'Unexpected response.', unauthorized: false };
}

function base(projectId: string, serviceId: string): string | null {
  return SAFE_ID_PATTERN.test(projectId) && SAFE_ID_PATTERN.test(serviceId)
    ? `/api/projects/${projectId}/services/${serviceId}/domains`
    : null;
}

function item(projectId: string, serviceId: string, domainId: string): string | null {
  const path = base(projectId, serviceId);
  return path === null || !SAFE_ID_PATTERN.test(domainId) ? null : `${path}/${domainId}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** One domain row from an API body, or null when its required fields are missing. */
export function toDomainRow(value: unknown): DomainRowView | null {
  const raw = record(value);
  if (raw === null) return null;
  const id = str(raw.id);
  const hostname = str(raw.hostname);
  if (id === null || hostname === null) return null;
  return {
    id,
    hostname,
    httpsRedirect: raw.httpsRedirect === true,
    certStatus: str(raw.certStatus) ?? '',
    certNotAfter: str(raw.certNotAfter),
    certErrorCode: str(raw.certErrorCode),
    dnsStatus: str(raw.dnsStatus),
    dnsCheckedAt: str(raw.dnsCheckedAt),
    applyStatus: str(raw.applyStatus) ?? '',
  };
}

function toInstructions(value: unknown): DnsInstructionsView | null {
  const raw = record(value);
  if (raw === null) return null;
  const hostname = str(raw.hostname);
  if (hostname === null) return null;
  const records = (Array.isArray(raw.records) ? raw.records : []).flatMap((entry: unknown) => {
    const r = record(entry);
    const type = str(r?.type);
    const name = str(r?.name);
    const recordValue = str(r?.value);
    return type === null || name === null || recordValue === null ? [] : [{ type, name, value: recordValue }];
  });
  const cname = record(raw.cnameAlternative);
  const cnameName = str(cname?.name);
  return {
    hostname,
    records,
    cnameAlternative: cnameName === null ? null : { name: cnameName, target: str(cname?.target) },
  };
}

export function toDomainList(value: unknown): DomainList | null {
  const raw = record(value);
  if (raw === null || !Array.isArray(raw.items)) return null;
  const items = raw.items.flatMap((entry: unknown) => {
    const row = toDomainRow(entry);
    return row === null ? [] : [row];
  });
  const dnsInstructions = (Array.isArray(raw.dnsInstructions) ? raw.dnsInstructions : []).flatMap((entry: unknown) => {
    const view = toInstructions(entry);
    return view === null ? [] : [view];
  });
  return { items, dnsInstructions };
}

/** The proxy fields of a server view (22-02), read structurally; null when absent. */
export function readProxy(server: unknown): ProxyState | null {
  const raw = record(server);
  const status = str(raw?.proxyStatus);
  if (raw === null || status === null) return null;
  return { status, errorCode: str(raw.proxyErrorCode) };
}

function mapRow(result: DomainApiResult<unknown>): DomainApiResult<DomainRowView> {
  if (!result.ok) return result;
  const row = toDomainRow(result.data);
  return row === null ? malformed() : { ok: true, data: row };
}

export async function listDomains(projectId: string, serviceId: string): Promise<DomainApiResult<DomainList>> {
  const path = base(projectId, serviceId);
  if (path === null) return invalid();
  const result = await deployApiGet<unknown>(path);
  if (!result.ok) return result;
  const list = toDomainList(result.data);
  return list === null ? malformed() : { ok: true, data: list };
}

export async function addDomain(
  projectId: string,
  serviceId: string,
  hostname: string,
): Promise<DomainApiResult<DomainRowView>> {
  const path = base(projectId, serviceId);
  if (path === null) return invalid();
  return mapRow(await deployApiSend<unknown>('POST', path, { hostname }));
}

export async function setHttpsRedirect(
  projectId: string,
  serviceId: string,
  domainId: string,
  httpsRedirect: boolean,
): Promise<DomainApiResult<DomainRowView>> {
  const path = item(projectId, serviceId, domainId);
  if (path === null) return invalid();
  return mapRow(await deployApiSend<unknown>('PATCH', path, { httpsRedirect }));
}

export async function checkDomainDns(
  projectId: string,
  serviceId: string,
  domainId: string,
): Promise<DomainApiResult<DomainRowView>> {
  const path = item(projectId, serviceId, domainId);
  if (path === null) return invalid();
  return mapRow(await deployApiSend<unknown>('POST', `${path}/dns-check`, {}));
}

export async function removeDomain(
  projectId: string,
  serviceId: string,
  domainId: string,
): Promise<DomainApiResult<null>> {
  const path = item(projectId, serviceId, domainId);
  if (path === null) return invalid();
  const result = await deployApiSend<unknown>('DELETE', path);
  return result.ok ? { ok: true, data: null } : result;
}

/** Re-runs the proxy install on the service's server (202; progress arrives over SSE). */
export async function retryProxyInstall(serverId: string): Promise<DomainApiResult<ProxyState>> {
  if (!SAFE_ID_PATTERN.test(serverId)) return invalid();
  const result = await deployApiSend<unknown>('POST', `/api/servers/${serverId}/proxy`, {});
  if (!result.ok) return result;
  const proxy = readProxy(result.data);
  return proxy === null ? malformed() : { ok: true, data: proxy };
}
