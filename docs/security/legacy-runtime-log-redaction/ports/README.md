# 33-04 port compatibility evidence

No production or dev knobs changed. Existing 33-03 source and evidence remain in the worktree.

Sanitized commands:

```sh
pnpm exec vitest run tests/unit/e2e/ports.test.ts
pnpm exec vitest run tests/unit/e2e/stack-ports.test.ts
pnpm exec vitest run tests/unit/e2e/ports.test.ts tests/unit/e2e/stack-ports.test.ts
pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit
NOODARA_E2E_WEB_PORT=33993 NOODARA_E2E_API_PORT=33994 pnpm exec playwright test tests/e2e/canary-ui.spec.ts tests/e2e/settings.spec.ts tests/e2e/theme-first-paint.spec.ts
```

- `resolver-red.txt`: test-first missing shared resolver failure.
- `lifecycle-red.txt`: 7/7 lifecycle tests fail against the original stack.
- `focused-green.txt`: 28/28 resolver/lifecycle tests pass. Real owned Node listeners exercise
  both selected API/web check/bind races with a 2-second test readiness cap below the unchanged
  60-second stack budget. Foreign listener responds after failure; other port binds again.
- `e2e-port-compat.txt`: 25/25 real browser specs pass in 1.1m, retries remain zero.
- `built-rewrites.json`: built `/api/*` and webhook destinations use selected API port 33994.
- `default-api-listener-during.txt`: empty; no default API listener on 3100 during this run.
  Successful authenticated same-origin mutations/settings through web 33993 therefore reach
  the selected API, rather than a cached/default origin.
- `listener-3000-before.txt` and `listener-3000-after.txt`: identical existing limactl PID and
  file descriptor; no process arguments or environment captured.
- `cleanup-proof.json`: both selected ports bind after teardown, zero run/test containers,
  run temp directory removed, unrelated 3000 listener identity unchanged.
- `source-proof.json`: HEAD and SHA-256 hashes for scoped implementation and preserved 33-03
  fixture/test sources. No commit, release, tag or provider actions.

Harness typecheck passed. An extra direct ESLint invocation (outside normal workspace lint)
reported existing E2E style errors and excludes playwright.config.ts from project service;
no production lint configuration was changed. Root executor runs authoritative full test,
typecheck, lint, boundaries and compatibility gates before task advancement.

Default pair behavior is covered by unit regression. A real default smoke was deliberately
not attempted because the unrelated listener on 3000 must remain untouched.
