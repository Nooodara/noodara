// The git failure -> DeploymentErrorCode table (DEP-08, QA-10, D-09). Same three-layer defense
// as classifySshError: safe field reads, per-rule try/catch, and an outer try/catch. Every
// capture in fixtures/deploy-errors exits 128 on git 2.34 and 2.43, so rules key on stderr text,
// never on the exit code. Messages are fixed templates (plus parsed numbers) and never echo
// remote output (T-11-29).
import {
  REPOSITORY_FEATURES,
  unsupportedRepositoryFeatureError,
  type DeploymentErrorCode,
  type RepositoryFeature,
  type RepositoryFeatureProbeResult,
} from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';

export interface RemoteFailure {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdoutTail: string;
}

export type GitFailureInput =
  | {
      readonly kind: 'command';
      readonly operation: 'clone' | 'checkout' | 'rev_parse';
      readonly failure: RemoteFailure;
    }
  | { readonly kind: 'feature_probe'; readonly result: RepositoryFeatureProbeResult };

export interface ClassifyDeploymentContext {
  readonly redactor: Redactor;
}

export interface DeploymentFailureClassification {
  readonly code: DeploymentErrorCode;
  readonly message: string;
}

export interface DeploymentClassificationRule<Input> {
  readonly name: string;
  readonly code: DeploymentErrorCode;
  readonly matches: (input: Input) => boolean;
  readonly message: (input: Input) => string;
}

/** Reads `value[key]` without ever throwing; a hostile getter yields `undefined`. */
export function safeField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The failure's stderr, or '' when absent, non-string or unreadable. */
export function safeStderr(input: unknown): string {
  const stderr = safeField(safeField(input, 'failure'), 'stderr');
  return typeof stderr === 'string' ? stderr : '';
}

/** The failure's exit code when it is a plausible process exit code, else undefined. */
export function safeExitCode(input: unknown): number | undefined {
  const exitCode = safeField(safeField(input, 'failure'), 'exitCode');
  return typeof exitCode === 'number' &&
    Number.isInteger(exitCode) &&
    exitCode >= 0 &&
    exitCode <= 255
    ? exitCode
    : undefined;
}

/** Copies an `unsupported` probe's features into a fresh, validated array; [] on anything else. */
function unsupportedFeatures(input: unknown): RepositoryFeature[] {
  if (safeField(input, 'kind') !== 'feature_probe') return [];
  const result = safeField(input, 'result');
  if (safeField(result, 'kind') !== 'unsupported') return [];
  const features = safeField(result, 'features');
  if (!Array.isArray(features)) return [];
  return REPOSITORY_FEATURES.filter((feature) => features.includes(feature));
}

function isCommand(input: unknown): boolean {
  return safeField(input, 'kind') === 'command';
}

function stderrMatches(input: unknown, pattern: RegExp): boolean {
  return isCommand(input) && pattern.test(safeStderr(input));
}

// Markers measured in fixtures/deploy-errors/README.md, plus GitHub/HTTPS equivalents.
const AUTH_FAILED_PATTERN =
  /Permission denied \(publickey[,)]|Authentication failed for '|could not read Username for '/;
const HOST_UNREACHABLE_PATTERN =
  /Could not resolve hostname |Could not resolve host: |ssh: connect to host \S+ port \d+: (?:Connection refused|Connection timed out|No route to host|Network is unreachable)/;
const REPOSITORY_NOT_FOUND_PATTERN =
  /does not appear to be a git repository|ERROR: Repository not found\.|remote: Repository not found\./;
const BRANCH_NOT_FOUND_PATTERN = /Remote branch \S+ not found in upstream origin/;
const DISK_FULL_PATTERN = /No space left on device/;
const HOST_KEY_MISMATCH_PATTERN =
  /REMOTE HOST IDENTIFICATION HAS CHANGED!|Host key verification failed\.|host key is known for \S+ and you have requested strict checking/;

/**
 * Ordered, frozen rule table. The feature-probe rule is structured and comes first (D-09);
 * disk-full precedes the repository rules because it is an infrastructure cause; the terminal
 * fallback is a visible named entry, never an implicit else.
 */
export const GIT_ERROR_CLASSIFICATION_RULES: readonly DeploymentClassificationRule<GitFailureInput>[] =
  Object.freeze([
    {
      name: 'unsupported-repository-feature',
      code: 'UNSUPPORTED_REPOSITORY_FEATURE',
      matches: (input) => unsupportedFeatures(input).length > 0,
      message: (input) => unsupportedRepositoryFeatureError(unsupportedFeatures(input)).message,
    },
    {
      name: 'disk-full',
      code: 'DISK_FULL',
      matches: (input) => stderrMatches(input, DISK_FULL_PATTERN),
      message: () =>
        'The server ran out of disk space while fetching the repository. Free disk space on the server, then redeploy.',
    },
    {
      // 14-06: StrictHostKeyChecking=yes refused the host (changed key, or no pinned key of the
      // offered type). Before auth: ssh never authenticates to an unverified host.
      name: 'git-host-key-mismatch',
      code: 'GIT_HOST_KEY_MISMATCH',
      matches: (input) => stderrMatches(input, HOST_KEY_MISMATCH_PATTERN),
      message: () =>
        "The Git host's SSH host key does not match the pinned key, so the clone was stopped. Verify the host's published key fingerprint before trusting a new key, then redeploy.",
    },
    {
      name: 'repository-auth-failed',
      code: 'REPOSITORY_AUTH_FAILED',
      matches: (input) => stderrMatches(input, AUTH_FAILED_PATTERN),
      message: () =>
        "The Git host rejected the deploy key. Add the deploy key shown in Noodara to the repository's deploy keys, then redeploy.",
    },
    {
      name: 'repository-host-unreachable',
      code: 'REPOSITORY_HOST_UNREACHABLE',
      matches: (input) => stderrMatches(input, HOST_UNREACHABLE_PATTERN),
      message: () =>
        "The server could not reach the Git host. Check the repository URL hostname and the server's DNS and outbound network access.",
    },
    {
      name: 'repository-not-found',
      code: 'REPOSITORY_NOT_FOUND',
      matches: (input) => stderrMatches(input, REPOSITORY_NOT_FOUND_PATTERN),
      message: () =>
        'The repository was not found on the Git host. Check the repository URL and that the deploy key has access to it.',
    },
    {
      name: 'branch-not-found',
      code: 'BRANCH_NOT_FOUND',
      matches: (input) => stderrMatches(input, BRANCH_NOT_FOUND_PATTERN),
      message: () =>
        'The configured branch does not exist in the repository. Check the branch name in the service settings, then redeploy.',
    },
    {
      // Terminal fallback (a decision, not a gap): anything unrecognised, including a supported
      // or unparseable feature probe, is a generic clone failure. Only the parsed exit code is
      // included.
      name: 'unclassified-fallback',
      code: 'CLONE_FAILED',
      matches: () => true,
      message: (input) => {
        const exitCode = safeExitCode(input);
        const detail = exitCode === undefined ? '' : ` (git exited with code ${String(exitCode)})`;
        return `Fetching the repository failed${detail}. Check the repository URL, branch and deploy key, then redeploy.`;
      },
    },
  ]);

const SAFE_FALLBACK_MESSAGE =
  'Fetching the repository failed. Check the repository URL, branch and deploy key, then redeploy.';

/** Classifies a git failure into the closed vocabulary. Never throws. */
export function classifyGitError(
  input: GitFailureInput,
  context: ClassifyDeploymentContext,
): DeploymentFailureClassification {
  try {
    for (const rule of GIT_ERROR_CLASSIFICATION_RULES) {
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
    return { code: 'CLONE_FAILED', message: context.redactor.redact(SAFE_FALLBACK_MESSAGE) };
  } catch {
    return { code: 'CLONE_FAILED', message: SAFE_FALLBACK_MESSAGE };
  }
}
