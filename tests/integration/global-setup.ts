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
//
// Uses the exact same `buildWorkspace()` helper `boot-command.test.ts`'s Test 4 restores `dist`
// with after deliberately deleting it, so there is exactly one definition of "build the
// workspace" and the two paths can never drift apart.
import { buildWorkspace } from './helpers/boot-process.js';

export default function globalSetup(): void {
  buildWorkspace();
}
