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
    // No installer integration tests exist yet in this plan (Plan 06-10..06-12 add them);
    // passWithNoTests is deliberate here, matching vitest.integration.config.ts's own precedent
    // for a not-yet-populated suite.
    passWithNoTests: true,
    globalSetup: ['tests/integration/global-setup.ts'],
  },
});
