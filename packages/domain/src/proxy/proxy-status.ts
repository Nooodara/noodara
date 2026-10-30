// Proxy lifecycle per server (ADR 0011): one noodara-traefik container. Every status change goes
// through transitionProxyStatus; the pg enum `proxy_status` (21-05) derives from PROXY_STATUSES.

export const PROXY_STATUSES = Object.freeze([
  'NOT_INSTALLED',
  'INSTALLING',
  'RUNNING',
  'FAILED',
] as const);

export type ProxyStatus = (typeof PROXY_STATUSES)[number];

export const PROXY_ERROR_CODES = Object.freeze([
  'PROXY_PORT_IN_USE',
  'PROXY_INSTALL_FAILED',
  'PROXY_UNAVAILABLE',
  'PROXY_IN_USE',
  'PROXY_ROUTE_FAILED',
] as const);

export type ProxyErrorCode = (typeof PROXY_ERROR_CODES)[number];

/** Fixed text: never carries remote output, process names, IPs or paths. */
export const PROXY_ERROR_MESSAGES: Readonly<Record<ProxyErrorCode, string>> = Object.freeze({
  PROXY_PORT_IN_USE:
    'Ports 80 or 443 are already in use on this server. Free them by stopping the other web server, then install the proxy again.',
  PROXY_INSTALL_FAILED:
    'The proxy could not be installed on this server. Check that Docker is running and the server can pull images, then try again.',
  PROXY_UNAVAILABLE:
    'The proxy on this server is not answering. Check that the proxy container is running, then try again.',
  PROXY_IN_USE:
    'The proxy still routes domains on this server. Remove those domains first, then try again.',
  PROXY_ROUTE_FAILED:
    'The proxy did not apply the new routes in time. Check the proxy on the server, then try again.',
} satisfies Record<ProxyErrorCode, string>);

const TRANSITIONS: Readonly<Record<ProxyStatus, readonly ProxyStatus[]>> = Object.freeze({
  NOT_INSTALLED: ['INSTALLING'],
  INSTALLING: ['RUNNING', 'FAILED'],
  RUNNING: ['INSTALLING', 'FAILED', 'NOT_INSTALLED'],
  FAILED: ['INSTALLING', 'RUNNING', 'NOT_INSTALLED'],
} satisfies Record<ProxyStatus, readonly ProxyStatus[]>);

export class InvalidProxyStatusTransitionError extends Error {
  readonly from: ProxyStatus;
  readonly to: ProxyStatus;

  constructor(from: ProxyStatus, to: ProxyStatus) {
    super(`Invalid proxy status transition: ${from} -> ${to}`);
    this.name = 'InvalidProxyStatusTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function initialProxyStatus(): ProxyStatus {
  return 'NOT_INSTALLED';
}

export function canTransitionProxyStatus(from: ProxyStatus, to: ProxyStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The only function allowed to produce a new proxy status. */
export function transitionProxyStatus(from: ProxyStatus, to: ProxyStatus): ProxyStatus {
  if (!canTransitionProxyStatus(from, to)) throw new InvalidProxyStatusTransitionError(from, to);
  return to;
}
