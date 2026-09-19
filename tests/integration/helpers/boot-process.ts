// Spawns the real, documented boot commands (`node dist/server.js`, `tsx watch`, `pnpm dev`) as
// detached child processes and gives the boot smoke test (`boot-command.test.ts`) a way to wait
// on their stdout/exit without ever shelling out to a `timeout` binary — GNU `timeout` is not
// available on macOS, so every bound here is implemented with Node's own `setTimeout`.
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolved from this file's own location, never `process.cwd()` — this module can be imported
 *  from a test running with any working directory. */
export const repoRoot = path.resolve(HERE, '../../..');
const DOMAIN_DIST = path.join(repoRoot, 'packages/domain/dist');
const CONTROL_PLANE_DIST = path.join(repoRoot, 'apps/control-plane/dist');

/**
 * A fresh, valid boot environment for the control plane. Every secret-shaped value is generated
 * per call from `randomBytes`/`randomUUID` (T-1-54) — never a committed literal — and this
 * object must never be interpolated into an assertion message or a log line.
 *
 * `redisUrl` is a required second parameter (Plan 04-07): once the root `pnpm dev` also spawns
 * the worker (`turbo run dev dev:worker`), the worker's own INST-06 fail-fast demands a real,
 * reachable Redis at boot — the previous hardcoded loopback-port placeholder only ever worked
 * because nothing before this plan actually connected to it.
 *
 * `NOODARA_API_ORIGIN` (05-07-PLAN.md): once `apps/web/package.json` declares its own `dev`
 * script, Turborepo's script-name dispatch means the root `pnpm dev` (`turbo run dev dev:worker`)
 * also starts `next dev`, and `next.config.ts`'s `rewrites()` fail-fasts without this variable
 * (docs/adr/0006) — same "the previous placeholder only worked because nothing connected to it"
 * class of gap the `redisUrl` comment above already documents for the worker.
 */
export function buildValidBootEnv(connectionString: string, redisUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;

  env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  env.BETTER_AUTH_SECRET = `boot-test-${randomUUID()}-${randomUUID()}`;
  env.DATABASE_URL = connectionString;
  env.REDIS_URL = redisUrl;
  env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
  env.NOODARA_API_ORIGIN = 'http://localhost:3100';
  // OS-assigned free port so two boot tests can never collide.
  env.PORT = '0';
  env.LOG_LEVEL = 'info';

  return env;
}

export interface SpawnBootProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Wraps `child_process.spawn` with `detached: true` so the whole process tree the command may
 * fork (pnpm -> turbo -> node -> tsx -> node) lands in one OS process group, and accumulates
 * stdout/stderr so callers can assert on real boot output without polling the child directly.
 */
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

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString('utf8');
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        this.hasExited = true;
        this.exitCode = code;
        resolve(code);
      });
    });
  }

  /** Polls accumulated stdout until `pattern` matches or `timeoutMs` elapses. */
  async waitForStdoutMatch(pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = this.stdout.match(pattern);
      if (match) return match;

      if (this.hasExited) {
        throw new Error(
          `boot process exited with code ${String(this.exitCode)} before stdout matched ${pattern.toString()}\n` +
            `--- stdout ---\n${this.stdout}\n--- stderr ---\n${this.stderr}`,
        );
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `boot process did not match ${pattern.toString()} within ${String(timeoutMs)}ms\n` +
            `--- stdout ---\n${this.stdout}\n--- stderr ---\n${this.stderr}`,
        );
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }

  async waitForExit(timeoutMs: number): Promise<number | null> {
    return Promise.race([
      this.exitPromise,
      new Promise<number | null>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`boot process did not exit within ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
  }

  /** Sends SIGTERM to the whole process group, escalating to SIGKILL after a grace period. */
  kill(): void {
    if (this.hasExited) return;
    const pid = this.child.pid;
    if (pid === undefined) return;

    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Group may already be gone.
    }

    setTimeout(() => {
      if (this.hasExited) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Group may already be gone.
      }
    }, 5_000).unref();
  }
}

export function spawnBootProcess(options: SpawnBootProcessOptions): BootProcess {
  return new BootProcess(options);
}

/** Pulls the port out of a Fastify listen-log match. Tolerates a turbo log prefix
 *  (`@noodara/control-plane:dev: {...}`), since Test 4 reads the same line through `turbo run dev`. */
export function parseListeningPort(match: RegExpMatchArray): number {
  const raw = match[1];
  if (raw === undefined) {
    throw new Error('parseListeningPort: match has no capture group');
  }
  const port = Number(raw);
  if (!Number.isInteger(port)) {
    throw new Error(`parseListeningPort: "${raw}" is not an integer port`);
  }
  return port;
}

/** Deletes both packages' build outputs so a caller can prove a command boots through a fresh
 *  `^build`, never through a stale `dist` from a previous run. */
export function removeBuildOutputs(): void {
  rmSync(DOMAIN_DIST, { recursive: true, force: true });
  rmSync(CONTROL_PLANE_DIST, { recursive: true, force: true });
}

/** Runs the real `pnpm build` from the repo root. Turbo caches `build` outputs, so repeat calls
 *  with nothing changed are near-instant. */
export function buildWorkspace(): void {
  const result = spawnSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`pnpm build failed with exit code ${String(result.status)}`);
  }
}
