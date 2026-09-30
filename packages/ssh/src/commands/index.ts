// Pure barrel over the four command modules. COMMAND_TEMPLATES/commandFor/escapeShellArg are
// deliberately declared in allowlist.ts, not here: vitest.config.ts's coverage config excludes
// `**/index.ts`, and this content must be measured.
export * from './discovery.js';
export * from './docker.js';
export * from './access.js';
export * from './allowlist.js';
// Deploy allowlist (11-13). The RemoteCommand factory is deliberately not re-exported: only the
// builder modules in this directory may create one.
export * from './deploy-allowlist.js';
export { renderRemoteCommand } from './remote-command.js';
export type { RemoteCommand, RemoteCommandStdin } from './remote-command.js';
export * from './shell-scripts.js';
export * from './git.js';
export * from './workspace.js';
export * from './docker-deploy.js';
