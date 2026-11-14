# Contributing to Noodara

Thanks for helping. This guide covers how to set up a machine, which tests to run before you open a
pull request, and what CI runs for you. The roadmap in
[`docs/roadmap-v0.1-v0.5.md`](docs/roadmap-v0.1-v0.5.md) defines what is in scope; behaviour changes
are developed test-first (red, green, refactor).

## Set up

You need Node.js matching `engines.node` in `package.json` (see `.nvmrc`) and the exact release of pnpm, as
pinned in `packageManager` (`corepack enable` picks it up). Then:

```sh
pnpm install
pnpm test:doctor --tier unit
```

## Test tiers

| Tier | Command | Needs | Typical time on a modest machine |
|---|---|---|---|
| Fast local check | `pnpm verify` | Node.js, pnpm | about 5 to 7 minutes |
| Unit | `pnpm test` | Node.js, pnpm | about 4 to 5 minutes |
| Integration | `pnpm test:integration` | Docker Engine, port 3000 free | tens of minutes |
| End to end | `pnpm test:e2e` | Docker Engine, Playwright Chromium, `unzip`, ports 3000 and 3100 free | about 40 minutes |

Times were measured on a 4 CPU / 6 GB virtual machine.

### What to run locally: `pnpm verify`

`pnpm verify` runs lint, typecheck, unit tests and the package boundary check, in that order, and
stops at the first step that fails with that step's exit code. It needs no Docker daemon, no free
port and no build output from an earlier run (Turborepo builds what lint and typecheck depend on).
Run it before every push.

### What CI runs on every pull request

Every pull request runs lint, typecheck, boundaries, unit tests with coverage, the state-machine
coverage gate, the AI eval suite, the public site build, integration tests (Ubuntu 24.04 SSH fixtures
on pull requests, every supported Ubuntu release on `main`), the security job (dependency audit,
secret-leak canaries, secret scanning), the boot smoke test and the end-to-end suite. You do not need
to run the Docker-backed tiers locally for a small change; CI will. Run them when you change code they
cover, starting with the single file that exercises your change.

### Running one integration or end-to-end file

```sh
pnpm test:integration tests/integration/helpers/port-checker.test.ts
pnpm test:e2e tests/e2e/deploy.spec.ts
pnpm test:e2e --list tests/e2e/deploy.spec.ts
```

The integration setup builds the workspace once per run, and both setups refuse to start while
resources labelled `noodara.test` from an earlier run still exist. The last command only lists the
tests in the file; it starts no stack.

Integration suites that run against Ubuntu SSH fixtures cover every supported release (22.04 and
24.04) by default; set `NOODARA_TEST_UBUNTU` to `22.04` or `24.04` to run only one, or `all` for both.

## Checking your machine: `pnpm test:doctor`

```sh
pnpm test:doctor --tier unit
pnpm test:doctor --tier integration
pnpm test:doctor --tier e2e
```

The doctor reports whether `package.json` matches the installed releases of Node.js and pnpm,
whether the Docker daemon is reachable, whether `unzip` is installed (the end-to-end artifact secret scan in
`tests/e2e/deploy.spec.ts` uses it to read Playwright trace archives), whether Playwright Chromium
is installed (`pnpm e2e:install`), whether the test ports are free, whether resources labelled
`noodara.test` are left over, and the CPU count and memory of the machine that runs Docker, with a
suggested timeout scale. Without `--tier` it checks for the strictest tier, `e2e`.

Checks that the chosen tier cannot run without are hard prerequisites; everything else is an
advisory and never changes the exit code. A check that cannot be determined (a probe that times out
or prints something unexpected) counts as missing when it is a hard prerequisite.

The doctor is read-only: it never removes or stops containers, never pulls or builds images, never
installs browsers and never writes files. It prints fixed messages only, never the value of an
environment variable or the output of a failed command. The integration and end-to-end global
setups run the same hard checks for their tier and fail with the same messages before any container,
build or port is touched.

| Exit code | Meaning |
|---|---|
| `0` | ok: every hard prerequisite of the tier is present |
| `1` | a hard prerequisite is missing or could not be determined |
| `2` | usage error: unknown flag, or a missing or unknown `--tier` value |

## Machine requirements

- Minimum: 4 CPUs and 6 GB of memory available to Docker. On that machine the tiers have passed with
  `NOODARA_TEST_TIMEOUT_SCALE` set (scaled local evidence), the Docker-backed ones at
  `NOODARA_TEST_TIMEOUT_SCALE=3`, and only one test command may run at a time. The full unit run was
  intermittent there on 2026-11-12: on the same tree at scale 3 it passed 4 times and failed 2 times,
  each failure time-based (cause not proven; memory pressure is suspected). If a time-based failure
  shows up on such a machine, close other heavy applications and retry once before treating it as a
  regression.
- Recommended: 8 CPUs and 16 GB of memory available to Docker, and an SSD. No timeout scale is needed.

## Slow machines: `NOODARA_TEST_TIMEOUT_SCALE`

Set `NOODARA_TEST_TIMEOUT_SCALE` to a plain decimal number from 1 to 10 to multiply test, hook and
runner timeouts on your machine, for example:

```sh
NOODARA_TEST_TIMEOUT_SCALE=2 pnpm test
NOODARA_TEST_TIMEOUT_SCALE=3 pnpm test:integration tests/integration/helpers/port-checker.test.ts
```

Unset means 1. Any other value stops the run before a test starts. `pnpm test:doctor` suggests a
value from the CPU count and memory of the Docker host. CI never sets it: a test that only passes with
a scale is a slow test, not a passing one, and its budget on CI stays the same.

## Port overrides

| Variable | Default | Used by |
|---|---|---|
| `NOODARA_TEST_PORT_OVERRIDE` | unset | Integration: when set, skips the port 3000 precheck. The tests never bind this value and `pnpm test:doctor` does not probe it. Must be a port number (1 to 65535). |
| `NOODARA_E2E_WEB_PORT` | `3000` | End to end: host port of the web UI. |
| `NOODARA_E2E_API_PORT` | `3100` | End to end: host port of the API. Must differ from the web port. |

Each value must be a decimal integer from 1 to 65535; anything else stops the tier that uses it.
See [`docs/testing/e2e-ports.md`](docs/testing/e2e-ports.md) for details.

## Windows and WSL

- Work inside WSL 2 and keep the clone in the Linux filesystem (your Linux home directory), not under
  `/mnt/c`. Tests on the Windows mount are several times slower.
- Run Docker Engine inside the distribution. Do not run Docker Desktop for Windows at the same time:
  two Docker daemons in one virtual machine exhausted host memory during a full gate run.
- Give the WSL virtual machine enough memory in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`:

  ```ini
  [wsl2]
  memory=8GB
  processors=4
  ```

- Install `unzip` in the distribution (for example `sudo apt-get install unzip`) before running the
  end-to-end suite.

## Commits and pull requests

- Conventional Commits in English (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`), subject
  of 72 characters or less.
- One pull request is one verifiable unit. CI must be green to merge.
- Never put credentials, tokens or real secrets in code, tests, logs or fixtures.
