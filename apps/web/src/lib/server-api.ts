// 24-03: typed calls for a server's reverse proxy (22-02): install or retry, remove, and the ACME
// email. The web `ServerView` has no proxy fields, so they are read structurally
// (`readServerProxy`): unknown fields are dropped and an unknown status stays a plain string.
import { deployApiSend, type ApiResult, type DeployApiErrorCode } from './api-client';

export type ServerApiResult<T> = ApiResult<T, DeployApiErrorCode>;

export interface ServerProxyView {
  readonly status: string;
  readonly errorCode: string | null;
  readonly acmeEmail: string | null;
  readonly installedAt: string | null;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function invalid<T>(): Promise<ServerApiResult<T>> {
  return Promise.resolve({ ok: false, code: 'VALIDATION_FAILED', message: 'This link is not valid.', unauthorized: false });
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The proxy fields of a server view, or null when it carries no proxy status. */
export function readServerProxy(server: unknown): ServerProxyView | null {
  if (typeof server !== 'object' || server === null || Array.isArray(server)) return null;
  const raw = server as Record<string, unknown>;
  const status = str(raw.proxyStatus);
  if (status === null) return null;
  return {
    status,
    errorCode: str(raw.proxyErrorCode),
    acmeEmail: str(raw.proxyAcmeEmail),
    installedAt: str(raw.proxyInstalledAt),
  };
}

function mapProxy(result: ServerApiResult<unknown>): ServerApiResult<ServerProxyView> {
  if (!result.ok) return result;
  const proxy = readServerProxy(result.data);
  return proxy === null
    ? { ok: false, code: 'INTERNAL_ERROR', message: 'Unexpected response.', unauthorized: false }
    : { ok: true, data: proxy };
}

/** Installs (or retries) the proxy (202; progress arrives over SSE). */
export async function installProxy(serverId: string, acmeEmail?: string): Promise<ServerApiResult<ServerProxyView>> {
  if (!SAFE_ID_PATTERN.test(serverId)) return invalid();
  const body = acmeEmail === undefined ? {} : { acmeEmail };
  return mapProxy(await deployApiSend<unknown>('POST', `/api/servers/${serverId}/proxy`, body));
}

/** Removes the proxy; 409 PROXY_IN_USE while domains still route through it. */
export async function removeProxy(serverId: string): Promise<ServerApiResult<ServerProxyView>> {
  if (!SAFE_ID_PATTERN.test(serverId)) return invalid();
  return mapProxy(await deployApiSend<unknown>('POST', `/api/servers/${serverId}/proxy/remove`, {}));
}

/** Sets the ACME email; it travels alone (22-07 A6). */
export async function setProxyAcmeEmail(serverId: string, acmeEmail: string): Promise<ServerApiResult<ServerProxyView>> {
  if (!SAFE_ID_PATTERN.test(serverId)) return invalid();
  return mapProxy(await deployApiSend<unknown>('PATCH', `/api/servers/${serverId}`, { proxyAcmeEmail: acmeEmail }));
}
