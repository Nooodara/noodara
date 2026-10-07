// The closed deploy allowlist (SVC-08, ROADMAP criterion 4). Separate from COMMAND_TEMPLATES
// (allowlist.ts) so the discovery CommandName <-> DiscoveryCheckId 1:1 guard stays meaningful.
// deploy-allowlist.test.ts is the exactness guard: a new template must update it in the same plan.
export const DEPLOY_COMMAND_NAMES = Object.freeze([
  'git.clone',
  'git.checkout',
  'git.head_sha',
  'git.probe_features',
  'git.keyscan',
  'fs.prepare_workspace',
  'fs.remove_deploy_dir',
  'secrets.write_file',
  'secrets.write_askpass',
  'process.supervise',
  'process.kill_group',
  'process.group_alive',
  'docker.login',
  'docker.logout',
  'docker.pull',
  'docker.build',
  'docker.image_remove',
  'docker.network_create',
  'docker.network_remove',
  'docker.create',
  'docker.start',
  'docker.stop',
  'docker.restart',
  'docker.remove',
  'docker.inspect',
  'docker.logs',
  'docker.ps',
  'docker.kill',
  'docker.builder_prune',
] as const);

export type DeployCommandName = (typeof DEPLOY_COMMAND_NAMES)[number];
