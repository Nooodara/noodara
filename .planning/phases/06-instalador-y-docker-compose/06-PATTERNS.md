# Phase 6: Instalador y Docker Compose - Pattern Map

**Mapped:** 2026-09-21
**Files analyzed:** 15 (8 new source/infra, 1 modified config, 6 new test files/helpers)
**Analogs found:** 10 / 15 (5 files have no in-repo analog — first-of-kind artifacts for this phase)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `install.sh` (root) | utility (installer script) | batch / orchestration | `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` (apt-repo Docker install block only) + `apps/control-plane/scripts/copy-migration-assets.mjs` (header-comment convention) | partial — no shell-script analog exists at all |
| `docker-compose.yml` (root, production) | config | declarative / service topology | `docker-compose.dev.yml` | exact (same role, sibling env) |
| `.dockerignore` (root) | config | N/A | none | no analog |
| `apps/control-plane/Dockerfile` | config (build) | file I/O / build | `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` | role-match (only multi-stage-shaped Dockerfile pattern in repo, though single-stage) |
| `apps/web/Dockerfile` | config (build) | file I/O / build | `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` + `apps/control-plane/Dockerfile` (once planned) | role-match |
| `.github/workflows/release.yml` | CI config | event-driven (tag push) | `.github/workflows/ci.yml`, `.github/workflows/nightly.yml` | exact (same role, same repo conventions) |
| `docs/install.md` | docs | N/A | `docs/ci-readiness.md` | role-match (tone/structure only) |
| `apps/web/next.config.ts` (MODIFIED — add `output: 'standalone'`) | config (Next.js) | transform (build-time) | itself (already read in full) | exact — additive change to existing file |
| `tests/integration/helpers/installer-dind.ts` (new) | test helper (Testcontainers fixture) | file I/O / process orchestration | `tests/integration/helpers/ssh.ts` | exact |
| `tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile` + `-24.04/Dockerfile` (new, if planner chooses per-version images) | config (Dockerfile fixture) | file I/O / build | `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` + `sshd-common/entrypoint.sh` | exact |
| `tests/integration/installer/shell-functions.test.ts` (new) | test (unit, shell-via-process) | process spawn / request-response | `tests/integration/helpers/boot-process.ts` (`BootProcess`/`spawnBootProcess`) | role-match (RESEARCH.md names this the explicit in-repo precedent) |
| `tests/integration/installer/fresh-install.test.ts` (new) | test (integration, DinD) | event-driven / process orchestration | `tests/integration/boot/boot-command.test.ts` | exact |
| `tests/integration/installer/idempotent-rerun.test.ts` (new) | test (integration, DinD) | event-driven / process orchestration | `tests/integration/boot/boot-command.test.ts` | exact |
| `tests/integration/installer/preflight-scenarios.test.ts` (new) | test (integration, DinD) | event-driven / process orchestration | `tests/integration/boot/boot-command.test.ts` | exact |
| `tests/integration/installer/preseed-admin.test.ts` (new) | test (integration, DinD) | event-driven / process orchestration | `tests/integration/boot/boot-command.test.ts` + `apps/control-plane/src/boot/bootstrap-admin.ts` (behavior consumed) | role-match |

## Pattern Assignments

### `install.sh` (root, new — utility, batch/orchestration)

**No shell-script analog exists anywhere in this repo.** This is a first-of-kind artifact — every existing script in `scripts/` and `apps/control-plane/scripts/` is Node (`.mjs`), not POSIX `sh`. Two partial analogs are worth copying from directly:

**1. The apt-repo Docker install block** (D-14) is already implemented, almost verbatim, in this repo's own test fixture:

`tests/integration/images/sshd-ubuntu-22.04/Dockerfile` lines 19-30:
```dockerfile
RUN if [ "$WITH_DOCKER_CLI" = "true" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends curl gnupg \
        && install -m 0755 -d /etc/apt/keyrings \
        && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
        && chmod a+r /etc/apt/keyrings/docker.asc \
        && . /etc/os-release \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
        && apt-get update \
        && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
        && rm -rf /var/lib/apt/lists/*; \
    fi
```
`install.sh`'s Docker-install preflight step should use the same GPG-key / `download.docker.com` / `.list`-file sequence, translated from Dockerfile `RUN` syntax to POSIX `sh` statements (per RESEARCH.md Pattern 5, which independently cites the same official Docker apt-repo steps). This is the strongest concrete, already-repo-verified precedent — it proves the exact command sequence already builds successfully in this project's own CI.

**2. Header-comment convention for a root-level operational script** — `apps/control-plane/scripts/copy-migration-assets.mjs` lines 1-6:
```javascript
#!/usr/bin/env node
// `tsc` does not emit `.sql` files or `migrations/meta/_journal.json` — it only compiles
// TypeScript. Without this step `dist/cli/index.js` (already declared in this package's `bin`)
// could not run `noodara`'s migration path against a built artifact, and neither could
// `dist/db/migrate.js` (the `start`/production path this plan is closing). Run after `tsc` as
// part of the `build` script.
```
Mirror this style for `install.sh`'s own header: a shebang line, then a comment block explaining *why* the script exists and what defect/requirement it closes (INST-01..05), not just *what* it does.

**Everything else in `install.sh`** (preflight predicates, `.env` merge, public-IP resolution, version resolution) has no in-repo precedent — copy directly from RESEARCH.md's own verified patterns (Patterns 1-7, the `env_has_key`/`env_append_if_missing` idempotent-merge snippet, and the Dokploy public-IP fallback chain), not from any file in this codebase.

---

### `docker-compose.yml` (root, new — config, production topology)

**Analog:** `docker-compose.dev.yml` (read in full, 41 lines)

**Full current dev file** (base to extend, NOT copy verbatim — Pitfall 4 below is a real bug in it):
```yaml
name: noodara-dev

services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - '${POSTGRES_PORT:-5432}:5432'
    volumes:
      - noodara_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}']
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['redis-server', '--requirepass', '${REDIS_PASSWORD}']
    ports:
      - '${REDIS_PORT:-6379}:6379'
    volumes:
      - noodara_redis_data:/data
    healthcheck:
      test: ['CMD-SHELL', 'redis-cli -a $${REDIS_PASSWORD} ping | grep -q PONG']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  noodara_postgres_data:
  noodara_redis_data:
```

**What production must change, concretely:**
1. **Remove `ports:` from both `postgres` and `redis`** — D-08/D-21 (fase 6 CONTEXT §"Same-origin"): only `web` publishes a host port.
2. **Fix the redis healthcheck bug before copying it** — `docker-compose.dev.yml`'s redis `healthcheck.test` references `$${REDIS_PASSWORD}` but the `redis` service has **no `environment:` block at all**, so the variable is undefined inside the container's own shell at healthcheck-execution time (RESEARCH.md Pitfall 4, verified by direct read above — confirmed true, this `environment:` block is genuinely absent). Production `redis` must add:
   ```yaml
   environment:
     REDIS_PASSWORD: ${REDIS_PASSWORD}
   ```
   before the healthcheck will ever report anything but permanently `unhealthy`.
3. **Add `api`, `worker`, `web`, `migrate`** — none exist in the dev file (control-plane is not containerized there). Use RESEARCH.md Pattern 9's exact `migrate`/`api` `depends_on: condition: service_completed_successfully` shape and Pattern 6's `redis`/`web` healthcheck recommendations (§"Compose details" table).
4. **Volume names stay identical** (`noodara_postgres_data`, `noodara_redis_data`) — D-10 locks these as the production volume names too, so upgrade-in-place (D-09) never orphans data.

---

### `apps/control-plane/Dockerfile` (new — config, build)

**No true analog** (this is the first application Dockerfile in the repo). The one structurally similar file is `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` — useful for **conventions**, not content:

**Non-root user pattern** (lines 46-49 of the sshd Dockerfile, via `sshd-common/setup-users.sh`):
```dockerfile
COPY sshd-common/setup-users.sh /usr/local/bin/setup-users.sh
RUN chmod 0755 /usr/local/bin/setup-users.sh \
    && /usr/local/bin/setup-users.sh
```
Mirrors the intent RESEARCH.md Pattern 10 spells out concretely for this Dockerfile (`groupadd -r noodara && useradd -r -g noodara noodara`, `USER noodara`) — same "create a dedicated non-root user, chown copied artifacts to it" shape this repo already applies to its one existing Dockerfile.

**Build-artifact contract to package (from ADR 0003, already read in full):** `apps/control-plane/package.json`'s `build` script is `tsc -p tsconfig.build.json && node scripts/copy-migration-assets.mjs` — the Dockerfile's build stage must run this exact script (via `turbo run build --filter=@noodara/control-plane`, per RESEARCH.md Pattern 10), and the runner stage must copy `dist/` (self-contained, migrations included) plus `node_modules`. `command:` differs only by `["node", "dist/server.js"]` vs `["node", "dist/worker.js"]` (phase 4 D-23, ADR 0003) — one image, two entrypoints, exactly as already locked.

**CLI must be included** — `apps/control-plane/package.json` declares `"bin": { "noodara": "./dist/cli/index.js" }` (`apps/control-plane/src/cli/index.ts`, `admin-reset.ts`, `secrets-rotate.ts` already exist) — CONTEXT.md's "Reusable Assets" requires `docker compose exec api noodara admin reset`/`secrets rotate` to work, so the Dockerfile's runner stage needs the compiled `dist/cli/` tree, not just `dist/server.js`/`dist/worker.js`.

---

### `apps/web/Dockerfile` (new — config, build)

**No analog either.** Follow RESEARCH.md Pattern 10's second snippet (Next.js standalone runner) directly — it is already Context7-verified against `/vercel/next.js`'s own `examples/with-docker/Dockerfile`. The one repo-specific fact to encode: `apps/web/public/` **does not currently exist** (confirmed by the `ls -a` directory listing performed during research) — the Dockerfile must omit or make conditional the standard `COPY .../public ./public` line.

**Build-time contract (Pitfall 3):** `NOODARA_API_ORIGIN` must be a `ARG`/`ENV` pair set **before** the `RUN turbo run build --filter=@noodara/web` step — never a Compose `environment:` on the running `web` service, because `apps/web/next.config.ts`'s `rewrites()` (read in full above, lines 24-35) only runs at `next build` time. `next.config.ts`'s own `readApiOrigin()` (lines 13-22) already fails fast with a named error if the variable is absent — the Dockerfile build step is what must supply it correctly (`http://api:3000`, the Compose-internal service name/port, never a dev value).

---

### `apps/web/next.config.ts` (MODIFIED — config, additive change)

**This is the file itself** — already read in full (63 lines). The only change this phase makes: add `output: 'standalone'` to the existing `nextConfig` object (currently absent, confirmed by direct read). Everything else in the file — `readApiOrigin()`'s fail-fast pattern, the `rewrites()` shape, the `headers()` security block — must be preserved unchanged; this phase does not touch ADR-0006's contract.

```typescript
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',   // <-- new line only; everything else below is unchanged
  rewrites() { /* unchanged */ },
  headers() { /* unchanged */ },
};
```

---

### `.github/workflows/release.yml` (new — CI config, event-driven)

**Analog:** `.github/workflows/ci.yml` and `.github/workflows/nightly.yml` (both read in full)

**Structural conventions to copy exactly** (both files share these, so they are the project's locked convention, not a one-off):

**Every third-party `uses:` pinned to a commit SHA, tag as trailing comment** (`ci.yml` lines 58-63):
```yaml
- uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
- uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
- uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
  with:
    node-version: ${{ env.NODE_VERSION }}
    cache: pnpm
```
`release.yml`'s new `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action`, `docker/setup-qemu-action` uses must follow this same pin-to-SHA-plus-tag-comment convention (RESEARCH.md's own Package Legitimacy Audit table already flags this requirement explicitly, citing `ci.yml`'s own comment as precedent).

**Per-job least-privilege `permissions:` block** (`ci.yml` lines 55-56, repeated per job — no workflow-level block):
```yaml
permissions:
  contents: read
```
`release.yml`'s build job needs `contents: read` + `packages: write` (GHCR push via `GITHUB_TOKEN`, no PAT) — same minimal-grant philosophy `ci.yml`'s `security` job already demonstrates when it adds `pull-requests: write` only for the one step that needs it (lines 202-207).

**`timeout-minutes:` sized and justified in a comment** (`ci.yml` lines 141-148, the `integration` job):
```yaml
timeout-minutes: 45
```
with the job's own comment explaining the number's source (observed local run time + headroom) — `release.yml`'s build job must do the same, not leave the default (6 hours).

**Trigger shape** — `nightly.yml`'s `on:` block (lines 22-26) is the closest example of a non-`pull_request` trigger already in this repo:
```yaml
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:
```
`release.yml` needs `on: push: tags: ['v*.*.*']` (RESEARCH.md Pattern 11) instead — different trigger, same file-shape convention (a focused `on:` block with an inline comment on any non-obvious choice).

**Concurrency group** (`ci.yml` lines 33-35, also in `nightly.yml`):
```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```
Reuse this exact templated form (swap the group-name prefix) for `release.yml`.

**Important gap already flagged by RESEARCH.md (D-02):** `nightly.yml`'s own header comment (lines 6-14) documents that `on: schedule` **cannot fire yet** because this repo has no remote. `release.yml`'s `on: push: tags:` trigger has the identical problem — it must carry the same kind of explicit "this cannot run for real until the repo is pushed (D-02)" comment `nightly.yml` already sets the precedent for, so a future reader doesn't mistake local-simulation evidence for a real gate.

---

### `docs/install.md` (new — docs)

**Analog:** `docs/ci-readiness.md` (partial read, 60 lines) — same repo convention for an operational/status doc: a clear H1 stating what the doc is for, then problem-first prose sections (not a generic feature-tour). `docs/install.md`'s content itself (command, supported env vars, upgrade, troubleshooting) has no analog to copy from — it is genuinely new user-facing documentation; only the house style (plain Markdown, no frontmatter, direct/precise tone, English per CLAUDE.md §7.1 since this is user-facing) carries over.

---

### `tests/integration/helpers/installer-dind.ts` (new — test helper, Testcontainers fixture)

**Analog:** `tests/integration/helpers/ssh.ts` (read in full, 204 lines) — this is the strongest match in the whole phase; the file's own header comment even states the convention explicitly: *"Mirrors tests/integration/helpers/postgres.ts's shape: `.withLabels({ 'noodara.test': 'true' })`, readiness gated by a real wait strategy (never a fixed sleep), and an idempotent `stop()`."*

**Directly reusable shape** (`ssh.ts` lines 58-91, `startSshd`):
```typescript
export async function startSshd(options: StartSshdOptions): Promise<SshdFixture> {
  const image = await GenericContainer.fromDockerfile(IMAGES_CONTEXT, `sshd-ubuntu-${ubuntu}/Dockerfile`)
    .withBuildArgs({ WITH_DOCKER_CLI: String(dockerCli), WITH_SLOW_DF: String(slowDf) })
    .build();

  const container = image
    .withLabels({ 'noodara.test': 'true' })
    .withEnvironment({ SSH_TEST_PASSWORD: password, SSH_TEST_KEY_PASSPHRASE: keyPassphrase })
    .withExposedPorts(hostPort === undefined ? 22 : { container: 22, host: hostPort })
    .withWaitStrategy(Wait.forLogMessage(/Server listening on .* port 22/));

  const started = await container.start();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await started.stop();
  };

  return { container: started, host: started.getHost(), port: started.getMappedPort(22), password, keyPassphrase, stop };
}
```
`startInstallerDind(ubuntu: '22.04' | '24.04')` should follow this exact shape: `GenericContainer.fromDockerfile(...)` against a new `tests/integration/images/installer-dind-ubuntu-{22.04,24.04}/Dockerfile`, `.withPrivilegedMode(true)` (new — needed for nested `dockerd`, not present in `ssh.ts` since sshd doesn't need it), `.withLabels({ 'noodara.test': 'true' })`, a `Wait.forLogMessage(...)` on `dockerd`'s own "API listen on" log line (or equivalent) instead of sshd's, and an identical idempotent `stop()` closure.

**Stray-container assertion to reuse verbatim** (`ssh.ts` lines 198-203, `assertNoStrayTestContainers`):
```typescript
export async function assertNoStrayTestContainers(): Promise<void> {
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((container) => container.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
}
```
Every new `tests/integration/installer/*.test.ts` file's `afterEach` should call this exact existing helper (it is already exported and general-purpose) rather than reimplementing it — no need for `installer-dind.ts` to duplicate this logic.

**Copying local images into the nested `dockerd` (Open Question 2, D-19):** no in-repo precedent for `docker save`/`docker load` + `copyFilesToContainer`, since no prior phase needed to push images *into* a Testcontainer's own daemon — this part must be written fresh from RESEARCH.md's own recommendation (§"Open Questions" #2), not copied from an analog.

---

### `tests/integration/images/installer-dind-ubuntu-{22.04,24.04}/Dockerfile` (new — Dockerfile fixture)

**Analog:** `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` + `tests/integration/images/sshd-common/entrypoint.sh` (Dockerfile read in full above; `entrypoint.sh` not read this session — same directory, same convention, referenced by the Dockerfile's `ENTRYPOINT`)

**Shared-build-context convention** (Dockerfile's own header comment, lines 1-5):
```dockerfile
# Project-owned Ubuntu 22.04 sshd fixture image (02-02-PLAN.md Task 1, QA-03).
#
# Build context is tests/integration/images/, so this Dockerfile shares tests/integration/images/
# sshd-common/** with the 24.04 variant without duplicating any script. This file is identical to
# ../sshd-ubuntu-24.04/Dockerfile except for the FROM line.
FROM ubuntu:22.04
```
The new `installer-dind-ubuntu-22.04/Dockerfile` / `-24.04/Dockerfile` pair should follow the identical two-file, shared-`-common/`-directory structure (a new `tests/integration/images/installer-dind-common/` holding `entrypoint.sh` that starts `dockerd`), differing only by `FROM` line — exactly how the sshd pair is organized today. Docker Engine install inside this fixture image reuses the same apt-repo block quoted under `install.sh` above (this is literally the same install path `install.sh` itself will run on a real VPS, so the fixture and the product share one true source of steps, only translated between Dockerfile `RUN`/`if` and POSIX `sh`).

**`EXPOSE`/`ENTRYPOINT` convention** (Dockerfile lines 62-63):
```dockerfile
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```
Mirror with `ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]` starting `dockerd` (no fixed `EXPOSE` needed — nothing outside the container needs a fixed port, `install.sh` is `exec()`'d into the container via Testcontainers, not reached over the network).

---

### `tests/integration/installer/shell-functions.test.ts` (new — unit test, shell-via-process)

**Analog:** `tests/integration/helpers/boot-process.ts` (read in full, 213 lines) — RESEARCH.md's own "Shell testing layer" section (§ D-18.1) names this file directly as *"the existing in-repo precedent for spawning a real process and asserting on its output/exit code."*

**Reusable process-spawn-and-assert shape** (`boot-process.ts` lines 65-96, the `BootProcess` class):
```typescript
export class BootProcess {
  stdout = '';
  stderr = '';
  private readonly child: ChildProcess;
  private exitCode: number | null = null;
  private hasExited = false;
  private readonly exitPromise: Promise<number | null>;

  constructor(options: SpawnBootProcessOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (chunk: Buffer) => { this.stdout += chunk.toString('utf8'); });
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString('utf8'); });
    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code) => { this.hasExited = true; this.exitCode = code; resolve(code); });
    });
  }
  // waitForStdoutMatch(pattern, timeoutMs), waitForExit(timeoutMs), kill() — all reusable as-is
}
```
`shell-functions.test.ts` should spawn `sh` (never `bash`) directly via `spawnSync('sh', [...])` or a slimmed-down version of this same `BootProcess` shape, asserting on `stdout`/`stderr`/exit code exactly like `boot-command.test.ts` already does against the real `node dist/server.js` entrypoint — RESEARCH.md is explicit that reusing this technique (not `bats-core`) is the deliberate, justified choice (§"Shell testing layer", rejecting bats specifically to avoid a second toolchain).

**Sourcing convention to establish in `install.sh` itself:** RESEARCH.md's own recommendation (§"Shell testing layer" point 3) requires guarding `install.sh`'s own `main`-equivalent invocation behind a check (e.g. `--test-<function-name>` dispatch or a documented `--source-only` guard) so a test can `. install.sh` without triggering a real install — this is a new pattern with no in-repo precedent; must be designed fresh, informed only by RESEARCH.md, not copied from any existing file.

---

### `tests/integration/installer/fresh-install.test.ts`, `idempotent-rerun.test.ts`, `preflight-scenarios.test.ts`, `preseed-admin.test.ts` (new — integration tests, DinD)

**Analog:** `tests/integration/boot/boot-command.test.ts` (read in full, 337 lines)

**Shared structural conventions to copy exactly:**

**Fixture lifecycle + `afterEach` stray-container assertion** (lines 32-47):
```typescript
let activeProcess: BootProcess | undefined;

afterEach(async () => {
  if (activeProcess !== undefined) {
    activeProcess.kill();
    await activeProcess.waitForExit(10_000).catch(() => undefined);
    activeProcess = undefined;
  }
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((container) => container.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});
```
The four new installer test files should follow this same shape, substituting `activeProcess` for the DinD container/`installer-dind.ts` fixture, and can call the already-exported `assertNoStrayTestContainers()` from `ssh.ts` instead of reimplementing the inline version above.

**`try`/`finally` around a real Postgres+Redis-style fixture pair** (lines 73-111, `postgres`/`redis` fixtures started, used, and always stopped in `finally` even on assertion failure):
```typescript
describe('start: real boot against a migrated database', () => {
  it('reaches Server listening, answers /health, prints the setup token, and exits cleanly on signal', async () => {
    const postgres = await startPostgres({ migrate: true });
    const redis = await startRedis();
    try {
      // ... spawn + assert ...
    } finally {
      await postgres.stop();
      await redis.stop();
    }
  });
});
```
`fresh-install.test.ts` follows the identical shape with the new DinD fixture in place of postgres/redis (or alongside them, if the DinD harness itself spins up nested Postgres/Redis containers via the production `docker-compose.yml`). `idempotent-rerun.test.ts` runs `install.sh` twice sequentially inside the same DinD container (D-18 layer 2's core requirement) — no existing test in this repo runs a command twice against the same fixture, so that specific "run twice, assert final-state equality" structure is new, though the surrounding `try`/`finally`/`afterEach` scaffolding is copied.

**Reading `NOODARA_SETUP_TOKEN=` from process output** (line 88, directly reusable assertion pattern):
```typescript
expect(activeProcess.stdout).toMatch(/NOODARA_SETUP_TOKEN=.+/);
```
`fresh-install.test.ts`'s INST-04 assertion (reading the token from `docker compose logs api` instead of a spawned process's own stdout) should assert against the same fixed `NOODARA_SETUP_TOKEN=<value>` shape `bootstrap-admin.ts` already emits (`apps/control-plane/src/boot/bootstrap-admin.ts` line 83: `process.stdout.write(\`NOODARA_SETUP_TOKEN=${revealSecret(token)}\\n\`)`) — this producer-side contract is already implemented and tested (phase 1); the new test only needs to consume it via `docker compose logs api` inside the DinD container.

**`preseed-admin.test.ts`'s behavior contract** is entirely already implemented in `apps/control-plane/src/boot/bootstrap-admin.ts` (read in full, 212 lines) — `preseedAdmin()` (lines 136-170) and `hasPreseedVariables()` (lines 181-187) define exactly what happens when `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` are both set; the new test only needs to prove `install.sh` correctly writes both into `.env` and that the resulting container boot reaches the "admin created, no token printed" path — no new application logic, purely an installer-level proof of an existing, already-unit-tested contract.

---

## Shared Patterns

### Testcontainers fixture shape (labels, wait strategy, idempotent stop)
**Source:** `tests/integration/helpers/ssh.ts`, `tests/integration/helpers/postgres.ts`, `tests/integration/helpers/redis.ts` (all read in full)
**Apply to:** `installer-dind.ts` and any other new Testcontainers-backed fixture this phase introduces
```typescript
// Every fixture in this repo follows this exact triad:
// 1. .withLabels({ 'noodara.test': 'true' })   — required for CI's stray-container check
// 2. A real wait strategy (log message / container health), never a fixed sleep
// 3. An idempotent stop(): () => Promise<void>, guarded by a local `stopped` boolean
let stopped = false;
const stop = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  await container.stop();
};
```

### Stray-container cleanup assertion
**Source:** `tests/integration/helpers/ssh.ts` lines 198-203 (`assertNoStrayTestContainers`), inlined equivalently in `tests/integration/boot/boot-command.test.ts` lines 41-46
**Apply to:** Every new `tests/integration/installer/*.test.ts` file's `afterEach`
```typescript
export async function assertNoStrayTestContainers(): Promise<void> {
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((container) => container.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
}
```

### GitHub Actions workflow conventions (SHA-pinned actions, per-job permissions, sized timeouts, concurrency group)
**Source:** `.github/workflows/ci.yml`, `.github/workflows/nightly.yml` (both read in full)
**Apply to:** `.github/workflows/release.yml`
```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  example:
    runs-on: ubuntu-latest
    timeout-minutes: 15   # sized + sourced in a comment, never the default
    permissions:
      contents: read       # least privilege, per job, no workflow-level block
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
```

### Fail-fast env validation with no fallback literal
**Source:** `apps/control-plane/src/env.ts` (read in full), `apps/web/next.config.ts`'s `readApiOrigin()` (lines 13-22)
**Apply to:** `install.sh`'s own preflight checks conceptually (fail with a named, actionable message per cause, never a silent default) and as the reason `apps/web/Dockerfile`'s build-arg step must be exact, not best-effort
```typescript
// apps/web/next.config.ts — the pattern install.sh's own preflight messaging should echo in spirit
function readApiOrigin(): string {
  const value = process.env.NOODARA_API_ORIGIN;
  if (value === undefined || value.length === 0) {
    throw new Error('NOODARA_API_ORIGIN is required ...');
  }
  return value;
}
```

### One image, two entrypoints (`command:` override)
**Source:** ADR 0003 (`docs/adr/0003-runtime-entrypoints-and-module-resolution.md`, read in full), `apps/control-plane/package.json`'s `start`/`start:worker` scripts
**Apply to:** `apps/control-plane/Dockerfile` and the `api`/`worker` services in `docker-compose.yml`
```json
"start": "node dist/server.js",
"start:worker": "node dist/worker.js"
```
Already-locked contract (phase 4 D-23) — the Dockerfile builds one image; Compose's `api`/`worker` services differ only by `command:`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `install.sh` | utility | batch/orchestration | No shell script of any kind exists in this repo today — every existing script is Node (`.mjs`). Planner must build this from RESEARCH.md's Patterns 1-7 directly (dash-safe POSIX sh, `get.docker.com` conventions), using only the apt-repo Docker-install block (quoted above from `sshd-ubuntu-22.04/Dockerfile`) as a partial, already-repo-verified precedent. |
| `docker-compose.yml` (production) | config | declarative | No production Compose file exists — only `docker-compose.dev.yml` (Postgres+Redis only, no app services, `ports:` published on both DB services). Use it as the direct base per the "Pattern Assignments" section above, but every deviation (no host ports on postgres/redis, new `api`/`worker`/`web`/`migrate` services, the redis healthcheck fix) must be applied deliberately, not copied wholesale. |
| `.dockerignore` | config | N/A | Does not exist. No repo convention to draw from beyond the existing root `.gitignore`'s general exclude-pattern style (not read this session; low-risk to consult directly if needed). |
| `apps/control-plane/Dockerfile` | config (build) | file I/O/build | No application Dockerfile exists anywhere in `apps/**` or `packages/**`. The only Dockerfile in the whole repo is the sshd test fixture (structurally different — single-stage, no `turbo prune`). Build entirely from RESEARCH.md Pattern 10 plus ADR 0003's already-locked dist/ contract. |
| `apps/web/Dockerfile` | config (build) | file I/O/build | Same as above — no analog. Build from RESEARCH.md Pattern 10 (Next.js standalone runner, Context7-verified) plus the concrete `apps/web/public/` absence noted above. |
| `.github/workflows/release.yml` | CI config | event-driven | No release/tag-triggered workflow exists — only `ci.yml` (PR/push-to-main) and `nightly.yml` (schedule). Structural conventions (SHA-pinning, per-job permissions, concurrency group, sized timeouts) transfer directly from both; the GHCR/buildx/multi-arch content itself is new, built from RESEARCH.md Pattern 11. |
| `docs/install.md` | docs | N/A | No installation-facing doc exists. `docs/ci-readiness.md` gives house tone/structure only; content is entirely new. |

## Metadata

**Analog search scope:** `tests/integration/helpers/`, `tests/integration/boot/`, `tests/integration/images/`, `.github/workflows/`, root config files (`docker-compose.dev.yml`, `turbo.json`, `pnpm-workspace.yaml`, `.env.example`), `apps/control-plane/src/{env.ts,db/migrate.ts,boot/bootstrap-admin.ts}`, `apps/control-plane/scripts/`, `apps/web/next.config.ts`, `apps/{control-plane,web}/package.json`, `docs/adr/0003-runtime-entrypoints-and-module-resolution.md`, `docs/ci-readiness.md`
**Files scanned/read in full or targeted:** 20
**Pattern extraction date:** 2026-09-21
