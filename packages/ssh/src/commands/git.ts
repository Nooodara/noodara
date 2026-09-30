// Git deploy templates (SVC-08, D14, ADR 0008 G1). Branded inputs only; every token is escaped by
// renderRemoteCommand. The clone is shallow, never recurses into submodules, runs no hooks and
// allows only the https and ssh transports (defense in depth next to the D-05 URL validator).
// Git exits 128 for every failure class (ADR 0008 G1): callers classify stderr, never the code.
import type {
  CommitSha,
  DeployRepoPath,
  DeploySecretPath,
  GitBranch,
  RepositoryUrl,
} from '@noodara/domain/validators';
import { escapeShellArg } from './allowlist.js';
import { createRemoteCommand, type RemoteCommand } from './remote-command.js';
import { SHELL_SCRIPTS } from './shell-scripts.js';

/** Paths only: no variant can carry a secret value (T-11-35). */
export type GitCloneAuth =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'deploy_key';
      readonly keyFile: DeploySecretPath;
      readonly knownHostsFile: DeploySecretPath;
    }
  | {
      readonly kind: 'https_token';
      readonly askpassFile: DeploySecretPath;
      readonly tokenFile: DeploySecretPath;
    };

export interface GitCloneInput {
  readonly url: RepositoryUrl;
  readonly branch: GitBranch;
  readonly target: DeployRepoPath;
  readonly auth: GitCloneAuth;
}

function authEnv(auth: GitCloneAuth): string[] {
  switch (auth.kind) {
    case 'none':
      return [];
    case 'deploy_key':
      // git evaluates GIT_SSH_COMMAND with sh, so both paths are quoted a second time.
      return [
        `GIT_SSH_COMMAND=ssh -i ${escapeShellArg(auth.keyFile)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${escapeShellArg(auth.knownHostsFile)}`,
      ];
    case 'https_token':
      return [`GIT_ASKPASS=${auth.askpassFile}`, `NOODARA_ASKPASS_TOKEN_FILE=${auth.tokenFile}`];
  }
}

export function gitClone(input: GitCloneInput): RemoteCommand {
  return createRemoteCommand({
    name: 'git.clone',
    argv: [
      'env',
      ...authEnv(input.auth),
      'GIT_TERMINAL_PROMPT=0',
      'git',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'protocol.ssh.allow=always',
      '-c',
      'core.hooksPath=/dev/null',
      'clone',
      '--depth',
      '1',
      '--no-recurse-submodules',
      '--branch',
      input.branch,
      '--',
      input.url,
      input.target,
    ],
    stdin: 'none',
    supervisable: true,
  });
}

export function gitCheckout(repo: DeployRepoPath, sha: CommitSha): RemoteCommand {
  return createRemoteCommand({
    name: 'git.checkout',
    argv: ['git', '-C', repo, 'checkout', '--detach', sha, '--'],
    stdin: 'none',
    supervisable: false,
  });
}

export function gitHeadSha(repo: DeployRepoPath): RemoteCommand {
  return createRemoteCommand({
    name: 'git.head_sha',
    argv: ['git', '-C', repo, 'rev-parse', 'HEAD'],
    stdin: 'none',
    supervisable: false,
  });
}

/** D-09: stdout is `submodules=<0|1>` and `lfs=<0|1>`. */
export function gitProbeFeatures(repo: DeployRepoPath): RemoteCommand {
  return createRemoteCommand({
    name: 'git.probe_features',
    argv: ['sh', '-c', SHELL_SCRIPTS.probeFeatures, repo],
    stdin: 'none',
    supervisable: false,
  });
}
