// The docker failure -> DeploymentErrorCode table (QA-10, D-03). Same three-layer defense as
// classifySshError and classifyGitError. Every capture in fixtures/deploy-errors/DOCKER.md exits
// 1 (125 for the port clash), so rules key on stderr text. Messages are fixed templates plus
// parsed numbers (build step, exit code, port) and never echo remote output (T-11-29).
import type { DeploymentErrorCode } from '@noodara/domain/deployment';
import {
  safeField,
  safeStderr,
  type ClassifyDeploymentContext,
  type DeploymentClassificationRule,
  type DeploymentFailureClassification,
  type RemoteFailure,
} from './git-error-classifier.js';

export interface DockerFailureInput {
  readonly operation:
    'build' | 'pull' | 'login' | 'create' | 'start' | 'stop' | 'remove' | 'inspect' | 'network';
  readonly failure: RemoteFailure;
}

function stderrMatches(input: unknown, pattern: RegExp): boolean {
  return pattern.test(safeStderr(input));
}

function operationIs(input: unknown, ...operations: readonly string[]): boolean {
  const operation = safeField(input, 'operation');
  return typeof operation === 'string' && operations.includes(operation);
}

// Markers from DOCKER.md (asserted live) and the discovery BuildKit captures (ADR 0008 G3).
const DOCKER_UNAVAILABLE_PATTERN =
  /Cannot connect to the Docker daemon|permission denied while trying to connect to the Docker daemon socket/;
const BUILDKIT_UNAVAILABLE_PATTERN =
  /'buildx' is not a docker command|BuildKit is enabled but the buildx component is missing or broken|Install the buildx component to build images with BuildKit/;
const DISK_FULL_PATTERN = /no space left on device/i;
const REGISTRY_AUTH_PATTERN =
  /authorization failed: no basic auth credentials|login attempt to \S+ failed with status: 401 Unauthorized|unauthorized: authentication required|denied: requested access to the resource is denied/;
// Scoped to daemon wording so a build log line such as `sh: foo: not found` does not match.
const IMAGE_NOT_FOUND_PATTERN =
  /manifest unknown|manifest for \S+ not found|failed to resolve reference "[^"\n]*": [^\n]*: not found/;
const DOCKERFILE_NOT_FOUND_PATTERN =
  /failed to read dockerfile: open [^\n]*: no such file or directory|Cannot locate specified Dockerfile/;
const PORT_IN_USE_PATTERN = /Bind for \S+ failed: port is already allocated|address already in use/;
const PORT_PATTERN = /Bind for \S*:(\d{1,5}) failed: port is already allocated/;
const BUILD_STEP_FAILED_PATTERN = /did not complete successfully: exit code: \d/;
const BUILD_EXIT_CODE_PATTERN = /did not complete successfully: exit code: (\d{1,3})(?!\d)/;
const BUILD_STEP_PATTERN = /^ > \[(?:[A-Za-z0-9_.-]{1,64} )?(\d{1,4})\/(\d{1,4})\]/m;

function parsedPort(input: unknown): number | undefined {
  const port = Number(PORT_PATTERN.exec(safeStderr(input))?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function buildFailedMessage(input: unknown): string {
  const stderr = safeStderr(input);
  const step = BUILD_STEP_PATTERN.exec(stderr);
  const exitCode = BUILD_EXIT_CODE_PATTERN.exec(stderr)?.[1];
  const stepText =
    step?.[1] !== undefined && step[2] !== undefined
      ? ` at step ${String(Number(step[1]))} of ${String(Number(step[2]))}`
      : '';
  const exitText = exitCode !== undefined ? ` with exit code ${String(Number(exitCode))}` : '';
  return `The Docker build failed${stepText}${exitText}. Check the build logs for that step, fix the Dockerfile or the application, then redeploy.`;
}

/**
 * Ordered, frozen rule table: daemon unreachable, BuildKit missing, disk full, auth, not found,
 * Dockerfile missing, port in use, build step failure, then per-operation fallbacks. Every
 * fallback is a visible named entry; the last one matches everything.
 */
export const DOCKER_ERROR_CLASSIFICATION_RULES: readonly DeploymentClassificationRule<DockerFailureInput>[] =
  Object.freeze([
    {
      name: 'docker-unavailable',
      code: 'DOCKER_UNAVAILABLE',
      matches: (input) => stderrMatches(input, DOCKER_UNAVAILABLE_PATTERN),
      message: () =>
        'Docker is not reachable on the server. Check that the Docker service is running and that the deploy user belongs to the docker group.',
    },
    {
      name: 'buildkit-unavailable',
      code: 'BUILDKIT_UNAVAILABLE',
      matches: (input) => stderrMatches(input, BUILDKIT_UNAVAILABLE_PATTERN),
      message: () =>
        'BuildKit is not available on the server. Install it with "sudo apt-get install docker-buildx-plugin", then redeploy.',
    },
    {
      name: 'disk-full',
      code: 'DISK_FULL',
      matches: (input) => stderrMatches(input, DISK_FULL_PATTERN),
      message: () =>
        'The server ran out of disk space. Free disk space on the server (for example unused Docker images), then redeploy.',
    },
    {
      name: 'registry-auth-failed',
      code: 'REGISTRY_AUTH_FAILED',
      matches: (input) => stderrMatches(input, REGISTRY_AUTH_PATTERN),
      message: () =>
        'The container registry rejected the credentials. Check the registry username and password configured for this service, then redeploy.',
    },
    {
      name: 'image-not-found',
      code: 'IMAGE_NOT_FOUND',
      matches: (input) => stderrMatches(input, IMAGE_NOT_FOUND_PATTERN),
      message: () =>
        'The image was not found in the registry. Check the image name and tag configured for this service, then redeploy.',
    },
    {
      name: 'dockerfile-not-found',
      code: 'DOCKERFILE_NOT_FOUND',
      matches: (input) => stderrMatches(input, DOCKERFILE_NOT_FOUND_PATTERN),
      message: () =>
        'The Dockerfile was not found in the repository. Check the Dockerfile path configured for this service, then redeploy.',
    },
    {
      name: 'port-in-use',
      code: 'PORT_IN_USE',
      matches: (input) => stderrMatches(input, PORT_IN_USE_PATTERN),
      message: (input) => {
        const port = parsedPort(input);
        const portText = port === undefined ? 'The host port' : `Host port ${String(port)}`;
        return `${portText} is already in use on the server. Choose a different port or stop the process using it, then redeploy.`;
      },
    },
    {
      name: 'build-step-failed',
      code: 'BUILD_FAILED',
      matches: (input) => stderrMatches(input, BUILD_STEP_FAILED_PATTERN),
      message: (input) => buildFailedMessage(input),
    },
    {
      name: 'build-unclassified',
      code: 'BUILD_FAILED',
      matches: (input) => operationIs(input, 'build'),
      message: () =>
        'The Docker build failed. Check the build logs, fix the Dockerfile or the application, then redeploy.',
    },
    {
      name: 'image-unclassified',
      code: 'IMAGE_PULL_FAILED',
      matches: (input) => operationIs(input, 'pull', 'login'),
      message: () =>
        'Pulling the image failed. Check the image name, the registry credentials and the server network access, then redeploy.',
    },
    {
      // Terminal fallback (a decision, not a gap): create/start and every other container
      // operation report START_FAILED.
      name: 'unclassified-fallback',
      code: 'START_FAILED',
      matches: () => true,
      message: () =>
        'The container could not be started. Check the service configuration and the server logs, then redeploy.',
    },
  ]);

const SAFE_FALLBACK_CODE: DeploymentErrorCode = 'START_FAILED';
const SAFE_FALLBACK_MESSAGE =
  'The container could not be started. Check the service configuration and the server logs, then redeploy.';

/** Classifies a docker failure into the closed vocabulary. Never throws. */
export function classifyDockerError(
  input: DockerFailureInput,
  context: ClassifyDeploymentContext,
): DeploymentFailureClassification {
  try {
    for (const rule of DOCKER_ERROR_CLASSIFICATION_RULES) {
      let isMatch: boolean;
      try {
        isMatch = rule.matches(input);
      } catch {
        isMatch = false;
      }
      if (!isMatch) continue;

      let message: string;
      try {
        message = rule.message(input);
      } catch {
        message = SAFE_FALLBACK_MESSAGE;
      }

      return { code: rule.code, message: context.redactor.redact(message) };
    }
    // Unreachable: `unclassified-fallback` always matches. Kept as a last-resort net.
    return { code: SAFE_FALLBACK_CODE, message: context.redactor.redact(SAFE_FALLBACK_MESSAGE) };
  } catch {
    return { code: SAFE_FALLBACK_CODE, message: SAFE_FALLBACK_MESSAGE };
  }
}
