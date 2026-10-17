import { describe, expect, it } from 'vitest';
import { SERVICE_VIEW_FIELDS } from '../services/service-view.js';
import { mapServiceCodeToStatus } from './http-errors.js';
import {
  CreateServiceBodySchema,
  SERVICE_ROUTE_BODY_LIMIT_BYTES,
  ServiceInputErrorBodySchema,
  ServiceParamsSchema,
  ServiceViewSchema,
  UpdateServiceBodySchema,
  UpdateServiceResponseSchema,
  WEBHOOK_ERROR_STATUS,
  WEBHOOK_ROUTE_BODY_LIMIT_BYTES,
  WebhookActionBodySchema,
  WebhookSecretResponseSchema,
  WebhookViewSchema,
} from './service-schemas.js';

const PROJECT_ID = '0192f1a4-7b3c-7d2e-8f00-0123456789ab';
const ENVIRONMENT_ID = '0192f1a4-7b3c-7d2e-8f00-0123456789cd';
const SERVER_ID = '0192f1a4-7b3c-7d2e-8f00-0123456789ef';
const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-012345678901';

const VIEW = {
  id: SERVICE_ID,
  projectId: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  serverId: SERVER_ID,
  name: 'api',
  sourceType: 'image',
  repositoryUrl: null,
  branch: null,
  buildContext: null,
  dockerfilePath: null,
  buildTarget: null,
  imageRef: 'nginx:1.27',
  internalPort: 80,
  publishedPort: null,
  status: 'NEVER_DEPLOYED',
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
};

describe('service request bodies', () => {
  it('keeps every field besides environmentId for the domain validator to judge by name', () => {
    const parsed = CreateServiceBodySchema.parse({ environmentId: ENVIRONMENT_ID, name: 'api', buildArgs: { A: '1' } });
    expect(parsed).toEqual({ environmentId: ENVIRONMENT_ID, name: 'api', buildArgs: { A: '1' } });
    expect(UpdateServiceBodySchema.parse({ serverId: SERVER_ID, env: {} })).toEqual({ serverId: SERVER_ID, env: {} });
  });

  it('requires a uuid environmentId on create and an object body everywhere', () => {
    expect(CreateServiceBodySchema.safeParse({ name: 'api' }).success).toBe(false);
    expect(CreateServiceBodySchema.safeParse({ environmentId: 'production' }).success).toBe(false);
    expect(CreateServiceBodySchema.safeParse([]).success).toBe(false);
    expect(UpdateServiceBodySchema.safeParse('name').success).toBe(false);
    expect(UpdateServiceBodySchema.safeParse(null).success).toBe(false);
  });

  it('caps the body at 16 KiB', () => {
    expect(SERVICE_ROUTE_BODY_LIMIT_BYTES).toBe(16 * 1024);
  });
});

describe('service params', () => {
  it('requires both ids to be uuids', () => {
    expect(ServiceParamsSchema.safeParse({ projectId: PROJECT_ID, serviceId: SERVICE_ID }).success).toBe(true);
    expect(ServiceParamsSchema.safeParse({ projectId: PROJECT_ID, serviceId: 'api' }).success).toBe(false);
  });
});

describe('service responses', () => {
  it('declares exactly the SVC-05 view fields', () => {
    expect(Object.keys(ServiceViewSchema.shape)).toEqual([...SERVICE_VIEW_FIELDS]);
  });

  it('strips a column that is not in the view (credential ids never reach the wire)', () => {
    const parsed = ServiceViewSchema.parse({ ...VIEW, repositoryCredentialId: SERVER_ID });
    expect(parsed).not.toHaveProperty('repositoryCredentialId');
  });

  it('rejects a status outside SERVICE_STATUSES', () => {
    expect(ServiceViewSchema.safeParse({ ...VIEW, status: 'HEALTHY' }).success).toBe(false);
  });

  it('describes the edit response and the named 422', () => {
    expect(
      UpdateServiceResponseSchema.safeParse({ service: VIEW, requiresRedeploy: true, changedFields: ['source'] }).success,
    ).toBe(true);
    expect(
      ServiceInputErrorBodySchema.safeParse({
        error: 'SERVICE_INPUT_INVALID',
        message: 'x',
        reason: 'REPOSITORY_URL_UNSUPPORTED_SCHEME',
      }).success,
    ).toBe(true);
  });
});

describe('webhook schemas (18-01)', () => {
  it('accepts an absent or empty action body and rejects any field (H3)', () => {
    expect(WebhookActionBodySchema.safeParse(undefined).success).toBe(true);
    expect(WebhookActionBodySchema.safeParse(null).success).toBe(true);
    expect(WebhookActionBodySchema.safeParse({}).success).toBe(true);
    expect(WebhookActionBodySchema.safeParse({ secret: 'mine' }).success).toBe(false);
    expect(WebhookActionBodySchema.safeParse('x').success).toBe(false);
    expect(WEBHOOK_ROUTE_BODY_LIMIT_BYTES).toBeLessThanOrEqual(SERVICE_ROUTE_BODY_LIMIT_BYTES);
  });

  it('never serializes a secret in the read view (A1)', () => {
    const view = WebhookViewSchema.parse({ enabled: true, payloadUrl: 'https://n.example/webhooks/github/abc', secret: 's3cr3t' });
    expect(view).toStrictEqual({ enabled: true, payloadUrl: 'https://n.example/webhooks/github/abc' });
    expect(WebhookViewSchema.parse({ enabled: false, payloadUrl: null })).toStrictEqual({ enabled: false, payloadUrl: null });
  });

  it('carries the secret only in the enable/rotate response', () => {
    expect(WebhookSecretResponseSchema.safeParse({ enabled: true, payloadUrl: 'u', secret: 'ab' }).success).toBe(true);
    expect(WebhookSecretResponseSchema.safeParse({ enabled: false, payloadUrl: 'u', secret: 'ab' }).success).toBe(false);
  });

  it('maps the webhook codes to 422 (image source) and 409 (state conflicts) (A4, H2, 18-05 H9)', () => {
    expect(WEBHOOK_ERROR_STATUS).toStrictEqual({
      WEBHOOK_SOURCE_NOT_GIT: 422,
      WEBHOOK_ALREADY_ENABLED: 409,
      WEBHOOK_NOT_ENABLED: 409,
      WEBHOOK_HOOK_ID_CONFLICT: 409,
    });
    for (const [code, status] of Object.entries(WEBHOOK_ERROR_STATUS)) {
      expect(mapServiceCodeToStatus(code), code).toBe(status);
    }
  });

  it('keeps the receiver codes in the shared status contract (18-02)', () => {
    expect(mapServiceCodeToStatus('WEBHOOK_DELIVERY_REJECTED')).toBe(422);
    expect(mapServiceCodeToStatus('RATE_LIMITED')).toBe(429);
  });
});
