import { defineConfig } from 'vitest/config';
import { domainSourceAliases, sshSourceAliases } from './vitest.shared.js';

// Separate config for the installer's Testcontainers/Docker-in-Docker suite (06-01-PLAN.md Task
// 3). This suite builds real production Docker images (apps/control-plane, apps/web) and runs
// Docker-in-Docker privileged containers to exercise install.sh end to end on Ubuntu 22.04/24.04
// -- it is kept out of `pnpm test:integration` (already ~32 min on a cold runner, per
// 06-VALIDATION.md) and out of vitest.integration.config.ts's own `include` (see the `exclude`
// entry added there), and is gated separately in CI (push to main + nightly, Plan 06-13), never
// on every PR.
export default defineConfig({
  // See vitest.config.ts / vitest.shared.ts: keeps in-process integration test files resolving
  // @noodara/domain and @noodara/ssh against source, not the built dist/ output.
  resolve: { alias: [...domainSourceAliases, ...sshSourceAliases] },
  test: {
    include: ['tests/integration/installer/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    pool: 'forks',
    fileParallelism: false,
    // Post-execution fix (orchestrator audit WR-08): this suite is long populated
    // (tests/integration/installer/** now has ten real, release-gating test files) -- leaving
    // `passWithNoTests` at its stale, permissive default from before Plan 06-10..06-12 added them
    // would let a future `include` glob typo, directory rename, or CI checkout that omits this
    // directory report success having run zero tests, rather than failing loudly. `pnpm
    // test:installer` is gated in CI on push-to-main and nightly (never on every PR); a silent
    // zero-test pass there is exactly the kind of gap this release-blocking gate exists to
    // prevent.
    passWithNoTests: false,
    globalSetup: ['tests/integration/global-setup.ts'],
  },
});
