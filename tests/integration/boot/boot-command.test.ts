// Reproduces the BLOCKER from 01-VERIFICATION.md: `pnpm dev` and the built `dist/server.js` both
// crash with `ERR_MODULE_NOT_FOUND` before INST-06's fail-fast validation ever runs. Every other
// test in this phase boots the app through Vitest's own module transform (startTestApp()) or
// through `tsx` directly — this file is the first to spawn the real, documented commands as
// child processes, so a regression here can no longer hide behind the test harness.
import { execPath } from 'node:process';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startPostgres } from '../helpers/postgres.js';
import { startRedis } from '../helpers/redis.js';
import {
  buildValidBootEnv,
  buildWorkspace,
  parseListeningPort,
  removeBuildOutputs,
  repoRoot,
  spawnBootProcess,
  type BootProcess,
} from '../helpers/boot-process.js';

const CONTROL_PLANE_DIR = path.join(repoRoot, 'apps/control-plane');
const SERVER_DIST_ENTRY = path.join(CONTROL_PLANE_DIR, 'dist/server.js');
const WORKER_DIST_ENTRY = path.join(CONTROL_PLANE_DIR, 'dist/worker.js');
// Fastify resolves `host: '0.0.0.0'` to each of the machine's real network interfaces when
// logging its listen line (loopback plus any LAN address) rather than printing the literal
// string "0.0.0.0" — confirmed against this Fastify version's real output. Match any resolved
// IPv4 host so the assertion doesn't depend on which interface Fastify logs first.
const LISTENING_PATTERN = /Server listening at http:\/\/[^:]+:(\d+)/;
// worker.ts's own deterministic startup marker (Plan 04-07) — mirrors LISTENING_PATTERN's role.
const WORKER_READY_PATTERN = /Worker ready/;

let activeProcess: BootProcess | undefined;

afterEach(async () => {
  if (activeProcess !== undefined) {
    activeProcess.kill();
    await activeProcess.waitForExit(10_000).catch(() => undefined);
    activeProcess = undefined;
  }

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((container) => container.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

describe('start: fail-fast under a completely empty environment', () => {
  it('exits 1 and names all five required variables on stderr', async () => {
    activeProcess = spawnBootProcess({
      command: execPath,
      args: [SERVER_DIST_ENTRY],
      cwd: CONTROL_PLANE_DIR,
      env: {},
    });

    const exitCode = await activeProcess.waitForExit(30_000);
    expect(exitCode).toBe(1);

    for (const variable of [
      'NOODARA_MASTER_KEY',
      'BETTER_AUTH_SECRET',
      'DATABASE_URL',
      'REDIS_URL',
      'NOODARA_PUBLIC_URL',
    ]) {
      expect(activeProcess.stderr).toContain(`NOODARA_CONFIG_ERROR ${variable}`);
    }
  });
});

describe('start: real boot against a migrated database', () => {
  it('reaches Server listening, answers /health, prints the setup token, and exits cleanly on signal', async () => {
    const postgres = await startPostgres({ migrate: true });
    const redis = await startRedis();
    try {
      activeProcess = spawnBootProcess({
        command: execPath,
        args: [SERVER_DIST_ENTRY],
        cwd: CONTROL_PLANE_DIR,
        env: buildValidBootEnv(postgres.connectionString, redis.connectionUrl),
      });

      const match = await activeProcess.waitForStdoutMatch(LISTENING_PATTERN, 60_000);
      const port = parseListeningPort(match);

      expect(activeProcess.stdout).toMatch(/NOODARA_SETUP_TOKEN=.+/);

      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; checks: { postgres: string; worker: string } };
      // D-26 (Plan 04-10): this case boots only the API, with no worker process ever running, so
      // there is genuinely no `noodara:worker:*` heartbeat key for `/health` to find — `degraded`
      // with `checks.worker: 'fail'` is the correct, honest answer here (still 200, never 503;
      // the two-process case in the describe block below is what proves `checks.worker: 'pass'`).
      expect(body.status).toBe('degraded');
      expect(body.checks.postgres).toBe('pass');
      expect(body.checks.worker).toBe('fail');

      // A clean SIGTERM shutdown reports `code: null` (Node only sets a numeric exit code for a
      // process that exited on its own; one terminated by a signal reports the signal instead).
      // `waitForExit` resolving at all — rather than rejecting on its own timeout — is the actual
      // proof of a clean exit.
      activeProcess.kill();
      await activeProcess.waitForExit(15_000);
    } finally {
      await postgres.stop();
      await redis.stop();
    }
  });
});

describe('start:worker: real boot against a migrated database and Redis', () => {
  it('reaches Worker ready and exits cleanly on signal within the D-14 budget', async () => {
    const postgres = await startPostgres({ migrate: true });
    const redis = await startRedis();
    try {
      activeProcess = spawnBootProcess({
        command: execPath,
        args: [WORKER_DIST_ENTRY],
        cwd: CONTROL_PLANE_DIR,
        env: buildValidBootEnv(postgres.connectionString, redis.connectionUrl),
      });

      await activeProcess.waitForStdoutMatch(WORKER_READY_PATTERN, 60_000);

      // See the comment on the equivalent assertion above: waitForExit resolving at all (rather
      // than rejecting on its own timeout) is the proof of a clean SIGTERM shutdown — an idle
      // worker's own `Promise.race` against the D-14 budget resolves via `worker.close()` almost
      // immediately since there is no active job to wait for.
      activeProcess.kill();
      await activeProcess.waitForExit(15_000);
    } finally {
      await postgres.stop();
      await redis.stop();
    }
  });
});

// UF-02/04-SECURITY.md (05-34 Task 3): worker.ts's `main()` was invoked as a bare `void main();`,
// with no `.catch(...)`. `getDb()` is lazy (`pg.Pool` never touches the network until a query
// runs, `db/client.ts`), so no real Postgres is needed to reproduce this — only a genuinely
// unreachable Redis, which `main()` fails fast against via `queueConnection.ping()` (bounded by
// that connection's own `commandTimeout: 2000, maxRetriesPerRequest: 1`, `redis/connections.ts`).
describe('start:worker: a boot-time rejection never dies silently (UF-02)', () => {
  it('exits non-zero with a structured pino error line when a required dependency is unreachable, never a bare unhandled rejection', async () => {
    activeProcess = spawnBootProcess({
      command: execPath,
      args: [WORKER_DIST_ENTRY],
      cwd: CONTROL_PLANE_DIR,
      env: buildValidBootEnv(
        'postgresql://boot-test-user:non-placeholder-boot-test-pw@127.0.0.1:1/boot-test-db',
        'redis://127.0.0.1:1/',
      ),
    });

    const exitCode = await activeProcess.waitForExit(30_000);

    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBeNull();
    // pino's default destination is stdout (never stderr) -- the structured error line lands
    // there, alongside nothing else this entrypoint ever writes to stdout before failing
    // (`Worker ready` only prints on a successful boot). A structured pino line looks nothing like
    // Node's default `UnhandledPromiseRejection`/`util.inspect` crash dump (whose first line is
    // the error's own constructor name, e.g. "MaxRetriesPerRequestError: ...", never `{"level"`).
    const stdoutLines = activeProcess.stdout.trim().split('\n').filter((line) => line.length > 0);
    const lastLine = stdoutLines.at(-1) ?? '';
    expect(lastLine.startsWith('{')).toBe(true);
    const record = JSON.parse(lastLine) as { level: number; err?: { name: string }; msg: string };
    expect(record.level).toBeGreaterThanOrEqual(50); // error or fatal
    expect(record.err?.name).toBeTruthy();
    expect(record.msg).toBe('worker boot failed');
    expect(activeProcess.stdout).not.toContain('Worker ready');
    // The pre-fix crash dump's stack trace never reaches stderr either (Node's own crash report
    // format, distinct from `[redis] ... connection error: <name>` -- the ioredis `'error'`
    // listeners in redis/connections.ts, which fire regardless of this fix and are expected here).
    expect(activeProcess.stderr).not.toMatch(/^\s+at .+\(.+:\d+:\d+\)/m);
  });
});

// D-26/T-4-43/T-4-44 (Plan 04-11 Task 3): both real entrypoints, booted together against one
// Postgres and one Redis, with `/health` proving it can tell a live worker from a dead one — the
// exact operational signal Phase 6's Compose healthchecks/restart policy will key on. This test
// manages its own two child processes directly (not the shared `activeProcess` this file's other
// describes use, which only ever tracks one process at a time) and cleans both up in its own
// `finally`.
describe('two-process boot: api + worker together, /health tells a live worker from a dead one', () => {
  it('reports checks.worker pass while the worker is alive, then degraded/fail once it is killed and its heartbeat TTL expires', async () => {
    const postgres = await startPostgres({ migrate: true });
    const redis = await startRedis();
    let apiProcess: BootProcess | undefined;
    let workerProcess: BootProcess | undefined;

    try {
      const env = buildValidBootEnv(postgres.connectionString, redis.connectionUrl);

      apiProcess = spawnBootProcess({ command: execPath, args: [SERVER_DIST_ENTRY], cwd: CONTROL_PLANE_DIR, env });
      workerProcess = spawnBootProcess({ command: execPath, args: [WORKER_DIST_ENTRY], cwd: CONTROL_PLANE_DIR, env });

      const listeningMatch = await apiProcess.waitForStdoutMatch(LISTENING_PATTERN, 60_000);
      const port = parseListeningPort(listeningMatch);
      await workerProcess.waitForStdoutMatch(WORKER_READY_PATTERN, 60_000);

      // The worker writes its first heartbeat immediately on boot (worker-heartbeat.ts), but the
      // write is fire-and-forget against Redis — a short, bounded wait for it to land avoids a
      // hairline race against `/health`'s own SCAN, without depending on any fixed sleep to prove
      // the *degraded* transition below (that one is bounded by the real 30s TTL instead).
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      const healthyResponse = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(healthyResponse.status).toBe(200);
      const healthyBody = (await healthyResponse.json()) as {
        status: string;
        checks: { postgres: string; redis: string; worker: string };
      };
      expect(healthyBody.status).toBe('ok');
      expect(healthyBody.checks.worker).toBe('pass');

      // Kill the worker and wait past its real, undoctored 30s heartbeat TTL (worker-heartbeat.ts
      // `startWorkerHeartbeat`'s own default) — no production env knob is added purely for this
      // test (Plan 04-11 Task 3's own instruction), so this genuinely proves what a container
      // orchestrator would see after the worker process dies.
      workerProcess.kill();
      await workerProcess.waitForExit(15_000);
      workerProcess = undefined;

      await new Promise((resolve) => {
        setTimeout(resolve, 31_000);
      });

      const degradedResponse = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(degradedResponse.status).toBe(200);
      const degradedBody = (await degradedResponse.json()) as {
        status: string;
        checks: { postgres: string; redis: string; worker: string };
      };
      // T-4-41: still only `pass`/`fail` literals and the version — no error text, no connection
      // detail — and the API itself answers 200 the whole time; a dead worker never restarts it.
      expect(degradedBody.status).toBe('degraded');
      expect(degradedBody.checks.postgres).toBe('pass');
      expect(degradedBody.checks.worker).toBe('fail');

      apiProcess.kill();
      await apiProcess.waitForExit(15_000);
    } finally {
      workerProcess?.kill();
      await workerProcess?.waitForExit(10_000).catch(() => undefined);
      apiProcess?.kill();
      await apiProcess?.waitForExit(10_000).catch(() => undefined);
      await postgres.stop();
      await redis.stop();
    }
  });
});

describe('dev: package-scoped tsx watch', () => {
  it('reaches Server listening and exits cleanly on signal', async () => {
    const postgres = await startPostgres({ migrate: true });
    const redis = await startRedis();
    try {
      activeProcess = spawnBootProcess({
        command: 'pnpm',
        args: ['--filter', '@noodara/control-plane', 'dev'],
        cwd: repoRoot,
        env: buildValidBootEnv(postgres.connectionString, redis.connectionUrl),
      });

      const match = await activeProcess.waitForStdoutMatch(LISTENING_PATTERN, 60_000);
      parseListeningPort(match);

      // See the comment on the equivalent assertion above: waitForExit resolving at all (rather
      // than rejecting on its own timeout) is the proof of a clean SIGTERM shutdown.
      activeProcess.kill();
      await activeProcess.waitForExit(15_000);
    } finally {
      await postgres.stop();
      await redis.stop();
    }
  });
});

// The actual regression proof: with both dist/ directories deleted, the literal root `pnpm dev`
// must still reach `Server listening`, because turbo.json's `dev` task declares
// `dependsOn: ["^build"]`. Test 3 above bypasses turbo's task graph entirely, and every other
// path in this suite pre-builds dist, so without this case a regression in the turbo config
// would be caught by nothing but a static JSON-shape assertion.
describe('dev: clean-tree, turbo-driven root pnpm dev (the regression proof)', () => {
  afterAll(() => {
    // Restore dist even if the test above fails — admin-reset.test.ts and every other boot test
    // in this file need a built dist/ to exist for the rest of the suite.
    buildWorkspace();
  });

  it(
    'reaches Server listening after turbo runs ^build on a tree with no dist',
    async () => {
      removeBuildOutputs();

      const postgres = await startPostgres({ migrate: true });
      // Root `pnpm dev` now runs `turbo run dev dev:worker` (Plan 04-07) — the worker half fails
      // fast without a reachable Redis, so this regression proof needs a real one too.
      const redis = await startRedis();
      try {
        activeProcess = spawnBootProcess({
          command: 'pnpm',
          args: ['dev'],
          cwd: repoRoot,
          env: {
            ...buildValidBootEnv(postgres.connectionString, redis.connectionUrl),
            // Keeps turbo off its interactive TUI on a non-TTY pipe so the child's stdout stays
            // readable.
            TURBO_UI: 'stream',
            NO_COLOR: '1',
            CI: '1',
          },
        });

        // Bounded at 90s: covers a cold ^build plus boot, and stays under this config's 120s
        // testTimeout.
        const match = await activeProcess.waitForStdoutMatch(LISTENING_PATTERN, 90_000);
        parseListeningPort(match);
        await activeProcess.waitForStdoutMatch(WORKER_READY_PATTERN, 90_000);

        activeProcess.kill();
        await activeProcess.waitForExit(15_000);
      } finally {
        await postgres.stop();
        await redis.stop();
      }
    },
    120_000,
  );
});
