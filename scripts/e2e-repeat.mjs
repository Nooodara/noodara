#!/usr/bin/env node
// 05-20-PLAN.md Task 2 (QA-04): runs `pnpm test:e2e` as N fully independent process invocations,
// each with its own fresh Postgres/Redis (and, for critical-path.spec.ts, sshd) Testcontainers,
// rather than Playwright's own `--repeat-each=N`.
//
// `--repeat-each` reuses the ONE stack `globalSetup` starts for the whole `playwright test`
// invocation across every repetition -- every spec's own real-API-seeded servers would then
// accumulate monotonically in that single shared Postgres database across all N passes, an
// order of magnitude past anything a single ordinary run ever produces. That is exactly the
// "the global stack makes `--repeat-each` unsound" case 05-20-PLAN.md's own Task 2 text
// anticipated, so this script runs each repetition as its own process instead: `globalSetup`/
// `globalTeardown` own a fresh Postgres/Redis Testcontainers pair per invocation, so no
// repetition ever sees another repetition's data.
//
// Thin and locally runnable by design (the same discipline ci.yml's own header comment states
// for every one of its own steps) -- `node scripts/e2e-repeat.mjs [count]` is exactly what CI
// runs, nothing CI-only layered on top. Fails fast on the first failing iteration and prints
// which one, rather than running all N and summarizing failures at the end.
import { spawnSync } from 'node:child_process';

const DEFAULT_COUNT = 20;
const requestedCount = Number(process.argv[2] ?? process.env.NOODARA_E2E_REPEAT_COUNT ?? DEFAULT_COUNT);
const count = Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : DEFAULT_COUNT;

const startedAt = Date.now();

for (let iteration = 1; iteration <= count; iteration += 1) {
  console.log(`\n=== e2e repeat ${String(iteration)}/${String(count)} ===\n`);
  const result = spawnSync('pnpm', ['test:e2e'], { stdio: 'inherit' });

  if (result.error) {
    console.error(`e2e-repeat: iteration ${String(iteration)} failed to spawn: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    console.error(
      `\ne2e-repeat: iteration ${String(iteration)}/${String(count)} FAILED (exit ${String(result.status)}) ` +
        `after ${String(elapsedSec)}s total -- stopping, not running the remaining iterations.`,
    );
    process.exit(result.status ?? 1);
  }
}

const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
console.log(`\ne2e-repeat: all ${String(count)}/${String(count)} iterations passed in ${String(elapsedSec)}s total.`);
