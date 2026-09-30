import {
  deployWorkspaceFor,
  validateCommitSha,
  validateGitBranch,
  validateRepositoryUrl,
  type CommitSha,
  type DeployRepoPath,
  type DeploySecretPath,
  type DeployWorkspace,
  type GitBranch,
  type RepositoryUrl,
  type ValidationResult,
} from '@noodara/domain/validators';
import { describe, expect, it } from 'vitest';
import { ADVERSARIAL_VALUES, shellWords } from '../testing/shell-round-trip.js';
import { gitCheckout, gitClone, gitHeadSha, gitProbeFeatures } from './git.js';
import { renderRemoteCommand } from './remote-command.js';
import { SHELL_SCRIPTS } from './shell-scripts.js';

function valid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.code}`);
  return result.value;
}

const DEPLOYMENT_ID = '0b5c2f7e-3c1d-4d8e-9a6b-1f2e3d4c5b6a';
const ws: DeployWorkspace = valid(deployWorkspaceFor(DEPLOYMENT_ID));
const url = valid(validateRepositoryUrl('git@github.com:noodara/node-api.git'));
const branch = valid(validateGitBranch('release/v1'));
const sha = valid(validateCommitSha('0123456789abcdef0123456789abcdef01234567'));

const GIT_PREAMBLE = [
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
];

describe('gitClone', () => {
  it('deploy_key: env GIT_SSH_COMMAND with the key and known_hosts paths quoted for the inner shell', () => {
    const command = gitClone({
      url,
      branch,
      target: ws.repo,
      auth: {
        kind: 'deploy_key',
        keyFile: ws.secretFile('deploy_key'),
        knownHostsFile: ws.secretFile('known_hosts'),
      },
    });

    expect(command.name).toBe('git.clone');
    expect(command.stdin).toBe('none');
    expect(command.supervisable).toBe(true);
    expect(command.argv).toEqual([
      'env',
      `GIT_SSH_COMMAND=ssh -i '${ws.secretsDir}/deploy_key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='${ws.secretsDir}/known_hosts'`,
      'GIT_TERMINAL_PROMPT=0',
      ...GIT_PREAMBLE,
      branch,
      '--',
      url,
      ws.repo,
    ]);
  });

  it('https_token: env GIT_ASKPASS plus the token file path, never the token itself', () => {
    const command = gitClone({
      url: valid(validateRepositoryUrl('https://github.com/noodara/node-api.git')),
      branch,
      target: ws.repo,
      auth: {
        kind: 'https_token',
        askpassFile: ws.secretFile('https_token'),
        tokenFile: ws.secretFile('https_token'),
      },
    });

    expect(command.argv.slice(0, 4)).toEqual([
      'env',
      `GIT_ASKPASS=${ws.secretsDir}/https_token`,
      `NOODARA_ASKPASS_TOKEN_FILE=${ws.secretsDir}/https_token`,
      'GIT_TERMINAL_PROMPT=0',
    ]);
    expect(command.argv.join(' ')).not.toContain('GIT_SSH_COMMAND');
  });

  it('none: no GIT_SSH_COMMAND and no GIT_ASKPASS', () => {
    const command = gitClone({ url, branch, target: ws.repo, auth: { kind: 'none' } });

    expect(command.argv).toEqual([
      'env',
      'GIT_TERMINAL_PROMPT=0',
      ...GIT_PREAMBLE,
      branch,
      '--',
      url,
      ws.repo,
    ]);
  });

  it('has no parameter that could carry a secret value (auth carries paths only)', () => {
    expect(gitClone.length).toBe(1);
  });

  it.each(ADVERSARIAL_VALUES)(
    'round-trips a force-cast adversarial value %j as literal words, in the inner ssh shell too',
    (value) => {
      const command = gitClone({
        url: value as RepositoryUrl,
        branch: value as GitBranch,
        target: value as DeployRepoPath,
        auth: {
          kind: 'deploy_key',
          keyFile: value as DeploySecretPath,
          knownHostsFile: value as DeploySecretPath,
        },
      });

      const words = shellWords(renderRemoteCommand(command));
      expect(words).toEqual(command.argv);

      // git hands GIT_SSH_COMMAND to sh: the key path must survive that second parse too.
      const sshCommand = (words[1] ?? '').slice('GIT_SSH_COMMAND='.length);
      expect(shellWords(sshCommand)).toEqual([
        'ssh',
        '-i',
        value,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${value}`,
      ]);
    },
  );
});

describe('gitCheckout', () => {
  it('detaches at the sha with -- after it', () => {
    const command = gitCheckout(ws.repo, sha);

    expect(command.name).toBe('git.checkout');
    expect(command.argv).toEqual(['git', '-C', ws.repo, 'checkout', '--detach', sha, '--']);
    expect(command.supervisable).toBe(false);
  });

  it.each(ADVERSARIAL_VALUES)('round-trips %j as literal words', (value) => {
    const command = gitCheckout(value as DeployRepoPath, value as CommitSha);

    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
  });
});

describe('gitHeadSha', () => {
  it('is rev-parse HEAD in the repo', () => {
    const command = gitHeadSha(ws.repo);

    expect(command.name).toBe('git.head_sha');
    expect(command.argv).toEqual(['git', '-C', ws.repo, 'rev-parse', 'HEAD']);
  });
});

describe('gitProbeFeatures', () => {
  it('runs the constant probe script with the repo as $0', () => {
    const command = gitProbeFeatures(ws.repo);

    expect(command.name).toBe('git.probe_features');
    expect(command.argv).toEqual(['sh', '-c', SHELL_SCRIPTS.probeFeatures, ws.repo]);
  });

  it.each(ADVERSARIAL_VALUES)('round-trips %j as literal words', (value) => {
    const command = gitProbeFeatures(value as DeployRepoPath);

    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
  });
});
