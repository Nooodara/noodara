# Deferred Items — Phase 03

Out-of-scope discoveries logged during plan execution, per the executor's scope-boundary rule
(pre-existing issues unrelated to the current task's changes are not auto-fixed).

## 03-10: full `pnpm test:integration` cascades into mass failure on this shared dev machine

**Found during:** 03-10's overall `<verification>` pass, after both tasks' own `<verify>`
commands (the new file alone, and `pnpm security:scan-leaks` running both canaries together)
already passed cleanly twice each with zero stray `noodara.test=true` containers.

**Observation:** a full `pnpm test:integration` run (234/311 tests failed) shows every failure
after a certain point in `tests/integration/ssh/*.test.ts` reporting the identical
`assertNoStrayTestContainers` assertion failure (`expected [...] to have a length of +0 but got
2`) — a classic cascading-failure signature: one earlier test in the sequential
(`fileParallelism: false`) run left exactly 2 containers labelled `noodara.test=true` running,
and every subsequent file's own `afterEach` then also fails against that same pre-existing pair,
regardless of which file it is or what it tests.

**Confirmed pre-existing and unrelated to 03-10:** this plan's diff touches only
`tests/integration/activity/canary-full-flow.test.ts`, `package.json` and
`.github/workflows/ci.yml` — none of `packages/ssh/**` or `tests/integration/ssh/**` (the files
where every failure occurred) import or depend on any of them. Re-running
`tests/integration/ssh/images.test.ts` (the file whose own container-lifecycle assertions are
most directly relevant) in isolation immediately afterward passed cleanly, 16/16, with the
expected two-container-build wait time (~252s) and zero stray containers left behind — proving
the file itself has no bug and the mass failure was a transient resource-contention artifact of
running the full ~19-minute, multi-image-build suite on this specific shared dev machine.
STATE.md's own Blockers/Concerns section already documents this exact machine's Docker host as
carrying 2000+ images from unrelated projects and having produced an unmeasured/flaky cold
`pnpm test:integration` run once before (02-10).

**Verified instead:** each task's own `<verify>` command (the new file alone, twice; `pnpm
security:scan-leaks` running both canaries together, once) passed with zero stray containers
after each run. `pnpm test` (739 unit tests), `pnpm typecheck`, `pnpm lint` and `pnpm exec turbo
boundaries` all pass. `tests/integration/ssh/images.test.ts` passes in isolation.

**Not fixed here:** out of scope per the scope-boundary rule (a pre-existing, machine-specific
flake in files this plan does not touch, not a regression introduced by this plan's three
modified files). Left for a future dedicated investigation into why a long, heavy
`pnpm test:integration` run occasionally leaves exactly 2 containers behind on this machine —
candidates include Testcontainers' Ryuk reaper being starved under this host's very high
pre-existing container count, or a slow `docker stop` racing the next file's own setup under load.
