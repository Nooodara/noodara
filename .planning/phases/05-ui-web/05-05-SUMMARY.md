---
phase: 05-ui-web
plan: 05
subsystem: api
tags: [discovery, zod, drift-guard, canary, fastify]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-04's server.discovery_progress SSE event and its { serverId, check } shape, which this plan's canary extension scans"
provides:
  - "readLatestDiscovery(deps, serverId): the latest discovery_snapshots row projected to exactly collectedAt/outcome/checks/warnings, dropping facts and any unknown payload key"
  - "GET /api/servers/:id/discovery: the ninth /api/servers route, session-guarded, 200 with the empty shape for a server with no discovery history (never 404), 404 for an unknown server id"
  - "DiscoveryCheckSchema/DiscoveryReadResponseSchema: Zod response schema built from DISCOVERY_CHECK_IDS/DISCOVERY_CHECK_STATUSES with a drift guard, .strict() against extra keys"
  - "canary-http.test.ts extended to scan the new endpoint's response body and a genuine server.discovery_progress SSE frame for secret leakage (QA-05, D-05 fourth clause)"
affects: [05-18]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Explicit-allowlist-plus-drift-guard schema (DiscoveryCheckSchema/DiscoveryReadResponseSchema built from DISCOVERY_CHECK_IDS/DISCOVERY_CHECK_STATUSES), same discipline as ServerViewSchema/assertServerViewSchemaKeysMatch"
    - "Read service with absence-as-value (all-null/empty LatestDiscoveryView), no transaction, no activity event — same discipline as read-servers.ts"

key-files:
  created:
    - apps/control-plane/src/services/read-discovery.ts
    - tests/integration/services/read-discovery.test.ts
    - tests/integration/routes/servers-discovery-read.test.ts
  modified:
    - apps/control-plane/src/services/server-services.ts
    - apps/control-plane/src/routes/server-schemas.ts
    - apps/control-plane/src/routes/server-schemas.test.ts
    - apps/control-plane/src/routes/servers.ts
    - tests/integration/activity/canary-http.test.ts
    - tests/integration/services/fail-in-flight-connection.test.ts
    - tests/integration/services/read-servers.test.ts
    - tests/integration/services/trust-fingerprint.test.ts

key-decisions:
  - "The route handler spreads readLatestDiscovery's readonly checks/warnings arrays into plain mutable arrays before reply.send() — the response serializer's inferred type wants mutable arrays, and this keeps the service's own readonly contract (matching DiscoveryCheck's domain shape) unchanged rather than loosening it"
  - "Task 1's four behaviours live in a dedicated tests/integration/services/read-discovery.test.ts (not folded into the route test), since Task 1 itself is tdd=true and needs its own RED/GREEN pair independent of Task 3's route"
  - "DiscoveryReadResponseSchema's collectedAt follows ServerViewSchema's existing z.date().nullable() convention (validates a real Date instance; JSON.stringify's own Date.prototype.toJSON produces the ISO string on the wire), not a z.iso.datetime() string schema"

requirements-completed: [DISC-02, QA-05]

# Metrics
duration: 21min
completed: 2026-09-19
---

# Phase 05 Plan 05: Discovery read endpoint Summary

**GET /api/servers/:id/discovery serves the latest discovery run's checks/outcome/warnings through a drift-guarded, .strict() Zod schema, and the HTTP secrets canary now scans both this endpoint and server.discovery_progress SSE frames.**

## Performance

- **Duration:** ~21 min (commit span; excludes file-reading/context-gathering time)
- **Started:** 2026-09-19T08:44:14-06:00
- **Completed:** 2026-09-19T09:05:11-06:00
- **Tasks:** 3
- **Files modified:** 11 (3 created, 8 modified)

## Accomplishments
- `readLatestDiscovery` reads `discovery_snapshots` ordered by `collected_at desc, limit 1`, projecting only `collectedAt`/`outcome`/`checks`/`warnings` — `facts` and any other stored payload key are deliberately dropped, and a malformed/missing `checks`/`warnings` array in the `jsonb` payload defensively yields `[]` rather than throwing; joined the `ServerServices` facade as its eleventh member
- `DiscoveryCheckSchema`/`DiscoveryReadResponseSchema` are built directly from `DISCOVERY_CHECK_IDS`/`DISCOVERY_CHECK_STATUSES` (never re-typed by hand), with a drift-guard assertion (`assertDiscoveryCheckSchemaLiteralsMatch`) mirroring `ServerViewSchema`'s own guard; the response schema is `.strict()` so an accidental extra field (notably `facts`) fails serialization instead of leaking
- The ninth `/api/servers` route — `GET /api/servers/:id/discovery` — sits inside the existing session-guarded `/api` scope, returns 200 with the all-null/empty shape for a server with no discovery history (never 404), and 404 only when the server itself doesn't exist
- `canary-http.test.ts` now also GETs the new endpoint after a real `connectAndDiscover` run and scans its body, and asserts a genuine `server.discovery_progress` frame reached the already-open SSE stream before scanning that stream for the per-run password/passphrase canaries — closing D-05's fourth clause

## Task Commits

Each task was committed atomically (TDD RED → GREEN):

1. **Task 1: readLatestDiscovery service and its facade entry**
   - `ca3f55b` test(05-05): add failing tests for readLatestDiscovery
   - `f6185b1` feat(05-05): add readLatestDiscovery service and facade entry
2. **Task 2: Zod response schema with a drift guard**
   - `8885319` test(05-05): add failing tests for discovery response schema
   - `6c88bd4` feat(05-05): add discovery response schema with tuple drift guard
3. **Task 3: The route, plus canary coverage for both new surfaces**
   - `00452a4` test(05-05): add failing tests for discovery read route
   - `6be5061` feat(05-05): add GET /api/servers/:id/discovery route
   - `056ba90` test(05-05): extend HTTP canary for discovery read endpoint and SSE
   - `8124cff` fix(05-05): update facade membership tests for readLatestDiscovery (deviation, see below)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `apps/control-plane/src/services/read-discovery.ts` - `readLatestDiscovery(deps, serverId)`: selects the newest `discovery_snapshots` row's `collectedAt`/`outcome`/`payload`, defensively projects `checks`/`warnings` off the `jsonb` payload, returns the all-null/empty shape for no row
- `tests/integration/services/read-discovery.test.ts` - Four behaviours: newer-snapshot selection over an older one, empty-absence shape, exactly-four-keys/no-facts-forwarded, malformed-payload resilience
- `apps/control-plane/src/services/server-services.ts` - `readLatestDiscovery` added to the `ServerServices` interface and factory (now eleven members); `LatestDiscoveryView` re-exported
- `apps/control-plane/src/routes/server-schemas.ts` - `DiscoveryCheckSchema`, `assertDiscoveryCheckSchemaLiteralsMatch`, `DiscoveryReadResponseSchema` (`.strict()`)
- `apps/control-plane/src/routes/server-schemas.test.ts` - Check-schema validation (well-formed/unknown id/unknown status/missing detail/non-numeric durationMs), the tuple drift guard, response-schema empty/populated/extra-key cases
- `apps/control-plane/src/routes/servers.ts` - Ninth route `GET /api/servers/:id/discovery`: 404 via `getServer` first, then `readLatestDiscovery`, response spread into mutable arrays before `reply.send()`
- `tests/integration/routes/servers-discovery-read.test.ts` - The 200 (populated)/200 (empty)/404/401/400 matrix against the real HTTP surface
- `tests/integration/activity/canary-http.test.ts` - Added a GET of the new endpoint (Act 6) scanned alongside existing success/error bodies, plus a non-vacuity assertion that a genuine `server.discovery_progress` frame reached the open SSE stream before the canary-absence scan of that stream
- `tests/integration/services/fail-in-flight-connection.test.ts`, `read-servers.test.ts`, `trust-fingerprint.test.ts` - Three pre-existing hardcoded `ServerServices` key-count assertions updated from ten to eleven members (deviation, see below)

## Decisions Made
- Task 1's four behaviours were written in a dedicated `tests/integration/services/read-discovery.test.ts` rather than folded into Task 3's route test, since Task 1 is itself `tdd="true"` and needed its own independent RED/GREEN pair
- The route handler spreads `readLatestDiscovery`'s `readonly` `checks`/`warnings` arrays into plain arrays at the `reply.send()` call site instead of loosening the service's own readonly return type, keeping `LatestDiscoveryView` consistent with `DiscoveryCheck`'s domain-level readonly shape
- `DiscoveryReadResponseSchema.collectedAt` uses the existing `z.date().nullable()` convention from `ServerViewSchema` (validates a `Date` instance; wire serialization is `Date.prototype.toJSON` via `JSON.stringify`), not a string-typed ISO schema, for consistency with every other timestamp field already on that schema

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Three pre-existing facade-membership tests hardcoded a stale ten-member key list**
- **Found during:** Task 1/plan-wide verification — running the full `tests/integration/services` suite after Task 1 landed the eleventh facade member (`readLatestDiscovery`)
- **Issue:** `tests/integration/services/read-servers.test.ts`, `trust-fingerprint.test.ts` and `fail-in-flight-connection.test.ts` each asserted `Object.keys(services).sort()` against a hand-written ten-member array (a pattern already established by Plan 04-10's own equivalent nine-to-ten update) — adding `readLatestDiscovery` to the factory broke all three
- **Fix:** Updated each hardcoded array to include `readLatestDiscovery` and bumped the descriptive comments/test names from "ten members" to "eleven members", following the same update pattern the 04-10 plan itself used when it grew the facade from nine to ten
- **Files modified:** `tests/integration/services/fail-in-flight-connection.test.ts`, `tests/integration/services/read-servers.test.ts`, `tests/integration/services/trust-fingerprint.test.ts`
- **Verification:** `pnpm test:integration tests/integration/routes/servers-discovery-read.test.ts tests/integration/services` — 11 files, 153/153 passed
- **Committed in:** `8124cff`

---

**Total deviations:** 1 auto-fixed (1 bug — stale test expectations, no behavior change)
**Impact on plan:** Purely mechanical; a direct, expected consequence of Task 1 growing the facade, not scope creep.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The detail page (Plan 05-18, per this plan's own `<interfaces>` block) can now cold-load the last completed discovery run via `GET /api/servers/:id/discovery`'s `{ collectedAt, outcome, checks, warnings }` shape, with `DiscoveryCheck` identical to `packages/domain/src/discovery/types.ts`'s interface
- Both DISC-02 backend surfaces this phase added (the SSE progress event from 05-04, and this plan's read endpoint) are inside `pnpm security:scan-leaks`'s canary coverage
- Full verification suite green: `pnpm test` (896/896 unit), `pnpm test:integration tests/integration/routes/servers-discovery-read.test.ts tests/integration/services` (153/153), `pnpm security:scan-leaks` (3/3), `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`
- No blockers for 05-18

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

All modified/created files confirmed present on disk; all 9 task commit hashes confirmed present in git history.
