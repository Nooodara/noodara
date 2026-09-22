# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v0.1 — Foundation

**Shipped:** 2026-09-22 (`v0.1.0`, 12 days from the first commit)
**Phases:** 6 | **Plans:** 109 | **Tasks:** 288 | **Commits:** 810

### What Was Built
- A pure domain package (server state machine, validators, secret redaction, AES-256-GCM envelope) at ≥95% coverage, over a versioned PostgreSQL schema and Better Auth with argon2id, setup/recovery tokens and brute-force containment.
- An isolated SSH adapter (`@noodara/ssh`) with TOFU host-key trust, per-command timeouts, allowlisted discovery commands and an empirically measured error taxonomy (ADR 0004), proven against real Ubuntu 22.04/24.04 sshd containers.
- Application services, an append-only activity log with redaction at the single insert path, a Fastify API, a BullMQ worker as a second process and Redis-backed SSE for live state.
- A Next.js web app (login → servers → add → connect → discovery → detail) with a same-origin proxy, backend-enforced host-key trust and an Apple-inspired design system.
- A POSIX-sh installer (`curl | sh`) that installs Docker from Docker's own repository, generates a per-installation `.env`, brings up a six-service Compose stack and is safe to re-run; proven in Docker-in-Docker on both Ubuntu versions and, at the end, on a real VPS.
- A real release pipeline: multi-arch images on native runners, GHCR, a GitHub Release the installer resolves, and CI/nightly jobs that run the whole thing.

### What Worked
- RED-first tests caught real bugs in every phase (a BullMQ jobId reuse, a Redis subscribe-before-ready, an SSE slot leak, a sign-out race, a `docker compose ps` JSON parser, six installer bugs on the first real run).
- Empirical contracts instead of assumptions: measuring ssh2 failure shapes, `curl` flag behaviour, Compose's dotenv parsing and Docker's port-release timing each turned a "should work" into a test.
- Per-wave gates run by the orchestrator from raw logs, not from executor claims; every executor claim was probed (`git fsck`, checksums of `.env`, hostile inputs at every write boundary).
- One-file-per-concern skills (`noodara-tdd`, `noodara-security`, …) kept 40+ executor agents on the same rules without re-deriving them.

### What Was Inefficient
- Executors silently skipped explicit security rules three times (newline validation, URL validation, a `git stash` ban); each was caught only by an orchestrator probe. The cost of auditing every plan was high but non-negotiable.
- Tests calibrated on the developer machine did not hold on GitHub's runners: it took five CI runs and eight fixes (system docker on PATH, OpenSSL without DSA, kernel buffer sizes, an instantly failing resolver, 14 GB of disk) to get the first green run.
- Phase 5 needed two gap-closure rounds plus a quick task; the first UI review inflated contrast numbers and invented an accessibility defect — subagent diagnoses had to be re-measured.
- Planning artefacts drifted from the code several times (plan text predating post-execution fixes); the docs-accuracy test that derives facts from `install.sh` was the right answer and should have existed earlier.

### Patterns Established
- Every value written to `.env` passes a single-line/no-quote guard; operator values are single-quoted for Compose.
- Every external command in the installer is exercised in unit tests by shadowing the command itself on PATH and pinning its argv, never only the wrapper.
- Every Docker-using test carries `noodara.test=true`, a real wait strategy, an explicit timeout and a stray-container assertion; CI fails on any survivor.
- Publishing = `git subtree split` from the monorepo, trailer strip, fast-forward push; the standalone repo never diverges.
- A release-gate document with a verdict per acceptance criterion and named evidence, kept honest (NOT READY until the last real run).

### Key Lessons
1. A green suite on one machine is a hypothesis; the first real run on another machine is the test. Budget for it.
2. Never trust an agent's "no rule skipped": probe every write boundary and every security control with hostile input before accepting a plan.
3. Idle measurements are not capacity measurements (the 192 MB Postgres cap would have OOM-killed a real install).
4. Anything an operator will paste into a root shell deserves a docs-accuracy test that reads the script, not the plan.
5. Close the loop with a real user action (the VPS install) before declaring a milestone shipped; everything before that is rehearsal.

### Cost Observations
- Model mix: orchestration and audits on the largest model; every executor and reviewer on Sonnet (`model_profile: balanced`).
- Sessions: several long sessions per phase; the phase-6 execution alone spanned 15 plans, ~14 audit-driven fix rounds and 5 CI runs in one continuous session.
- Notable: the orchestrator's own probes (a few hundred tokens each) repeatedly saved multi-plan rework; the most expensive waste was re-running the 35-minute Docker suites after each executor mistake.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v0.1 | many | 6 | Orchestrator audits every plan against the code; release gate with per-criterion evidence; real-runner CI as the last gate |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v0.1 | 2214 unit / 523 integration / 93 E2E / 51 installer | ≥95% in `packages/domain` | check-package-provenance, check-posix-sh, check-workflow-pins, e2e-repeat |

### Top Lessons (Verified Across Milestones)

1. Real infrastructure (containers, runners, a VPS) finds what stubs cannot — schedule the real run, do not hope for it.
2. Security rules must be verified by probing, never by reading an agent's report.
