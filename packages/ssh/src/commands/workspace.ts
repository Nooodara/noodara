// Workspace, secret-file and process templates (ADR 0008 G1 and G2). Secrets travel only on stdin
// to a constant script; paths are positional parameters. Supervised operations run under
// `setsid -w` (plain setsid exits 0 at once and hides the real status) and are killed with
// `kill -s TERM -- "-$pgid"` (the `kill -TERM` form fails under dash).
import type { DeployRunPath, DeploySecretPath, DeployWorkspace } from '@noodara/domain/validators';
import { createRemoteCommand, type RemoteCommand } from './remote-command.js';
import { SHELL_SCRIPTS } from './shell-scripts.js';

/**
 * The askpass helper written with writeAskpassFile (D7). Git calls it with the prompt as $1; the
 * token is read from the mode-600 file named by NOODARA_ASKPASS_TOKEN_FILE, so it never appears in
 * argv or env. Measured end to end over HTTPS on 22.04 and 24.04 (ADR 0008 open item 4).
 */
export const ASKPASS_SCRIPT_CONTENT = [
  '#!/bin/sh',
  'case "$1" in',
  '  Username*) echo x-access-token ;;',
  '  *) cat "$NOODARA_ASKPASS_TOKEN_FILE" ;;',
  'esac',
  '',
].join('\n');

const WORKSPACE_ROOT_PATTERN =
  /^\/opt\/noodara-deploy\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertWorkspaceRoot(workspace: DeployWorkspace): string {
  // Defense in depth for `rm -rf`: the type already requires deployWorkspaceFor's output.
  const root: unknown = (workspace as Partial<DeployWorkspace> | undefined)?.root;
  if (typeof root !== 'string' || !WORKSPACE_ROOT_PATTERN.test(root)) {
    throw new Error('Refusing a workspace root outside /opt/noodara-deploy/<uuid>');
  }
  return root;
}

/**
 * The askpass helper's own slot under <ws>/secrets (A1): not a DEPLOY_SECRET_NAMES file, so it never
 * overwrites a credential, and a sibling of the clone, so it never enters a build context.
 */
export const ASKPASS_FILE_NAME = 'askpass';

/** `<root>/secrets/askpass`. Git executes this path, so a forged workspace is refused. */
export function askpassFileFor(workspace: DeployWorkspace): DeploySecretPath {
  const root = assertWorkspaceRoot(workspace);
  if (workspace.secretsDir !== `${root}/secrets`) {
    throw new Error('Refusing a workspace whose secrets dir is not <root>/secrets');
  }
  return `${workspace.secretsDir}/${ASKPASS_FILE_NAME}` as DeploySecretPath;
}

export function prepareWorkspace(workspace: DeployWorkspace): RemoteCommand {
  return createRemoteCommand({
    name: 'fs.prepare_workspace',
    argv: ['sh', '-c', SHELL_SCRIPTS.prepareWorkspace, workspace.root],
    stdin: 'none',
    supervisable: false,
  });
}

export function removeDeployDir(workspace: DeployWorkspace): RemoteCommand {
  return createRemoteCommand({
    name: 'fs.remove_deploy_dir',
    argv: ['rm', '-rf', '--', assertWorkspaceRoot(workspace)],
    stdin: 'none',
    supervisable: false,
  });
}

export function writeSecretFile(path: DeploySecretPath): RemoteCommand {
  return createRemoteCommand({
    name: 'secrets.write_file',
    argv: ['sh', '-c', SHELL_SCRIPTS.writeSecretFromStdin, path],
    stdin: 'secret',
    supervisable: false,
  });
}

/** Pass the workspace to write the helper to its own slot (askpassFileFor); mode 0700, it is run. */
export function writeAskpassFile(target: DeployWorkspace | DeploySecretPath): RemoteCommand {
  const path = typeof target === 'string' ? target : askpassFileFor(target);
  return createRemoteCommand({
    name: 'secrets.write_askpass',
    argv: ['sh', '-c', SHELL_SCRIPTS.writeAskpassFromStdin, path],
    stdin: 'secret',
    supervisable: false,
  });
}

/** Runs `inner` in its own process group and records the pgid in `pidFile`. */
export function supervise(pidFile: DeployRunPath, inner: RemoteCommand): RemoteCommand {
  if (!inner.supervisable) {
    throw new Error(`${inner.name} cannot run under process.supervise`);
  }
  return createRemoteCommand({
    name: 'process.supervise',
    argv: ['setsid', '-w', 'sh', '-c', SHELL_SCRIPTS.supervise, pidFile, ...inner.argv],
    stdin: inner.stdin,
    supervisable: false,
  });
}

export function killGroup(pidFile: DeployRunPath): RemoteCommand {
  return createRemoteCommand({
    name: 'process.kill_group',
    argv: ['sh', '-c', SHELL_SCRIPTS.killGroup, pidFile],
    stdin: 'none',
    supervisable: false,
  });
}

/** Exit 0 while the group has a member, 1 once it has none. */
export function groupAlive(pidFile: DeployRunPath): RemoteCommand {
  return createRemoteCommand({
    name: 'process.group_alive',
    argv: ['sh', '-c', SHELL_SCRIPTS.groupAlive, pidFile],
    stdin: 'none',
    supervisable: false,
  });
}
