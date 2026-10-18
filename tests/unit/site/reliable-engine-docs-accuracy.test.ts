// 19-06 A2: the healthcheck, webhook and rollback docs must quote the real defaults, bounds and
// error codes, read from the domain and control-plane sources rather than retyped.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICE_ERROR_STATUS } from '../../../apps/control-plane/src/routes/http-errors';
import {
  DEFAULT_EXPECTED_STATUSES,
  MAX_HEALTHCHECK_BUDGET_MS,
  validateHealthcheckConfig,
} from '../../../packages/domain/src/deployment/healthcheck';
import {
  DEFAULT_IMAGE_RETENTION,
  MAX_IMAGE_RETENTION,
  MIN_IMAGE_RETENTION,
} from '../../../packages/domain/src/deployment/image-retention';

// webhook-ingest.ts pulls in the env loader, so its constants are read from the source text.
const ingestSource = readFileSync('apps/control-plane/src/services/webhook-ingest.ts', 'utf8');
const WEBHOOK_BODY_LIMIT_BYTES = Number((/WEBHOOK_BODY_LIMIT_BYTES = ([\d_]+)/.exec(ingestSource)?.[1] ?? '').replaceAll('_', ''));
const perHook = /perHook: Object\.freeze\(\{ limit: (\d+)/.exec(ingestSource)?.[1];
const perIp = /perIp: Object\.freeze\(\{ limit: (\d+)/.exec(ingestSource)?.[1];

const page = (name: string) => readFileSync(`apps/site/content/docs/operate/${name}.mdx`, 'utf8');
const base = { type: 'container', probeTimeoutS: 5, intervalS: 5, retries: 3, startPeriodS: 10 };

/** Row `| Name | min | max |` of the bounds table. */
function boundsRow(text: string, name: string): [number, number] {
  const m = new RegExp(`^\\|\\s*${name}\\s*\\|\\s*(\\d+)\\s*\\|\\s*(\\d+)\\s*\\|`, 'm').exec(text);
  expect(m, `bounds row "${name}" missing`).toBeTruthy();
  return [Number(m?.[1]), Number(m?.[2])];
}

describe('healthchecks.mdx', () => {
  const text = page('healthchecks');
  const fields = [
    ['Probe timeout', 'probeTimeoutS'],
    ['Interval', 'intervalS'],
    ['Retries', 'retries'],
    ['Start period', 'startPeriodS'],
  ] as const;

  for (const [label, key] of fields) {
    it(`bounds for ${label} equal the domain validator's`, () => {
      const [min, max] = boundsRow(text, label);
      expect(validateHealthcheckConfig({ ...base, [key]: min }).ok).toBe(true);
      expect(validateHealthcheckConfig({ ...base, [key]: max }).ok).toBe(true);
      expect(validateHealthcheckConfig({ ...base, [key]: min - 1 }).ok).toBe(false);
      expect(validateHealthcheckConfig({ ...base, [key]: max + 1 }).ok).toBe(false);
    });
  }

  it('documents the default expected statuses and the budget cap', () => {
    expect(DEFAULT_EXPECTED_STATUSES[0]).toBe(200);
    expect(DEFAULT_EXPECTED_STATUSES.at(-1)).toBe(399);
    expect(text).toContain('every status from 200 to 399');
    expect(text).toContain(`under ${MAX_HEALTHCHECK_BUDGET_MS / 1000} seconds`);
  });

  it('documents the real error codes', () => {
    for (const code of ['HEALTHCHECK_FAILED', 'HEALTHCHECK_TIMEOUT', 'HEALTHCHECK_CONFIG_INVALID']) {
      expect(text).toContain(code);
    }
  });
});

describe('webhooks.mdx', () => {
  const text = page('webhooks');
  it('quotes the body cap and the rate limits from the receiver', () => {
    expect(text).toContain(`${WEBHOOK_BODY_LIMIT_BYTES / 1_048_576} MiB`);
    expect(Number.isFinite(WEBHOOK_BODY_LIMIT_BYTES)).toBe(true);
    expect(text.replace(/\s+/g, ' ')).toContain(`at most ${perHook} deliveries per minute (${perIp} per minute per source address)`);
  });
  it('only names error codes the API really returns', () => {
    for (const code of ['WEBHOOK_SOURCE_NOT_GIT', 'WEBHOOK_DELIVERY_REJECTED', 'RATE_LIMITED']) {
      expect(text).toContain(code);
      expect(Object.hasOwn(SERVICE_ERROR_STATUS, code), `${code} not in SERVICE_ERROR_STATUS`).toBe(true);
    }
  });
});

describe('service-rollback.mdx', () => {
  const text = page('service-rollback');
  it('quotes the retention default and range', () => {
    expect(text).toContain(`default is ${DEFAULT_IMAGE_RETENTION} previous versions`);
    expect(text).toContain(`${MIN_IMAGE_RETENTION} to ${MAX_IMAGE_RETENTION}`);
  });
  it('only names error codes the API really returns', () => {
    for (const code of ['ROLLBACK_TARGET_UNAVAILABLE', 'ROLLBACK_IN_PROGRESS']) {
      expect(text).toContain(code);
      expect(Object.hasOwn(SERVICE_ERROR_STATUS, code), `${code} not in SERVICE_ERROR_STATUS`).toBe(true);
    }
  });
  it('states the replacement downtime until v0.4', () => {
    expect(text).toContain('Until v0.4');
  });
});

describe('error-codes.mdx', () => {
  const text = readFileSync('apps/site/content/docs/reference/error-codes.mdx', 'utf8');
  it('lists the healthcheck failure codes', () => {
    for (const code of ['HEALTHCHECK_FAILED', 'HEALTHCHECK_TIMEOUT', 'HEALTHCHECK_CONFIG_INVALID']) {
      expect(text).toContain(code);
    }
  });
});
