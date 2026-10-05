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
      const result = validateServiceSource({
        kind: 'image',
        imageRef: 'node:22',
        [key]: 'x',
      });

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

// H1/H2 hardening (phase 12): every hostile shape is rejected at the service-source boundary,
// before any value can reach a remote command template.
describe('validateServiceSource hardening', () => {
  function gitWith(overrides: Record<string, unknown>): unknown {
    return { ...GIT_SOURCE, ...overrides };
  }

  it.each([
    'https://github.com/acme/app.git',
    'ssh://git@github.com/acme/app.git',
    'ssh://git@github.com:2222/acme/app.git',
    'git@github.com:acme/app.git',
  ])('accepts the repository URL %s', (repositoryUrl) => {
    expect(validateServiceSource(gitWith({ repositoryUrl })).ok).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'file:/etc/passwd',
    'ext::sh -c touch% /tmp/pwned',
    'ext::sh%20-c%20id',
    'git://github.com/acme/app.git',
    'http://github.com/acme/app.git',
    'HTTPS://github.com/acme/app.git',
    'javascript:alert(1)',
    'javascript://github.com/%0aalert(1)',
    'data:text/plain,hello',
    'https://user:pass@github.com/acme/app.git',
    'https://ghp_token@github.com/acme/app.git',
    'ssh://git:secret@github.com/acme/app.git',
    'deploy:secret@github.com:acme/app.git',
    '-uhttps://github.com/acme/app.git',
    '--upload-pack=touch /tmp/x',
    '-oProxyCommand=id@github.com:acme/app.git',
    ' https://github.com/acme/app.git',
    'https://github.com/acme/app.git\n',
    'https://github.com/acme/\tapp.git',
    'https://github.com/acme/app\u0000.git',
    'https://github.com/acme/app\u001b.git',
    'https://github.com/acme/app\u007f.git',
    'https://git\u0001hub.com/acme/app.git',
    'https://github.com/acme/app\u00a0.git',
    'https://github.com/acme/app\u200b.git',
    'git@github.com:../../etc/passwd',
    'https://github.com/acme/../app.git',
    '',
  ])('rejects the repository URL %j', (repositoryUrl) => {
    const result = validateServiceSource(gitWith({ repositoryUrl }));

    expect(result.ok).toBe(false);
    expect(codeOf(result)).toMatch(/^REPOSITORY_URL_/);
  });

  it.each([
    'a..b',
    '..',
    '../main',
    '/main',
    '-main',
    '--upload-pack=x',
    'ma\u0000in',
    'ma\nin',
    'main\r',
    'ma in',
    'x'.repeat(256),
    '',
  ])('rejects the branch %j', (branch) => {
    expect(codeOf(validateServiceSource(gitWith({ branch })))).toMatch(/^GIT_BRANCH_/);
  });

  it('accepts a branch of exactly 255 characters', () => {
    expect(validateServiceSource(gitWith({ branch: 'b'.repeat(255) })).ok).toBe(true);
  });

  it.each([
    '..',
    '../x',
    'a/../b',
    'a/..',
    '/abs',
    '/',
    '-x',
    'a/-x',
    'a\u0000',
    'a\nb',
    'a b',
    'a//b',
    'x'.repeat(256),
    '',
  ])('rejects the build context %j', (buildContext) => {
    expect(codeOf(validateServiceSource(gitWith({ buildContext })))).toBe(
      'BUILD_CONTEXT_PATH_INVALID',
    );
  });

  it.each([
    '..',
    '../Dockerfile',
    'a/../Dockerfile',
    '/etc/passwd',
    '-f',
    'docker/-f',
    'Docker\u0000file',
    'Docker\nfile',
    'x'.repeat(256),
    '',
    '.',
  ])('rejects the Dockerfile path %j', (dockerfilePath) => {
    expect(codeOf(validateServiceSource(gitWith({ dockerfilePath })))).toBe(
      'DOCKERFILE_PATH_INVALID',
    );
  });

  it('accepts build paths of exactly 255 characters', () => {
    const path = 'p'.repeat(255);

    expect(validateServiceSource(gitWith({ buildContext: path, dockerfilePath: path })).ok).toBe(
      true,
    );
  });

  it.each([
    'node:22',
    'ghcr.io/acme/app:v1',
    'localhost:5000/app:1',
    `node@sha256:${'a'.repeat(64)}`,
    `node:22@sha256:${'b'.repeat(64)}`,
  ])('accepts the image reference %s', (imageRef) => {
    expect(validateServiceSource({ kind: 'image', imageRef }).ok).toBe(true);
  });

  it.each([
    'node :22',
    ' node:22',
    'node:22 ',
    'node:2\t2',
    'node:22\n',
    '-node:22',
    '--privileged',
    'node@sha256:abc',
    `node@sha256:${'a'.repeat(63)}`,
    `node@sha256:${'a'.repeat(65)}`,
    `node@sha256:${'A'.repeat(64)}`,
    `node@md5:${'a'.repeat(32)}`,
    `node@${'a'.repeat(64)}`,
    'node@',
    'node:22\u0000',
    'Node:22',
  ])('rejects the image reference %j', (imageRef) => {
    expect(codeOf(validateServiceSource({ kind: 'image', imageRef }))).toBe('IMAGE_REF_INVALID');
  });

  it('never accepts an implicit :latest', () => {
    expect(codeOf(validateServiceSource({ kind: 'image', imageRef: 'ghcr.io/acme/app' }))).toBe(
      'IMAGE_REF_TAG_REQUIRED',
    );
  });
});
