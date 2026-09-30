// Composite service source (SVC-08, DEP-08, ROADMAP D13). 'git' always builds the repository's
// Dockerfile (the "Dockerfile service" of D-03); 'image' pulls a published image. By design the
// model has no build-arg or env field: any extra key is rejected by name, so a secret can never
// travel into a build through this shape.

import {
  type BuildContextPath,
  type BuildTarget,
  type DockerfilePath,
  type ImageRef,
  validateBuildContextPath,
  validateBuildTarget,
  validateDockerfilePath,
  validateImageRef,
} from './docker-naming.js';
import {
  type GitBranch,
  type RepositoryUrl,
  validateGitBranch,
  validateRepositoryUrl,
} from './git.js';
import { type ValidationResult, fail, ok } from './network.js';

/** Feeds the `service_source_type` pg enum. */
export const SERVICE_SOURCE_TYPES = ['git', 'image'] as const;
export type ServiceSourceType = (typeof SERVICE_SOURCE_TYPES)[number];

export type ServiceSource =
  | {
      readonly kind: 'git';
      readonly repositoryUrl: RepositoryUrl;
      readonly branch: GitBranch;
      readonly buildContext: BuildContextPath;
      readonly dockerfilePath: DockerfilePath;
      readonly target: BuildTarget | null;
    }
  | { readonly kind: 'image'; readonly imageRef: ImageRef };

const ALLOWED_KEYS: Record<ServiceSourceType, readonly string[]> = {
  git: ['kind', 'repositoryUrl', 'branch', 'buildContext', 'dockerfilePath', 'target'],
  image: ['kind', 'imageRef'],
};

const DEFAULT_BUILD_CONTEXT = '.';
const DEFAULT_DOCKERFILE_PATH = 'Dockerfile';

function invalid<T>(reason: string): ValidationResult<T> {
  return fail('SERVICE_SOURCE_INVALID', `Service source ${reason}`);
}

function isServiceSourceType(value: unknown): value is ServiceSourceType {
  return (SERVICE_SOURCE_TYPES as readonly unknown[]).includes(value);
}

/**
 * Validates an untyped service source (API body, DB row) field by field. A field that fails its
 * own validator returns that validator's code unchanged.
 */
export function validateServiceSource(input: unknown): ValidationResult<ServiceSource> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('must be an object');
  }
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  if (!isServiceSourceType(kind)) {
    return invalid(`kind must be one of: ${SERVICE_SOURCE_TYPES.join(', ')}`);
  }
  const unsupported = Object.keys(record).find((key) => !ALLOWED_KEYS[kind].includes(key));
  if (unsupported !== undefined) {
    return fail(
      'SERVICE_SOURCE_UNSUPPORTED_FIELD',
      `Service source field "${unsupported}" is not supported for kind "${kind}"`,
    );
  }
  return kind === 'git' ? validateGitSource(record) : validateImageSource(record);
}

function validateImageSource(record: Record<string, unknown>): ValidationResult<ServiceSource> {
  if (typeof record.imageRef !== 'string') return invalid('imageRef must be a string');
  const imageRef = validateImageRef(record.imageRef);
  if (!imageRef.ok) return imageRef;
  return ok({ kind: 'image', imageRef: imageRef.value });
}

function validateGitSource(record: Record<string, unknown>): ValidationResult<ServiceSource> {
  const {
    repositoryUrl: rawUrl,
    branch: rawBranch,
    buildContext: rawContext = DEFAULT_BUILD_CONTEXT,
    dockerfilePath: rawDockerfile = DEFAULT_DOCKERFILE_PATH,
    target: rawTarget = null,
  } = record;
  if (
    typeof rawUrl !== 'string' ||
    typeof rawBranch !== 'string' ||
    typeof rawContext !== 'string' ||
    typeof rawDockerfile !== 'string' ||
    (rawTarget !== null && typeof rawTarget !== 'string')
  ) {
    return invalid('git fields must be strings (target may be null)');
  }

  const repositoryUrl = validateRepositoryUrl(rawUrl);
  if (!repositoryUrl.ok) return repositoryUrl;
  const branch = validateGitBranch(rawBranch);
  if (!branch.ok) return branch;
  const buildContext = validateBuildContextPath(rawContext);
  if (!buildContext.ok) return buildContext;
  const dockerfilePath = validateDockerfilePath(rawDockerfile);
  if (!dockerfilePath.ok) return dockerfilePath;
  let target: BuildTarget | null = null;
  if (rawTarget !== null) {
    const validated = validateBuildTarget(rawTarget);
    if (!validated.ok) return validated;
    target = validated.value;
  }

  return ok({
    kind: 'git',
    repositoryUrl: repositoryUrl.value,
    branch: branch.value,
    buildContext: buildContext.value,
    dockerfilePath: dockerfilePath.value,
    target,
  });
}
