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
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe('ok');

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
