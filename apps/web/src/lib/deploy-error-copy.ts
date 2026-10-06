// 13-13: user-facing copy for a failed deployment. The server's `errorMessage` is never shown:
// the UI renders only the classified copy for `errorCode` (title + what to do) and, when present,
// a guarded tail of the build log. `DEPLOYMENT_ERROR_COPY` is typed as a full Record over the
// domain codes, so adding a code without copy fails typecheck and deploy-error-copy.test.ts.
import type { DeploymentErrorCode } from '@noodara/domain/deployment';

export interface DeploymentErrorCopy {
  readonly title: string;
  readonly recovery: string;
}

export const DEPLOYMENT_ERROR_COPY: Readonly<Record<DeploymentErrorCode, DeploymentErrorCopy>> = Object.freeze({
  REPOSITORY_AUTH_FAILED: {
    title: 'Repository access denied',
    recovery: 'Check that the repository credential in the service settings can read this repository, then deploy again.',
  },
  REPOSITORY_NOT_FOUND: {
    title: 'Repository not found',
    recovery: 'Check the repository URL and that the credential can see it, then deploy again.',
  },
  BRANCH_NOT_FOUND: {
    title: 'Branch not found',
    recovery: 'Check the branch name in the service settings, then deploy again.',
  },
  REPOSITORY_HOST_UNREACHABLE: {
    title: 'Repository host unreachable',
    recovery: 'Check that the server can reach the Git host (DNS and outbound network), then deploy again.',
  },
  UNSUPPORTED_REPOSITORY_FEATURE: {
    title: 'Unsupported repository feature',
    recovery: 'Git LFS and submodules are not supported yet. Remove them from the build or deploy from an image.',
  },
  CLONE_FAILED: {
    title: 'Clone failed',
    recovery: 'Check the build log for the Git error, then deploy again.',
  },
  DOCKERFILE_NOT_FOUND: {
    title: 'Dockerfile not found',
    recovery: 'Add a Dockerfile at the configured path or change the Dockerfile path in the service settings.',
  },
  BUILDKIT_UNAVAILABLE: {
    title: 'BuildKit unavailable',
    recovery: 'Install the docker-buildx-plugin package on the server, then deploy again.',
  },
  BUILD_FAILED: {
    title: 'Build failed',
    recovery: 'Check the last lines of the build log, fix the Dockerfile or the code, then deploy again.',
  },
  REGISTRY_AUTH_FAILED: {
    title: 'Registry access denied',
    recovery: 'Check the registry credential in the service settings, then deploy again.',
  },
  IMAGE_NOT_FOUND: {
    title: 'Image not found',
    recovery: 'Check the image name and tag in the service settings, then deploy again.',
  },
  IMAGE_PULL_FAILED: {
    title: 'Image pull failed',
    recovery: 'Check that the server can reach the registry, then deploy again.',
  },
  DISK_FULL: {
    title: 'Server disk full',
    recovery: 'Free disk space on the server, for example by removing unused images, then deploy again.',
  },
  PORT_IN_USE: {
    title: 'Port already in use',
    recovery: 'Choose another published port in the service settings or stop what uses it on the server, then deploy again.',
  },
  START_FAILED: {
    title: 'Container failed to start',
    recovery: 'Check the runtime logs and the container start command, then deploy again.',
  },
  DOCKER_UNAVAILABLE: {
    title: 'Docker unavailable',
    recovery: 'Check that Docker is installed and running on the server, then deploy again.',
  },
  SERVER_UNREACHABLE: {
    title: 'Server unreachable',
    recovery: 'Check that the server is online and reachable over SSH, then deploy again.',
  },
  BUILD_TIMEOUT: {
    title: 'Deploy timed out',
    recovery: 'The deploy ran past its time limit. Make the build faster or raise NOODARA_DEPLOY_MAX_MS, then deploy again.',
  },
  BUILD_STALLED: {
    title: 'Build stalled',
    recovery: 'The build printed nothing for too long. Check for a step waiting on input, then deploy again.',
  },
  WORKER_CRASHED: {
    title: 'Deploy interrupted',
    recovery: 'The deploy worker stopped before finishing. Deploy again.',
  },
});

/** Shown for a code this build of the UI does not know (a newer server) or no code at all. */
export const GENERIC_DEPLOYMENT_ERROR_COPY: DeploymentErrorCopy = Object.freeze({
  title: 'Deploy failed',
  recovery: 'Check the build log for details, then deploy again.',
});

/** Total: unknown, empty or prototype-named codes get the generic copy, never undefined. */
export function deploymentErrorCopy(code: string | null | undefined): DeploymentErrorCopy {
  if (typeof code !== 'string' || !Object.hasOwn(DEPLOYMENT_ERROR_COPY, code)) return GENERIC_DEPLOYMENT_ERROR_COPY;
  return DEPLOYMENT_ERROR_COPY[code as DeploymentErrorCode];
}

// Log tail guard (H1). The server already redacts build logs; this is a second, client-side net:
// mask first (on whole lines), then cap, so a cut can never leave part of a secret visible.
export const LOG_TAIL_MAX_LINES = 20;
export const LOG_TAIL_MAX_LINE_CHARS = 240;
export const LOG_TAIL_MAX_CHARS = 4000;

const MASK = '[REDACTED]';
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED:private_key]'],
  [/-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED:private_key]'],
  // Key bodies and other long mixed-case base64 runs (hex digests are single-case and kept).
  [/(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/=]*[a-z])(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/]{40,}={0,2}/g, MASK],
  [/noodara-canary-[A-Za-z0-9_-]+/g, MASK],
  [/cnry[A-Za-z0-9]+/g, MASK],
  [/ghp_[A-Za-z0-9]{10,}/g, '[REDACTED:token]'],
  [/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED:token]'],
  [/AKIA[A-Z0-9]{10,}/g, '[REDACTED:token]'],
  [/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, `$1${MASK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${MASK}@`],
  [/(\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
];

function maskSecrets(text: string): string {
  let masked = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) masked = masked.replace(pattern, replacement);
  return masked;
}

function capLine(line: string): string {
  return line.length <= LOG_TAIL_MAX_LINE_CHARS ? line : `${line.slice(0, LOG_TAIL_MAX_LINE_CHARS - 1)}…`;
}

/** The last build log lines safe to show next to an error: text only, masked, length-capped. */
export function guardLogTail(text: string | null | undefined): readonly string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const all = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').split('\n');
  while (all.length > 0 && (all.at(-1) ?? '').trim() === '') all.pop();
  if (all.length === 0) return [];
  // A few extra lines of context so a private key whose BEGIN line is just outside is still caught.
  const window = all.slice(-LOG_TAIL_MAX_LINES * 2).join('\n');
  const lines = maskSecrets(window).split('\n').slice(-LOG_TAIL_MAX_LINES).map(capLine);
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  while (lines.length > 0 && total > LOG_TAIL_MAX_CHARS) total -= (lines.shift()?.length ?? 0) + 1;
  return lines;
}
