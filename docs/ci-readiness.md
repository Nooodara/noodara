# CI readiness — what is true today, and what still needs a real run

This document exists because REQUIREMENTS.md correctly marks **QA-04** and **QA-05** `Pending`,
not `Complete`, and 05-VERIFICATION.md's gap 3 formalized why. It records, without softening,
what Plan 05-36 fixed locally, what remains genuinely unverifiable in this environment, and the
exact observation a human must make before either requirement can honestly move to `Complete`.

## Why this repository has no CI evidence at all

This monorepo lives nested under a personal workspace (`/Users/xch4rt/work/myself/noodara/code`)
and has **no remote** — `git remote -v` returns empty, by explicit user policy. GitHub Actions only
evaluates a workflow file that already exists on a repository's default branch *on GitHub*; a
`schedule:` trigger, a `pull_request` trigger and a `push` trigger all require the workflow to be
hosted there. Until this repository is pushed somewhere, `.github/workflows/ci.yml` and
`.github/workflows/nightly.yml` have **never executed as a real GitHub Actions run** — not once,
not partially. Every "pass" recorded anywhere in this project's `.planning/` history for these
workflows is a **local simulation**: the same shell command a job's `run:` step would execute,
run directly on a developer machine, with its result and timing hand-recorded in the relevant
`SUMMARY.md`. That is real evidence that the underlying command works. It is not evidence that the
job — with its actual runner image, its actual `permissions:` grant, its actual Docker/network
sandbox, its actual concurrency with other jobs — works. Those are different claims, and this
project's own bookkeeping (REQUIREMENTS.md) already declines to conflate them.

## What Plan 05-36 actually fixed

Before this plan, `.github/workflows/ci.yml`'s `security` job ran `pnpm security:scan-leaks` —
which ends with `playwright test --grep @canary` — with **no step anywhere in the job that
installs a Playwright browser binary**. `.github/workflows/nightly.yml`'s `canary` job ran the
identical command with the identical gap. Both would have failed before testing anything, on
their very first real execution: the exact defect 05-VERIFICATION.md's gap 3 named. Both jobs now
run `pnpm exec playwright install --with-deps chromium` before that script, the same form the
`e2e` and `e2e-repeat` jobs already used.

Both workflow files also gained, for every job:

- an explicit, job-level `permissions:` block (`contents: read` everywhere; additionally
  `pull-requests: write` on `ci.yml`'s `security` job only, for `gitleaks-action`'s documented PR
  review-comment capability — see the action's own README, quoted in that job's workflow comment);
- a `timeout-minutes:` value sized above that job's real observed local cost, with the source of
  each number recorded in the job's own comment (`integration`'s 45-minute ceiling is the binding
  one, above the ~31-minute cold local run 02-VALIDATION.md and this plan's own objective text
  cite);
- every third-party `uses:` (`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`,
  `actions/upload-artifact`, `gitleaks/gitleaks-action`) pinned to a commit SHA, with the
  human-readable tag kept as a trailing comment — a tag is mutable, a commit SHA is not.

`ci.yml`'s full-tree gitleaks step (`push`-to-`main` only) used to pipe `curl` straight into `tar`
with no integrity check on the downloaded binary. It now downloads the release archive and
gitleaks' own published checksum file as two separate steps and verifies the archive's SHA256
against that checksum file with `sha256sum -c` before extracting anything — the network fetch is
never piped directly into an extractor.

`scripts/check-package-provenance.mjs` (WR-C-14, gap 8) used to check a hardcoded 29-entry list
covering 27 of this monorepo's 52 direct dependencies, resolved at the registry's `dist-tags`
latest version rather than the version `pnpm-lock.yaml` actually pins. It now enumerates every
direct dependency (production and development, across every workspace) from
`pnpm list -r --depth 0 --json` — the real locked tree — and resolves each one at its exact locked
version. Coverage is **52/52** as of this plan (`node scripts/check-package-provenance.mjs`'s own
printed coverage line is the source of that number, not an estimate), closing the seven
previously-unchecked production packages WR-C-14 named by name: `ssh2`, `argon2`, `better-auth`,
`pg`, `fastify`, `pino`, `zod`. An enumerated package with no configured expected repository now
fails the gate instead of being silently skipped, so a future dependency addition cannot bypass
this check by omission.

**Limitation this script still cannot close** (documented in its own header, and repeated here
per WR-C-14 finding 2): a registry `repository.url` is publisher-controlled, free-text metadata.
The npm registry does not verify that a package's declared repository is the code it actually
published. This check narrows the risk — an attacker must specifically choose to lie about, or
match, a value a human already reviewed at least once, and an exact `owner/repo` comparison closes
the substring-match bypass a looser check would allow — it does not eliminate it. Closing that
fully needs npm's provenance attestations (cryptographically binding a published tarball to the
repository and CI run that built it), which this plan does not implement.

## What still cannot be verified without a remote

QA-04 and QA-05 stay `Pending`. The exact, literal observation a human must make before either can
honestly move to `Complete`:

1. `nightly.yml`'s `e2e-repeat` job passes **20/20** — twenty fully independent
   `pnpm test:e2e` invocations, each iteration's own fresh Testcontainers pair, with zero failing
   iterations — in a real scheduled (or `workflow_dispatch`) GitHub Actions run;
2. **in that same run**, `nightly.yml`'s `canary` job also passes — the secrets-leak canary
   confirming in the same nightly execution the 20/20 repetition happened in, not a separate,
   unrelated pass recorded at a different time; and
3. `ci.yml`'s `security` job passes on a real pull request — proving the `playwright install` fix
   above actually unblocks the job in the real runner environment, not just in the reasoning that
   produced it.

None of that has happened. It cannot happen until this repository has a remote and at least one
of these workflows executes there for real. Local simulation — however carefully recorded — is
not the same observation, and this document does not claim it is. This gap re-surfaces explicitly
in Plan 05-37's own human-verification checkpoint; it is not simulated, not approximated and not
marked complete here or anywhere else in this plan.

## Local-simulation evidence that exists today, and why it is not equivalent

- `05-20-SUMMARY.md` records a local run of the 20-repeat E2E suite and the 100-consecutive-
  connection stress suite, with per-iteration timings and a 20/20 pass count. This proves
  `scripts/e2e-repeat.mjs` and `tests/integration/ssh/stress-connections.test.ts` are each
  individually correct commands. It does not prove they behave the same way under
  `nightly.yml`'s actual `runs-on: ubuntu-latest` image, its actual job `permissions:` grant, or
  GitHub Actions' actual scheduling and concurrency behavior — none of which a local shell
  invocation exercises at all.
- `05-21-SUMMARY.md` and later gap-closure summaries record local runs of
  `pnpm security:scan-leaks`. Same caveat: the command's own correctness is demonstrated: the CI
  job wrapping it, with its own runner, browser-install step and token permissions, has not been.
- This plan (05-36) itself: every acceptance check in 05-36-SUMMARY.md was run locally —
  `node scripts/check-package-provenance.mjs`, the YAML parse, the grep-based structural checks
  on the workflow files, and a manual reproduction of the checksum-verified gitleaks download —
  never inside an actual GitHub Actions job.

A local simulation and a real CI run are not equivalent to the roadmap criterion's own wording
("el nightly lo repite... en el mismo run"), because "en el mismo run" names a property of a real,
single, scheduled execution — something a sequence of separate local shell invocations, run at
different times by different people, cannot by construction demonstrate.
