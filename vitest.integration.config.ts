import { defineConfig } from 'vitest/config';
import { domainSourceAliases, sshSourceAliases } from './vitest.shared.js';

// Separate config for Testcontainers-backed integration tests: heavier timeouts, no coverage,
// and file-parallelism disabled since containers are heavy and must not race each other.
export default defineConfig({
  // See vitest.config.ts / vitest.shared.ts: keeps in-process integration test files resolving
  // @noodara/domain against source, not the built dist/ output.
  resolve: { alias: [...domainSourceAliases, ...sshSourceAliases] },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // The installer's Docker-in-Docker suite has its own config (vitest.installer.config.ts,
    // `pnpm test:installer`) since it builds real production images and runs privileged
    // Docker-in-Docker -- excluded here so it never inflates this suite's ~32 min PR-gate budget.
    // Not untested: see vitest.installer.config.ts.
    exclude: ['tests/integration/installer/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
    // Post-execution fix (orchestrator audit WR-08): this suite is long populated -- leaving
    // `passWithNoTests` at its stale, permissive default from before any integration test existed
    // would let a future `include`/`exclude` glob mistake or an incomplete CI checkout report
    // success having run zero tests, rather than failing loudly. `pnpm test:integration` gates
    // every PR.
    passWithNoTests: false,
    // Builds the workspace once before the whole integration run (see global-setup.ts) so the
    // boot smoke test always exercises current sources, never a stale dist/.
    globalSetup: ['tests/integration/global-setup.ts'],
  },
});
