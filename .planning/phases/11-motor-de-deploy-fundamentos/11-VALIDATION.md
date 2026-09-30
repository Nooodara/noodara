---
phase: 11
slug: motor-de-deploy-fundamentos
status: ready
nyquist_compliant: true
wave_0_complete: false
created: 2026-09-29
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (unit) + Testcontainers (integration), already configured |
| **Config file** | `vitest.config.ts` (root); `tests/integration` runs via `pnpm test:integration` |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test && pnpm test:integration` |
| **Estimated runtime** | ~30 s unit / several minutes integration (Docker image build + sshd+dockerd fixture) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test:integration`
- **Before `/gsd:verify-work`:** Full suite must be green and ADR 0008 must be `Accepted`
- **Max feedback latency:** 60 s (unit); integration accepted as slower gate per wave

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 11-01 | 1 | DEP-01, DEP-08 | — | 7-state FSM, 49-pair exhaustive transition table, terminal states closed | unit | `pnpm exec vitest run packages/domain/src/deployment/deployment-state.test.ts` | ❌ W0 | ⬜ pending |
| 11-01-02 | 11-01 | 1 | DEP-01, DEP-08 | — | closed error vocabulary; UNKNOWN distinct from STOPPED | unit | `pnpm exec vitest run packages/domain/src/deployment/deployment-error.test.ts packages/domain/src/deployment/service-status.test.ts` | ❌ W0 | ⬜ pending |
| 11-01-03 | 11-01 | 1 | DEP-01, DEP-08 | T-11-01, T-11-02 | LFS/submodules probe -> UNSUPPORTED_REPOSITORY_FEATURE; malformed probe never "supported" | unit | `pnpm exec vitest run packages/domain tests/unit/scripts/vitest-aliases.test.ts && pnpm --filter @noodara/domain typecheck && pnpm --filter @noodara/domain build` | ✅ | ⬜ pending |
| 11-02-01 | 11-02 | 1 | SVC-08, DEP-08 | T-11-03, T-11-04, T-11-05, T-11-06 | repo URL/branch reject metachar, whitespace, bad schemes, userinfo, `..`, private hosts | unit | `pnpm exec vitest run packages/domain/src/validators/git.test.ts` | ❌ W0 | ⬜ pending |
| 11-02-02 | 11-02 | 1 | SVC-08, DEP-08 | T-11-03, T-11-04 | image ref requires tag/digest; paths/names only from validated UUIDs; leading `-` rejected | unit | `pnpm exec vitest run packages/domain/src/validators/docker-naming.test.ts` | ❌ W0 | ⬜ pending |
| 11-02-03 | 11-02 | 1 | SVC-08, DEP-08 | — | ServiceSource rejects buildArgs/env keys (DEP-08) | unit | `pnpm exec vitest run packages/domain && pnpm --filter @noodara/domain typecheck` | ❌ W0 | ⬜ pending |
| 11-03-01 | 11-03 | 1 | QA-07, QA-10 | T-11-07 | no key/password baked into images; install.sh Docker package set | integration | `sh -n tests/integration/images/sshd-dockerd-common/entrypoint.sh && sh -n tests/integration/images/sshd-dockerd-common/setup-git-host.sh && docker build -f tests/integration/images/sshd-dockerd-ubuntu-24.04/Dockerfile --label noodara.test=true -t noodara-test/sshd-dockerd:24.04-check tests/integration/images && docker image rm noodara-test/sshd-dockerd:24.04-check` | ❌ W0 | ⬜ pending |
| 11-03-02 | 11-03 | 1 | QA-07, QA-10 | T-11-07 | per-run secrets, htpasswd registry, no stray noodara.test resources (G7 mechanism user-confirmed) | integration | `NOODARA_TEST_UBUNTU=24.04 pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/harness.test.ts && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 11-03-03 | 11-03 | 1 | QA-07, QA-10 | T-11-08 | D-11 matrix; stray containers and networks fail CI | static/grep | `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8');if(!y.includes('NOODARA_TEST_UBUNTU'))process.exit(1)" && node -e "const y=require('fs').readFileSync('.github/workflows/nightly.yml','utf8');if(!y.includes('tests/integration/deploy-engine')\|\|!y.includes('NOODARA_TEST_UBUNTU=all'))process.exit(1)" && pnpm exec vitest run tests/unit` | ✅ | ⬜ pending |
| 11-04-01 | 11-04 | 1 | QA-07 | T-11-10, T-11-11 | digest-pinned FROM, .dockerignore excludes secrets, context < 1 MiB (RED) | unit | `pnpm exec vitest run tests/unit/fixtures/official-fixtures.test.ts; test $? -ne 0` | ❌ W0 | ⬜ pending |
| 11-04-02 | 11-04 | 1 | QA-07 | — | fixtures pass the guard; deterministic failure exit 42 | integration | `pnpm exec vitest run tests/unit/fixtures/official-fixtures.test.ts && docker build --label noodara.test=true -t noodara-test/node-api-check fixtures/node-api && docker image rm noodara-test/node-api-check` | ❌ W0 | ⬜ pending |
| 11-05-01 | 11-05 | 2 | PROJ-04, DEP-01, DEP-08 | T-11-12, T-11-13, T-11-14, T-11-15 | cross-project insert 23503, second active deployment 23505, credential RESTRICT (RED) | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/schema-ownership.test.ts; test $? -ne 0` | ✅ | ⬜ pending |
| 11-05-02 | 11-05 | 2 | PROJ-04, DEP-01, DEP-08 | — | defensive DDL; new credential enum values never referenced in any migration | integration | `pnpm --filter @noodara/control-plane typecheck && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migration-hygiene.test.ts` | ✅ | ⬜ pending |
| 11-05-03 | 11-05 | 2 | PROJ-04, DEP-01, DEP-08 | T-11-12, T-11-15 | [BLOCKING] pnpm db:migrate on real PostgreSQL; clean from scratch and from 0004 | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db` | ✅ | ⬜ pending |
| 11-06-01 | 11-06 | 2 | QA-10 | T-11-16, T-11-17 | secret never in ps/environ/sshd logs/.git/config; registry creds confined to workspace | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/contracts-g1-g2.test.ts -t "G1"` | ❌ W0 | ⬜ pending |
| 11-06-02 | 11-06 | 2 | QA-10 | T-11-18 | remote process confirmed absent in ps after combined D-04 kill | integration | `NOODARA_TEST_UBUNTU=all pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/contracts-g1-g2.test.ts` | ❌ W0 | ⬜ pending |
| 11-07-01 | 11-07 | 2 | QA-10 | T-11-20 | BuildKit detected by real build, not inferred (D-03) | integration | `NOODARA_TEST_UBUNTU=all pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/contracts-g3-g4.test.ts -t "G3"` | ❌ W0 | ⬜ pending |
| 11-07-02 | 11-07 | 2 | QA-10 | T-11-21 | docker ps parsed as NDJSON; Size not computed | integration | `NOODARA_TEST_UBUNTU=all pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/contracts-g3-g4.test.ts` | ❌ W0 | ⬜ pending |
| 11-08-01 | 11-08 | 2 | QA-07 | T-11-24 | context < 1 MiB from real BuildKit output; fixtures run/fail deterministically | integration | `NOODARA_TEST_UBUNTU=24.04 pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/fixtures.test.ts -t "QA-07"` | ❌ W0 | ⬜ pending |
| 11-08-02 | 11-08 | 2 | QA-07 | T-11-22, T-11-23 | password only via stdin, absent from ps and captures | integration | `NOODARA_TEST_UBUNTU=all pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/fixtures.test.ts` | ❌ W0 | ⬜ pending |
| 11-09-01 | 11-09 | 3 | QA-10 | T-11-25 | every ADR decision cites its enforcing contract test | static/grep | `test -f docs/adr/0008-deploy-engine-empirical-contracts.md && for s in "G1" "G2" "G3" "G4" "G7" "22.04" "24.04" "contracts-g1-g2.test.ts" "contracts-g3-g4.test.ts"; do grep -q "$s" docs/adr/0008-deploy-engine-empirical-contracts.md \|\| { echo "missing $s"; exit 1; }; done` | ❌ W0 | ⬜ pending |
| 11-09-02 | 11-09 | 3 | QA-10 | T-11-26 | stale 10-state/naming guidance removed | static/grep | `grep -q "noodara-net-<serviceId>" .claude/skills/noodara-domain-model/SKILL.md && ! grep -q "noodara-<project>-<environment>" .claude/skills/noodara-domain-model/SKILL.md && ! grep -q "idempotency_key" .claude/skills/noodara-domain-model/SKILL.md` | ❌ W0 | ⬜ pending |
| 11-09-03 | 11-09 | 3 | QA-10 | — | human acceptance of ADR 0008 before Phase 12 | manual+grep | `grep -q "Accepted" docs/adr/0008-deploy-engine-empirical-contracts.md` | ❌ W0 | ⬜ pending |
| 11-10-01 | 11-10 | 3 | QA-10, DEP-01 | T-11-27, T-11-28 | malformed docker ps lines isolated, never promoted to containers | unit | `pnpm exec vitest run packages/domain/src/deployment` | ❌ W0 | ⬜ pending |
| 11-10-02 | 11-10 | 3 | QA-10, DEP-01 | T-11-28 | unparseable never collapsed into plugin_missing | unit | `pnpm exec vitest run packages/domain/src/discovery` | ❌ W0 | ⬜ pending |
| 11-11-01 | 11-11 | 3 | DEP-08, QA-10 | T-11-29, T-11-30 | never throws; messages redacted, no raw stderr | unit | `pnpm exec vitest run packages/ssh/src/git-error-classifier.test.ts` | ❌ W0 | ⬜ pending |
| 11-11-02 | 11-11 | 3 | DEP-08, QA-10 | T-11-29 | never throws; registered secrets never in messages | unit | `pnpm exec vitest run packages/ssh` | ❌ W0 | ⬜ pending |
| 11-12-01 | 11-12 | 4 | QA-10 | T-11-32, T-11-33 | static docker.buildkit template under exactness guard; fact never set from unparseable output | unit | `pnpm exec vitest run packages/domain/src/discovery packages/ssh` | ❌ W0 | ⬜ pending |
| 11-12-02 | 11-12 | 4 | QA-10 | — | fact persisted; not exposed in ServerView | integration | `pnpm typecheck && pnpm test && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/discovery.test.ts tests/integration/services/connect-and-discover.test.ts` | ✅ | ⬜ pending |
| 11-13-01 | 11-13 | 4 | SVC-08, DEP-08, QA-10 | T-11-34 | RemoteCommand constructible only inside packages/ssh; scripts free of interpolation markers | unit | `pnpm exec vitest run packages/ssh/src/commands/deploy-allowlist.test.ts` | ❌ W0 | ⬜ pending |
| 11-13-02 | 11-13 | 4 | SVC-08, DEP-08, QA-10 | T-11-35, T-11-37 | every token escaped, `--` before positionals, no secret parameter, hooks/protocols locked | unit | `pnpm exec vitest run packages/ssh/src/commands` | ❌ W0 | ⬜ pending |
| 11-13-03 | 11-13 | 4 | SVC-08, DEP-08, QA-10 | T-11-36 | no build-arg/env/privileged/volume flags; password via stdin | unit | `pnpm exec vitest run packages/ssh && pnpm --filter @noodara/ssh typecheck && pnpm --filter @noodara/ssh lint` | ❌ W0 | ⬜ pending |
| 11-14-01 | 11-14 | 5 | QA-10, SVC-08 | T-11-39, T-11-40, T-11-42 | per-line redaction incl. split and multi-line secrets; bounded bytes/time; stdin never echoed | unit | `pnpm exec vitest run packages/ssh/src/exec-streaming.test.ts` | ❌ W0 | ⬜ pending |
| 11-14-02 | 11-14 | 5 | QA-10, SVC-08 | T-11-41, T-11-43 | confirmed kill only on ps absence; internals not exported | unit | `pnpm exec vitest run packages/ssh && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 11-14-03 | 11-14 | 5 | QA-10, SVC-08 | T-11-39, T-11-41 | canary redacted on real build; kill confirmed on real fixture | integration | `NOODARA_TEST_UBUNTU=all pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/exec-streaming.test.ts` | ❌ W0 | ⬜ pending |
| 11-15-01 | 11-15 | 6 | SVC-08, DEP-08, QA-10 | T-11-44, T-11-45 | credentials only via stdin builders; ssh-adapter boundary | unit | `pnpm exec vitest run packages/git && pnpm --filter @noodara/git typecheck && pnpm --filter @noodara/git build && pnpm boundaries` | ❌ W0 | ⬜ pending |
| 11-15-02 | 11-15 | 6 | SVC-08, DEP-08, QA-10 | T-11-44 | thin classified wrappers; no build args/env; boundaries green | unit | `pnpm exec vitest run packages/docker packages/git packages/ssh && pnpm typecheck && pnpm lint && pnpm boundaries && pnpm build` | ❌ W0 | ⬜ pending |
| 11-16-01 | 11-16 | 7 | QA-07, QA-10, SVC-08, DEP-08, DEP-01 | T-11-48 | no managed containers/networks/images/workspace left after teardown | integration | `NOODARA_TEST_UBUNTU=all pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/engine-primitives.test.ts -t "happy path" && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 11-16-02 | 11-16 | 7 | QA-07, QA-10, SVC-08, DEP-08, DEP-01 | T-11-46, T-11-47 | canaries absent from ps, .git/config, docker inspect, docker history, chunks | integration | `NOODARA_TEST_UBUNTU=all pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Each plan writes its failing tests first (RED) before implementing; these are the test files the plans create:

- [ ] `packages/domain/src/deployment/{deployment-state,deployment-error,service-status,repository-features}.test.ts` — DEP-01, DEP-08 (11-01)
- [ ] `packages/domain/src/validators/{git,docker-naming,service-source}.test.ts` — SVC-08, DEP-08 (11-02)
- [ ] `tests/integration/deploy-engine/harness.test.ts` + images `sshd-dockerd-ubuntu-{22.04,24.04}` + helpers `deploy-engine.ts`, `registry.ts`, `deploy-keys.ts` — QA-07, QA-10 (11-03)
- [ ] `tests/unit/fixtures/official-fixtures.test.ts` — QA-07 (11-04)
- [ ] `tests/integration/db/schema-ownership.test.ts` + extended `migrations.test.ts`, `schema.test.ts`, `migration-hygiene.test.ts` (clean + from snapshot 0004) — PROJ-04 (11-05)
- [ ] `tests/integration/deploy-engine/contracts-g1-g2.test.ts` — QA-10 G1/G2 (11-06)
- [ ] `tests/integration/deploy-engine/contracts-g3-g4.test.ts` — QA-10 G3/G4 (11-07)
- [ ] `tests/integration/deploy-engine/fixtures.test.ts` — QA-07 (11-08)
- [ ] `packages/domain/src/deployment/{docker-ps,container-state}.test.ts`, `packages/domain/src/discovery/buildkit.test.ts` — QA-10 (11-10)
- [ ] `packages/ssh/src/{git,docker}-error-classifier.test.ts` — DEP-08 (11-11)
- [ ] extended `merge-facts.test.ts`, `allowlist.test.ts`, `run-discovery.test.ts`, `tests/integration/ssh/discovery.test.ts` — QA-10 D-03 (11-12)
- [ ] `packages/ssh/src/commands/{deploy-allowlist,git,workspace,docker-deploy}.test.ts` — SVC-08 (11-13)
- [ ] `packages/ssh/src/{exec-streaming,remote-kill}.test.ts`, `tests/integration/deploy-engine/exec-streaming.test.ts` — QA-10, SVC-08 (11-14)
- [ ] `packages/git/src/clone-repository.test.ts`, `packages/docker/src/docker-operations.test.ts` — SVC-08 (11-15)
- [ ] `tests/integration/deploy-engine/engine-primitives.test.ts` — phase goal end to end (11-16)
- Framework already installed; no test-framework install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ADR 0008 measured numbers reviewed for plausibility | QA-10 | Judgment on evidence quality, not automatable | Read `docs/adr/0008-deploy-engine-empirical-contracts.md`; confirm each G1–G4 section has decision, measurement on 22.04 and 24.04, rejected-alternatives table, date, status Accepted |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (39/39 tasks, including the 11-09 checkpoint's grep)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (every ❌ W0 file above is created RED-first by its own plan)
- [x] No watch-mode flags (all commands use `vitest run`)
- [x] Feedback latency < 60s (unit): unit tasks run targeted `pnpm exec vitest run <path>`; integration tasks are the slower per-wave gate
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planner sign-off 2026-09-29 (all boxes checked; ADR 0008 human acceptance remains a manual-only item)
