// Reproduces the BLOCKER from 01-VERIFICATION.md: `pnpm dev` and the built `dist/server.js` both
// crash with `ERR_MODULE_NOT_FOUND` before INST-06's fail-fast validation ever runs. Every other
// test in this phase boots the app through Vitest's own module transform (startTestApp()) or
// through `tsx` directly — this file is the first to spawn the real, documented commands as
// child processes, so a regression here can no longer hide behind the test harness.
import { execPath } from 'node:process';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startPostgres } from '../helpers/postgres.js';
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
const LISTENING_PATTERN = /Server listening at http:\/\/0\.0\.0\.0:(\d+)/;

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
    try {
      activeProcess = spawnBootProcess({
        command: execPath,
        args: [SERVER_DIST_ENTRY],
        cwd: CONTROL_PLANE_DIR,
        env: buildValidBootEnv(postgres.connectionString),
      });

      const match = await activeProcess.waitForStdoutMatch(LISTENING_PATTERN, 60_000);
      const port = parseListeningPort(match);

      expect(activeProcess.stdout).toMatch(/NOODARA_SETUP_TOKEN=.+/);

      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe('ok');

      activeProcess.kill();
      const exitCode = await activeProcess.waitForExit(15_000);
      expect(exitCode).not.toBeNull();
    } finally {
      await postgres.stop();
    }
  });
});

describe('dev: package-scoped tsx watch', () => {
  it('reaches Server listening and exits cleanly on signal', async () => {
    const postgres = await startPostgres({ migrate: true });
    try {
      activeProcess = spawnBootProcess({
        command: 'pnpm',
        args: ['--filter', '@noodara/control-plane', 'dev'],
        cwd: repoRoot,
        env: buildValidBootEnv(postgres.connectionString),
      });

      const match = await activeProcess.waitForStdoutMatch(LISTENING_PATTERN, 60_000);
      parseListeningPort(match);

      activeProcess.kill();
      const exitCode = await activeProcess.waitForExit(15_000);
      expect(exitCode).not.toBeNull();
    } finally {
      await postgres.stop();
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
      try {
        activeProcess = spawnBootProcess({
          command: 'pnpm',
          args: ['dev'],
          cwd: repoRoot,
          env: {
            ...buildValidBootEnv(postgres.connectionString),
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

        activeProcess.kill();
        await activeProcess.waitForExit(15_000);
      } finally {
        await postgres.stop();
      }
    },
    120_000,
  );
});
