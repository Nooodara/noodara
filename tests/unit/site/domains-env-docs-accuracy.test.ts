// 24-05 A1/A2: the domains and variables pages quote the real error codes, defaults, limits and
// precedence, read from the domain and control-plane sources rather than retyped.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICE_ERROR_STATUS } from '../../../apps/control-plane/src/routes/http-errors';
import { V04_DEPLOYMENT_ERROR_CODES } from '../../../packages/domain/src/deployment/deployment-error';
import {
  CERT_FAILURE_CAUSES,
  CERT_POST_CHANGE_CHECK_OFFSETS_MS,
  CERT_RENEWAL_WINDOW_MS,
  CERT_STATUSES,
  DEFAULT_CERT_CHECK_INTERVAL_MS,
  DEFAULT_CERT_ISSUE_TIMEOUT_MS,
} from '../../../packages/domain/src/domain/cert-status';
import { DNS_OUTCOMES } from '../../../packages/domain/src/domain/dns';
import {
  MAX_DOMAINS_PER_SERVICE,
  MAX_HOSTNAME_LABEL_LENGTH,
  MAX_HOSTNAME_LENGTH,
} from '../../../packages/domain/src/domain/hostname';
import {
  MAX_ENV_KEY_LENGTH,
  MAX_ENV_VALUE_BYTES,
  MAX_ENV_VARS_PER_SCOPE,
  MAX_SECRET_NAME_LENGTH,
  MAX_SECRETS_PER_SCOPE,
} from '../../../packages/domain/src/env/env-value';
import { ENV_SCOPES } from '../../../packages/domain/src/env/resolve-env';
import { LETS_ENCRYPT_PRODUCTION_CA_URL } from '../../../packages/domain/src/proxy/static-config';

// env.ts parses process.env on import, so its knob list is read from the source text.
const envSource = readFileSync('apps/control-plane/src/env.ts', 'utf8');
const PROXY_ENV_KNOBS = [...(/export const PROXY_ENV_KNOBS = \[([^\]]*)\]/.exec(envSource)?.[1] ?? '').matchAll(/'(NOODARA_[A-Z0-9_]+)'/g)].map((m) => m[1] ?? '');

const read = (path: string) => readFileSync(`apps/site/content/docs/${path}.mdx`, 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');
const minutes = (ms: number) => `${String(ms / 60_000)} minutes`;
/** Every `UPPER_CODE` in backticks. */
const codesIn = (text: string) => [...text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1] ?? '');

const domains = read('operate/domains');
const env = read('operate/variables-and-secrets');
const variables = read('reference/variables');
const errorCodes = read('reference/error-codes');

describe('operate/domains.mdx', () => {
  const text = flat(domains);

  it('covers DNS records, ports, ufw, NOODARA_PORT, Let\'s Encrypt limits and the swap window', () => {
    for (const needle of ['`A` record', '`AAAA`', '`CNAME`', 'ports 80 and 443', 'ufw', '`NOODARA_PORT` off 80 and 443', 'rate limits', '`502`']) {
      expect(text, needle).toContain(needle);
    }
  });

  it('lists exactly the certificate states of the domain state machine', () => {
    const rows = [...domains.matchAll(/^\| `([A-Z]+)` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual([...CERT_STATUSES]);
  });

  it('lists every certificate failure cause and DNS outcome', () => {
    for (const code of [...CERT_FAILURE_CAUSES, ...DNS_OUTCOMES]) expect(text).toContain(`\`${code}\``);
  });

  it('quotes the check schedule, issuance timeout and renewal window', () => {
    const offsets = CERT_POST_CHANGE_CHECK_OFFSETS_MS.map((ms) => String(ms / 1000));
    expect(text).toContain(`${offsets.slice(0, -1).join(', ')} and ${offsets.at(-1) ?? ''} seconds after a domain change, then every ${minutes(DEFAULT_CERT_CHECK_INTERVAL_MS)}`);
    expect(text).toContain(`within ${minutes(DEFAULT_CERT_ISSUE_TIMEOUT_MS)} of the request`);
    expect(text).toContain(`within ${String(CERT_RENEWAL_WINDOW_MS / 86_400_000)} days`);
  });

  it('quotes the hostname and per-service limits', () => {
    expect(text).toContain(`at most ${String(MAX_DOMAINS_PER_SERVICE)} domains`);
    expect(text).toContain(`at most ${String(MAX_HOSTNAME_LENGTH)} characters (${String(MAX_HOSTNAME_LABEL_LENGTH)} per label)`);
  });

  it('only names HTTP error codes the API really returns', () => {
    const allowed = new Set<string>([...CERT_FAILURE_CAUSES, ...DNS_OUTCOMES, ...CERT_STATUSES]);
    for (const code of codesIn(domains).filter((c) => !allowed.has(c) && !c.startsWith('NOODARA_'))) {
      expect(Object.hasOwn(SERVICE_ERROR_STATUS, code), `${code} not in SERVICE_ERROR_STATUS`).toBe(true);
    }
  });
});

describe('operate/variables-and-secrets.mdx', () => {
  const text = flat(env);

  it('states the precedence order of the domain resolver, with the roadmap example', () => {
    expect(text).toContain([...ENV_SCOPES].reverse().join(' > '));
    expect(text).toContain('| `DATABASE_URL` | `<secret:database_url>` |');
  });

  it('quotes the key, value, name and per-scope limits', () => {
    expect(text).toContain(`at most ${String(MAX_ENV_KEY_LENGTH)} characters`);
    expect(text).toContain(`at most ${String(MAX_ENV_VALUE_BYTES / 1024)} KiB`);
    expect(text).toContain(`at most ${String(MAX_SECRET_NAME_LENGTH)} characters`);
    expect(text).toContain(`at most ${String(MAX_ENV_VARS_PER_SCOPE)} variables`);
    expect(text).toContain(`at most ${String(MAX_SECRETS_PER_SCOPE)} secrets`);
  });

  it('states the single-line rule with the base64 hint, next-deploy apply, server exposure and rotation', () => {
    for (const needle of ['`ENV_VALUE_MULTILINE`', 'base64', 'Redeploy to apply.', '`docker inspect`', '## Rotation']) {
      expect(env, needle).toContain(needle);
    }
  });

  it('only names error codes the API really returns', () => {
    const codes = codesIn(env).filter((c) => c !== 'DATABASE_URL'); // the example key, not a code
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(Object.hasOwn(SERVICE_ERROR_STATUS, code), `${code} not in SERVICE_ERROR_STATUS`).toBe(true);
    }
  });
});

describe('reference pages', () => {
  it('variables.mdx lists every proxy and certificate knob with its real default', () => {
    expect(PROXY_ENV_KNOBS.length).toBe(5);
    for (const knob of PROXY_ENV_KNOBS) expect(variables).toMatch(new RegExp(`^\\| \`${knob}\` \\|`, 'm'));
    expect(variables).toContain(`| \`NOODARA_ACME_CA_URL\` | \`${LETS_ENCRYPT_PRODUCTION_CA_URL}\` |`);
    expect(variables).toContain(`| \`NOODARA_CERT_CHECK_INTERVAL_MS\` | \`${String(DEFAULT_CERT_CHECK_INTERVAL_MS)}\` (${minutes(DEFAULT_CERT_CHECK_INTERVAL_MS)}) |`);
    expect(variables).toContain(`| \`NOODARA_CERT_ISSUE_TIMEOUT_MS\` | \`${String(DEFAULT_CERT_ISSUE_TIMEOUT_MS)}\` (${minutes(DEFAULT_CERT_ISSUE_TIMEOUT_MS)}) |`);
  });

  it('error-codes.mdx carries the certificate causes and the v0.4 deployment failures', () => {
    for (const code of [...CERT_FAILURE_CAUSES, ...V04_DEPLOYMENT_ERROR_CODES]) expect(errorCodes).toContain(`\`${code}\``);
  });

  it('no page promises a later release for these features', () => {
    for (const text of [domains, env]) expect(text).not.toMatch(/coming soon|until v0\.\d|in a future release/i);
  });
});

describe('v0.4.0 release notes link', () => {
  it('the upgrade page points to the v0.4.0 release notes', () => {
    const page = readFileSync('apps/site/content/docs/operate/upgrade.mdx', 'utf8');
    expect(page).toContain('https://github.com/nooodara/noodara/blob/main/docs/releases/v0.4.0.md');
  });
});
