import { describe, expect, it } from 'vitest';
import {
  CreateEnvironmentBodySchema,
  CreateProjectBodySchema,
  DeleteProjectBodySchema,
  EnvironmentParamsSchema,
  EnvironmentViewSchema,
  PROJECT_ROUTE_BODY_LIMIT_BYTES,
  ProjectIdParamSchema,
  ProjectViewSchema,
  UpdateEnvironmentBodySchema,
  UpdateProjectBodySchema,
} from './project-schemas.js';

const PROJECT_ID = '0192f1a4-7b3c-7d2e-8f00-0123456789ab';
const ENVIRONMENT_ID = '0192f1a4-7b3c-7d2e-8f00-0123456789cd';

describe('project request bodies', () => {
  it('accepts a create body with a name and an optional description', () => {
    expect(CreateProjectBodySchema.safeParse({ name: 'Shop' }).success).toBe(true);
    expect(CreateProjectBodySchema.safeParse({ name: 'Shop', description: 'Store front' }).success).toBe(true);
    expect(CreateProjectBodySchema.safeParse({ name: 'Shop', description: null }).success).toBe(true);
  });

  it('rejects unknown fields on every mutating body', () => {
    expect(CreateProjectBodySchema.safeParse({ name: 'Shop', slug: 'x' }).success).toBe(false);
    expect(UpdateProjectBodySchema.safeParse({ slug: 'x' }).success).toBe(false);
    expect(DeleteProjectBodySchema.safeParse({ confirmName: 'Shop', force: true }).success).toBe(false);
    expect(CreateEnvironmentBodySchema.safeParse({ name: 'production', env: {} }).success).toBe(false);
    expect(UpdateEnvironmentBodySchema.safeParse({ projectId: PROJECT_ID }).success).toBe(false);
  });

  it('rejects a missing or non-string name on create', () => {
    expect(CreateProjectBodySchema.safeParse({}).success).toBe(false);
    expect(CreateProjectBodySchema.safeParse({ name: 42 }).success).toBe(false);
    expect(CreateEnvironmentBodySchema.safeParse({}).success).toBe(false);
  });

  it('caps raw string lengths before the domain validators run', () => {
    expect(CreateProjectBodySchema.safeParse({ name: 'x'.repeat(1025) }).success).toBe(false);
    expect(CreateProjectBodySchema.safeParse({ name: 'x', description: 'y'.repeat(4097) }).success).toBe(false);
    expect(DeleteProjectBodySchema.safeParse({ confirmName: 'x'.repeat(1025) }).success).toBe(false);
  });

  it('requires confirmName as a string on delete, allowing an empty one to fail as a mismatch', () => {
    expect(DeleteProjectBodySchema.safeParse({}).success).toBe(false);
    expect(DeleteProjectBodySchema.safeParse({ confirmName: '' }).success).toBe(true);
  });

  it('accepts partial edits (emptiness is the domain validator job)', () => {
    expect(UpdateProjectBodySchema.safeParse({}).success).toBe(true);
    expect(UpdateProjectBodySchema.safeParse({ description: null }).success).toBe(true);
    expect(UpdateEnvironmentBodySchema.safeParse({ kind: 'staging' }).success).toBe(true);
  });

  it('keeps the route body cap small', () => {
    expect(PROJECT_ROUTE_BODY_LIMIT_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(PROJECT_ROUTE_BODY_LIMIT_BYTES).toBeGreaterThanOrEqual(4 * 1024);
  });
});

describe('project route params', () => {
  it('requires UUID ids', () => {
    expect(ProjectIdParamSchema.safeParse({ projectId: PROJECT_ID }).success).toBe(true);
    expect(ProjectIdParamSchema.safeParse({ projectId: 'shop' }).success).toBe(false);
    expect(
      EnvironmentParamsSchema.safeParse({ projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID }).success,
    ).toBe(true);
    expect(EnvironmentParamsSchema.safeParse({ projectId: PROJECT_ID, environmentId: '1' }).success).toBe(false);
  });
});

describe('project response views', () => {
  it('describes a project view with exactly its allowlisted keys', () => {
    expect(Object.keys(ProjectViewSchema.shape).sort()).toEqual(
      ['archivedAt', 'createdAt', 'description', 'id', 'name', 'slug', 'updatedAt'].sort(),
    );
  });

  it('describes an environment view with exactly its allowlisted keys', () => {
    expect(Object.keys(EnvironmentViewSchema.shape).sort()).toEqual(
      ['createdAt', 'id', 'kind', 'name', 'projectId', 'updatedAt'].sort(),
    );
  });
});
