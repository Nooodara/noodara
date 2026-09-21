// 06-05-PLAN.md Task 3: builds the real `apps/web/Dockerfile` image and proves the baked
// `NOODARA_API_ORIGIN` proxy actually works -- not merely that the Dockerfile parses or that
// `next build` succeeds. 06-RESEARCH.md's Pattern 8 (Context7-verified against /vercel/next.js)
// is that `rewrites()` is evaluated once at `next build` and never again, so the only way to prove
// the published image proxies to the right place is a real HTTP request through a running web
// container into a running api container on the same Docker network, with the api container
// reachable under the exact alias (`api`) the production docker-compose.yml uses.
//
// Networking: unlike control-plane-image.test.ts (06-03-PLAN.md), this suite needs the web
// container to resolve a literal hostname (`api`) baked into its image at build time -- the
// host.docker.internal/host-gateway mechanism that test uses lets a container reach a *host*
// port, but cannot give a container a network-visible alias of its own. This suite therefore
// creates an explicit Testcontainers `Network` and attaches both the api and web containers to
// it with `withNetworkAliases('api')` on the api container; the api container itself still
// reaches the Postgres/Redis Testcontainers fixtures via the same host-gateway mechanism
// control-plane-image.test.ts already proved, since postgres.ts/redis.ts expose no shared network
// of their own (same fallback, confirmed still true for this plan).
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Resolved from this file's own location, never process.cwd() -- the build context for
// `GenericContainer.fromDockerfile` must be the repo root regardless of which directory Vitest
// runs from (mirrors control-plane-image.test.ts's REPO_ROOT resolution).
const REPO_ROOT = path.resolve(HERE, '../../..');
const WEB_DOCKERFILE_NAME = 'apps/web/Dockerfile';
const CONTROL_PLANE_DOCKERFILE_NAME = 'apps/control-plane/Dockerfile';

// Test-only tags (hard_rules #8) -- never pushed, never collide with a real release tag.
const WEB_IMAGE_TAG = 'noodara-web:test-06-05';
// A deliberately unreachable origin baked in at build time -- the `.invalid` TLD is reserved by
// RFC 2606 to never resolve, so this is a deterministic DNS-failure negative control, never a
// network flake.
const WRONG_ORIGIN_IMAGE_TAG = 'noodara-web:test-06-05-wrong-origin';
const WRONG_ORIGIN = 'http://api-does-not-exist.invalid:3000';
const CONTROL_PLANE_IMAGE_TAG = 'noodara-control-plane:test-06-05';
const API_ALIAS = 'api';
const API_PORT = 3000;
const WEB_PORT = 3000;

const HOST_GATEWAY_EXTRA_HOST = { host: 'host.docker.internal', ipAddress: 'host-gateway' };

// Confirmed against this repo's real `next start`/standalone output (Next.js 16.3.5, see
// tests/e2e/fixtures/stack.ts's own WEB_READY_PATTERN): "✓ Ready in 147ms".
const WEB_READY_PATTERN = /Ready in \d+ms/;
const API_READY_PATTERN = /Server listening at/;

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
 *  own accessors -- never a repo literal, never logged (T-06-22). Mirrors
 *  control-plane-image.test.ts exactly. */
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

/** A fresh, obviously-fake, format-valid environment -- the same stand-in shapes
 *  control-plane-image.test.ts already uses for the same purpose (T-06-22: never logged, never a
 *  repo literal). */
function apiEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NOODARA_MASTER_KEY: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: `web-image-test-${randomUUID()}-${randomUUID()}`,
    DATABASE_URL: 'postgres://test_user:test-fixture-pw@localhost:5432/noodara_test',
    REDIS_URL: 'redis://127.0.0.1:1/',
    NOODARA_PUBLIC_URL: 'http://localhost:3000',
    PORT: String(API_PORT),
    LOG_LEVEL: 'info',
    ...overrides,
  };
}

/** Best-effort local image cleanup (hard_rules #8) -- never fails the suite if the image was
 *  never built (e.g. an earlier `beforeAll`/`it` failure). */
function removeImage(tag: string): void {
  spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' });
}

/** Finds one real static-asset file inside the running web container's own `.next/static`
 *  directory and returns its public `/_next/static/...` URL path -- read from the container
 *  itself rather than assumed from a host-side build, since the Docker build produces its own
 *  BUILD_ID/asset hashes independently of whatever a local `next build` on the host produced. */
async function findStaticAssetPath(container: StartedTestContainer): Promise<string> {
  const result = await container.exec(['find', 'apps/web/.next/static', '-type', 'f']);
  if (result.exitCode !== 0) {
    throw new Error(`findStaticAssetPath: find exited ${String(result.exitCode)}: ${result.stderr}`);
  }
  const firstLine = result.stdout.split('\n').find((line) => line.trim().length > 0);
  if (firstLine === undefined) {
    throw new Error(`findStaticAssetPath: no static files found under apps/web/.next/static:\n${result.stdout}`);
  }
  const prefix = 'apps/web/.next/static/';
  if (!firstLine.startsWith(prefix)) {
    throw new Error(`findStaticAssetPath: unexpected path shape ${firstLine}`);
  }
  return `/_next/static/${firstLine.slice(prefix.length)}`;
}

describe('web production image (06-05-PLAN.md)', () => {
  let network: StartedNetwork;
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let apiContainer: StartedTestContainer;

  beforeAll(async () => {
    await GenericContainer.fromDockerfile(REPO_ROOT, CONTROL_PLANE_DOCKERFILE_NAME).build(CONTROL_PLANE_IMAGE_TAG, {
      deleteOnExit: false,
    });
    await GenericContainer.fromDockerfile(REPO_ROOT, WEB_DOCKERFILE_NAME)
      .withBuildArgs({ NOODARA_API_ORIGIN: `http://${API_ALIAS}:${String(API_PORT)}` })
      .build(WEB_IMAGE_TAG, { deleteOnExit: false });
    await GenericContainer.fromDockerfile(REPO_ROOT, WEB_DOCKERFILE_NAME)
      .withBuildArgs({ NOODARA_API_ORIGIN: WRONG_ORIGIN })
      .build(WRONG_ORIGIN_IMAGE_TAG, { deleteOnExit: false });

    network = await new Network().start();

    postgres = await startPostgres({ migrate: true });
    redis = await startRedis();

    apiContainer = await new GenericContainer(CONTROL_PLANE_IMAGE_TAG)
      .withLabels({ 'noodara.test': 'true' })
      .withNetwork(network)
      .withNetworkAliases(API_ALIAS)
      .withExtraHosts([HOST_GATEWAY_EXTRA_HOST])
      .withEnvironment(
        apiEnv({
          DATABASE_URL: containerAccessibleDatabaseUrl(postgres),
          REDIS_URL: containerAccessibleRedisUrl(redis),
        }),
      )
      .withWaitStrategy(Wait.forLogMessage(API_READY_PATTERN))
      .withStartupTimeout(180_000)
      .start();
  }, 600_000);

  afterAll(async () => {
    await apiContainer?.stop();
    await redis?.stop();
    await postgres?.stop();
    await network?.stop();
    removeImage(WEB_IMAGE_TAG);
    removeImage(WRONG_ORIGIN_IMAGE_TAG);
    removeImage(CONTROL_PLANE_IMAGE_TAG);
  });

  afterEach(async () => {
    // noodara-tdd skill §5: no container labelled noodara.test=true survives a test.
    await assertNoStrayTestContainers();
  });

  it(
    'proxies GET /api/config through to the real api container (Fastify, not a Next.js 404)',
    async () => {
      const web = await new GenericContainer(WEB_IMAGE_TAG)
        .withLabels({ 'noodara.test': 'true' })
        .withNetwork(network)
        .withExposedPorts(WEB_PORT)
        .withWaitStrategy(Wait.forLogMessage(WEB_READY_PATTERN))
        .withStartupTimeout(120_000)
        .start();
      try {
        const host = web.getHost();
        const port = web.getMappedPort(WEB_PORT);
        const response = await fetch(`http://${host}:${String(port)}/api/config`, {
          signal: AbortSignal.timeout(10_000),
        });
        // Unauthenticated: the real api's requireSession hook answers 401 with its own
        // D-16 error-body shape -- a Next.js 404 for an unmatched route would be HTML with no
        // `error` field at all, so this body shape is evidence the request reached the real
        // Fastify app, not proof merely that *some* 401 came back.
        expect(response.status).toBe(401);
        const body = (await response.json()) as { error: string; message: string };
        expect(body.error).toBe('UNAUTHORIZED');
      } finally {
        await web.stop();
      }
    },
    150_000,
  );

  it(
    'serves / with the phase-5 security headers intact and a real static asset at 200',
    async () => {
      const web = await new GenericContainer(WEB_IMAGE_TAG)
        .withLabels({ 'noodara.test': 'true' })
        .withNetwork(network)
        .withExposedPorts(WEB_PORT)
        .withWaitStrategy(Wait.forLogMessage(WEB_READY_PATTERN))
        .withStartupTimeout(120_000)
        .start();
      try {
        const host = web.getHost();
        const port = web.getMappedPort(WEB_PORT);

        // Unauthenticated `/` is matched by apps/web/src/proxy.ts, which redirects to `/login`
        // after a real (unauthenticated) session lookup against the api container -- fetch's
        // default redirect:follow lands on /login's own 200 response, proving proxy.ts's own
        // runtime NOODARA_API_ORIGIN dependency (apps/web/src/proxy.ts, distinct from
        // next.config.ts's build-time-only rewrites()) survives the standalone build too.
        const rootResponse = await fetch(`http://${host}:${String(port)}/`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(rootResponse.status).toBe(200);
        expect(rootResponse.headers.get('x-frame-options')).toBe('DENY');
        expect(rootResponse.headers.get('referrer-policy')).toBe('no-referrer');

        const staticAssetPath = await findStaticAssetPath(web);
        const staticResponse = await fetch(`http://${host}:${String(port)}${staticAssetPath}`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(staticResponse.status).toBe(200);
      } finally {
        await web.stop();
      }
    },
    150_000,
  );

  it(
    'a web image built with a wrong NOODARA_API_ORIGIN never answers /api/config with a 2xx',
    async () => {
      const web = await new GenericContainer(WRONG_ORIGIN_IMAGE_TAG)
        .withLabels({ 'noodara.test': 'true' })
        .withNetwork(network)
        .withExposedPorts(WEB_PORT)
        .withWaitStrategy(Wait.forLogMessage(WEB_READY_PATTERN))
        .withStartupTimeout(120_000)
        .start();
      try {
        const host = web.getHost();
        const port = web.getMappedPort(WEB_PORT);
        const response = await fetch(`http://${host}:${String(port)}/api/config`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.status < 200 || response.status >= 300).toBe(true);
      } finally {
        await web.stop();
      }
    },
    150_000,
  );
});
