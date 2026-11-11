// Composes the real stack a Playwright spec drives — Postgres, Redis, the control-plane API, the
// worker and the built Next.js web app — reusing the exact Testcontainers/boot-process helpers
// tests/integration/** already established (postgres.ts, redis.ts, boot-process.ts, ssh.ts),
// never a parallel implementation. Teardown only ever checks containers this run started (13-06):
// other runs' `noodara.test=true` containers (e.g. a concurrent integration suite) are not ours.
//
// Test-only host ports preserve localhost and the real browser Origin guard.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildValidBootEnv,
  buildWorkspace,
  repoRoot,
  spawnBootProcess,
  type BootProcess,
} from '../../integration/helpers/boot-process.js';
import { startPostgres, type PostgresFixture } from '../../integration/helpers/postgres.js';
import { startRedis, type RedisFixture } from '../../integration/helpers/redis.js';
import { startSshd, createSshdLifecycle, type SshdFixture, type StartSshdOptions, type SshdLifecycle } from '../../integration/helpers/ssh.js';
import { test as base } from '@playwright/test';

type StartOwnedSshd = (options: StartSshdOptions) => Promise<SshdFixture>;

/** Playwright owns this fixture before test code awaits image build. Teardown runs on setup
 * failure and test timeout, including when no SshdFixture handle was ever returned. */
export const sshTest = base.extend<{ startOwnedSshd: StartOwnedSshd }>({
  startOwnedSshd: async ({}, use, testInfo) => {
    const began = performance.now();
    const owners: SshdLifecycle[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      await use((options) => {
        const owner = createSshdLifecycle(options);
        owners.push(owner);
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        // Read the current timeout at invocation: test.setTimeout may run inside the test.
        // This is the existing outer budget, not a new or increased startup budget.
        if (testInfo.timeout > 0) {
          const remaining = Math.max(0, testInfo.timeout - (performance.now() - began));
          startupTimer = setTimeout(() => owner.cancel(new Error('SSH fixture test deadline')), remaining);
          timers.push(startupTimer);
        }
        // The captured deadline bounds startup only. Once a handle is returned, the runner
        // owns its lifetime and may legitimately extend the test budget (discovery does).
        // Real timeout teardown still cancels and joins every registered owner below.
        return owner.result.finally(() => clearTimeout(startupTimer));
      });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const owner of owners) owner.cancel();
      const results = await Promise.allSettled(owners.map((owner) => owner.stop()));
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('SSH fixture cleanup unverified');
      }
    }
  },
});
import { resolveE2ePorts, type E2ePorts } from './ports.js';

const execFileAsync = promisify(execFile);
const WORKER_READY_PATTERN = /Worker ready/;
// Confirmed against this project's real `next start` output (Next.js 16.3.5): "✓ Ready in 147ms".
const WEB_READY_PATTERN = /Ready in \d+ms/;

const CONTROL_PLANE_DIR = path.join(repoRoot, 'apps/control-plane');

// 24-04 (H1): the ACME test seam lives only here, never in the control-plane image or compose
// files. The worker trusts Pebble's listener root from a file the `acme` fixture writes into the
// run dir once Pebble is up (read lazily at proxy install); the API's DNS resolver is pointed at
// challtestsrv by a preload that reads the `ip:port` the fixture writes (fixtures/dns-seam.mjs).
export const E2E_ACME_CA_URL = 'https://pebble:14000/dir';
export const ACME_ROOT_FILE_NAME = 'pebble-listener-root.pem';
export const DNS_SERVER_FILE_NAME = 'dns-server';
export const STACK_LOG_DIR_NAME = 'stack-logs';
/** 30-05: the replay provider writes its loopback `ip:port` here (fixtures/ai-seam.mjs). */
export const AI_REPLAY_FILE_NAME = 'ai-replay';
/** The env minimum (60 s): issuance failures and re-checks land within a test's budget. */
const E2E_CERT_TIMING_MS = '60000';
const DNS_SEAM = path.join(repoRoot, 'tests/e2e/fixtures/dns-seam.mjs');
const AI_SEAM = path.join(repoRoot, 'tests/e2e/fixtures/ai-seam.mjs');
const LOG_FLUSH_MS = 500;

function runDir(): string {
  const dir = process.env['NOODARA_E2E_RUN_DIR'];
  if (dir === undefined || dir === '') throw new Error('startStack: NOODARA_E2E_RUN_DIR unset (global-setup did not run)');
  return dir;
}

/** Mirrors every stack process's stdout/stderr into `<runDir>/stack-logs/` (canary greps). */
function mirrorLogs(dir: string, processes: Readonly<Record<string, BootProcess | undefined>>): () => void {
  const logDir = path.join(dir, STACK_LOG_DIR_NAME);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const flush = (): void => {
    for (const [name, proc] of Object.entries(processes)) {
      if (proc === undefined) continue;
      try {
        writeFileSync(path.join(logDir, `${name}.log`), `${proc.stdout}\n${proc.stderr}`, { mode: 0o600 });
      } catch {
        // The run dir may already be gone at teardown.
      }
    }
  };
  const timer = setInterval(flush, LOG_FLUSH_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    flush();
  };
}

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
  readonly ports: E2ePorts;
  readonly postgres: PostgresFixture;
  readonly redis: RedisFixture;
  readonly api: BootProcess;
  readonly worker: BootProcess;
  readonly web: BootProcess;
  readonly stopLogs: () => void;
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
    () => {
      throw new Error(`startStack: ${label} did not become ready within ${String(timeoutMs)}ms`);
    },
  );
}

/** Run-scoped leak check: only the given container ids (the ones this run started). */
async function assertContainersGone(ids: readonly string[]): Promise<void> {
  const survivors: string[] = [];
  for (const id of ids) {
    const { stdout } = await execFileAsync('docker', ['ps', '-aq', '--no-trunc', '--filter', `id=${id}`], {
      timeout: 30_000,
    });
    if (stdout.trim() !== '') survivors.push(id.slice(0, 12));
  }
  if (survivors.length > 0) {
    throw new Error(`stopStack: containers started by this run survived teardown: ${survivors.join(', ')}`);
  }
}

async function assertPortsFree(ports: readonly number[], stage: string): Promise<void> {
  const busy: number[] = [];
  for (const port of ports) {
    const inUse = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => {
        resolve(true);
      });
      probe.listen(port, () => {
        probe.close(() => {
          resolve(false);
        });
      });
    });
    if (inUse) busy.push(port);
  }
  if (busy.length > 0) {
    throw new Error(`${stage}: host ports in use: ${busy.join(', ')}`);
  }
}

async function killAndWait(proc: BootProcess, label: string): Promise<void> {
  try {
    await proc.killGroup();
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

  const ports = resolveE2ePorts();
  const { apiPort, webPort, apiOrigin, webOrigin } = ports;
  await assertPortsFree([webPort, apiPort], 'startStack');
  const dir = runDir();
  // Turbo includes NOODARA_API_ORIGIN in the build hash: a different selected API cannot reuse
  // a rewrite baked for another origin. Both the build and runtime must see the selected pair.
  process.env.NOODARA_API_ORIGIN = apiOrigin;
  process.env.NOODARA_PUBLIC_URL = webOrigin;
  buildWorkspace();

  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let api: BootProcess | undefined;
  let worker: BootProcess | undefined;
  let web: BootProcess | undefined;
  const processes: Record<string, BootProcess | undefined> = {};
  const stopLogs = mirrorLogs(dir, processes);
  try {
    postgres = await startPostgres({ migrate: true });
    redis = await startRedis();
    const sharedEnv: NodeJS.ProcessEnv = {
      ...buildValidBootEnv(postgres.connectionString, redis.connectionUrl),
      PORT: String(apiPort),
      NOODARA_PUBLIC_URL: webOrigin,
      NOODARA_API_ORIGIN: apiOrigin,
      NOODARA_ADMIN_EMAIL: E2E_ADMIN_EMAIL,
      NOODARA_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
      NOODARA_ACME_CA_URL: E2E_ACME_CA_URL,
      NOODARA_ACME_CA_ROOT_FILE: path.join(dir, ACME_ROOT_FILE_NAME),
      NOODARA_CERT_CHECK_INTERVAL_MS: E2E_CERT_TIMING_MS,
      NOODARA_CERT_ISSUE_TIMEOUT_MS: E2E_CERT_TIMING_MS,
    };

    api = spawnBootProcess({
      command: process.execPath,
      args: ['--import', DNS_SEAM, '--import', AI_SEAM, path.join(CONTROL_PLANE_DIR, 'dist/server.js')],
      cwd: CONTROL_PLANE_DIR,
      env: {
        ...sharedEnv,
        E2E_DNS_SERVER_FILE: path.join(dir, DNS_SERVER_FILE_NAME),
        E2E_AI_REPLAY_FILE: path.join(dir, AI_REPLAY_FILE_NAME),
      },
    });
    processes['api'] = api;
    await waitForReady(api, new RegExp(`Server listening at http://[^ ]*:${String(apiPort)}(?:[^0-9]|$)`), `the API on port ${String(apiPort)}`, 60_000);

    worker = spawnBootProcess({
      command: process.execPath,
      args: [path.join(CONTROL_PLANE_DIR, 'dist/worker.js')],
      cwd: CONTROL_PLANE_DIR,
      env: sharedEnv,
    });
    processes['worker'] = worker;
    await waitForReady(worker, WORKER_READY_PATTERN, 'the worker', 60_000);

    web = spawnBootProcess({
      command: 'pnpm',
      args: ['--filter', '@noodara/web', 'exec', 'next', 'start', '--port', String(webPort)],
      cwd: repoRoot,
      env: {
        ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
        PORT: String(webPort),
        NOODARA_PUBLIC_URL: webOrigin,
        NOODARA_API_ORIGIN: apiOrigin,
      },
    });
    processes['web'] = web;
    await waitForReady(web, WEB_READY_PATTERN, `the web app on port ${String(webPort)}`, 60_000);
    activeStack = {
      baseUrl: webOrigin, adminEmail: E2E_ADMIN_EMAIL, adminPassword: E2E_ADMIN_PASSWORD,
      ports, postgres, redis, api, worker, web, stopLogs,
    };
  } catch (err) {
    await Promise.allSettled([
      ...Object.values(processes).filter((proc): proc is BootProcess => proc !== undefined).map((proc) => proc.killGroup()),
    ]);
    stopLogs();
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
    // A foreign listener may have won the check/bind race. Never kill it or require its port
    // to be free after failed startup; only the process handles above belong to this run.
    throw err;
  }

  return { baseUrl: activeStack.baseUrl, adminEmail: activeStack.adminEmail, adminPassword: activeStack.adminPassword };
}

/**
 * Starts a real Ubuntu 24.04 sshd Testcontainer (reusing `startSshd` verbatim, never a second
 * container-lifecycle implementation) and registers it on this module's own `activeSshd` handle —
 * `stopStack` tears it down as a safety net even if the caller's own `finally` never runs.
 */
export async function startCriticalPathSshd(start: () => Promise<SshdFixture> = () => startSshd({ ubuntu: '24.04' })): Promise<SshdFixture> {
  if (activeSshd !== undefined) {
    throw new Error('startCriticalPathSshd: an sshd fixture is already running — call stopCriticalPathSshd first');
  }
  const fixture = await start();
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
 * `closeAll` and `worker.ts`'s shutdown handler use) — and finishes by asserting the containers
 * this run started are gone (noodara-tdd skill §5). Idempotent: a second call is a no-op.
 */
export async function stopStack(stack: Stack): Promise<void> {
  // Safety net for the critical-path spec's own sshd fixture — runs first and unconditionally, so
  // a crash that skips the spec's own `finally` (stopCriticalPathSshd there) still leaves no
  // stray container behind, whatever state the rest of the stack is in.
  await stopCriticalPathSshd();

  const handle = activeStack;
  activeStack = undefined;

  if (handle === undefined) return;
  if (handle.baseUrl !== stack.baseUrl) {
    console.warn('stopStack: received a Stack value that does not match the active one — stopping the active one anyway');
  }

  await killAndWait(handle.web, 'the web app');
  await killAndWait(handle.worker, 'the worker');
  await killAndWait(handle.api, 'the API');
  handle.stopLogs();

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

  await assertPortsFree([handle.ports.webPort, handle.ports.apiPort], 'stopStack');
  await assertContainersGone([handle.postgres.container.getId(), handle.redis.container.getId()]);
}
