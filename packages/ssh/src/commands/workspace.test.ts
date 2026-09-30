import {
  deployWorkspaceFor,
  validateGitBranch,
  validateRepositoryUrl,
  type DeployRunPath,
  type DeploySecretPath,
  type DeployWorkspace,
  type ValidationResult,
} from '@noodara/domain/validators';
import { describe, expect, it } from 'vitest';
import { ADVERSARIAL_VALUES, shellWords } from '../testing/shell-round-trip.js';
import { gitCheckout, gitClone } from './git.js';
import { renderRemoteCommand } from './remote-command.js';
import { SHELL_SCRIPTS } from './shell-scripts.js';
import {
  ASKPASS_SCRIPT_CONTENT,
  groupAlive,
  killGroup,
  prepareWorkspace,
  removeDeployDir,
  supervise,
  writeAskpassFile,
  writeSecretFile,
} from './workspace.js';

function valid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.code}`);
  return result.value;
}

const ws: DeployWorkspace = valid(deployWorkspaceFor('0b5c2f7e-3c1d-4d8e-9a6b-1f2e3d4c5b6a'));
const clone = gitClone({
  url: valid(validateRepositoryUrl('git@github.com:noodara/node-api.git')),
  branch: valid(validateGitBranch('main')),
  target: ws.repo,
  auth: { kind: 'none' },
});

const DOLLAR = String.fromCharCode(36);
const BACKTICK = String.fromCharCode(96);

describe('prepareWorkspace', () => {
  it('is the ADR 0008 G1 workspace script with the root as $0', () => {
    const command = prepareWorkspace(ws);

    expect(command.name).toBe('fs.prepare_workspace');
    expect(command.argv).toEqual(['sh', '-c', SHELL_SCRIPTS.prepareWorkspace, ws.root]);
    expect(command.stdin).toBe('none');
  });

  it('creates exactly the secrets and run dirs deployWorkspaceFor names', () => {
    expect(ws.secretsDir).toBe(`${ws.root}/secrets`);
    expect(ws.runDir).toBe(`${ws.root}/run`);
    expect(ws.dockerConfigDir.startsWith(`${ws.secretsDir}/`)).toBe(true);
  });
});

describe('removeDeployDir', () => {
  it('is rm -rf -- <root>', () => {
    const command = removeDeployDir(ws);

    expect(command.name).toBe('fs.remove_deploy_dir');
    expect(command.argv).toEqual(['rm', '-rf', '--', ws.root]);
  });

  it('accepts only a DeployWorkspace, never a raw path', () => {
    // @ts-expect-error a raw "/" is not a DeployWorkspace
    expect(() => removeDeployDir('/')).toThrow();
  });

  it.each(['/', '/opt/noodara-deploy', '/opt/noodara-deploy/', '/home/deployer', ws.repo])(
    'refuses a force-cast root %j outside /opt/noodara-deploy/<uuid> (defense in depth for rm -rf)',
    (root) => {
      expect(() => removeDeployDir({ ...ws, root: root as never })).toThrow(/workspace root/);
    },
  );
});

describe('writeSecretFile / writeAskpassFile', () => {
  it('writeSecretFile pipes stdin to the G1 script with the path as $0', () => {
    const path = ws.secretFile('deploy_key');
    const command = writeSecretFile(path);

    expect(command.name).toBe('secrets.write_file');
    expect(command.argv).toEqual(['sh', '-c', SHELL_SCRIPTS.writeSecretFromStdin, path]);
    expect(command.stdin).toBe('secret');
  });

  it('writeAskpassFile uses the askpass script and stdin', () => {
    const path = ws.secretFile('https_token');
    const command = writeAskpassFile(path);

    expect(command.name).toBe('secrets.write_askpass');
    expect(command.argv).toEqual(['sh', '-c', SHELL_SCRIPTS.writeAskpassFromStdin, path]);
    expect(command.stdin).toBe('secret');
  });

  it.each(ADVERSARIAL_VALUES)('round-trips %j as literal words', (value) => {
    for (const command of [
      writeSecretFile(value as DeploySecretPath),
      writeAskpassFile(value as DeploySecretPath),
    ]) {
      expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
    }
  });
});

describe('ASKPASS_SCRIPT_CONTENT', () => {
  it('answers x-access-token for a Username prompt and cats the token file otherwise', () => {
    expect(ASKPASS_SCRIPT_CONTENT).toContain('Username*) echo x-access-token');
    expect(ASKPASS_SCRIPT_CONTENT).toContain('cat "$NOODARA_ASKPASS_TOKEN_FILE"');
    expect(ASKPASS_SCRIPT_CONTENT.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('contains no interpolation marker, backtick or command substitution', () => {
    expect(ASKPASS_SCRIPT_CONTENT.includes(DOLLAR + String.fromCharCode(123))).toBe(false);
    expect(ASKPASS_SCRIPT_CONTENT.includes(BACKTICK)).toBe(false);
    expect(ASKPASS_SCRIPT_CONTENT.includes(DOLLAR + String.fromCharCode(40))).toBe(false);
  });
});

describe('supervise', () => {
  it('wraps a supervisable command in the ADR 0008 G2 launcher: setsid -w sh -c <script> <pidfile> <argv...>', () => {
    const pidFile = ws.pidFile('clone');
    const command = supervise(pidFile, clone);

    expect(command.name).toBe('process.supervise');
    expect(command.argv).toEqual([
      'setsid',
      '-w',
      'sh',
      '-c',
      SHELL_SCRIPTS.supervise,
      pidFile,
      ...clone.argv,
    ]);
    expect(command.stdin).toBe(clone.stdin);
    expect(command.supervisable).toBe(false);
  });

  it('refuses a command that is not supervisable (programming error)', () => {
    const checkout = gitCheckout(ws.repo, '0123456789abcdef0123456789abcdef01234567' as never);

    expect(() => supervise(ws.pidFile('clone'), checkout)).toThrow(/git\.checkout/);
  });

  it('refuses to nest supervise', () => {
    const once = supervise(ws.pidFile('clone'), clone);

    expect(() => supervise(ws.pidFile('clone'), once)).toThrow(/process\.supervise/);
  });

  it.each(ADVERSARIAL_VALUES)('round-trips a force-cast pidfile %j as literal words', (value) => {
    const command = supervise(value as DeployRunPath, clone);

    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
  });
});

describe('killGroup / groupAlive', () => {
  it('killGroup runs the G2 kill script with the pidfile as $0', () => {
    const pidFile = ws.pidFile('build');
    const command = killGroup(pidFile);

    expect(command.name).toBe('process.kill_group');
    expect(command.argv).toEqual(['sh', '-c', SHELL_SCRIPTS.killGroup, pidFile]);
  });

  it('groupAlive runs the pgrep script with the pidfile as $0', () => {
    const pidFile = ws.pidFile('build');
    const command = groupAlive(pidFile);

    expect(command.name).toBe('process.group_alive');
    expect(command.argv).toEqual(['sh', '-c', SHELL_SCRIPTS.groupAlive, pidFile]);
  });

  it.each(ADVERSARIAL_VALUES)('round-trips %j as literal words', (value) => {
    for (const command of [killGroup(value as DeployRunPath), groupAlive(value as DeployRunPath)]) {
      expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
    }
  });
});
