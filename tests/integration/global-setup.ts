// Vitest `globalSetup` for the integration config, run exactly once before any file in
// `tests/integration/**`.
//
// Rationale:
// (a) The boot smoke test (`tests/integration/boot/boot-command.test.ts`) spawns the real `dev`
//     and `start` commands against compiled output — it must exercise the *current* sources, not
//     a stale `dist/` left over from a previous session.
// (b) `packages/domain`'s `exports` map moves onto a built `dist` output (01-16-PLAN.md Task 2),
//     which `tests/integration/cli/admin-reset.test.ts` needs too: it spawns the operator CLI in
//     a separate `tsx` process, and that process resolves `@noodara/domain` through the same
//     `exports` map plain Node does.
// (c) Precheck port 3000 (Task 14-11): fail early with a clear message if port is in use,
//     before any containers or databases are started. This distinguishes between another process
//     and a stale Noodara test stack, avoiding orphaned infrastructure.
//
// (d) Leak guard (14-27): fail before anything starts when an earlier run left `noodara.test`
//     resources, and return a teardown that removes whatever this run added and fails loudly
//     naming it -- Ryuk is shared across processes and cannot be relied on (helpers/test-resources.ts).
//
// Uses the exact same `buildWorkspace()` helper `boot-command.test.ts`'s Test 4 restores `dist`
// with after deliberately deleting it, so there is exactly one definition of "build the
// workspace" and the two paths can never drift apart.
import { buildWorkspace } from './helpers/boot-process.js';
import { checkPort } from './helpers/port-checker.js';
import { assertNoLeakedTestResources, assertNoTestResources, snapshotTestResources } from './helpers/test-resources.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Precheck: port 3000 availability (Task 14-11 — OPEN_QUESTIONS #3).
  // This runs before any Docker containers or databases are started.
  const portCheck = await checkPort(3000);
  if (!portCheck.success) {
    const message = portCheck.message ?? `Port ${portCheck.port} is in use`;
    console.error(`\n${'='.repeat(80)}`);
    console.error('PRECHECK FAILURE: Port 3000 is unavailable');
    console.error(`${'='.repeat(80)}`);
    console.error(`\n${message}\n`);
    console.error('To skip this check, set: NOODARA_TEST_PORT_OVERRIDE=<alternative-port>');
    console.error(`${'='.repeat(80)}\n`);
    process.exit(1);
  }

  await assertNoTestResources('vitest globalSetup');
  const baseline = await snapshotTestResources();

  buildWorkspace();

  return async () => {
    await assertNoLeakedTestResources('this vitest run', baseline, { settleMs: 2_000 });
  };
}
