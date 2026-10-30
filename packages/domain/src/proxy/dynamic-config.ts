// ADR 0011 A1: the per-service dynamic file `dynamic/<serviceId>.yml`, a pure function of the
// service's domain rows. Names derive from UUIDs only; the Host rule carries the hostname after
// re-validation (H1), so no quote, backtick, newline, `@`, `/` or whitespace can reach the file.

import { type Hostname, MAX_DOMAINS_PER_SERVICE, validateHostname } from '../domain/hostname.js';
import { containerNameFor, validateContainerPort, validateResourceId } from '../validators/docker-naming.js';
import { type ValidationResult, fail, ok } from '../validators/network.js';
import { type JsonValue, canonicalJson } from './canonical-json.js';

export const PROXY_CERT_RESOLVER = 'noodara';
/** H3: every https router references a TLS options block with this floor. */
export const PROXY_TLS_MIN_VERSION = 'VersionTLS12';
export const PROXY_ENTRYPOINT_WEB = 'web';
export const PROXY_ENTRYPOINT_WEBSECURE = 'websecure';

export interface ProxyRouteService {
  readonly id: string;
  readonly internalPort: number;
}

export interface ProxyRouteDomain {
  readonly id: string;
  readonly hostname: Hostname;
  readonly httpsRedirect: boolean;
}

function serviceName(serviceId: string): string {
  return `noodara-${serviceId}`;
}

function tlsOptionsName(serviceId: string): string {
  return `noodara-${serviceId}-tls`;
}

function domainNames(
  serviceId: string,
  domainId: string,
): { web: string; websecure: string; redirect: string } {
  const base = `noodara-${serviceId}-${domainId}`;
  return { web: `${base}-web`, websecure: `${base}-websecure`, redirect: `${base}-redirect` };
}

/** The `@file` routers verify (22-03) expects for these domains, without the suffix, sorted. */
export function proxyRouterNamesFor(
  serviceId: string,
  domains: readonly Pick<ProxyRouteDomain, 'id'>[],
): string[] {
  return domains
    .flatMap((domain) => {
      const names = domainNames(serviceId, domain.id);
      return [names.web, names.websecure];
    })
    .sort();
}

function validateRoute(
  service: ProxyRouteService,
  domains: readonly ProxyRouteDomain[],
): ValidationResult<null> {
  if (!validateContainerPort(service.internalPort).ok) {
    return fail('PROXY_CONFIG_PORT_INVALID', 'Internal port must be an integer from 1 to 65535');
  }
  if (domains.length > MAX_DOMAINS_PER_SERVICE) {
    return fail(
      'PROXY_CONFIG_TOO_MANY_DOMAINS',
      `A service can have at most ${MAX_DOMAINS_PER_SERVICE.toString()} domains`,
    );
  }
  const ids = new Set<string>();
  const hostnames = new Set<string>();
  for (const domain of domains) {
    if (!validateResourceId(domain.id).ok) {
      return fail('PROXY_CONFIG_DOMAIN_ID_INVALID', 'Domain id must be a lowercase UUID');
    }
    if (!validateHostname(domain.hostname).ok) {
      return fail('PROXY_CONFIG_HOSTNAME_INVALID', 'Domain hostname is not a valid hostname');
    }
    if (ids.has(domain.id) || hostnames.has(domain.hostname)) {
      return fail(
        'PROXY_CONFIG_DUPLICATE_DOMAIN',
        'Each domain id and hostname may appear only once per service',
      );
    }
    ids.add(domain.id);
    hostnames.add(domain.hostname);
  }
  return ok(null);
}

export function renderDynamicConfig(
  service: ProxyRouteService,
  domains: readonly ProxyRouteDomain[],
): ValidationResult<string> {
  const container = containerNameFor(service.id);
  if (!container.ok) {
    return fail('PROXY_CONFIG_SERVICE_ID_INVALID', 'Service id must be a lowercase UUID');
  }
  const valid = validateRoute(service, domains);
  if (!valid.ok) return valid;

  const upstream = serviceName(service.id);
  const tlsOptions = tlsOptionsName(service.id);
  const routers: Record<string, JsonValue> = {};
  const middlewares: Record<string, JsonValue> = {};

  for (const domain of domains) {
    const names = domainNames(service.id, domain.id);
    const rule = `Host(\`${domain.hostname}\`)`;
    routers[names.web] = {
      entryPoints: [PROXY_ENTRYPOINT_WEB],
      rule,
      service: upstream,
      ...(domain.httpsRedirect ? { middlewares: [names.redirect] } : {}),
    };
    routers[names.websecure] = {
      entryPoints: [PROXY_ENTRYPOINT_WEBSECURE],
      rule,
      service: upstream,
      tls: { certResolver: PROXY_CERT_RESOLVER, options: tlsOptions },
    };
    if (domain.httpsRedirect) {
      // H5: 302, never 301/308, so turning the switch off works in browsers that saw it.
      middlewares[names.redirect] = { redirectScheme: { scheme: 'https', permanent: false } };
    }
  }

  const http: Record<string, JsonValue> = {
    routers,
    services: {
      [upstream]: {
        loadBalancer: {
          servers: [{ url: `http://${container.value}:${service.internalPort.toString()}` }],
        },
      },
    },
  };
  if (Object.keys(middlewares).length > 0) http.middlewares = middlewares;

  return ok(
    canonicalJson({
      http,
      tls: { options: { [tlsOptions]: { minVersion: PROXY_TLS_MIN_VERSION } } },
    }),
  );
}
