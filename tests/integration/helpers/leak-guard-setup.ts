// Vitest `setupFiles` entry for the integration and installer configs (14-27): runs before each
// test file (files run one at a time, fileParallelism: false), snapshots the `noodara.test=true`
// resources, and after the file's own hooks -- even ones that timed out or threw before reaching
// their `stack.stop()` -- removes anything the file added and fails it, naming the leak.
import path from 'node:path';
import { afterAll } from 'vitest';
import { assertNoLeakedTestResources, snapshotTestResources } from './test-resources.js';

const baseline = await snapshotTestResources();

afterAll(async (suite) => {
  const file = 'filepath' in suite ? path.relative(process.cwd(), suite.filepath) : suite.name;
  await assertNoLeakedTestResources(file, baseline, { settleMs: 2_000 });
}, 180_000);
