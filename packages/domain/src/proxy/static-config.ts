// ADR 0011 static config (`traefik.yml`, a change needs a proxy restart) plus the API router file
// and the published ports. H2: no telemetry, no update check, no dashboard, no insecure API, no
// access log, log level WARN. The read-only API is reached only through an explicit router on
// the `traefik` entrypoint, whose port is published on 127.0.0.1 alone.

import { validateEmail } from '../validators/identity.js';
import { PROXY_CONTAINER_PATHS } from '../validators/docker-naming.js';
import { type ValidationResult, fail, ok } from '../validators/network.js';
import { type JsonValue, canonicalJson } from './canonical-json.js';
import { PROXY_CERT_RESOLVER, PROXY_ENTRYPOINT_WEB, PROXY_ENTRYPOINT_WEBSECURE } from './dynamic-config.js';

export const LETS_ENCRYPT_PRODUCTION_CA_URL = 'https://acme-v02.api.letsencrypt.org/directory';
export const PROXY_API_PORT = 9180;
export const PROXY_API_ROUTER_NAME = 'noodara-api';
export const PROXY_PUBLISHED_PORTS: readonly string[] = Object.freeze([
  '80:80',
  '443:443',
  `127.0.0.1:${PROXY_API_PORT.toString()}:${PROXY_API_PORT.toString()}`,
]);

const MAX_CA_URL_LENGTH = 2048;
/** Traefik's default is 2160 h; tests shorten it (ADR 0011 renewal measurement). */
const MAX_CERTIFICATES_DURATION_HOURS = 2160;
/** Stricter than validateEmail: the address lands in a config file and an ACME account. */
const ACME_EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const UNSAFE_URL_CHARACTER = /[\s"'`\\<>{}|^]/;

export interface ProxyAcmeSettings {
  readonly email: string;
  readonly caUrl: string;
  /** Test seam only (Pebble over plain HTTP); production always requires https. */
  readonly allowInsecureCaUrl?: boolean;
  /** Test seam only; omitted in production so Traefik keeps its 2160 h default. */
  readonly certificatesDurationHours?: number;
}

export interface ProxyStaticConfig {
  /** `/opt/noodara-proxy/traefik.yml`. */
  readonly traefikConfig: string;
  /** `/opt/noodara-proxy/dynamic/noodara-api.yml`, written with the static config. */
  readonly apiRouterConfig: string;
  /** `docker run -p` values; the API port is bound to 127.0.0.1 only. */
  readonly publishedPorts: readonly string[];
}

function validateCaUrl(input: string, allowInsecure: boolean): ValidationResult<string> {
  const invalid = fail<string>(
    'PROXY_ACME_CA_URL_INVALID',
    'ACME CA URL must be an absolute https URL without credentials, fragment or whitespace',
  );
  if (input.length === 0 || input.length > MAX_CA_URL_LENGTH) return invalid;
  if (UNSAFE_URL_CHARACTER.test(input) || !URL.canParse(input)) return invalid;
  const url = new URL(input);
  if (url.username !== '' || url.password !== '' || url.hash !== '' || input.includes('#')) {
    return invalid;
  }
  if (url.protocol === 'http:') {
    if (allowInsecure) return ok(url.href);
    return fail(
      'PROXY_ACME_CA_URL_INSECURE',
      'ACME CA URL must use https; plain http is only allowed by the test seam',
    );
  }
  if (url.protocol !== 'https:') return invalid;
  return ok(url.href);
}

function validateAcmeEmail(input: string): ValidationResult<string> {
  const email = validateEmail(input);
  if (!email.ok || !ACME_EMAIL_PATTERN.test(email.value)) {
    return fail('PROXY_ACME_EMAIL_INVALID', 'ACME email must be a plain address such as ops@example.com');
  }
  return email;
}

function validateDuration(hours: number | undefined): ValidationResult<number | null> {
  if (hours === undefined) return ok(null);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_CERTIFICATES_DURATION_HOURS) {
    return fail(
      'PROXY_ACME_DURATION_INVALID',
      `Certificate duration must be an integer from 1 to ${MAX_CERTIFICATES_DURATION_HOURS.toString()} hours`,
    );
  }
  return ok(hours);
}

export function renderStaticConfig(acme: ProxyAcmeSettings): ValidationResult<ProxyStaticConfig> {
  const email = validateAcmeEmail(acme.email);
  if (!email.ok) return email;
  const caUrl = validateCaUrl(acme.caUrl, acme.allowInsecureCaUrl === true);
  if (!caUrl.ok) return caUrl;
  const duration = validateDuration(acme.certificatesDurationHours);
  if (!duration.ok) return duration;

  const acmeBlock: Record<string, JsonValue> = {
    email: email.value,
    storage: PROXY_CONTAINER_PATHS.acmeStorageFile,
    caServer: caUrl.value,
    httpChallenge: { entryPoint: PROXY_ENTRYPOINT_WEB },
  };
  if (duration.value !== null) acmeBlock.certificatesDuration = duration.value;

  const traefikConfig = canonicalJson({
    global: { checkNewVersion: false, sendAnonymousUsage: false },
    log: { level: 'WARN' },
    entryPoints: {
      [PROXY_ENTRYPOINT_WEB]: { address: ':80' },
      [PROXY_ENTRYPOINT_WEBSECURE]: { address: ':443' },
      traefik: { address: `:${PROXY_API_PORT.toString()}` },
    },
    api: { dashboard: false, insecure: false },
    providers: { file: { directory: PROXY_CONTAINER_PATHS.dynamicDir, watch: true } },
    certificatesResolvers: { [PROXY_CERT_RESOLVER]: { acme: acmeBlock } },
  });

  const apiRouterConfig = canonicalJson({
    http: {
      routers: {
        [PROXY_API_ROUTER_NAME]: {
          entryPoints: ['traefik'],
          rule: 'PathPrefix(`/api`)',
          service: 'api@internal',
        },
      },
    },
  });

  return ok({ traefikConfig, apiRouterConfig, publishedPorts: PROXY_PUBLISHED_PORTS });
}
