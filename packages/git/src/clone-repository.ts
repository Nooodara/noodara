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
  validateCommitSha,
  type CommitSha,
  type DeployWorkspace,
  type ServiceSource,
} from '@noodara/domain/validators';
import {
  ASKPASS_SCRIPT_CONTENT,
  classifyGitError,
  gitClone,
  gitHeadSha,
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
  readonly limits: StepLimits;
  readonly signal?: AbortSignal;
  /** Redacted output of every step, for the deployment log. */
  readonly onChunk?: (chunk: StreamChunk) => void;
}

export interface ClonedRepository {
  readonly commitSha: CommitSha;
}

type GitOperation = 'clone' | 'checkout' | 'rev_parse';

/** Pinning host keys is not part of v0.2: ssh runs with StrictHostKeyChecking=accept-new. */
const EMPTY_KNOWN_HOSTS = secretValue('', 'ssh_private_key');
/** Not secret, but `secrets.write_askpass` reads stdin as a secret. */
const ASKPASS_SCRIPT = secretValue(ASKPASS_SCRIPT_CONTENT, 'api_key');

interface CredentialPlan {
  readonly writes: readonly {
    readonly command: RemoteCommand;
    readonly stdin: SecretValue;
  }[];
  readonly auth: Parameters<typeof gitClone>[0]['auth'];
  readonly secrets: readonly SecretValue[];
}

function credentialPlan(workspace: DeployWorkspace, credential: GitCredential): CredentialPlan {
  switch (credential.kind) {
    case 'none':
      return { writes: [], auth: { kind: 'none' }, secrets: [] };
    case 'deploy_key': {
      const keyFile = workspace.secretFile('deploy_key');
      const knownHostsFile = workspace.secretFile('known_hosts');
      return {
        writes: [
          { command: writeSecretFile(keyFile), stdin: credential.privateKey },
          {
            command: writeSecretFile(knownHostsFile),
            stdin: EMPTY_KNOWN_HOSTS,
          },
        ],
        auth: { kind: 'deploy_key', keyFile, knownHostsFile },
        secrets: [credential.privateKey],
      };
    }
    case 'https_token':
      // The helper has its own <ws>/secrets/askpass slot (writeAskpassFile(workspace)); measured
      // end to end over HTTPS in ADR 0008 open item 4.
      return {
        writes: [
          { command: writeSecretFile(workspace.secretFile('https_token')), stdin: credential.token },
          { command: writeAskpassFile(workspace), stdin: ASKPASS_SCRIPT },
        ],
        auth: { kind: 'https_token', workspace },
        secrets: [credential.token, ASKPASS_SCRIPT],
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

export async function cloneRepository(
  input: CloneRepositoryInput,
): Promise<StepResult<ClonedRepository>> {
  const { redactor, workspace } = input;
  const plan = credentialPlan(workspace, input.credential);
  const context: StepContext = {
    session: input.session,
    limits: input.limits,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onChunk === undefined ? {} : { onChunk: input.onChunk }),
  };
  const release = registerSecrets(redactor, plan.secrets);
  try {
    const prepared = await runStep(context, prepareWorkspace(workspace));
    if (prepared.kind !== 'completed') return notCompleted(prepared);
    if (prepared.result.exitCode !== 0) return classifyCommand(redactor, 'clone', prepared.result);

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

    return { ok: true, value: { commitSha: sha.value }, result: cloned.result };
  } finally {
    release();
  }
}
