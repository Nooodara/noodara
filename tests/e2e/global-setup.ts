// Playwright `globalSetup`: starts the real stack (fixtures/stack.ts) exactly once before any
// spec runs. `stack.ts` keeps the live process/container handles in a module-level singleton
// (global-setup.ts and global-teardown.ts run in the same runner process); this file also persists
// the serializable parts to JSON under test-results/ so global-teardown.ts can read them back.
//
// 13-06: every run gets a random run id (the `noodara.e2e.run` label) and a 0700 temp dir, exported
// to workers via process.env. The run manifest is written before anything starts, so a teardown
// after a crashed setup still knows which resources are this run's.
//
// 14-27: a precheck fails the run before anything starts when `noodara.test` resources already
// exist (an earlier run's leak), and the manifest carries a snapshot of the labelled resources, so
// teardown removes exactly what this run added -- not whatever a clock comparison picks up.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RUN_DIR_ENV, RUN_ID_ENV, sweepRunResources } from './fixtures/deploy-host.js';
import { startStack } from './fixtures/stack.js';
import { assertNoTestResources, snapshotTestResources, type TestResourceSnapshot } from '../integration/helpers/test-resources.js';

export const STACK_HANDOFF_PATH = path.join(process.cwd(), 'test-results', 'e2e-stack.json');
/** Non-secret: run id and run temp dir only. */
export const RUN_MANIFEST_PATH = path.join(process.cwd(), 'test-results', 'e2e-run.json');

export interface RunManifest {
  readonly runId: string;
  readonly runDir: string;
  /** `noodara.test=true` resources present before the run: teardown reaps anything added since. */
  readonly baseline: TestResourceSnapshot;
}

export default async function globalSetup(): Promise<void> {
  // A stale manifest must never point teardown at another run's resources.
  rmSync(RUN_MANIFEST_PATH, { force: true });
  await assertNoTestResources('e2e globalSetup');
  const baseline = await snapshotTestResources();

  const runId = randomUUID();
  const runDir = mkdtempSync(path.join(tmpdir(), 'noodara-e2e-'));
  chmodSync(runDir, 0o700);
  process.env[RUN_ID_ENV] = runId;
  process.env[RUN_DIR_ENV] = runDir;

  mkdirSync(path.dirname(RUN_MANIFEST_PATH), { recursive: true });
  rmSync(STACK_HANDOFF_PATH, { force: true });
  const manifest: RunManifest = { runId, runDir, baseline };
  writeFileSync(RUN_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  try {
    const stack = await startStack();
    writeFileSync(STACK_HANDOFF_PATH, JSON.stringify(stack, null, 2), 'utf8');
  } catch (err) {
    // startStack already stops what it started; sweep anything labelled for this run anyway.
    await sweepRunResources(runId).catch((sweepErr: unknown) => {
      console.warn(`globalSetup: sweep after failed start: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`);
    });
    rmSync(runDir, { recursive: true, force: true });
    throw err;
  }
}
