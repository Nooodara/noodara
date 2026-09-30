import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  SERVICE_SOURCE_TYPES,
  type ServiceSource,
  validateServiceSource,
} from './service-source.js';

const GIT_SOURCE = {
  kind: 'git',
  repositoryUrl: 'https://github.com/acme/app.git',
  branch: 'main',
};

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

describe('SERVICE_SOURCE_TYPES', () => {
  it('lists exactly git and image', () => {
    expect(SERVICE_SOURCE_TYPES).toEqual(['git', 'image']);
  });
});

describe('validateServiceSource', () => {
  it('accepts a git source and applies the build defaults', () => {
    expect(validateServiceSource(GIT_SOURCE)).toEqual({
      ok: true,
      value: {
        kind: 'git',
        repositoryUrl: GIT_SOURCE.repositoryUrl,
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        target: null,
      },
    });
  });

  it('accepts a git source with explicit build context, Dockerfile and target', () => {
    const input = {
      ...GIT_SOURCE,
      buildContext: 'services/api',
      dockerfilePath: 'services/api/Dockerfile',
      target: 'production',
    };

    expect(validateServiceSource(input)).toEqual({ ok: true, value: input });
  });

  it('accepts an explicit null target', () => {
    const result = validateServiceSource({ ...GIT_SOURCE, target: null });

    expect(result.ok && result.value.kind === 'git' && result.value.target).toBeNull();
  });

  it('accepts an image source', () => {
    const input = { kind: 'image', imageRef: 'ghcr.io/acme/app:v1' };

    expect(validateServiceSource(input)).toEqual({ ok: true, value: input });
  });

  it.each([null, undefined, 'git', 42, [], [GIT_SOURCE], {}, { kind: 'dockerfile' }, { kind: 1 }])(
    'rejects %j with SERVICE_SOURCE_INVALID',
    (input) => {
      expect(codeOf(validateServiceSource(input))).toBe('SERVICE_SOURCE_INVALID');
    },
  );

  it.each(['buildArgs', 'build_args', 'env', 'environment', 'envVars', 'secrets', 'imageRef'])(
    'rejects the unsupported git field %s by name',
    (key) => {
      const result = validateServiceSource({ ...GIT_SOURCE, [key]: 'x' });

      expect(codeOf(result)).toBe('SERVICE_SOURCE_UNSUPPORTED_FIELD');
      expect(!result.ok && result.message).toContain(key);
    },
  );

  it.each(['buildArgs', 'env', 'repositoryUrl', 'branch', 'target'])(
    'rejects the unsupported image field %s by name',
    (key) => {
      const result = validateServiceSource({ kind: 'image', imageRef: 'node:22', [key]: 'x' });

      expect(codeOf(result)).toBe('SERVICE_SOURCE_UNSUPPORTED_FIELD');
      expect(!result.ok && result.message).toContain(key);
    },
  );

  it.each([
    [
      { ...GIT_SOURCE, repositoryUrl: 'http://github.com/acme/app.git' },
      'REPOSITORY_URL_UNSUPPORTED_SCHEME',
    ],
    [{ ...GIT_SOURCE, branch: 'a..b' }, 'GIT_BRANCH_PATH_TRAVERSAL'],
    [{ ...GIT_SOURCE, buildContext: '../x' }, 'BUILD_CONTEXT_PATH_INVALID'],
    [{ ...GIT_SOURCE, dockerfilePath: '/etc/passwd' }, 'DOCKERFILE_PATH_INVALID'],
    [{ ...GIT_SOURCE, target: '-x' }, 'BUILD_TARGET_INVALID'],
    [{ kind: 'image', imageRef: 'node' }, 'IMAGE_REF_TAG_REQUIRED'],
  ])('passes a field validator code through unchanged (%j -> %s)', (input, code) => {
    expect(codeOf(validateServiceSource(input))).toBe(code);
  });

  it.each([
    { ...GIT_SOURCE, repositoryUrl: 42 },
    { ...GIT_SOURCE, branch: undefined },
    { ...GIT_SOURCE, buildContext: 1 },
    { ...GIT_SOURCE, dockerfilePath: null },
    { ...GIT_SOURCE, target: 7 },
    { kind: 'image' },
    { kind: 'image', imageRef: ['node:22'] },
  ])('rejects a missing or non-string field in %j with SERVICE_SOURCE_INVALID', (input) => {
    expect(codeOf(validateServiceSource(input))).toBe('SERVICE_SOURCE_INVALID');
  });

  it('exposes no build-arg or env field on either variant (DEP-08)', () => {
    type GitSource = Extract<ServiceSource, { kind: 'git' }>;
    type ImageSource = Extract<ServiceSource, { kind: 'image' }>;

    expectTypeOf<GitSource>().not.toHaveProperty('buildArgs');
    expectTypeOf<GitSource>().not.toHaveProperty('env');
    expectTypeOf<ImageSource>().not.toHaveProperty('buildArgs');
    expectTypeOf<ImageSource>().not.toHaveProperty('env');
    expectTypeOf<keyof GitSource>().toEqualTypeOf<
      'kind' | 'repositoryUrl' | 'branch' | 'buildContext' | 'dockerfilePath' | 'target'
    >();
    expectTypeOf<keyof ImageSource>().toEqualTypeOf<'kind' | 'imageRef'>();
  });
});
