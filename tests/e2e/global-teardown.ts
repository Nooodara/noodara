// Playwright `globalTeardown`: stops the stack global-setup.ts started, then sweeps every
// container, network and volume labelled with this run's id (deploy hosts started by workers
// included) and removes the run temp dir. Idempotent and run-scoped: running it twice, or after a
// crashed setup, never errors and never touches another run's resources (13-06 H1).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { sweepRunResources } from './fixtures/deploy-host.js';
import { stopStack, type Stack } from './fixtures/stack.js';
import { RUN_MANIFEST_PATH, STACK_HANDOFF_PATH, type RunManifest } from './global-setup.js';

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
    if (manifest.runDir.includes('noodara-e2e-')) rmSync(manifest.runDir, { recursive: true, force: true });
  }

  if (errors.length > 0) throw new AggregateError(errors, 'globalTeardown: e2e run did not tear down cleanly');
}
