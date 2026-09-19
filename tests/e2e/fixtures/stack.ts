// Composes the real stack a Playwright spec drives — Postgres, Redis, the control-plane API, the
// worker and the built Next.js web app — reusing the exact Testcontainers/boot-process helpers
// tests/integration/** already established (postgres.ts, redis.ts, boot-process.ts, ssh.ts's
// assertNoStrayTestContainers), never a parallel implementation.
//
// Port/origin contract is docs/adr/0006's, fixed rather than OS-assigned: the API listens on
// 3100, the web app on 3000, and NOODARA_PUBLIC_URL is the web origin so a mutating request's real
// browser `Origin` header satisfies the control plane's Origin guard instead of 403
// FORBIDDEN_ORIGIN (T-5-41).
import path from 'node:path';
import {
  buildValidBootEnv,
  buildWorkspace,
  repoRoot,
  spawnBootProcess,
  type BootProcess,
} from '../../integration/helpers/boot-process.js';
import { startPostgres, type PostgresFixture } from '../../integration/helpers/postgres.js';
import { startRedis, type RedisFixture } from '../../integration/helpers/redis.js';
import { assertNoStrayTestContainers, startSshd, type SshdFixture } from '../../integration/helpers/ssh.js';

const API_PORT = 3100;
const WEB_PORT = 3000;
const WEB_ORIGIN = `http://localhost:${String(WEB_PORT)}`;
const API_ORIGIN = `http://localhost:${String(API_PORT)}`;

const LISTENING_PATTERN = /Server listening at http:\/\/[^:]+:(\d+)/;
const WORKER_READY_PATTERN = /Worker ready/;
// Confirmed against this project's real `next start` output (Next.js 16.3.5): "✓ Ready in 147ms".
const WEB_READY_PATTERN = /Ready in \d+ms/;

const CONTROL_PLANE_DIR = path.join(repoRoot, 'apps/control-plane');

/** Obviously-fake fixture credentials for the preseeded E2E admin (T-5-42) — never a value that
 *  resembles a real secret. Fixed rather than random so a spec can log in deterministically; the
 *  admin account only ever exists inside this fixture's own throwaway Postgres container. */
export const E2E_ADMIN_EMAIL = 'e2e-admin@noodara.test';
export const E2E_ADMIN_PASSWORD = 'Noodara-E2E-Fixture-Only-2026!';

/** The public shape `startStack`/`stopStack` hand to callers — deliberately narrower than the
 *  live process/container handles `RunningStack` below carries, so a spec importing this type
 *  never sees (and can never accidentally hold open) a raw `BootProcess`/Testcontainers reference. */
export interface Stack {
  readonly baseUrl: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
}

interface RunningStack extends Stack {
  readonly postgres: PostgresFixture;
  readonly redis: RedisFixture;
  readonly api: BootProcess;
  readonly worker: BootProcess;
  readonly web: BootProcess;
}

// Playwright's global-setup and global-teardown modules are loaded via plain require/import in
// the same runner process (never a forked child), so this module-level singleton is what
// `stopStack` actually tears down — the `Stack` value a caller passes back in is read only for a
// sanity check, never re-derived from it (a live process/container handle cannot be
// reconstructed from anything serializable). global-setup.ts additionally persists the
// serializable `Stack` fields to a JSON file so a crashed run still leaves a debuggable record.
let activeStack: RunningStack | undefined;

// 05-20-PLAN.md Task 1 (QA-04): the critical-path spec's own real sshd container, started through
// this module rather than by calling `startSshd` (tests/integration/helpers/ssh.ts) directly from
// the spec, so `stopStack`'s own guarded teardown sequence can tear it down as a safety net if the
// spec's own `finally` never runs (a hard crash mid-test) -- mirroring `activeStack`'s own
// singleton discipline immediately above. Every other real-ssh spec in this directory
// (discovery.spec.ts's `@ssh-live`, host-key.spec.ts's `@hostkey`) still owns its own fixture
// directly, unaffected: this module-level handle exists only for the one spec that routes through
// it.
let activeSshd: SshdFixture | undefined;

function waitForReady(bootProcess: BootProcess, pattern: RegExp, label: string, timeoutMs: number): Promise<void> {
  return bootProcess.waitForStdoutMatch(pattern, timeoutMs).then(
    () => undefined,
    (err: unknown) => {
      throw new Error(`startStack: ${label} did not become ready — ${err instanceof Error ? err.message : String(err)}`);
    },
  );
}

async function killAndWait(proc: BootProcess, label: string): Promise<void> {
  try {
    proc.kill();
    await proc.waitForExit(15_000);
  } catch (err) {
    // One process failing to exit cleanly must never skip stopping the rest — logged, not thrown.
    console.warn(`stopStack: ${label} did not exit cleanly: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Starts Postgres, Redis, the API, the worker and the web app, in that order, waiting on each
 * one's own real readiness signal (never a fixed sleep). Rejects — naming which process failed —
 * and tears down everything already started rather than ever resolving a half-started stack.
 */
export async function startStack(): Promise<Stack> {
  if (activeStack !== undefined) {
    throw new Error('startStack: a stack is already running — call stopStack first');
  }

  // apps/web's `next.config.ts` fails fast on a missing NOODARA_API_ORIGIN at build time
  // (docs/adr/0006) — CI's workflow-level env already provides it for `pnpm build`
  // (05-07-PLAN.md), but a plain local `pnpm test:e2e` invocation has no reason to have it set
  // in the ambient shell, so this fixture sets it itself before building.
  process.env.NOODARA_API_ORIGIN = API_ORIGIN;
  // Always exercises current sources, never a stale dist/.next (mirrors
  // tests/integration/global-setup.ts's own rationale, now also covering apps/web's `next build`
  // since Plan 05-07 wired it into the shared `build` task graph).
  buildWorkspace();

  const postgres = await startPostgres({ migrate: true });
  const redis = await startRedis();

  const sharedEnv: NodeJS.ProcessEnv = {
    ...buildValidBootEnv(postgres.connectionString, redis.connectionUrl),
    PORT: String(API_PORT),
    NOODARA_PUBLIC_URL: WEB_ORIGIN,
    NOODARA_API_ORIGIN: API_ORIGIN,
    NOODARA_ADMIN_EMAIL: E2E_ADMIN_EMAIL,
    NOODARA_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
  };

  const api = spawnBootProcess({
    command: process.execPath,
    args: [path.join(CONTROL_PLANE_DIR, 'dist/server.js')],
    cwd: CONTROL_PLANE_DIR,
    env: sharedEnv,
  });

  let worker: BootProcess | undefined;
  let web: BootProcess | undefined;

  try {
    await waitForReady(api, LISTENING_PATTERN, 'the API', 60_000);

    worker = spawnBootProcess({
      command: process.execPath,
      args: [path.join(CONTROL_PLANE_DIR, 'dist/worker.js')],
      cwd: CONTROL_PLANE_DIR,
      env: sharedEnv,
    });
    await waitForReady(worker, WORKER_READY_PATTERN, 'the worker', 60_000);

    web = spawnBootProcess({
      command: 'pnpm',
      args: ['--filter', '@noodara/web', 'start'],
      cwd: repoRoot,
      env: {
        ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
        NOODARA_API_ORIGIN: API_ORIGIN,
      },
    });
    await waitForReady(web, WEB_READY_PATTERN, 'the web app', 60_000);
  } catch (err) {
    api.kill();
    worker?.kill();
    web?.kill();
    await Promise.allSettled([
      api.waitForExit(10_000),
      worker?.waitForExit(10_000) ?? Promise.resolve(null),
      web?.waitForExit(10_000) ?? Promise.resolve(null),
    ]);
    await postgres.stop();
    await redis.stop();
    throw err;
  }

  activeStack = {
    baseUrl: WEB_ORIGIN,
    adminEmail: E2E_ADMIN_EMAIL,
    adminPassword: E2E_ADMIN_PASSWORD,
    postgres,
    redis,
    api,
    worker,
    web,
  };

  return { baseUrl: activeStack.baseUrl, adminEmail: activeStack.adminEmail, adminPassword: activeStack.adminPassword };
}

/**
 * Starts a real Ubuntu 24.04 sshd Testcontainer (reusing `startSshd` verbatim, never a second
 * container-lifecycle implementation) and registers it on this module's own `activeSshd` handle —
 * `stopStack` tears it down as a safety net even if the caller's own `finally` never runs.
 */
export async function startCriticalPathSshd(): Promise<SshdFixture> {
  if (activeSshd !== undefined) {
    throw new Error('startCriticalPathSshd: an sshd fixture is already running — call stopCriticalPathSshd first');
  }
  const fixture = await startSshd({ ubuntu: '24.04' });
  activeSshd = fixture;
  return fixture;
}

/** Idempotent — safe to call more than once (the spec's own `finally` and, if that never runs, a
 *  later `stopStack` invocation both call this). */
export async function stopCriticalPathSshd(): Promise<void> {
  const handle = activeSshd;
  activeSshd = undefined;
  if (handle === undefined) return;
  try {
    await handle.stop();
  } catch (err) {
    console.warn(`stopCriticalPathSshd: sshd fixture did not stop cleanly: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Stops the web app, the worker and the API, then Redis and Postgres — every step individually
 * guarded so one failure can never skip the rest (the same discipline `sse-broadcaster.ts`'s
 * `closeAll` and `worker.ts`'s shutdown handler use) — and finishes by asserting no
 * `noodara.test=true` container survived (noodara-tdd skill §5).
 */
export async function stopStack(stack: Stack): Promise<void> {
  // Safety net for the critical-path spec's own sshd fixture — runs first and unconditionally, so
  // a crash that skips the spec's own `finally` (stopCriticalPathSshd there) still leaves no
  // stray container behind, whatever state the rest of the stack is in.
  await stopCriticalPathSshd();

  const handle = activeStack;
  activeStack = undefined;

  if (handle === undefined) {
    await assertNoStrayTestContainers();
    return;
  }
  if (handle.baseUrl !== stack.baseUrl) {
    console.warn('stopStack: received a Stack value that does not match the active one — stopping the active one anyway');
  }

  await killAndWait(handle.web, 'the web app');
  await killAndWait(handle.worker, 'the worker');
  await killAndWait(handle.api, 'the API');

  try {
    await handle.redis.stop();
  } catch (err) {
    console.warn(`stopStack: Redis container did not stop cleanly: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await handle.postgres.stop();
  } catch (err) {
    console.warn(`stopStack: Postgres container did not stop cleanly: ${err instanceof Error ? err.message : String(err)}`);
  }

  await assertNoStrayTestContainers();
}
