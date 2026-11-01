// 13-13: user-facing copy for a failed deployment. The server's `errorMessage` is never shown:
// the UI renders only the classified copy for `errorCode` (title + what to do) and, when present,
// a guarded tail of the build log. `DEPLOYMENT_ERROR_COPY` is typed as a full Record over the
// domain codes, so adding a code without copy fails typecheck and deploy-error-copy.test.ts.
import type { DeploymentErrorCode } from '@noodara/domain/deployment';

/** Every domain deployment error code; the v0.4 ones joined DEPLOYMENT_ERROR_CODES with migration 0014 (21-06). */
export type DeploymentErrorCopyCode = DeploymentErrorCode;

export interface DeploymentErrorCopy {
  readonly title: string;
  readonly recovery: string;
}

export const DEPLOYMENT_ERROR_COPY: Readonly<Record<DeploymentErrorCopyCode, DeploymentErrorCopy>> = Object.freeze({
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
  GIT_HOST_KEY_MISMATCH: {
    title: 'Git host key changed',
    recovery: "The Git host's SSH key does not match the pinned key. Verify the host's published key fingerprint before trusting it, then deploy again.",
  },
  GIT_HOST_KEY_UNAVAILABLE: {
    title: 'Git host key unavailable',
    recovery: "The server could not read the Git host's SSH key. Check the repository hostname and port and the server's outbound network, then deploy again.",
  },
  UNSUPPORTED_REPOSITORY_FEATURE: {
    title: 'Unsupported repository feature',
    recovery: 'Git LFS and submodules are not supported yet. Remove them from the build or deploy from an image.',
  },
  CLONE_FAILED: {
    title: 'Clone failed',
    recovery: 'Check the build log for the Git error, then deploy again.',
  },
  COMMIT_NOT_FOUND: {
    title: 'Commit not found',
    recovery: 'Check that the commit still exists on the configured branch, then deploy again.',
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
  HEALTHCHECK_FAILED: {
    title: 'Health check failed',
    recovery: 'Check the runtime logs and the health check settings of the service, then deploy again.',
  },
  HEALTHCHECK_TIMEOUT: {
    title: 'Health check timed out',
    recovery: 'Check that the app becomes healthy within the health check timeout, or raise the timeout, then deploy again.',
  },
  ROLLBACK_FAILED: {
    title: 'Rollback failed',
    recovery: 'The previous version could not be restored. Check the server and the runtime logs, then deploy again.',
  },
  ROLLBACK_TARGET_UNAVAILABLE: {
    title: 'Rollback target unavailable',
    recovery: 'The image of that deployment is no longer on the server. Choose another successful deployment or deploy again.',
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
  ENQUEUE_FAILED: {
    title: 'Deploy never started',
    recovery: 'The deployment could not be queued, so nothing ran and the service is unchanged. Deploy again.',
  },
  WORKSPACE_UNAVAILABLE: {
    title: 'Deploy workspace unavailable',
    recovery:
      "Noodara could not write ~/.noodara/deploy on the server. Make sure the SSH user has a home directory it can write to, then deploy again.",
  },
  SECRET_UNRESOLVED: {
    title: 'Secret not found',
    recovery: 'A variable references a secret that does not exist. Add the secret or fix the reference, then deploy again.',
  },
  ENV_INJECTION_FAILED: {
    title: 'Variables not written',
    recovery: 'The environment variables could not be written to the server. Check the server disk and connection, then deploy again.',
  },
  PROXY_ROUTE_FAILED: {
    title: 'Proxy route rejected',
    recovery: 'The proxy did not accept the routes for this service. Check the proxy on the server, then deploy again.',
  },
});

/** Shown for a code this build of the UI does not know (a newer server) or no code at all. */
export const GENERIC_DEPLOYMENT_ERROR_COPY: DeploymentErrorCopy = Object.freeze({
  title: 'Deploy failed',
  recovery: 'Check the build log for details, then deploy again.',
});

// 24-03 A2: what the configure step logged, used to name keys and reference names (never values)
// in the recovery copy of the three v0.4 codes. Every token is re-checked against the domain's
// key/name rules here, so a log line that is not exactly `  KEY` or `  KEY = <secret:name>` is
// dropped, and a value can never be mistaken for a name.
export interface SecretReferenceName {
  readonly key: string;
  readonly secret: string;
}

export interface DeploymentErrorContext {
  readonly keys?: readonly string[];
  readonly references?: readonly SecretReferenceName[];
  readonly hostnames?: readonly string[];
}

export interface ConfigureNames {
  readonly keys: readonly string[];
  readonly references: readonly SecretReferenceName[];
}

export const CONTEXT_ERROR_CODES: ReadonlySet<DeploymentErrorCopyCode> = new Set<DeploymentErrorCopyCode>([
  'SECRET_UNRESOLVED',
  'ENV_INJECTION_FAILED',
  'PROXY_ROUTE_FAILED',
]);

const KEY_TOKEN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SECRET_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const HOSTNAME_TOKEN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONFIGURE_LINE = /^ {2}([A-Z_][A-Z0-9_]{0,127})(?: = <secret:([a-z][a-z0-9_]{0,63})>)?$/;
const MAX_NAMED = 5;

/** Keys and secret references from the configure lines of a deployment's prepare log. */
export function parseConfigureLog(text: string | null | undefined): ConfigureNames {
  if (typeof text !== 'string') return { keys: [], references: [] };
  const keys: string[] = [];
  const references: SecretReferenceName[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const match = CONFIGURE_LINE.exec(line);
    const key = match?.[1];
    if (key === undefined || keys.includes(key)) continue;
    keys.push(key);
    const secret = match?.[2];
    if (secret !== undefined) references.push({ key, secret });
  }
  return { keys, references };
}

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED).join(', ');
  const rest = names.length - MAX_NAMED;
  return rest > 0 ? `${shown} and ${String(rest)} more` : shown;
}

function contextualRecovery(code: DeploymentErrorCopyCode, context: DeploymentErrorContext): string | null {
  if (code === 'SECRET_UNRESOLVED') {
    const refs = (context.references ?? []).filter((ref) => KEY_TOKEN.test(ref.key) && SECRET_TOKEN.test(ref.secret));
    if (refs.length === 0) return null;
    const list = nameList(refs.map((ref) => `${ref.key} → <secret:${ref.secret}>`));
    return `One of these references points to a secret that does not exist or is out of scope: ${list}. Add the secret or fix the reference, then deploy again.`;
  }
  if (code === 'ENV_INJECTION_FAILED') {
    const keys = (context.keys ?? []).filter((key) => KEY_TOKEN.test(key));
    if (keys.length === 0) return null;
    return `The variables ${nameList(keys)} could not be written to the server. Check the server disk and connection, then deploy again.`;
  }
  if (code === 'PROXY_ROUTE_FAILED') {
    const hosts = (context.hostnames ?? []).filter((host) => HOSTNAME_TOKEN.test(host));
    if (hosts.length === 0) return null;
    return `The proxy did not accept the routes for ${nameList(hosts)}. Check the proxy on the server, then deploy again.`;
  }
  return null;
}

/** Total: unknown, empty or prototype-named codes get the generic copy, never undefined. `context`
 *  only changes the recovery of CONTEXT_ERROR_CODES, and only with at least one valid name. */
export function deploymentErrorCopy(code: string | null | undefined, context?: DeploymentErrorContext): DeploymentErrorCopy {
  if (typeof code !== 'string' || !Object.hasOwn(DEPLOYMENT_ERROR_COPY, code)) return GENERIC_DEPLOYMENT_ERROR_COPY;
  const known = code as DeploymentErrorCopyCode;
  const copy = DEPLOYMENT_ERROR_COPY[known];
  if (context === undefined || !CONTEXT_ERROR_CODES.has(known)) return copy;
  const recovery = contextualRecovery(known, context);
  return recovery === null ? copy : { title: copy.title, recovery };
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
