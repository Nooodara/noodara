// 19-03: typed calls for a service's push webhook (18-01) and its recent deliveries (19-03).
// Same transport as deploy-api.ts (relative paths, 15s timeout, fixed failure vocabulary). Ids are
// checked before they reach a URL. The enable and rotate bodies hold the secret exactly once: the
// caller keeps it in component state only; nothing here stores, caches or logs it.
import {
  deployApiGet,
  deployApiSend,
  type ApiResult,
  type DeployApiErrorCode,
} from "./api-client";

export type WebhookApiResult<T> = ApiResult<T, DeployApiErrorCode>;

export interface WebhookView {
  readonly enabled: boolean;
  readonly payloadUrl: string | null;
}
/** Enable and rotate only: the one response that carries the secret. */
export interface WebhookSecretView {
  readonly enabled: true;
  readonly payloadUrl: string;
  readonly secret: string;
}
/** `outcome` is a plain string: a value this build does not know still renders (fallback row). */
export interface WebhookDelivery {
  readonly id: string;
  readonly deliveryId: string;
  readonly event: string;
  readonly outcome: string;
  readonly pushedSha: string | null;
  readonly deploymentId: string | null;
  readonly receivedAt: string;
}
export interface WebhookDeliveriesPage {
  readonly deliveries: readonly WebhookDelivery[];
  readonly nextCursor: string | null;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
const PAYLOAD_PATH_PREFIX = "/webhooks/github/";

function invalid<T>(): Promise<WebhookApiResult<T>> {
  return Promise.resolve({
    ok: false,
    code: "VALIDATION_FAILED",
    message: "This link is not valid.",
    unauthorized: false,
  });
}

function base(projectId: string, serviceId: string): string | null {
  return SAFE_ID_PATTERN.test(projectId) && SAFE_ID_PATTERN.test(serviceId)
    ? `/api/projects/${projectId}/services/${serviceId}/webhook`
    : null;
}

export function getWebhook(
  projectId: string,
  serviceId: string,
): Promise<WebhookApiResult<WebhookView>> {
  const path = base(projectId, serviceId);
  return path === null ? invalid() : deployApiGet<WebhookView>(path);
}

export function enableWebhook(
  projectId: string,
  serviceId: string,
): Promise<WebhookApiResult<WebhookSecretView>> {
  const path = base(projectId, serviceId);
  return path === null
    ? invalid()
    : deployApiSend<WebhookSecretView>("POST", path, {});
}

export function rotateWebhook(
  projectId: string,
  serviceId: string,
): Promise<WebhookApiResult<WebhookSecretView>> {
  const path = base(projectId, serviceId);
  return path === null
    ? invalid()
    : deployApiSend<WebhookSecretView>("POST", `${path}/rotate`, {});
}

export function disableWebhook(
  projectId: string,
  serviceId: string,
): Promise<WebhookApiResult<WebhookView>> {
  const path = base(projectId, serviceId);
  return path === null
    ? invalid()
    : deployApiSend<WebhookView>("DELETE", path, {});
}

export function listWebhookDeliveries(
  projectId: string,
  serviceId: string,
  query: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<WebhookApiResult<WebhookDeliveriesPage>> {
  const path = base(projectId, serviceId);
  if (path === null) return invalid();
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const search = params.toString();
  return deployApiGet<WebhookDeliveriesPage>(
    `${path}/deliveries${search === "" ? "" : `?${search}`}`,
  );
}

/**
 * The payload URL to show: only an http(s) URL without credentials whose path is
 * `/webhooks/github/<hook id>` with a well-formed id (H2). Anything else is null, so a tampered
 * response never renders as a link-looking string.
 */
export function safePayloadUrl(value: string | null): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (!url.pathname.startsWith(PAYLOAD_PATH_PREFIX)) return null;
  const hookId = url.pathname.slice(PAYLOAD_PATH_PREFIX.length);
  return HOOK_ID_PATTERN.test(hookId) ? `${url.origin}${url.pathname}` : null;
}
