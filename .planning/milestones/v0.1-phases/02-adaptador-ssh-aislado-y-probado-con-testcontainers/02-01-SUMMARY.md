---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 01
subsystem: infra
tags: [ssh2, turborepo-boundaries, vitest-projects, adapter-contracts, sec-04, allowlist]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "ADR 0003's build-for-prod/tsx-for-dev contract (packages/domain's tsc build + dist-pointing exports + vitest.shared.ts source aliases), ServerErrorCode/ConnectionResult (server/connection-result.ts), SecretValue/Redactor (security/), the purity.test.ts pattern this plan mirrors for packages/ssh's own boundary.test.ts"
provides:
  - "packages/ssh: a real, buildable @noodara/ssh workspace package following the same ADR 0003 contract as packages/domain (tsc build to dist, exports map pointing at dist, vitest alias to src)"
  - "ssh2@1.17.0 as a dependency of packages/ssh and nothing else — boundary.test.ts fails the suite if any other file imports it; turbo boundaries' ssh-adapter tag restricts packages/ssh to depending only on @noodara/domain (pure-domain) and @noodara/config"
  - "SshPort, SshTarget, SshCredential, SshTimeouts, HostFingerprint, ExecResult, SshSession, ConnectInput, ConnectOutcome (packages/ssh/src/ssh-port.ts) — the full adapter contract surface every remaining phase-2 plan implements against"
  - "DiscoveryCheck, DiscoveryFacts, DiscoverySnapshot, DISCOVERY_CHECK_IDS, DISCOVERY_CHECK_STATUSES, SUPPORTED_UBUNTU_VERSIONS (packages/domain/src/discovery/types.ts), wired as a sixth ./discovery entrypoint on @noodara/domain"
  - "The frozen 11-entry SSH command allowlist (packages/ssh/src/commands): COMMAND_TEMPLATES, COMMAND_NAMES, CommandName, commandFor(), escapeShellArg() — SEC-04's complete 'no user input reaches a shell' guarantee"
affects: ["02-02..02-10 (every remaining phase-2 plan implements SshPort/runDiscovery against these exact names)", "phase-3 (persists ConnectOutcome.fingerprint / DiscoverySnapshot)", "phase-5 (renders DiscoveryCheck's pass/fail/skipped/not_applicable narrative unchanged)"]

# Tech tracking
tech-stack:
  added: ["ssh2@1.17.0 (packages/ssh only; no @types/ssh2 — ships its own declarations)"]
  patterns:
    - "packages/ssh mirrors packages/domain's ADR 0003 scaffold exactly: tsc build to dist, single '.' exports entry pointing at dist/*.js+.d.ts, vitest.shared.ts resolve.alias so in-process tests hit src"
    - "A per-package boundary.test.ts (packages/ssh/src/boundary.test.ts), sibling to packages/domain's purity.test.ts, is the source-level half of a containment guarantee that turbo boundaries' package.json-level tags enforce as the other half"
    - "Frozen command allowlist: each concern (discovery/docker/access) gets its own module of dotted-key literal string templates, merged in allowlist.ts into a single object typed via `keyof typeof`, so CommandName and COMMAND_NAMES can never drift from COMMAND_TEMPLATES's actual keys"
    - "Contracts-first plan pattern: a plan with zero behaviour (all declaration-only types + a frozen data allowlist) that every subsequent implementation plan in the phase depends on, so no later plan has to reverse-engineer a contract from a sibling's output"
    - "escapeShellArg is a quoting function, never a sanitiser — no blocklist, no metacharacter stripping, single-quote-and-reopen the POSIX way (Dokploy GHSA-fcgq-jjfg-hrhj is the documented reason not to hand-roll a blocklist instead)"

key-files:
  created:
    - packages/ssh/package.json
    - packages/ssh/tsconfig.json
    - packages/ssh/tsconfig.build.json
    - packages/ssh/turbo.json
    - packages/ssh/src/index.ts
    - packages/ssh/src/boundary.test.ts
    - packages/ssh/src/ssh-port.ts
    - packages/ssh/src/commands/index.ts
    - packages/ssh/src/commands/allowlist.ts
    - packages/ssh/src/commands/allowlist.test.ts
    - packages/ssh/src/commands/discovery.ts
    - packages/ssh/src/commands/docker.ts
    - packages/ssh/src/commands/access.ts
    - packages/domain/src/discovery/types.ts
    - packages/domain/src/discovery/index.ts
  modified:
    - packages/domain/src/index.ts
    - packages/domain/package.json
    - turbo.json
    - package.json
    - vitest.shared.ts
    - vitest.config.ts
    - vitest.integration.config.ts
    - pnpm-lock.yaml

key-decisions:
  - "turbo boundaries' tag 'allow' lists are an undirected adjacency check in turbo 2.10.12, not a one-directional 'my outgoing dependencies' rule as the upstream docs describe: adding ssh-adapter (packages/ssh) with an allow list naming pure-domain was not enough on its own — pure-domain's own allow list also had to add 'ssh-adapter', or `pnpm boundaries` failed on the ssh->domain edge even though nothing about domain's own outgoing dependencies changed. Verified empirically (with the ORIGINAL, unmodified phase-1 pure-domain rule) that adding packages/ssh alone — with no rule changes at all — already broke `pnpm boundaries`, confirming this is turbo's real behavior, not a mistake in this plan's edits. The real 'domain cannot depend on ssh' guarantee is unaffected: packages/domain/src/purity.test.ts independently freezes domain's dependencies to exactly ['zod'] and asserts domain never imports another @noodara/ package — verified by temporarily adding '@noodara/ssh' to domain's package.json and confirming purity.test.ts fails."
  - "packages/ssh/src/commands/index.ts (Task 3) ships as a minimal `export type CommandName = string;` stub so ssh-port.ts's `import type { CommandName } from './commands/index.js'` resolves and the package keeps building after Task 3 — Task 4 replaces it with the real barrel deriving CommandName from the 11-entry frozen tuple. The plan's Task 3 text says 'Task 4 defines it' while also requiring `pnpm build` green at the end of Task 3; the stub is the minimal fix reconciling both."
  - "ssh2 was not flagged by 02-RESEARCH.md's Package Legitimacy Audit (verdict [OK], repo mscdex/ssh2 confirmed again via `npm view ssh2 repository.url` = git+ssh://git@github.com/mscdex/ssh2.git, version 1.17.0), so no row was added to docs/adr/0000-package-legitimacy-approvals.md — that ADR's own stated scope is packages slopcheck flagged as [SUS]/needing-caveat, not every dependency"
  - "allowlist.test.ts's own fixtures (the no-\${/backtick/$( guards and the metacharacter round-trip test for escapeShellArg) are built via String.fromCharCode/array-join rather than literal template/interpolation syntax, so the test file's own source text doesn't trip the same static no-marker grep gate it exists to enforce on discovery.ts/docker.ts/access.ts"

patterns-established:
  - "Any future workspace package depending on packages/domain across a turbo boundaries tag boundary must be added to pure-domain's own allow list too (not just its own tag's allow list) — turbo boundaries checks both directions of an edge against BOTH tags' allow lists"
  - "A stub-then-replace pattern for forward references across tasks in the same plan: when Task N's contract needs a type Task N+1 defines, Task N ships a minimal same-shape stub so the build stays green after every task, and Task N+1 fully replaces the stub's content (not just adds to it)"

requirements-completed: [SEC-04, SERV-07]

# Metrics
duration: ~55min (wall-clock git commit timestamps span longer due to sandbox/session gaps, not continuous active work)
completed: 2026-09-13
---

# Phase 2 Plan 1: packages/ssh scaffold, SshPort contracts, discovery types, frozen allowlist Summary

**`@noodara/ssh` workspace package (ADR 0003 contract, ssh2@1.17.0 contained via boundary.test.ts), the full SshPort/ConnectOutcome/ExecResult adapter contract surface, DiscoverySnapshot types in packages/domain, and a frozen 11-entry SSH command allowlist with a TDD-built exactness guard (SEC-04).**

## Performance

- **Duration:** ~55 min active work
- **Tasks:** 4 completed (Task 4 via RED→GREEN TDD)
- **Files modified:** 23 (15 created, 8 modified)

## Accomplishments
- `packages/ssh` builds to `dist`, resolves as `@noodara/ssh` under plain Node (`node -e "import('@noodara/ssh')"` exits 0) and via Vitest's source alias, with `ssh2` as its only production dependency and a machine-enforced containment guard
- Declared every adapter-boundary type (`SshPort`, `SshTarget`, `SshCredential`, `SshTimeouts`, `HostFingerprint`, `ExecResult`, `SshSession`, `ConnectInput`, `ConnectOutcome`) and every discovery result type (`DiscoveryCheck`, `DiscoveryFacts`, `DiscoverySnapshot`, `DISCOVERY_CHECK_IDS`) so the remaining seven phase-2 plans have zero contracts left to invent
- Built the frozen, SEC-04 command allowlist through a full RED→GREEN TDD cycle: 26 tests cover the 11-entry exactness guard, the no-`${`/backtick/`$(` guards, `access.sudo`/`docker.version` specifics, `CommandName`↔`DiscoveryCheckId` correspondence, and a real POSIX-shell round-trip for `escapeShellArg`
- Diagnosed and fixed a turbo boundaries behavior gap (undirected tag-adjacency checking) that the plan's own stated config didn't anticipate, without weakening the actual domain→ssh containment guarantee (which lives in `purity.test.ts`, independently verified)

## Task Commits

1. **Task 1: Scaffold packages/ssh as a workspace package and contain ssh2 to it** - `4ee2c5b` (feat)
2. **Task 2: Shared workspace wiring — boundaries, passThroughEnv and the vitest source aliases** - `f61be0d` (feat)
3. **Task 3: Adapter boundary contracts and domain discovery result types** - `9f4076d` (feat)
4. **Task 4: Frozen command allowlist with an exactness guard (SEC-04)** - `62cae63` (test, RED) → `7d668c3` (feat, GREEN)

**Plan metadata:** (this commit) `docs: complete plan`

## Files Created/Modified
- `packages/ssh/package.json` - `@noodara/ssh` workspace package, exports map to dist, ssh2@1.17.0 + @noodara/domain deps
- `packages/ssh/tsconfig.json` / `tsconfig.build.json` - mirrors packages/domain's build config, excludes `src/testing/**` from dist
- `packages/ssh/turbo.json` - `ssh-adapter` tag
- `packages/ssh/src/boundary.test.ts` - fails the suite if `ssh2` is imported outside `packages/ssh`, or if its dependency set drifts from `['@noodara/domain', 'ssh2']`
- `packages/ssh/src/ssh-port.ts` - `SshPort` and every adapter-boundary type
- `packages/ssh/src/commands/{discovery,docker,access}.ts` - the 11 fixed command-template literals, split by concern
- `packages/ssh/src/commands/allowlist.ts` - `COMMAND_TEMPLATES`, `COMMAND_NAMES`, `CommandName`, `commandFor()`, `escapeShellArg()`
- `packages/ssh/src/commands/allowlist.test.ts` - 26 tests, the RED half of Task 4's TDD cycle
- `packages/ssh/src/commands/index.ts` / `packages/ssh/src/index.ts` - real barrels (replacing Task 1/3's placeholders)
- `packages/domain/src/discovery/types.ts` / `index.ts` - `DiscoverySnapshot` and friends
- `packages/domain/src/index.ts` / `package.json` - sixth `./discovery` entrypoint
- `turbo.json` - `ssh-adapter` boundaries tag, `pure-domain`'s allow list extended with `ssh-adapter`, three `NOODARA_SSH_*` timeout vars added to `dev`'s `passThroughEnv`
- `package.json` - `@noodara/ssh` added as a root devDependency
- `vitest.shared.ts` / `vitest.config.ts` / `vitest.integration.config.ts` - `sshSourceAliases`, `@noodara/domain/discovery` alias, `packages/ssh/src/testing/**` coverage exclude
- `.planning/phases/02-.../deferred-items.md` - logged a pre-existing, out-of-scope coverage-reporting gap found during verification

## Decisions Made
See `key-decisions` in frontmatter. Summary: (1) turbo boundaries' allow lists had to be extended on both `pure-domain` and `ssh-adapter` tags — an undirected-adjacency behavior, not a bug in this plan's config, confirmed by reproducing the failure with the unmodified phase-1 `pure-domain` rule alone; (2) a minimal `CommandName` stub in Task 3 resolves the plan's own forward reference to Task 4; (3) no new row in `docs/adr/0000-package-legitimacy-approvals.md` since `ssh2` wasn't flagged; (4) `allowlist.test.ts`'s own fixtures avoid the literal markers they assert templates never contain.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] turbo boundaries required `pure-domain`'s allow list to include `ssh-adapter`, not just the reverse**
- **Found during:** Task 2 verification (`pnpm boundaries`)
- **Issue:** The plan's Task 2 instructed adding an `ssh-adapter` tag with `dependencies.allow: ["pure-domain", "@noodara/config"]` and explicitly said to leave `pure-domain`'s existing rule untouched, asserting it "already forbids packages/domain from importing packages/ssh." With only that change, `pnpm boundaries` failed on the `@noodara/ssh -> @noodara/domain` edge (`Package @noodara/ssh found without any tag listed in allowlist for @noodara/domain`). Reproduced with the original, un-edited phase-1 `pure-domain` rule in isolation (via a temporary file swap, restored immediately after) to confirm this is turbo's actual behavior for this edge, not a mistake introduced by other 02-01 edits.
- **Fix:** Added `"ssh-adapter"` to `pure-domain`'s own `dependencies.allow` array. The real "domain cannot depend on ssh" guarantee remains fully intact via `packages/domain/src/purity.test.ts`'s independent, frozen `['zod']`-only dependency check and its "never imports another @noodara/ package" source scan — verified by temporarily adding `@noodara/ssh` to `packages/domain/package.json` and confirming `purity.test.ts` failed as expected, then reverting.
- **Files modified:** `turbo.json`
- **Verification:** `pnpm boundaries` exits 0; `purity.test.ts` still independently blocks domain→ssh
- **Committed in:** `f61be0d` (Task 2 commit)

**2. [Rule 3 - Blocking] Task 3's `ssh-port.ts` imports `CommandName` from a file Task 4 doesn't create until later**
- **Found during:** Task 3 (`import type { CommandName } from './commands/index.js'`)
- **Issue:** The plan's own Task 3 text says "Task 4 defines it" for `./commands/index.js`, but Task 3's verification requires `pnpm build && pnpm typecheck && pnpm lint` to exit 0 at the end of Task 3 — impossible if the imported module doesn't exist yet.
- **Fix:** Added a minimal `packages/ssh/src/commands/index.ts` stub (`export type CommandName = string;`) in Task 3, fully replaced by Task 4's real barrel.
- **Files modified:** `packages/ssh/src/commands/index.ts` (created in Task 3, replaced in Task 4)
- **Verification:** `pnpm build && pnpm typecheck && pnpm lint` exit 0 after Task 3; the stub is gone (real barrel in place) after Task 4
- **Committed in:** `9f4076d` (Task 3), `7d668c3` (Task 4)

**3. [Rule 1 - Bug] `ssh-port.ts` doc comment tripped the `process.env` acceptance grep**
- **Found during:** Task 3 acceptance check (`grep -c 'process.env' packages/ssh/src/ssh-port.ts` expected 0)
- **Issue:** A doc comment reading "nothing in packages/ssh may read `process.env` directly" matched the grep's regex (`.` matches any character), since "process environment" also matched due to `env` following any single character after `process`.
- **Fix:** Reworded the comment to "environment variables" instead of "process.env" / "process environment".
- **Files modified:** `packages/ssh/src/ssh-port.ts`
- **Verification:** `grep -c 'process.env' packages/ssh/src/ssh-port.ts` returns 0
- **Committed in:** `9f4076d` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 turbo-boundaries config bug, 1 blocking forward-reference, 1 acceptance-grep wording fix)
**Impact on plan:** All three necessary to satisfy the plan's own stated verification commands. No scope creep — no behavior beyond what the plan specified was added.

## Issues Encountered
- `pnpm --filter @noodara/ssh add ssh2@1.17.0` was run with an incorrect flag order the first time (`pnpm install --filter @noodara/ssh add ssh2@1.17.0`), which pnpm interpreted as installing a package literally named `add` into `packages/ssh/package.json`. Caught immediately via `git status`/lockfile inspection before it reached any commit; removed with `pnpm remove --filter @noodara/ssh add` and re-verified the lockfile contained no `add` entry.
- `pnpm test --coverage`'s text/lcov reporter omits `packages/*` rows entirely (only `apps/control-plane/src` prints), so `packages/domain/**`'s QA-02 95%/95% threshold isn't visibly confirmed by the printed report. Confirmed this predates 02-01 (reproduced identically with `vitest.config.ts` reverted to its pre-02-01 content) — logged to `deferred-items.md`, not fixed here (out of scope).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `SshPort`, `ConnectOutcome`, `ExecResult`, `HostFingerprint`, `DiscoverySnapshot` and the 11-entry command allowlist are all in place, type-checked, and tested — plans 02-02 through 02-10 can implement against these names with zero contract exploration.
- `docker version`/`docker compose version` output parsers, `ssh2`-error-to-`ServerErrorCode` classification, TOFU fingerprint capture/verification, and `runDiscovery` itself are all still unimplemented — this plan is declaration-only by design (see `<objective>`).
- No blockers for 02-02.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-13*

## Self-Check: PASSED

- All 16 created files verified present on disk (`packages/ssh/**`, `packages/domain/src/discovery/**`, `deferred-items.md`).
- All 5 task commit hashes (`4ee2c5b`, `f61be0d`, `9f4076d`, `62cae63`, `7d668c3`) verified present in `git log`.
