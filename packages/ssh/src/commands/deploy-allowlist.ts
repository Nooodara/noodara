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
  // 17-01 (ADR 0010): the -prev container, per-service images and healthcheck probes.
  'docker.inspect_networks',
  'docker.network_connect',
  'docker.rename_to_prev',
  'docker.rename_from_prev',
  'docker.start_prev',
  'docker.stop_prev',
  'docker.remove_prev',
  'docker.image_list_service',
  'docker.image_remove_service',
  'probe.http',
  'probe.tcp',
  // 17-05: manual rollback checks the target image is still on the server.
  'docker.image_inspect',
  // 18-03: deploy the exact pushed SHA (fetch it shallowly; unshallow fallback).
  'git.fetch_commit',
  'git.fetch_unshallow',
  // 22-01 (ADR 0011): the reverse proxy lifecycle and the certificate probe.
  'proxy.prepare_dirs',
  'proxy.write_static',
  'proxy.write_dynamic',
  'proxy.restore_dynamic',
  'proxy.remove_dynamic',
  // 22-02: remove/delete-server purges /opt/noodara-proxy (acme.json holds cert keys).
  'proxy.remove_files',
  'proxy.create',
  'proxy.status',
  // 22-07 A7: the dynamic port read had shared proxy.status; one script body per name.
  'proxy.read_dynamic',
  'proxy.ports_in_use',
  'tls.cert_status',
  'docker.network_disconnect',
] as const);

export type DeployCommandName = (typeof DEPLOY_COMMAND_NAMES)[number];
