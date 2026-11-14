// Vitest `setupFiles` entry for the integration and installer configs (14-27): runs before each
// test file (files run one at a time, fileParallelism: false), snapshots the `noodara.test=true`
// resources, and after the file's own hooks -- even ones that timed out or threw before reaching
// their `stack.stop()` -- removes anything the file added and fails it, naming the leak.
import path from 'node:path';
import { afterAll } from 'vitest';
import { assertNoLeakedTestResources, snapshotTestResources } from './test-resources.js';
import { resolveRunnerTimeoutScale } from '../../support/timeout-scale.js';

/** Unscaled budget for the file-level reap + verification. The 2 s settle below is NOT scaled:
 *  lengthening it would only hide late leaks (36-02 A3). */
const LEAK_GUARD_HOOK_BUDGET_MS = 180_000;

const baseline = await snapshotTestResources();

// Vitest 5 parses the first hook argument as a fixture pattern; the suite is the second.
afterAll(async ({}, suite) => {
  const file = 'filepath' in suite ? path.relative(process.cwd(), suite.filepath) : suite.name;
  await assertNoLeakedTestResources(file, baseline, { settleMs: 2_000 });
}, resolveRunnerTimeoutScale('vitest').scaled(LEAK_GUARD_HOOK_BUDGET_MS));
