// Shared integration harness for every `apps/control-plane/src/services/*.ts` suite in this phase
// (03-05..03-10): a migrated Testcontainers Postgres plus a resolved `ServerServicesDeps` with a
// swappable fake `SshPort`. Every service in this phase opens `db.transaction` (03-05-PLAN.md's
// own test-placement decision), so its tests live in `tests/integration/services/*.test.ts`
// against real Postgres rather than as colocated unit tests.
//
// Mirrors tests/integration/helpers/app.ts's env-before-import discipline exactly: `env.ts`
// fail-fasts by reading `process.env` at *module import time* (INST-06), so a complete, valid
// test environment is written to `process.env` *before* `server-service-deps.ts` (which
// transitively imports `env.ts`) is ever imported — via a dynamic `await import(...)`, never a
// static top-level import of anything under `apps/control-plane/src`.
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  CommandName,
  ConnectInput,
  ConnectOutcome,
  ExecResult,
  SshPort,
  SshSession,
} from '@noodara/ssh';
import { startPostgres, type PostgresFixture } from '../../helpers/postgres.js';

// A fixed clock every test in this phase's services suites can assert against (deps.now()) —
// never `new Date()` inside a test, so `createdAt`/`occurredAt` assertions are deterministic.
export const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
}

/**
 * A `SshPort` test double whose `connect` always fails loudly — the default injected into
 * `deps.ssh` before any test calls `setSshPort`. Services that never call `ssh.connect` (e.g.
 * `registerServer`) never touch this; services that do (connectAndDiscover, plan 03-08) must call
 * `setSshPort` first, or this default makes the omission fail immediately instead of silently
 * resolving.
 */
function buildUnconfiguredSshPort(): SshPort {
  return {
    connect(): Promise<ConnectOutcome> {
      return Promise.reject(
        new Error('service-fixture: no SshPort configured — call setSshPort() before connecting'),
      );
    },
  };
}

// This file's own dynamic-import surface — resolved once, lazily, the first time
// `startServiceFixture` runs, so importing this module alone never triggers `env.ts`.
type ServerServiceDepsModule =
  typeof import('../../../../apps/control-plane/src/services/server-service-deps.js');
export type ServiceFixtureDeps = Awaited<
  ReturnType<ServerServiceDepsModule['resolveServerServicesDeps']>
>;

export interface ServiceFixture {
  readonly db: PostgresFixture['db'];
  readonly deps: ServiceFixtureDeps;
  /** Swaps the `SshPort` implementation `deps.ssh.connect` forwards to, for a later test case —
   *  `deps` itself is the same object for the fixture's whole lifetime. */
  setSshPort(port: SshPort): void;
  /** Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * Starts a migrated Testcontainers Postgres, writes a valid test env, then resolves
 * `ServerServicesDeps` against it with a swappable fake `SshPort` and the fixed clock above.
 * Every service suite in this phase (03-05..03-10) uses this as its one entrypoint, mirroring
 * `tests/integration/helpers/app.ts`'s `startTestApp()` shape for the HTTP-level suites.
 */
export async function startServiceFixture(): Promise<ServiceFixture> {
  const postgres = await startPostgres();
  setTestEnv(postgres.connectionString);

  const { resolveServerServicesDeps } =
    await import('../../../../apps/control-plane/src/services/server-service-deps.js');

  let currentSsh: SshPort = buildUnconfiguredSshPort();
  const forwardingSsh: SshPort = {
    connect: (input: ConnectInput): Promise<ConnectOutcome> => currentSsh.connect(input),
  };

  const deps = await resolveServerServicesDeps({
    db: postgres.db,
    ssh: forwardingSsh,
    now: () => FIXED_NOW,
  });

  const setSshPort = (port: SshPort): void => {
    currentSsh = port;
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await postgres.stop();
  };

  return { db: postgres.db, deps, setSshPort, stop };
}

export interface FakeSshPort extends SshPort {
  /** Every `ConnectInput` this fake received, in call order — so a test can assert which target,
   *  timeouts and trustedFingerprint the service under test passed. */
  readonly calls: ConnectInput[];
}

/**
 * Builds an `SshPort` whose `connect` resolves to `outcome` (or, when `outcome` is a function,
 * to whatever it returns for that call's `ConnectInput` — for a test case that needs a different
 * result on a second attempt). Mirrors `packages/ssh/src/run-discovery.test.ts`'s `buildFakeSession`
 * fake-double shape, one level up at the `SshPort.connect` boundary.
 */
export function buildFakeSshPort(
  outcome: ConnectOutcome | ((input: ConnectInput) => ConnectOutcome),
): FakeSshPort {
  const calls: ConnectInput[] = [];
  return {
    calls,
    connect(input: ConnectInput): Promise<ConnectOutcome> {
      calls.push(input);
      const result = typeof outcome === 'function' ? outcome(input) : outcome;
      return Promise.resolve(result);
    },
  };
}

export interface FakeSshSession extends SshSession {
  /** Every `CommandName` `exec` was called with, in call order. */
  readonly execCalls: CommandName[];
  /** How many times `close()` has been called so far (live — reads the current count). */
  readonly closeCallCount: number;
}

/**
 * Builds an `SshSession` test double scripted by `execResults` (a partial map of `CommandName` to
 * either its `ExecResult` or an `Error` to reject with), recording every `exec` call and `close()`
 * call count — the exact template `packages/ssh/src/run-discovery.test.ts`'s own `buildFakeSession`
 * uses, exported here so `apps/control-plane` service suites (connectAndDiscover, plan 03-08) get
 * the identical double without duplicating it.
 */
export function buildFakeSshSession(
  execResults: Partial<Record<CommandName, ExecResult | Error>>,
): FakeSshSession {
  const execCalls: CommandName[] = [];
  let closeCalls = 0;
  return {
    execCalls,
    get closeCallCount() {
      return closeCalls;
    },
    exec(name: CommandName): Promise<ExecResult> {
      execCalls.push(name);
      const scripted = execResults[name];
      if (scripted === undefined) {
        return Promise.reject(new Error(`unscripted command in test double: ${name}`));
      }
      if (scripted instanceof Error) {
        return Promise.reject(scripted);
      }
      return Promise.resolve(scripted);
    },
    close(): Promise<void> {
      closeCalls += 1;
      return Promise.resolve();
    },
  };
}
