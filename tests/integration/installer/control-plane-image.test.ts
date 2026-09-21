// 06-03-PLAN.md Task 3: builds the real `apps/control-plane/Dockerfile` image and proves the
// four compiled entrypoints it packages (api, worker, one-shot migrate, the `noodara` CLI) genuinely
// run from it against real Postgres/Redis fixtures -- not merely that the Dockerfile parses.
//
// Networking: `tests/integration/helpers/postgres.ts`/`redis.ts` expose no shared Docker network
// of their own (checked before writing this file), so the container under test reaches them via
// Docker's own `host.docker.internal` alias (`--add-host host.docker.internal:host-gateway`,
// supported on Docker Desktop macOS and on Linux Docker Engine >=20.10) plus each fixture's own
// host-mapped port. This is the documented fallback 06-03-PLAN.md's own Task 3 names over adding
// a network parameter to those two widely-shared helpers. Plan 06-07's Compose-based proof reuses
// this same host-gateway mechanism.
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Resolved from this file's own location, never process.cwd() -- the build context for
// `GenericContainer.fromDockerfile` must be the repo root regardless of which directory Vitest
// runs from (mirrors tests/integration/helpers/ssh.ts's IMAGES_CONTEXT resolution).
const REPO_ROOT = path.resolve(HERE, '../../..');
const DOCKERFILE_NAME = 'apps/control-plane/Dockerfile';

// Test-only tags (hard_rules #8) -- never pushed, never collide with a real release tag.
const IMAGE_TAG = 'noodara-control-plane:test-06-03';
const VERSIONED_IMAGE_TAG = 'noodara-control-plane:test-06-03-versioned';
const VERSIONED_TAG_VALUE = '9.9.9-test';

const HOST_GATEWAY_EXTRA_HOST = { host: 'host.docker.internal', ipAddress: 'host-gateway' };

function readStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    stream.on('end', () => {
      resolve(data);
    });
    stream.on('error', reject);
  });
}

/** Points at the real Postgres fixture through the host-gateway alias, built from the fixture's
 *  own accessors -- never a repo literal, never logged (T-06-22). */
function containerAccessibleDatabaseUrl(postgres: PostgresFixture): string {
  const url = new URL('', 'postgres://');
  url.hostname = 'host.docker.internal';
  url.port = postgres.container.getPort().toString();
  url.pathname = postgres.container.getDatabase();
  url.username = postgres.container.getUsername();
  url.password = postgres.container.getPassword();
  return url.toString();
}

function containerAccessibleRedisUrl(redis: RedisFixture): string {
  const url = new URL('', 'redis://');
  url.hostname = 'host.docker.internal';
  url.port = redis.container.getPort().toString();
  return url.toString();
}

/** A fresh, obviously-fake, format-valid environment -- the exact stand-in shapes
 *  `vitest.config.ts`'s `apps` project already uses for the same purpose, so no new fake-secret
 *  shape enters the repo (T-06-22: this object is never printed on failure). */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NOODARA_MASTER_KEY: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: `installer-image-test-${randomUUID()}-${randomUUID()}`,
    DATABASE_URL: 'postgres://test_user:test-fixture-pw@localhost:5432/noodara_test',
    REDIS_URL: 'redis://127.0.0.1:1/',
    NOODARA_PUBLIC_URL: 'http://localhost:3000',
    PORT: '3000',
    LOG_LEVEL: 'info',
    ...overrides,
  };
}

const APPLIED_MIGRATIONS_PATTERN = /(\d+) migration\(s\) applied/;

function appliedMigrationCount(logs: string): number {
  const match = APPLIED_MIGRATIONS_PATTERN.exec(logs);
  if (match === null) {
    throw new Error(`expected "N migration(s) applied" in db:migrate output, got:\n${logs}`);
  }
  const raw = match[1];
  if (raw === undefined) {
    throw new Error('regex match missing capture group 1');
  }
  return Number(raw);
}

interface OneShotResult {
  readonly logs: string;
}

/** Runs `command` inside `imageTag` to completion and returns its combined stdout/stderr.
 *  `Wait.forOneShotStartup()` makes `.start()` itself reject if the container's exit code is
 *  non-zero -- every call site here expects a clean exit, so a non-zero exit surfaces as this
 *  function throwing, not as a silent wrong-logs assertion failure. */
async function runOneShot(
  imageTag: string,
  command: string[],
  env: Record<string, string>,
): Promise<OneShotResult> {
  const container = await new GenericContainer(imageTag)
    .withLabels({ 'noodara.test': 'true' })
    .withExtraHosts([HOST_GATEWAY_EXTRA_HOST])
    .withCommand(command)
    .withEnvironment(env)
    .withWaitStrategy(Wait.forOneShotStartup())
    .withStartupTimeout(120_000)
    .start();
  try {
    return { logs: await readStream(await container.logs()) };
  } finally {
    await container.stop();
  }
}

interface LongRunningHandle {
  readonly container: StartedTestContainer;
  stop: () => Promise<void>;
}

async function startLongRunning(
  imageTag: string,
  command: string[],
  env: Record<string, string>,
  options: { exposePort?: number; waitFor: RegExp },
): Promise<LongRunningHandle> {
  const base = new GenericContainer(imageTag)
    .withLabels({ 'noodara.test': 'true' })
    .withExtraHosts([HOST_GATEWAY_EXTRA_HOST])
    .withCommand(command)
    .withEnvironment(env)
    .withWaitStrategy(Wait.forLogMessage(options.waitFor))
    .withStartupTimeout(120_000);
  const configured = options.exposePort === undefined ? base : base.withExposedPorts(options.exposePort);
  const container = await configured.start();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await container.stop();
  };
  return { container, stop };
}

/** Best-effort local image cleanup (hard_rules #8) -- never fails the suite if the image was
 *  never built (e.g. an earlier `beforeAll`/`it` failure). */
function removeImage(tag: string): void {
  spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' });
}

describe('control-plane production image (06-03-PLAN.md)', () => {
  beforeAll(async () => {
    await GenericContainer.fromDockerfile(REPO_ROOT, DOCKERFILE_NAME).build(IMAGE_TAG, { deleteOnExit: false });
  }, 600_000);

  afterAll(() => {
    removeImage(IMAGE_TAG);
    removeImage(VERSIONED_IMAGE_TAG);
  });

  afterEach(async () => {
    // noodara-tdd skill §5: no container labelled noodara.test=true survives a test.
    await assertNoStrayTestContainers();
  });

  it(
    'builds from apps/control-plane/Dockerfile and runs as a non-root user',
    async () => {
      const result = await runOneShot(
        IMAGE_TAG,
        ['node', '-e', 'process.stdout.write(String(process.getuid()))'],
        {},
      );
      expect(result.logs.trim()).not.toBe('0');
    },
    120_000,
  );

  it(
    'node dist/db/migrate.js applies pending migrations, then reports 0 applied on a second run',
    async () => {
      const postgres = await startPostgres({ migrate: false });
      try {
        const env = baseEnv({ DATABASE_URL: containerAccessibleDatabaseUrl(postgres) });

        const first = await runOneShot(IMAGE_TAG, ['node', 'dist/db/migrate.js'], env);
        expect(first.logs).toContain('db:migrate completed');
        expect(appliedMigrationCount(first.logs)).toBeGreaterThan(0);

        // Idempotency proof: Compose's own `up` re-runs the one-shot `migrate` service on every
        // subsequent `docker compose up` even though it already exited 0 once (a documented
        // Compose behavior, github.com/docker/compose/issues/9260) -- safe only because Drizzle's
        // migrate() diffs the migrations-tracking table and no-ops when nothing is pending.
        const second = await runOneShot(IMAGE_TAG, ['node', 'dist/db/migrate.js'], env);
        expect(second.logs).toContain('db:migrate completed');
        expect(appliedMigrationCount(second.logs)).toBe(0);
      } finally {
        await postgres.stop();
      }
    },
    300_000,
  );

  it(
    'node dist/server.js answers GET /health 200 with checks.postgres pass',
    async () => {
      const postgres = await startPostgres({ migrate: true });
      const redis = await startRedis();
      let handle: LongRunningHandle | undefined;
      try {
        const env = baseEnv({
          DATABASE_URL: containerAccessibleDatabaseUrl(postgres),
          REDIS_URL: containerAccessibleRedisUrl(redis),
        });
        handle = await startLongRunning(IMAGE_TAG, ['node', 'dist/server.js'], env, {
          exposePort: 3000,
          waitFor: /Server listening at/,
        });

        const host = handle.container.getHost();
        const port = handle.container.getMappedPort(3000);
        const response = await fetch(`http://${host}:${String(port)}/health`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { status: string; checks: { postgres: string } };
        expect(body.checks.postgres).toBe('pass');
      } finally {
        await handle?.stop();
        await redis.stop();
        await postgres.stop();
      }
    },
    180_000,
  );

  it(
    'node dist/worker.js reaches Worker ready and stays responsive',
    async () => {
      const postgres = await startPostgres({ migrate: true });
      const redis = await startRedis();
      let handle: LongRunningHandle | undefined;
      try {
        const env = baseEnv({
          DATABASE_URL: containerAccessibleDatabaseUrl(postgres),
          REDIS_URL: containerAccessibleRedisUrl(redis),
        });
        handle = await startLongRunning(IMAGE_TAG, ['node', 'dist/worker.js'], env, {
          waitFor: /Worker ready/,
        });

        // The wait strategy above already proved the "Worker ready" log line printed; this
        // confirms the process is still alive and responsive afterward, not merely that it
        // printed one line before crashing.
        const alive = await handle.container.exec(['true']);
        expect(alive.exitCode).toBe(0);
      } finally {
        await handle?.stop();
        await redis.stop();
        await postgres.stop();
      }
    },
    180_000,
  );

  it(
    'node dist/cli/index.js --help exits 0 and names the admin and secrets commands',
    async () => {
      const result = await runOneShot(IMAGE_TAG, ['node', 'dist/cli/index.js', '--help'], baseEnv());
      expect(result.logs).toMatch(/\badmin\b/);
      expect(result.logs).toMatch(/\bsecrets\b/);
    },
    60_000,
  );

  it(
    'a build with --build-arg NOODARA_IMAGE_VERSION reports that version from GET /health',
    async () => {
      await GenericContainer.fromDockerfile(REPO_ROOT, DOCKERFILE_NAME)
        .withBuildArgs({ NOODARA_IMAGE_VERSION: VERSIONED_TAG_VALUE })
        .build(VERSIONED_IMAGE_TAG, { deleteOnExit: false });

      const postgres = await startPostgres({ migrate: true });
      const redis = await startRedis();
      let handle: LongRunningHandle | undefined;
      try {
        const env = baseEnv({
          DATABASE_URL: containerAccessibleDatabaseUrl(postgres),
          REDIS_URL: containerAccessibleRedisUrl(redis),
        });
        handle = await startLongRunning(VERSIONED_IMAGE_TAG, ['node', 'dist/server.js'], env, {
          exposePort: 3000,
          waitFor: /Server listening at/,
        });

        const host = handle.container.getHost();
        const port = handle.container.getMappedPort(3000);
        const response = await fetch(`http://${host}:${String(port)}/health`);
        const body = (await response.json()) as { version: string };
        expect(body.version).toBe(VERSIONED_TAG_VALUE);
      } finally {
        await handle?.stop();
        await redis.stop();
        await postgres.stop();
      }
    },
    600_000,
  );
});
