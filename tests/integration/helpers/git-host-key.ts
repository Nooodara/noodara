// 14-06: the fixture git host is the deploy-host container under GIT_HOST_ALIAS, so its host key is
// the container's own sshd ed25519 key. Callers pin clones to it (StrictHostKeyChecking=yes).
import { parseGitHostKeyLine, type GitHostKey } from '@noodara/domain/validators';
import { GIT_HOST_ALIAS, type DeployEngineStack } from './deploy-engine.js';

/** A valid ed25519 key that is not the fixture host's (github.com's published key). */
const FOREIGN_ED25519_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

function hostKey(line: string): GitHostKey {
  const parsed = parseGitHostKeyLine(line);
  if (!parsed.ok) throw new Error(`fixture git host key does not parse: ${parsed.code}`);
  return parsed.value;
}

/** Root-side truth: the git host's ed25519 public key, as a known_hosts entry for GIT_HOST_ALIAS. */
export async function fixtureGitHostKey(stack: DeployEngineStack): Promise<GitHostKey> {
  const result = await stack.exec(['cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
  if (result.exitCode !== 0) throw new Error(`cannot read the fixture host key: ${result.stderr}`);
  const [type, blob] = result.stdout.trim().split(/\s+/);
  if (type === undefined || blob === undefined) throw new Error('fixture host key is malformed');
  return hostKey(`${GIT_HOST_ALIAS} ${type} ${blob}`);
}

/** A well-formed key for GIT_HOST_ALIAS that the fixture host does not hold: forces a mismatch. */
export function wrongGitHostKey(): GitHostKey {
  return hostKey(`${GIT_HOST_ALIAS} ssh-ed25519 ${FOREIGN_ED25519_BLOB}`);
}
