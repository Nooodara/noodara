// Pure Docker-side validators and deterministic names (SVC-08, 11-CONTEXT D-07, ROADMAP D11/D12).
// Every value here later reaches a remote shell through a closed command template, so each one is
// an allowlist grammar with a named rejection code, returned as a branded type.

import type { Brand } from './branded.js';
import { type ValidationResult, assertDefined, fail, ok } from './network.js';

export type ImageRef = Brand<string, 'ImageRef'>;
export type RegistryHost = Brand<string, 'RegistryHost'>;
export type RegistryUsername = Brand<string, 'RegistryUsername'>;
export type BuildContextPath = Brand<string, 'BuildContextPath'>;
export type DockerfilePath = Brand<string, 'DockerfilePath'>;
export type BuildTarget = Brand<string, 'BuildTarget'>;
export type ContainerPort = Brand<number, 'ContainerPort'>;
export type DockerObjectId = Brand<string, 'DockerObjectId'>;
export type ContainerName = Brand<string, 'ContainerName'>;
export type NetworkName = Brand<string, 'NetworkName'>;
export type DeployWorkspacePath = Brand<string, 'DeployWorkspacePath'>;
export type DeployRepoPath = Brand<string, 'DeployRepoPath'>;
export type DeploySecretPath = Brand<string, 'DeploySecretPath'>;
export type DeployRunPath = Brand<string, 'DeployRunPath'>;
export type DockerConfigDir = Brand<string, 'DockerConfigDir'>;
export type RepoBuildPath = Brand<string, 'RepoBuildPath'>;
/** A lowercase UUID of a Service or Deployment, e.g. for `noodara.*` Docker label values. */
export type ResourceId = Brand<string, 'ResourceId'>;

export const DEPLOY_SECRET_NAMES = [
  'deploy_key',
  'known_hosts',
  'https_token',
  'registry_password',
] as const;
export type DeploySecretName = (typeof DEPLOY_SECRET_NAMES)[number];

/** `logs` is a runtime `docker logs --follow` stream (12-16), killed by group like the others. */
export const SUPERVISED_OPERATIONS = ['clone', 'build', 'pull', 'logs'] as const;
/** The operations a deployment runs; the crash sweep kills only these, never a log follow. */
export const DEPLOYMENT_SUPERVISED_OPERATIONS = ['clone', 'build', 'pull'] as const satisfies readonly SupervisedOperation[];
export type SupervisedOperation = (typeof SUPERVISED_OPERATIONS)[number];

export interface DeployWorkspace {
  readonly root: DeployWorkspacePath;
  /** Clone target; every build context lives under it. */
  readonly repo: DeployRepoPath;
  /** Mode-700 directory, a sibling of `repo`, so a secret can never enter a build context. */
  readonly secretsDir: DeploySecretPath;
  /** Pidfiles of supervised operations. */
  readonly runDir: DeployRunPath;
  readonly dockerConfigDir: DockerConfigDir;
  secretFile(name: DeploySecretName): DeploySecretPath;
  pidFile(op: SupervisedOperation): DeployRunPath;
}

const MAX_IMAGE_REF_LENGTH = 255;
const MAX_REGISTRY_HOST_LENGTH = 255;
const MAX_RELATIVE_PATH_LENGTH = 255;
const DEPLOY_WORKSPACE_ROOT = '/opt/noodara-deploy/';

// distribution/reference grammar.
const PATH_COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HOST_LABEL_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const REGISTRY_USERNAME_PATTERN = /^[A-Za-z0-9._@][A-Za-z0-9._@-]{0,254}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const BUILD_TARGET_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,62}$/;
const DOCKER_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/;
const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `host[:port]` with RFC 1123 labels and a 1-65535 port. */
function isRegistryHost(input: string): boolean {
  const colon = input.indexOf(':');
  const host = colon === -1 ? input : input.slice(0, colon);
  if (colon !== -1) {
    const port = input.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false;
  }
  return host.split('.').every((label) => HOST_LABEL_PATTERN.test(label));
}

/**
 * D-07: `[registry[:port]/]repo[:tag][@sha256:<hex>]` on any registry. The tag or digest is
 * mandatory (an implicit `:latest` is rejected with IMAGE_REF_TAG_REQUIRED); an explicit `:latest`
 * is accepted. As in Docker, the first component is a registry only if it contains "." or ":" or
 * is "localhost".
 */
export function validateImageRef(input: string): ValidationResult<ImageRef> {
  const invalid = fail<ImageRef>(
    'IMAGE_REF_INVALID',
    'Image reference must follow [registry[:port]/]name[:tag][@sha256:digest] with a lowercase name',
  );
  if (input.length === 0 || input.length > MAX_IMAGE_REF_LENGTH) return invalid;

  const at = input.indexOf('@');
  const nameAndTag = at === -1 ? input : input.slice(0, at);
  const digest = at === -1 ? null : input.slice(at + 1);
  if (digest !== null && !DIGEST_PATTERN.test(digest)) return invalid;

  const lastSlash = nameAndTag.lastIndexOf('/');
  const tagColon = nameAndTag.indexOf(':', lastSlash + 1);
  const name = tagColon === -1 ? nameAndTag : nameAndTag.slice(0, tagColon);
  const tag = tagColon === -1 ? null : nameAndTag.slice(tagColon + 1);
  if (tag !== null && !TAG_PATTERN.test(tag)) return invalid;

  const components = name.split('/');
  const first = assertDefined(components[0]);
  const hasRegistry =
    components.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (hasRegistry && !isRegistryHost(first)) return invalid;
  const pathComponents = hasRegistry ? components.slice(1) : components;
  if (!pathComponents.every((component) => PATH_COMPONENT_PATTERN.test(component))) {
    return invalid;
  }

  if (tag === null && digest === null) {
    return fail(
      'IMAGE_REF_TAG_REQUIRED',
      'Image reference must include an explicit tag (for example :1.2.3 or :latest) or a sha256 digest',
    );
  }
  return ok(input as ImageRef);
}

export function validateRegistryHost(input: string): ValidationResult<RegistryHost> {
  if (input.length === 0 || input.length > MAX_REGISTRY_HOST_LENGTH || !isRegistryHost(input)) {
    return fail(
      'REGISTRY_HOST_INVALID',
      'Registry must be a hostname with an optional port (host[:port]), without scheme, path or user',
    );
  }
  return ok(input as RegistryHost);
}

export function validateRegistryUsername(input: string): ValidationResult<RegistryUsername> {
  if (!REGISTRY_USERNAME_PATTERN.test(input)) {
    return fail(
      'REGISTRY_USERNAME_INVALID',
      'Registry username must be 1-255 characters of [A-Za-z0-9._@-] and not start with "-"',
    );
  }
  return ok(input as RegistryUsername);
}

/** A relative path inside the repository: no absolute path, no "." / ".." / empty / "-" segment. */
function isSafeRelativePath(input: string): boolean {
  if (input.length === 0 || input.length > MAX_RELATIVE_PATH_LENGTH) return false;
  return input
    .split('/')
    .every((segment) => PATH_SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..');
}

/** Build context relative to the repository root; "." is the root itself. */
export function validateBuildContextPath(input: string): ValidationResult<BuildContextPath> {
  if (input !== '.' && !isSafeRelativePath(input)) {
    return fail(
      'BUILD_CONTEXT_PATH_INVALID',
      'Build context must be "." or a relative path of [A-Za-z0-9._-] segments without ".." or a leading "-"',
    );
  }
  return ok(input as BuildContextPath);
}

/** Dockerfile path relative to the repository root. */
export function validateDockerfilePath(input: string): ValidationResult<DockerfilePath> {
  if (!isSafeRelativePath(input)) {
    return fail(
      'DOCKERFILE_PATH_INVALID',
      'Dockerfile path must be a relative path of [A-Za-z0-9._-] segments without ".." or a leading "-"',
    );
  }
  return ok(input as DockerfilePath);
}

export function validateBuildTarget(input: string): ValidationResult<BuildTarget> {
  if (!BUILD_TARGET_PATTERN.test(input)) {
    return fail(
      'BUILD_TARGET_INVALID',
      'Build target must start with a letter and use at most 63 characters of [A-Za-z0-9_.-]',
    );
  }
  return ok(input as BuildTarget);
}

export function validateContainerPort(input: unknown): ValidationResult<ContainerPort> {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > 65535) {
    return fail('CONTAINER_PORT_INVALID', 'Container port must be an integer from 1 to 65535');
  }
  return ok(input as ContainerPort);
}

/** A container/image/build id as Docker prints it: 12 or 64 lowercase hex characters. */
export function validateDockerObjectId(input: string): ValidationResult<DockerObjectId> {
  if (!DOCKER_OBJECT_ID_PATTERN.test(input)) {
    return fail(
      'DOCKER_OBJECT_ID_INVALID',
      'Docker object id must be 12 or 64 lowercase hex characters',
    );
  }
  return ok(input as DockerObjectId);
}

function resourceIdFailure<T>(): ValidationResult<T> {
  return fail('RESOURCE_ID_INVALID', 'Resource id must be a lowercase UUID');
}

function isResourceId(id: string): boolean {
  return RESOURCE_ID_PATTERN.test(id);
}

export function validateResourceId(input: string): ValidationResult<ResourceId> {
  if (!isResourceId(input)) return resourceIdFailure();
  return ok(input as ResourceId);
}

export function containerNameFor(serviceId: string): ValidationResult<ContainerName> {
  if (!isResourceId(serviceId)) return resourceIdFailure();
  return ok(`noodara-${serviceId}` as ContainerName);
}

export function networkNameFor(serviceId: string): ValidationResult<NetworkName> {
  if (!isResourceId(serviceId)) return resourceIdFailure();
  return ok(`noodara-net-${serviceId}` as NetworkName);
}

export function deploymentImageRefFor(
  serviceId: string,
  deploymentId: string,
): ValidationResult<ImageRef> {
  if (!isResourceId(serviceId) || !isResourceId(deploymentId)) return resourceIdFailure();
  return ok(`noodara/${serviceId}:${deploymentId}` as ImageRef);
}

export function deployWorkspaceFor(deploymentId: string): ValidationResult<DeployWorkspace> {
  if (!isResourceId(deploymentId)) return resourceIdFailure();
  const root = `${DEPLOY_WORKSPACE_ROOT}${deploymentId}`;
  const secretsDir = `${root}/secrets`;
  const runDir = `${root}/run`;
  return ok({
    root: root as DeployWorkspacePath,
    repo: `${root}/repo` as DeployRepoPath,
    secretsDir: secretsDir as DeploySecretPath,
    runDir: runDir as DeployRunPath,
    dockerConfigDir: `${secretsDir}/docker` as DockerConfigDir,
    secretFile: (name) => `${secretsDir}/${name}` as DeploySecretPath,
    pidFile: (op) => `${runDir}/${op}.pid` as DeployRunPath,
  });
}

/** Joins already-validated relative paths onto the clone directory; "." maps to the repo root. */
export function resolveRepoBuildPaths(
  repo: DeployRepoPath,
  context: BuildContextPath,
  dockerfile: DockerfilePath,
): { contextPath: RepoBuildPath; dockerfilePath: RepoBuildPath } {
  return {
    contextPath: (context === '.' ? repo : `${repo}/${context}`) as RepoBuildPath,
    dockerfilePath: `${repo}/${dockerfile}` as RepoBuildPath,
  };
}
