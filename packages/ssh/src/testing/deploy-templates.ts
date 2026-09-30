// Test-only entry for tests/integration/deploy-engine (11-13): the deploy templates, so the
// integration suite can run the exact rendered command lines against the sshd + dockerd fixture.
// Resolved only through the Vitest alias `@noodara/ssh/testing/deploy-templates`; excluded from the
// build (tsconfig.build.json) and never listed in packages/ssh/package.json `exports`.
export * from '../commands/deploy-allowlist.js';
export * from '../commands/docker-deploy.js';
export * from '../commands/git.js';
export * from '../commands/workspace.js';
export { renderRemoteCommand } from '../commands/remote-command.js';
export type { RemoteCommand } from '../commands/remote-command.js';
export { SHELL_SCRIPTS } from '../commands/shell-scripts.js';
