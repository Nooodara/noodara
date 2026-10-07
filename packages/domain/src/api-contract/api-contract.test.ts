import { describe, expect, it } from 'vitest';
import * as contract from './index.js';

const UUID = '0192f1a4-7b3c-7d2e-8f00-00000000aaaa';

describe('http-errors', () => {
  it('maps known codes and defaults unknown ones to 500', () => {
    expect(contract.mapServiceCodeToStatus('NOT_FOUND')).toBe(404);
    expect(contract.mapServiceCodeToStatus('NOPE')).toBe(500);
  });

  it('builds the error body field by field', () => {
    expect(contract.toErrorBody('X', 'm')).toEqual({ error: 'X', message: 'm' });
  });

  it('turns Fastify request errors into fixed 4xx bodies', () => {
    expect(contract.toClientRequestError({ code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 })?.status).toBe(413);
    expect(contract.toClientRequestError({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 })?.body.error).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expect(contract.toClientRequestError({ code: 'FST_ERR_X', statusCode: 400, message: 'secret' })?.body).toEqual({
      error: 'MALFORMED_REQUEST',
      message: 'Request could not be parsed',
    });
    expect(contract.toClientRequestError({ code: 1, statusCode: 400 })).toBeNull();
    expect(contract.toClientRequestError({ code: 'OTHER', statusCode: 400 })).toBeNull();
    expect(contract.toClientRequestError({ code: 'FST_X', statusCode: 'x' })).toBeNull();
    expect(contract.toClientRequestError({ code: 'FST_X', statusCode: 400.5 })).toBeNull();
    expect(contract.toClientRequestError({ code: 'FST_X', statusCode: 500 })).toBeNull();
    expect(contract.toClientRequestError({ code: 'FST_X', statusCode: 399 })).toBeNull();
    expect(contract.toClientRequestError({})).toBeNull();
  });

  it('normalises validation issues and copies only path and message', () => {
    const body = contract.toValidationErrorBody([
      { instancePath: '/a', message: 'bad', received: 'secret' } as never,
      { path: ['b', 'c'], message: 'worse' },
      {},
    ]);
    expect(body).toEqual({
      error: 'VALIDATION_FAILED',
      message: 'Request does not match the schema',
      issues: [
        { path: '/a', message: 'bad' },
        { path: 'b.c', message: 'worse' },
        { path: '', message: '' },
      ],
    });
    expect(contract.toValidationErrorBody([], 'CUSTOM').error).toBe('CUSTOM');
  });

  it('validates error body shapes', () => {
    expect(contract.ErrorBodySchema.safeParse({ error: 'a', message: 'b' }).success).toBe(true);
    expect(contract.ValidationErrorBodySchema.safeParse({ error: 'a', message: 'b', issues: [] }).success).toBe(false);
    expect(contract.FieldErrorBodySchema.safeParse({ error: 'a', message: 'b', issues: [] }).success).toBe(true);
  });
});

describe('deployment schemas', () => {
  it('lists unknown deploy fields', () => {
    expect(contract.unknownDeployFields(undefined)).toEqual([]);
    expect(contract.unknownDeployFields(null)).toEqual([]);
    expect(contract.unknownDeployFields({ a: 1 })).toEqual(['a']);
  });

  it('applies list and log query defaults and rejects unknown keys', () => {
    expect(contract.DeploymentListQuerySchema.parse({}).limit).toBe(contract.DEPLOYMENT_LIST_DEFAULT_LIMIT);
    expect(contract.DeploymentListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(contract.DeploymentListQuerySchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(contract.DeploymentLogsQuerySchema.parse({})).toEqual({
      phase: 'prepare',
      since: 0,
      limit: contract.DEPLOYMENT_LOGS_DEFAULT_LIMIT,
    });
    expect(contract.DeploymentLogsQuerySchema.parse({ since: '5' }).since).toBe(5);
    expect(contract.DeploymentLogsQuerySchema.safeParse({ since: '-1' }).success).toBe(false);
    expect(contract.DeploymentLogsQuerySchema.safeParse({ since: '99999999999' }).success).toBe(false);
  });

  it('validates params', () => {
    expect(contract.ServiceDeploymentParamsSchema.safeParse({ serviceId: UUID, deploymentId: UUID }).success).toBe(true);
    expect(contract.ServiceIdParamSchema.safeParse({ serviceId: 'x' }).success).toBe(false);
    expect(contract.DeploymentIdParamSchema.safeParse({ deploymentId: UUID }).success).toBe(true);
    expect(contract.DeployBodySchema.safeParse({}).success).toBe(true);
  });
});

describe('service schemas', () => {
  it('requires environmentId on create and accepts any update keys', () => {
    expect(contract.CreateServiceBodySchema.safeParse({}).success).toBe(false);
    expect(contract.CreateServiceBodySchema.safeParse({ environmentId: UUID, name: 'a' }).success).toBe(true);
    expect(contract.UpdateServiceBodySchema.safeParse({ any: 1 }).success).toBe(true);
    expect(contract.ServiceParamsSchema.safeParse({ projectId: UUID, serviceId: UUID }).success).toBe(true);
  });

  it('discriminates repository credentials strictly', () => {
    expect(contract.RepositoryCredentialBodySchema.safeParse({ kind: 'deploy_key' }).success).toBe(true);
    expect(contract.RepositoryCredentialBodySchema.safeParse({ kind: 'https_token', token: 't' }).success).toBe(true);
    expect(contract.RepositoryCredentialBodySchema.safeParse({ kind: 'deploy_key', token: 't' }).success).toBe(false);
    expect(contract.RegistryCredentialBodySchema.safeParse({ username: 'u', password: 'p', x: 1 }).success).toBe(false);
  });

  it('shapes credential and runtime log responses', () => {
    expect(contract.ServiceCredentialsResponseSchema.safeParse({ repository: null, registry: null }).success).toBe(true);
    expect(contract.RuntimeLogsQuerySchema.safeParse({ tail: 'x'.repeat(17) }).success).toBe(false);
    expect(
      contract.RuntimeLogsResponseSchema.safeParse({
        lines: [{ stream: 'stdout', timestamp: null, text: 't' }],
        truncated: false,
      }).success,
    ).toBe(true);
  });
});

describe('project schemas', () => {
  it('rejects unknown keys and oversized confirmations', () => {
    expect(contract.DeleteProjectBodySchema.safeParse({ confirmName: 'a', x: 1 }).success).toBe(false);
    expect(contract.DeleteEnvironmentBodySchema.safeParse({ confirmName: 'a'.repeat(5000) }).success).toBe(false);
    expect(contract.DeleteProjectResponseSchema.safeParse({ ok: true, projectId: UUID }).success).toBe(true);
    expect(contract.ProjectIdParamSchema.safeParse({ projectId: UUID }).success).toBe(true);
    expect(contract.EnvironmentParamsSchema.safeParse({ projectId: UUID, environmentId: UUID }).success).toBe(true);
  });
});
