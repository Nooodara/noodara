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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSshEndpoint, type GitSshEndpoint } from '@noodara/domain/validators';
import { gitCheckout, gitClone, gitHeadSha, gitKeyscan, gitProbeFeatures } from './git.js';
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
  '-c',
  'credential.helper=',
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
      `GIT_SSH_COMMAND=ssh -i '${ws.secretsDir}/deploy_key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${ws.secretsDir}/known_hosts'`,
      'GIT_TERMINAL_PROMPT=0',
      ...GIT_PREAMBLE,
      branch,
      '--',
      url,
      ws.repo,
    ]);
  });

  it('https_token: env GIT_ASKPASS at the askpass slot plus the token file path, never the token itself', () => {
    const httpsUrl = valid(validateRepositoryUrl('https://github.com/noodara/node-api.git'));
    const command = gitClone({
      url: httpsUrl,
      branch,
      target: ws.repo,
      auth: { kind: 'https_token', workspace: ws },
    });

    expect(command.argv).toEqual([
      'env',
      `GIT_ASKPASS=${ws.secretsDir}/askpass`,
      `NOODARA_ASKPASS_TOKEN_FILE=${ws.secretsDir}/https_token`,
      'GIT_TERMINAL_PROMPT=0',
      ...GIT_PREAMBLE,
      branch,
      '--',
      httpsUrl,
      ws.repo,
    ]);
    expect(command.argv.join(' ')).not.toContain('GIT_SSH_COMMAND');
    expect(command.argv.join(' ')).not.toContain(`${ws.secretsDir}/known_hosts`);
  });

  it('https_token: refuses a forged workspace, since git executes the askpass path', () => {
    expect(() =>
      gitClone({
        url,
        branch,
        target: ws.repo,
        auth: { kind: 'https_token', workspace: { ...ws, secretsDir: '/usr/bin' as DeploySecretPath } },
      }),
    ).toThrow(/workspace/);
  });

  it('resets every configured credential helper, so no helper can persist the token', () => {
    for (const auth of [
      { kind: 'none' } as const,
      { kind: 'https_token', workspace: ws } as const,
    ]) {
      const argv = gitClone({ url, branch, target: ws.repo, auth }).argv;
      const clone = argv.indexOf('clone');
      const at = argv.indexOf('credential.helper=');
      expect(at).toBeGreaterThan(0);
      expect(argv[at - 1]).toBe('-c');
      expect(at).toBeLessThan(clone);
    }
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

  it('none with a known_hosts file: strict host key checking without an identity (A2)', () => {
    const command = gitClone({
      url,
      branch,
      target: ws.repo,
      auth: { kind: 'none', knownHostsFile: ws.secretFile('known_hosts') },
    });

    expect(command.argv.slice(0, 3)).toEqual([
      'env',
      `GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${ws.secretsDir}/known_hosts'`,
      'GIT_TERMINAL_PROMPT=0',
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
        'StrictHostKeyChecking=yes',
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

function endpoint(input: string): GitSshEndpoint {
  const parsed = gitSshEndpoint(valid(validateRepositoryUrl(input)));
  if (!parsed) throw new Error(`no ssh endpoint for ${input}`);
  return parsed;
}

describe('gitKeyscan (A3, H3)', () => {
  it('scans one host on its port with an explicit timeout and only the accepted key types', () => {
    const command = gitKeyscan(endpoint('ssh://git@git.example.com:2222/org/repo.git'));

    expect(command.name).toBe('git.keyscan');
    expect(command.stdin).toBe('none');
    expect(command.supervisable).toBe(false);
    expect(command.argv).toEqual([
      'ssh-keyscan',
      '-T',
      '10',
      '-t',
      'ed25519,ecdsa,rsa',
      '-p',
      '2222',
      '--',
      'git.example.com',
    ]);
  });

  it('uses port 22 and the normalized host for an scp-like URL', () => {
    const command = gitKeyscan(endpoint('git@Git.Example.com:org/repo.git'));

    expect(command.argv.slice(-4)).toEqual(['-p', '22', '--', 'git.example.com']);
  });

  it.each(ADVERSARIAL_VALUES)('round-trips a force-cast adversarial host %j as one literal word', (value) => {
    const command = gitKeyscan({ host: value, port: 22, knownHostsHost: value } as unknown as GitSshEndpoint);

    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
    expect(command.argv.at(-1)).toBe(value);
    expect(command.argv.at(-2)).toBe('--');
  });
});

describe('no trust-on-first-use without pinning (A2)', () => {
  const FORBIDDEN = ['accept', 'new'].join('-');
  const packagesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx|js|mjs|md|sh|txt)$/.test(entry.name) ? [path] : [];
    });
  }

  it(`no file under packages/ mentions StrictHostKeyChecking=${FORBIDDEN}`, () => {
    const offenders = sourceFiles(packagesRoot).filter((file) => readFileSync(file, 'utf8').includes(FORBIDDEN));

    expect(offenders).toEqual([]);
  });
});
