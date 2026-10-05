import { describe, expect, it } from 'vitest';
import {
  DEPLOY_SECRET_NAMES,
  DEPLOYMENT_SUPERVISED_OPERATIONS,
  SUPERVISED_OPERATIONS,
  type BuildContextPath,
  type DeployRepoPath,
  type DockerfilePath,
  containerNameFor,
  deployWorkspaceFor,
  deploymentImageRefFor,
  networkNameFor,
  resolveRepoBuildPaths,
  validateBuildContextPath,
  validateBuildTarget,
  validateContainerPort,
  validateDockerObjectId,
  validateDockerfilePath,
  validateImageRef,
  validateRegistryHost,
  validateRegistryUsername,
  validateResourceId,
} from './docker-naming.js';

const SERVICE_ID = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';
const DEPLOYMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const DIGEST = `sha256:${'a1'.repeat(32)}`;

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

describe('validateImageRef', () => {
  it.each([
    'node:22-alpine',
    'nginx:1.27-alpine',
    'ghcr.io/acme/app:v1.2.3',
    'registry.example.com:5000/team/app:latest',
    'node:latest',
    `node@${DIGEST}`,
    `ghcr.io/acme/app:v1@${DIGEST}`,
    `noodara/${SERVICE_ID}:${DEPLOYMENT_ID}`,
    'localhost:5000/app:1',
    'library/my_app__x.y-z:TAG_1.0',
  ])('accepts %s unchanged', (ref) => {
    expect(validateImageRef(ref)).toEqual({ ok: true, value: ref });
  });

  it.each(['node', 'ghcr.io/acme/app', 'registry.example.com:5000/team/app', 'localhost/app'])(
    'rejects %s with IMAGE_REF_TAG_REQUIRED',
    (ref) => {
      expect(codeOf(validateImageRef(ref))).toBe('IMAGE_REF_TAG_REQUIRED');
    },
  );

  it.each([
    '',
    'Node:22',
    'ghcr.io/Acme/app:1',
    'ghcr.io//app:1',
    'acme/../app:1',
    'node:',
    `node:${'a'.repeat(129)}`,
    'node:.hidden',
    'node:-flag',
    'node@sha256:abc',
    `node@sha256:${'A1'.repeat(32)}`,
    `node@sha512:${'a1'.repeat(32)}`,
    'node@',
    `${'a'.repeat(250)}:12345678`,
    'node :22',
    'node:22\n',
    'node:22;rm',
    'node:$(id)',
    '-node:22',
    'ghcr.io:abc/app:1',
    '-ghcr.io/app:1',
    'app_:1',
    '/app:1',
    'app/:1',
  ])('rejects %j with IMAGE_REF_INVALID', (ref) => {
    expect(codeOf(validateImageRef(ref))).toBe('IMAGE_REF_INVALID');
  });
});

describe('validateRegistryHost', () => {
  it.each(['ghcr.io', 'docker.io', 'registry.noodara-test.internal:5000', 'localhost:5000'])(
    'accepts %s',
    (host) => {
      expect(validateRegistryHost(host)).toEqual({ ok: true, value: host });
    },
  );

  it.each([
    '',
    'https://ghcr.io',
    'ghcr.io/acme',
    'user@ghcr.io',
    'ghcr .io',
    'ghcr.io;id',
    'ghcr.io:',
    'ghcr.io:99999',
    '-ghcr.io',
    `${'a'.repeat(250)}.io`,
  ])('rejects %j with REGISTRY_HOST_INVALID', (host) => {
    expect(codeOf(validateRegistryHost(host))).toBe('REGISTRY_HOST_INVALID');
  });
});

describe('validateRegistryUsername', () => {
  it.each(['octocat', 'robot.acme', 'me@example.com', 'a_b-c'])('accepts %s', (name) => {
    expect(validateRegistryUsername(name)).toEqual({ ok: true, value: name });
  });

  it.each(['', '-user', 'a b', 'a;b', 'a:b', 'a'.repeat(256)])(
    'rejects %j with REGISTRY_USERNAME_INVALID',
    (name) => {
      expect(codeOf(validateRegistryUsername(name))).toBe('REGISTRY_USERNAME_INVALID');
    },
  );
});

const BAD_RELATIVE_PATHS = [
  '',
  '/abs',
  '../up',
  'a/../b',
  'a//b',
  'a/',
  '-flag',
  'a/-flag',
  'a b',
  'a;b',
  'a/./b',
  'a'.repeat(256),
];

describe('validateBuildContextPath', () => {
  it.each(['.', 'app', 'services/api', 'a_b/c-d.e'])('accepts %s', (path) => {
    expect(validateBuildContextPath(path)).toEqual({ ok: true, value: path });
  });

  it.each(BAD_RELATIVE_PATHS)('rejects %j with BUILD_CONTEXT_PATH_INVALID', (path) => {
    expect(codeOf(validateBuildContextPath(path))).toBe('BUILD_CONTEXT_PATH_INVALID');
  });
});

describe('validateDockerfilePath', () => {
  it.each(['Dockerfile', 'docker/Dockerfile.prod'])('accepts %s', (path) => {
    expect(validateDockerfilePath(path)).toEqual({ ok: true, value: path });
  });

  it.each([...BAD_RELATIVE_PATHS, '.'])('rejects %j with DOCKERFILE_PATH_INVALID', (path) => {
    expect(codeOf(validateDockerfilePath(path))).toBe('DOCKERFILE_PATH_INVALID');
  });
});

describe('validateBuildTarget', () => {
  it.each(['production', 'build-stage', 'a', `A${'b'.repeat(62)}`, 'v1.2_x'])('accepts %s', (t) => {
    expect(validateBuildTarget(t)).toEqual({ ok: true, value: t });
  });

  it.each(['', '1stage', '-x', '_x', 'a b', 'a;b', `A${'b'.repeat(63)}`])(
    'rejects %j with BUILD_TARGET_INVALID',
    (t) => {
      expect(codeOf(validateBuildTarget(t))).toBe('BUILD_TARGET_INVALID');
    },
  );
});

describe('validateContainerPort', () => {
  it.each([1, 80, 3000, 65535])('accepts %d', (port) => {
    expect(validateContainerPort(port)).toEqual({ ok: true, value: port });
  });

  it.each([0, 65536, 1.5, '80', Number.NaN, null, -1])(
    'rejects %j with CONTAINER_PORT_INVALID',
    (port) => {
      expect(codeOf(validateContainerPort(port))).toBe('CONTAINER_PORT_INVALID');
    },
  );
});

describe('validateDockerObjectId', () => {
  it.each(['0123456789ab', 'f'.repeat(64)])('accepts %s', (id) => {
    expect(validateDockerObjectId(id)).toEqual({ ok: true, value: id });
  });

  it.each([
    '',
    '0123456789a',
    '0123456789AB',
    'f'.repeat(63),
    'f'.repeat(65),
    `sha256:${'f'.repeat(64)}`,
  ])('rejects %j with DOCKER_OBJECT_ID_INVALID', (id) => {
    expect(codeOf(validateDockerObjectId(id))).toBe('DOCKER_OBJECT_ID_INVALID');
  });
});

const BAD_IDS = [
  '',
  '3F2B8C1E-9A4D-4E7B-8C2F-1A2B3C4D5E6F',
  `{${SERVICE_ID}}`,
  '../etc',
  '../x',
  'abc',
];

describe('deterministic names', () => {
  it('derives the container name noodara-<serviceId>', () => {
    expect(containerNameFor(SERVICE_ID)).toEqual({ ok: true, value: `noodara-${SERVICE_ID}` });
  });

  it('derives the network name noodara-net-<serviceId>', () => {
    expect(networkNameFor(SERVICE_ID)).toEqual({ ok: true, value: `noodara-net-${SERVICE_ID}` });
  });

  it('derives the image ref noodara/<serviceId>:<deploymentId>, which is itself a valid ref', () => {
    const result = deploymentImageRefFor(SERVICE_ID, DEPLOYMENT_ID);

    expect(result).toEqual({ ok: true, value: `noodara/${SERVICE_ID}:${DEPLOYMENT_ID}` });
    expect(result.ok && validateImageRef(result.value).ok).toBe(true);
  });

  it.each(BAD_IDS)('rejects the id %j with RESOURCE_ID_INVALID', (id) => {
    expect(codeOf(containerNameFor(id))).toBe('RESOURCE_ID_INVALID');
    expect(codeOf(networkNameFor(id))).toBe('RESOURCE_ID_INVALID');
    expect(codeOf(deploymentImageRefFor(id, DEPLOYMENT_ID))).toBe('RESOURCE_ID_INVALID');
    expect(codeOf(deploymentImageRefFor(SERVICE_ID, id))).toBe('RESOURCE_ID_INVALID');
    expect(codeOf(deployWorkspaceFor(id))).toBe('RESOURCE_ID_INVALID');
    expect(codeOf(validateResourceId(id))).toBe('RESOURCE_ID_INVALID');
  });

  it('brands a lowercase UUID as a ResourceId (docker label values, 11-13)', () => {
    expect(validateResourceId(SERVICE_ID)).toEqual({ ok: true, value: SERVICE_ID });
  });
});

describe('deployWorkspaceFor', () => {
  it('lays out the workspace under /opt/noodara-deploy/<deploymentId>', () => {
    const result = deployWorkspaceFor(DEPLOYMENT_ID);
    const root = `/opt/noodara-deploy/${DEPLOYMENT_ID}`;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ws = result.value;
    expect(ws.root).toBe(root);
    expect(ws.repo).toBe(`${root}/repo`);
    expect(ws.secretsDir).toBe(`${root}/secrets`);
    expect(ws.runDir).toBe(`${root}/run`);
    expect(ws.dockerConfigDir).toBe(`${root}/secrets/docker`);
    expect(ws.secretFile('deploy_key')).toBe(`${root}/secrets/deploy_key`);
    expect(ws.pidFile('build')).toBe(`${root}/run/build.pid`);
    expect(ws.pidFile('logs')).toBe(`${root}/run/logs.pid`);
  });

  it('exposes every secret and supervised-operation name as a path under its directory', () => {
    const result = deployWorkspaceFor(DEPLOYMENT_ID);
    if (!result.ok) throw new Error('expected ok');
    const ws = result.value;

    expect(DEPLOY_SECRET_NAMES).toEqual([
      'deploy_key',
      'known_hosts',
      'https_token',
      'registry_password',
    ]);
    expect(SUPERVISED_OPERATIONS).toEqual(['clone', 'build', 'pull', 'logs']);
    expect(DEPLOYMENT_SUPERVISED_OPERATIONS).toEqual(['clone', 'build', 'pull']);
    for (const name of DEPLOY_SECRET_NAMES) {
      expect(ws.secretFile(name)).toBe(`${ws.secretsDir}/${name}`);
    }
    for (const op of SUPERVISED_OPERATIONS) {
      expect(ws.pidFile(op)).toBe(`${ws.runDir}/${op}.pid`);
    }
  });

  it('keeps the secrets directory outside the repository (and so outside any build context)', () => {
    const result = deployWorkspaceFor(DEPLOYMENT_ID);
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.secretsDir.startsWith(`${result.value.repo}/`)).toBe(false);
  });
});

describe('resolveRepoBuildPaths', () => {
  const repo = `/opt/noodara-deploy/${DEPLOYMENT_ID}/repo` as DeployRepoPath;

  it("maps '.' to the repository root", () => {
    const paths = resolveRepoBuildPaths(
      repo,
      '.' as BuildContextPath,
      'Dockerfile' as DockerfilePath,
    );

    expect(paths).toEqual({ contextPath: repo, dockerfilePath: `${repo}/Dockerfile` });
  });

  it('joins a nested context and Dockerfile relative to the repository root', () => {
    const paths = resolveRepoBuildPaths(
      repo,
      'services/api' as BuildContextPath,
      'services/api/Dockerfile' as DockerfilePath,
    );

    expect(paths).toEqual({
      contextPath: `${repo}/services/api`,
      dockerfilePath: `${repo}/services/api/Dockerfile`,
    });
    expect(paths.contextPath.startsWith(repo)).toBe(true);
    expect(paths.dockerfilePath.startsWith(repo)).toBe(true);
  });
});
