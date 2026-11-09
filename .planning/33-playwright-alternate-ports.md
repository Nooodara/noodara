# Phase 33 amendment — Alternate Playwright host ports

Status: independently hardened; no port-support implementation. Requirement: QA-22.

## Objective

Allow the Playwright stack to use explicit alternative web/API host ports while
preserving existing local processes. Complete the exact `security:scan-leaks`
gate for 33-03 without changing assertions, skipping its Playwright stage or
stopping the unrelated listener on 3000.

## Confirmed context

- 33-01 and 33-02 are done (`ad2ab5b8`, `d784c8a0`). Their gates passed.
- 33-03 has uncommitted fixture/canary/review work, including focused canary2 and
  fixture27 PASS. Preserve this work and its evidence; full gates/review are pending.
- `playwright.config.ts` fixes `baseURL` to localhost3000.
- `tests/e2e/fixtures/stack.ts` fixes API3100/web3000, derives the build/runtime API
  origin, and explicitly sets the API port but does not pass the web port to Next.
  Teardown checks the fixed pair. Existing process handles and run labels own cleanup.
- Legitimate host-origin literals also exist in canary-ui, settings, theme-first-paint,
  deploy, projects-dod and the engine fixture. The engine's `APP_PORT=3000` describes
  a deployed application container, not the E2E web host; preserve it.
- `buildWorkspace` honors an exported `NOODARA_API_ORIGIN`; Turbo already hashes
  that variable for builds. Keep this mechanism so Next rewrites target the chosen API.
- Integration's `NOODARA_TEST_PORT_OVERRIDE` only affects its separate precheck.
  It does not configure Playwright. No existing E2E port override was found.

## Plan and sequencing

Add **33-04** in the existing phase, after completed33-02 and before33-03:

```text
33-01 done → 33-02 done → 33-04 planned → 33-03 pending → independent phase review
```

33-04 is wave3/deep. 33-03 moves to wave4 and depends on both33-02 and33-04.
Completed tasks and historical phases stay intact. This is an explicit plan amendment,
not permission to change files outside the newly authored task scopes.

33-04 implements one small test-only port resolver, wires all consumers and adds
meaningful configuration/lifecycle regressions. Its scope explicitly includes the
Playwright config, shared resolver, stack and affected specs, unit tests,
test-run documentation, evidence and agent-flow metadata. Do not place Vitest
unit files inside Playwright's `testDir`; use `tests/unit/e2e/`.

Use `NOODARA_E2E_WEB_PORT` / `NOODARA_E2E_API_PORT`, defaulting only when absent
to3000/3100. Accept decimal integer ports1..65535 and reject invalid/empty/equal
selections before any build or resource allocation. Partial overrides are allowed
when the resolved pair remains valid. The hostname/scheme stay localhost/http;
no arbitrary URL, production env setting or automatic free-port fallback is added.

Keep selected ports/origins consistent in config.baseURL, Stack.baseUrl, API and
Next `PORT`, build/runtime API origin, public web origin, worker env, Origin headers,
cookies and token URL expectations. Preserve same-origin routing and CSRF guards.
Defaults must remain backward compatible in CI and existing local commands.

Preflight only selected ports. If one is busy, fail clearly before creating
resources and never attach to or stop the foreign listener. Test partial failures
and normal/idempotent cleanup: only owned processes/groups and run-labelled
containers may be removed; never blindly kill by port or check unrelated defaults
as evidence of an orphan. Preserve existing bounded cleanup.

## Acceptance and verification

Structured acceptance criteria A1–A7 and exact file scopes are in `plan.json`.
They cover RED-first validation, origin propagation, all affected literals,
collision/ownership cleanup, a real alternate-port smoke, documentation and safe diagnostics.

33-04 gates: `test`, `typecheck`, `lint`, `boundaries`, `e2e-port-compat`.
The new gate runs the existing canary-ui, settings and theme-first-paint specs with
web33993/API33994. It provides real browser/auth/origin coverage, rather than
tests that only copy source strings. Record evidence that the unrelated listener3000
survives and that selected test ports/resources are released. Unit tests cover the
unchanged default pair; a default-port real smoke requires a free isolated environment.

After33-04 passes, resume33-03's **original eight gates unchanged**, then record an
independent tier-1 phase verdict before advance/closure. Expected invocation after
implementation (confirm selected ports are free; keep unrelated processes):

```sh
DOCKER_HOST=unix:///Users/xch4rt/.docker/run/docker.sock \
NOODARA_TEST_PORT_OVERRIDE=33992 \
NOODARA_E2E_WEB_PORT=33993 NOODARA_E2E_API_PORT=33994 \
agent-flow gate --task 33-03 --strict
```

The underlying command remains `pnpm security:scan-leaks`, with both its Vitest
and Playwright stages required. The integration precheck override is independent
of the E2E pair. No change to product env validation, package versions or release
tags is planned. These commands do not claim existing gates have passed.

## Independent hardening

The hardening reviewer added33-04 H1: explicitly inject a foreign listener after
selected-port preflight but before API/web bind. Both startup paths must fail
within the bounded readiness budget, never reuse that listener or silently switch
ports, clean all already-created owned resources, and leave the foreign listener
responding.33-03 received no additional criteria; its original gates and pending
independent phase review remain mandatory. Existing documented waivers stay unchanged.

## Risks, assumptions and waivers

- Assumption: the example alternative ports are free at execution. If not, choose
  and record another explicit valid pair; never displace a listener. There is a
  normal check/bind race; failure cleanup must still only touch owned handles.
- Wrong Next build origin can pass static configuration tests but route API calls
  to another app. Exercise authenticated API access through the real web proxy.
- A leftover literal in a spec can target an unrelated service. Audit legitimate
  host origins without replacing container-internal ports or negative-origin tests.
- Defaults and alternatives must use the same resolver. Reject ambiguous values
  instead of silently accepting malformed env values or letting Next choose a port.
- This permits one E2E run to coexist with unrelated listeners; it does not promise
  parallel E2E suites. Existing shared test-results/manifests/build outputs remain
  serialized; workers/retries and resource-leak guards are unchanged.
- No new public HTTP input or persistence format is introduced. The HTTP-input,
  body-cap, arbitrary-URL and file-persistence pitfall waivers are limited to this
  test harness; local env-port validation and resource lifecycle remain mandatory.
- The randomness/crypto-random warning is consciously waived: ports are explicit
  deterministic configuration, not secrets or random allocations. Existing random
  run IDs/credentials stay in their existing modules. Diagnostics must not echo
  raw invalid env values, token URLs, credentials or boot env objects (A7).
- Password hashing is waived for33-04: it only routes existing authentication
  fixtures to a selected origin and does not create/change password storage or
  backend authentication. Existing hashing and canary coverage remain unchanged.

## Continuity

Update STATE, requirement QA-22 and dependency order; append planning evidence to
memory without rewriting existing entries. Store future sanitized port smoke
evidence in `docs/security/legacy-runtime-log-redaction/ports/`. Keep33-03 WIP
separate from claims of completed verification. M2 and SEC requirements remain open
until the full original gates and independent phase review pass.

Recommended next commands:

```text
/flow-orchestrate
```
