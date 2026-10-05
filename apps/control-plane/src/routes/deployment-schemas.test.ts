import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_VIEW_FIELDS } from '../services/deployment-services.js';
import {
  DEPLOYMENT_LIST_MAX_LIMIT,
  DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES,
  DeployBodySchema,
  DeploymentListQuerySchema,
  DeploymentListResponseSchema,
  DeploymentViewSchema,
  ServiceDeploymentParamsSchema,
  unknownDeployFields,
} from './deployment-schemas.js';

const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-00000000cccc';

const VIEW = {
  id: DEPLOYMENT_ID,
  serviceId: SERVICE_ID,
  status: 'QUEUED',
  trigger: 'manual',
  triggeredBy: '0192f1a4-7b3c-7d2e-8f00-00000000aaaa',
  source: {
    sourceType: 'image',
    repositoryUrl: null,
    branch: null,
    buildContext: null,
    dockerfilePath: null,
    buildTarget: null,
    imageRef: 'nginx:1.27',
    internalPort: 80,
    publishedPort: 8080,
  },
  commitSha: null,
  previousDeploymentId: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
};

describe('deploy request body (H3)', () => {
  it('caps the body at 1 KiB', () => {
    expect(DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES).toBe(1024);
  });

  it('accepts no body or an empty object', () => {
    expect(DeployBodySchema.parse(undefined)).toBeUndefined();
    expect(unknownDeployFields(DeployBodySchema.parse({}))).toEqual([]);
    expect(unknownDeployFields(undefined)).toEqual([]);
    expect(unknownDeployFields(DeployBodySchema.parse(null))).toEqual([]);
  });

  it('keeps unknown keys so the handler can answer a named 422 listing them', () => {
    const body = DeployBodySchema.parse({ branch: 'dev', force: true });
    expect(unknownDeployFields(body)).toEqual(['branch', 'force']);
  });

  it('rejects a non-object body at validation', () => {
    expect(DeployBodySchema.safeParse('deploy').success).toBe(false);
    expect(DeployBodySchema.safeParse([1]).success).toBe(false);
  });
});

describe('deployment list query (H2)', () => {
  it('defaults to 20 items', () => {
    expect(DeploymentListQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('accepts limits within 1..max and coerces query strings', () => {
    expect(DeploymentListQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(DeploymentListQuerySchema.parse({ limit: String(DEPLOYMENT_LIST_MAX_LIMIT) }).limit).toBe(100);
  });

  it.each(['0', '-1', '101', '1.5', 'abc', '1e9'])('rejects limit=%s', (limit) => {
    expect(DeploymentListQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects an empty or oversized cursor before decoding', () => {
    expect(DeploymentListQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(DeploymentListQuerySchema.safeParse({ cursor: 'a'.repeat(513) }).success).toBe(false);
  });

  it('rejects unknown query keys', () => {
    expect(DeploymentListQuerySchema.safeParse({ limit: '5', status: 'FAILED' }).success).toBe(false);
  });
});

describe('deployment params', () => {
  it('requires uuids', () => {
    expect(ServiceDeploymentParamsSchema.safeParse({ serviceId: SERVICE_ID, deploymentId: DEPLOYMENT_ID }).success).toBe(true);
    expect(ServiceDeploymentParamsSchema.safeParse({ serviceId: SERVICE_ID, deploymentId: '../x' }).success).toBe(false);
  });
});

describe('deployment view schema', () => {
  it('matches the service view field list', () => {
    expect(Object.keys(DeploymentViewSchema.shape)).toEqual([...DEPLOYMENT_VIEW_FIELDS]);
  });

  it('strips any extra key on serialization, including inside the source snapshot', () => {
    const parsed = DeploymentViewSchema.parse({ ...VIEW, token: 'ghp_canary', source: { ...VIEW.source, password: 'pw' } });
    expect(JSON.stringify(parsed)).not.toContain('ghp_canary');
    expect(JSON.stringify(parsed)).not.toContain('"pw"');
  });

  it('wraps pages with a nullable next cursor', () => {
    expect(DeploymentListResponseSchema.parse({ items: [VIEW], nextCursor: null }).items).toHaveLength(1);
  });
});
