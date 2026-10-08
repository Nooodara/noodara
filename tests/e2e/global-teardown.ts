// Playwright `globalTeardown`: stops the stack global-setup.ts started, then sweeps every
// container, network and volume labelled with this run's id (deploy hosts started by workers
// included) and removes the run temp dir. Idempotent and run-scoped: running it twice, or after a
// crashed setup, never errors and never touches another run's resources (13-06 H1).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { sweepRunResources } from './fixtures/deploy-host.js';
import { stopStack, type Stack } from './fixtures/stack.js';
import { RUN_MANIFEST_PATH, STACK_HANDOFF_PATH, type RunManifest } from './global-setup.js';

const execFileAsync = promisify(execFile);

/**
 * Removes and asserts gone every `noodara.test=true` container created since this run began
 * (worker-started sshd fixtures included), so nothing is left for Ryuk to reap after the process
 * exits and race the next suite's stray-container check.
 */
async function reapRunTestContainers(startedAtMs: number): Promise<void> {
  const docker = (args: readonly string[]) => execFileAsync('docker', [...args], { timeout: 60_000 });
  const mine = async (): Promise<string[]> => {
    const { stdout } = await docker(['ps', '-aq', '--no-trunc', '--filter', 'label=noodara.test=true']);
    const ids = stdout.split('\n').filter((l) => l !== '');
    if (ids.length === 0) return [];
    const { stdout: out } = await docker(['inspect', '--format', '{{.Id}} {{.Created}}', ...ids]);
    return out
      .split('\n')
      .filter((l) => l !== '')
      .filter((l) => Date.parse(l.split(' ')[1] ?? '') >= startedAtMs - 1000)
      .map((l) => l.split(' ')[0] ?? '');
  };
  const found = await mine();
  if (found.length > 0) await docker(['rm', '-f', '-v', ...found]).catch(() => undefined);
  const left = await mine();
  if (left.length > 0) {
    throw new Error(`globalTeardown: noodara.test containers survived teardown: ${left.map((i) => i.slice(0, 12)).join(', ')}`);
  }
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export default async function globalTeardown(): Promise<void> {
  const errors: unknown[] = [];

  const stack = readJson<Stack>(STACK_HANDOFF_PATH);
  if (stack !== undefined) {
    try {
      await stopStack(stack);
    } catch (err) {
      errors.push(err);
    }
  }

  const manifest = readJson<RunManifest>(RUN_MANIFEST_PATH);
  if (manifest !== undefined) {
    try {
      await sweepRunResources(manifest.runId);
    } catch (err) {
      errors.push(err);
    }
    try {
      await reapRunTestContainers(manifest.startedAtMs ?? 0);
    } catch (err) {
      errors.push(err);
    }
    if (manifest.runDir.includes('noodara-e2e-')) rmSync(manifest.runDir, { recursive: true, force: true });
  }

  if (errors.length > 0) throw new AggregateError(errors, 'globalTeardown: e2e run did not tear down cleanly');
}
