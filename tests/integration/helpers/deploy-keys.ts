// Per-run ed25519 key pairs for the deploy-engine fixture (11-03-PLAN.md Task 2). Generated with the
// host's ssh-keygen in a mkdtemp dir that is always removed; never written into the repository.
// packages/ssh/src/testing/generate-keys.ts stays untouched (11-RESEARCH.md Pitfall 4).
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KEYGEN_TIMEOUT_MS = 30_000;

export interface DeployKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

export async function generateDeployKeyPair(comment: string): Promise<DeployKeyPair> {
  const dir = await mkdtemp(path.join(tmpdir(), 'noodara-deploy-key-'));
  const keyPath = path.join(dir, 'id_ed25519');
  try {
    await execFileAsync(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath],
      {
        timeout: KEYGEN_TIMEOUT_MS,
      },
    );
    const [privateKey, publicKey] = await Promise.all([
      readFile(keyPath, 'utf8'),
      readFile(`${keyPath}.pub`, 'utf8'),
    ]);
    return { privateKey, publicKey: publicKey.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
