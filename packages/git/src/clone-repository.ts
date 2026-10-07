// cloneRepository (11-15, DEP-08, D-09, D14, ADR 0008 G1): prepare the workspace, write the
// credential over stdin, run a supervised shallow clone, read the head SHA, probe for LFS and
// submodules. Every remote command comes from an @noodara/ssh builder; secrets reach the server
// only on stdin and are registered with the session's redactor for the whole call.
import {
  parseRepositoryFeatureProbe,
  type RepositoryFeatureProbeResult,
} from '@noodara/domain/deployment';
import { secretValue, type Redactor, type SecretValue } from '@noodara/domain/security';
import {
  bundledGitHostKeysFor,
  gitSshEndpoint,
  knownHostsContent,
  parseKeyscanOutput,
  sameKnownHostsHost,
  validateCommitSha,
  type CommitSha,
  type DeployWorkspace,
  type GitHostKey,
  type GitSshEndpoint,
  type ServiceSource,
} from '@noodara/domain/validators';
import {
  ASKPASS_SCRIPT_CONTENT,
  classifyGitError,
  gitClone,
  gitHeadSha,
  gitKeyscan,
  gitProbeFeatures,
  prepareWorkspace,
  supervise,
  writeAskpassFile,
  writeSecretFile,
  type RemoteCommand,
  type SshDeploySession,
  type StreamChunk,
  type StreamResult,
} from '@noodara/ssh';
import { notCompleted, registerSecrets, runStep, type StepContext } from './run-step.js';
import type { StepLimits, StepResult } from './step-result.js';

/** The decrypted credential, as a SecretValue: never a bare string (SEC-01). */
export type GitCredential =
  | { readonly kind: 'none' }
  | { readonly kind: 'deploy_key'; readonly privateKey: SecretValue }
  | { readonly kind: 'https_token'; readonly token: SecretValue };

export interface CloneRepositoryInput {
  readonly session: SshDeploySession;
  /** The redactor the session was connected with, so streamed output is scrubbed of the secret. */
  readonly redactor: Redactor;
  readonly workspace: DeployWorkspace;
  readonly source: Extract<ServiceSource, { kind: 'git' }>;
  readonly credential: GitCredential;
  /**
   * Host keys the caller trusts for this repository (14-07 persists the scanned ones per service).
   * Only keys for the URL's own `host` / `[host]:port` are used; bundled published keys win.
   */
  readonly pinnedHostKeys?: readonly GitHostKey[];
  readonly limits: StepLimits;
  readonly signal?: AbortSignal;
  /** Redacted output of every step, for the deployment log. */
  readonly onChunk?: (chunk: StreamChunk) => void;
}

/** Where the keys the clone was pinned to came from; `none` for an https URL. */
export type HostKeySource = 'bundled' | 'pinned' | 'scanned' | 'none';

export interface ClonedRepository {
  readonly commitSha: CommitSha;
  /** The host keys the clone was pinned to, for the caller to persist (14-07). */
  readonly hostKeys: readonly GitHostKey[];
  readonly hostKeySource: HostKeySource;
}

type GitOperation = 'clone' | 'checkout' | 'rev_parse';

/** ssh-keyscan already stops each connection after GIT_KEYSCAN_TIMEOUT_SECONDS; these cap the step. */
const KEYSCAN_LIMITS: StepLimits = {
  maxDurationMs: 30_000,
  idleTimeoutMs: 20_000,
  maxTotalBytes: 64 * 1024,
  maxLineBytes: 16_384,
};
const HOST_KEY_UNAVAILABLE_MESSAGE =
  "Noodara could not read the Git host's SSH host key, so the clone was not started. Check that the host is reachable over SSH from the server, then redeploy.";
/** Not secret, but `secrets.write_askpass` reads stdin as a secret. */
const ASKPASS_SCRIPT = secretValue(ASKPASS_SCRIPT_CONTENT, 'api_key');

interface CredentialPlan {
  readonly writes: readonly {
    readonly command: RemoteCommand;
    readonly stdin: SecretValue;
  }[];
  readonly auth: Parameters<typeof gitClone>[0]['auth'];
}

interface ResolvedHostKeys {
  readonly keys: readonly GitHostKey[];
  readonly source: HostKeySource;
}

/**
 * known_hosts is not secret, but `secrets.write_file` reads stdin as a SecretValue. It is never
 * registered with the redactor: the content is built only from re-validated key parts.
 */
function knownHostsWrite(workspace: DeployWorkspace, keys: readonly GitHostKey[]) {
  const knownHostsFile = workspace.secretFile('known_hosts');
  return {
    knownHostsFile,
    write: {
      command: writeSecretFile(knownHostsFile),
      stdin: secretValue(knownHostsContent(keys), 'ssh_private_key'),
    },
  };
}

function credentialPlan(
  workspace: DeployWorkspace,
  credential: GitCredential,
  hostKeys: ResolvedHostKeys,
): CredentialPlan {
  switch (credential.kind) {
    case 'none': {
      if (hostKeys.source === 'none') return { writes: [], auth: { kind: 'none' } };
      const { knownHostsFile, write } = knownHostsWrite(workspace, hostKeys.keys);
      return { writes: [write], auth: { kind: 'none', knownHostsFile } };
    }
    case 'deploy_key': {
      const keyFile = workspace.secretFile('deploy_key');
      const { knownHostsFile, write } = knownHostsWrite(workspace, hostKeys.keys);
      return {
        writes: [{ command: writeSecretFile(keyFile), stdin: credential.privateKey }, write],
        auth: { kind: 'deploy_key', keyFile, knownHostsFile },
      };
    }
    case 'https_token':
      // The helper has its own <ws>/secrets/askpass slot (writeAskpassFile(workspace)); measured
      // end to end over HTTPS in ADR 0008 open item 4.
      return {
        writes: [
          {
            command: writeSecretFile(workspace.secretFile('https_token')),
            stdin: credential.token,
          },
          { command: writeAskpassFile(workspace), stdin: ASKPASS_SCRIPT },
        ],
        auth: { kind: 'https_token', workspace },
      };
  }
}

function classifyCommand(
  redactor: Redactor,
  operation: GitOperation,
  result: StreamResult,
  exitCode: number | null = result.exitCode,
): StepResult<never> {
  const classification = classifyGitError(
    {
      kind: 'command',
      operation,
      failure: {
        exitCode,
        stderr: result.stderrTail,
        stdoutTail: result.stdoutTail,
      },
    },
    { redactor },
  );
  return { ok: false, kind: 'failed', ...classification };
}

function classifyProbe(redactor: Redactor, probe: RepositoryFeatureProbeResult): StepResult<never> {
  const classification = classifyGitError({ kind: 'feature_probe', result: probe }, { redactor });
  return { ok: false, kind: 'failed', ...classification };
}

function readProbe(outcome: {
  result: StreamResult;
  stdout: string;
}): RepositoryFeatureProbeResult {
  const { result, stdout } = outcome;
  if (result.truncated) return { kind: 'unparseable', reason: 'Probe output was truncated' };
  if (result.exitCode === null)
    return { kind: 'unparseable', reason: 'Probe ended without an exit code' };
  return parseRepositoryFeatureProbe({
    stdout,
    stderr: result.stderrTail,
    exitCode: result.exitCode,
  });
}

function credentialSecrets(credential: GitCredential): readonly SecretValue[] {
  switch (credential.kind) {
    case 'none':
      return [];
    case 'deploy_key':
      return [credential.privateKey];
    case 'https_token':
      return [credential.token, ASKPASS_SCRIPT];
  }
}

function hostKeyUnavailable(): StepResult<never> {
  return {
    ok: false,
    kind: 'failed',
    code: 'GIT_HOST_KEY_UNAVAILABLE',
    message: HOST_KEY_UNAVAILABLE_MESSAGE,
  };
}

function capLimits(caller: StepLimits): StepLimits {
  return {
    maxDurationMs: Math.min(caller.maxDurationMs, KEYSCAN_LIMITS.maxDurationMs),
    idleTimeoutMs: Math.min(caller.idleTimeoutMs, KEYSCAN_LIMITS.idleTimeoutMs),
    maxTotalBytes: Math.min(caller.maxTotalBytes, KEYSCAN_LIMITS.maxTotalBytes),
    maxLineBytes: Math.min(caller.maxLineBytes, KEYSCAN_LIMITS.maxLineBytes),
  };
}

/**
 * A2/A3/H3: bundled published keys, then the caller's pinned keys for this exact endpoint, then
 * one bounded ssh-keyscan whose untrusted output is filtered to the endpoint's own key lines.
 * No key means no clone: the result is GIT_HOST_KEY_UNAVAILABLE, never an unpinned connection.
 */
async function resolveHostKeys(
  context: StepContext,
  input: CloneRepositoryInput,
): Promise<HostKeyResolution> {
  const endpoint = gitSshEndpoint(input.source.repositoryUrl);
  if (endpoint === null) return resolved({ keys: [], source: 'none' });
  const bundled = bundledGitHostKeysFor(endpoint);
  if (bundled.length > 0) return resolved({ keys: bundled, source: 'bundled' });
  const pinned = (input.pinnedHostKeys ?? []).filter((key) =>
    sameKnownHostsHost(key.host, endpoint.knownHostsHost),
  );
  if (pinned.length > 0) return resolved({ keys: pinned, source: 'pinned' });
  return scanHostKeys(context, endpoint);
}

type StepFailure = Exclude<StepResult<never>, { ok: true }>;
type HostKeyResolution = { readonly ok: true; readonly value: ResolvedHostKeys } | StepFailure;

function resolved(value: ResolvedHostKeys): HostKeyResolution {
  return { ok: true, value };
}

async function scanHostKeys(
  context: StepContext,
  endpoint: GitSshEndpoint,
): Promise<HostKeyResolution> {
  const scanned = await runStep(
    { ...context, limits: capLimits(context.limits) },
    gitKeyscan(endpoint),
  );
  if (scanned.kind === 'transport') return notCompleted(scanned);
  if (scanned.kind === 'interrupted') {
    return scanned.outcome === 'aborted' ? notCompleted(scanned) : hostKeyUnavailable();
  }
  if (scanned.result.exitCode !== 0 || scanned.result.truncated) return hostKeyUnavailable();
  const keys = parseKeyscanOutput(scanned.stdout, endpoint);
  if (keys.length === 0) return hostKeyUnavailable();
  return resolved({ keys, source: 'scanned' });
}

export async function cloneRepository(
  input: CloneRepositoryInput,
): Promise<StepResult<ClonedRepository>> {
  const { redactor, workspace } = input;
  const context: StepContext = {
    session: input.session,
    limits: input.limits,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onChunk === undefined ? {} : { onChunk: input.onChunk }),
  };
  // Registered before the first step, so no output can ever carry the credential unredacted.
  const release = registerSecrets(redactor, credentialSecrets(input.credential));
  try {
    const prepared = await runStep(context, prepareWorkspace(workspace));
    if (prepared.kind !== 'completed') return notCompleted(prepared);
    if (prepared.result.exitCode !== 0) return classifyCommand(redactor, 'clone', prepared.result);

    const hostKeys = await resolveHostKeys(context, input);
    if (!hostKeys.ok) return hostKeys;
    const plan = credentialPlan(workspace, input.credential, hostKeys.value);

    for (const write of plan.writes) {
      const written = await runStep(context, write.command, write.stdin);
      if (written.kind !== 'completed') return notCompleted(written);
      if (written.result.exitCode !== 0) return classifyCommand(redactor, 'clone', written.result);
    }

    const clone = supervise(
      workspace.pidFile('clone'),
      gitClone({
        url: input.source.repositoryUrl,
        branch: input.source.branch,
        target: workspace.repo,
        auth: plan.auth,
      }),
    );
    const cloned = await runStep(context, clone);
    if (cloned.kind !== 'completed') return notCompleted(cloned);
    if (cloned.result.exitCode !== 0) return classifyCommand(redactor, 'clone', cloned.result);

    const head = await runStep(context, gitHeadSha(workspace.repo));
    if (head.kind !== 'completed') return notCompleted(head);
    if (head.result.exitCode !== 0) return classifyCommand(redactor, 'rev_parse', head.result);
    const sha = head.result.truncated ? undefined : validateCommitSha(head.stdout.trim());
    if (!sha?.ok) return classifyCommand(redactor, 'rev_parse', head.result, null);

    const probed = await runStep(context, gitProbeFeatures(workspace.repo));
    if (probed.kind !== 'completed') return notCompleted(probed);
    const probe = readProbe(probed);
    if (probe.kind !== 'supported') return classifyProbe(redactor, probe);

    return {
      ok: true,
      value: {
        commitSha: sha.value,
        hostKeys: hostKeys.value.keys,
        hostKeySource: hostKeys.value.source,
      },
      result: cloned.result,
    };
  } finally {
    release();
  }
}
