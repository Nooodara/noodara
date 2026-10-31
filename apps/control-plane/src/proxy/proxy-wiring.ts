// 22-02: production wiring of the proxy lifecycle. Nothing here imports env.js: worker.ts and
// app.ts pass the config in, so tests build the same pieces without the process environment.
// - createProxyInstallJobDeps: the job handler's ports over the DB, the SSH adapter and config.
// - createProxyRemover: connect (stored host key only) + removeProxy + close; never throws.
// - startProxyWorker: one BullMQ Worker on the `proxy` queue, lock above the install budget.
// - sweepStaleProxyInstalls: the boot sweep (H1); a failure is logged, never fatal.
import { readFile } from 'node:fs/promises';
import { Worker, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedactor } from '@noodara/domain/security';
import type { ProxyExtraHost, SshDeploySession, SshPort, SshTimeouts } from '@noodara/ssh';
import type { Database } from '../db/client.js';
import { createDeployConnect, loadDeployServerFromDb, type DeployServerRow } from '../deploy/deploy-connect.js';
import type { DeployJobLogger } from '../deploy/deploy-worker.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import { BULLMQ_PREFIX } from '../queue/connect-server-queue.js';
import { PROXY_QUEUE_NAME } from '../queue/proxy-queue.js';
import type { MasterKeys } from '../services/server-service-deps.js';
import type { ProxyInstallJobDeps, ProxyInstallJobOutcome } from './proxy-job.js';
import { removeProxy, type ProxyRuntimeLimits } from './proxy-runtime.js';
import type { ProxyRemover } from './proxy-service.js';
import { failStaleInstalls, finishInstall, loadInstallTarget, loadServerView } from './proxy-store.js';

/** Total budget of one install, connect included (pull dominates). */
export const PROXY_INSTALL_BUDGET_MS = 600_000;
const PULL_MS = 300_000;
const VERIFY_MS = 60_000;
const VERIFY_POLL_MS = 1_000;
/** Margin between the install budget and the BullMQ lock, so a live job is never marked stalled. */
const LOCK_MARGIN_MS = 60_000;

export function proxyRuntimeLimits(input: { readonly commandMs: number; readonly maxLineBytes: number }): ProxyRuntimeLimits {
  return {
    stepMs: input.commandMs,
    pullMs: PULL_MS,
    verifyMs: VERIFY_MS,
    verifyPollMs: VERIFY_POLL_MS,
    maxLineBytes: input.maxLineBytes,
  };
}

/** Bound on a synchronous removal: connect, `docker rm -f` and the purge script. */
export function proxyRemoveTimeoutMs(timeouts: Pick<SshTimeouts, 'connectMs' | 'commandMs'>): number {
  return timeouts.connectMs * 2 + timeouts.commandMs * 3;
}

export function proxyWorkerLockDurationMs(budgetMs: number): number {
  return budgetMs + LOCK_MARGIN_MS;
}

export interface ProxyConnectDeps {
  readonly loadServer: (serverId: string) => Promise<DeployServerRow | null>;
  readonly ssh: SshPort<SshDeploySession>;
  readonly timeouts: SshTimeouts;
  readonly masterKeys: () => Promise<MasterKeys>;
}

export function createProxyRemover(
  deps: ProxyConnectDeps & { readonly limits: Pick<ProxyRuntimeLimits, 'stepMs' | 'maxLineBytes'> },
): ProxyRemover {
  const connect = createDeployConnect(deps);
  return async (serverId) => {
    const startedAt = Date.now();
    const failed = { ok: false, code: 'PROXY_UNAVAILABLE', durationMs: 0 } as const;
    let close: (() => Promise<void>) | null = null;
    try {
      const connected = await connect(serverId, createRedactor(), undefined);
      if (!connected.ok) return { ...failed, durationMs: Date.now() - startedAt };
      close = connected.close;
      return await removeProxy({ session: connected.session, limits: deps.limits });
    } catch {
      return { ...failed, durationMs: Date.now() - startedAt };
    } finally {
      if (close !== null) {
        try {
          await close();
        } catch {
          // A failed close never changes the outcome.
        }
      }
    }
  };
}

export interface ProxyInstallRuntimeDeps {
  readonly db: Database;
  readonly events: ServerEventPublisher;
  readonly ssh: SshPort<SshDeploySession>;
  readonly timeouts: SshTimeouts;
  readonly masterKeys: () => Promise<MasterKeys>;
  readonly image: string;
  readonly acmeCaUrl: string;
  /** NOODARA_ACME_CA_ROOT_FILE; absent in production. */
  readonly acmeCaRootFile?: string;
  readonly maxLineBytes: number;
  readonly logger: DeployJobLogger;
  readonly budgetMs?: number;
  readonly now?: () => Date;
  /** Test seams (Pebble). */
  readonly allowInsecureCaUrl?: boolean;
  readonly certificatesDurationHours?: number;
  readonly extraHosts?: readonly ProxyExtraHost[];
}

export function createProxyInstallJobDeps(deps: ProxyInstallRuntimeDeps): ProxyInstallJobDeps {
  const now = deps.now ?? (() => new Date());
  const rootFile = deps.acmeCaRootFile;
  return {
    loadTarget: (serverId) => loadInstallTarget(deps.db, serverId),
    finish: (serverId, outcome, reinstalled) => finishInstall(deps.db, now, serverId, outcome, reinstalled),
    events: deps.events,
    connect: createDeployConnect({
      loadServer: loadDeployServerFromDb(deps.db),
      ssh: deps.ssh,
      timeouts: deps.timeouts,
      masterKeys: deps.masterKeys,
    }),
    createRedactor,
    image: deps.image,
    acmeCaUrl: deps.acmeCaUrl,
    readCaRoot: () => (rootFile === undefined ? Promise.resolve(null) : readFile(rootFile, 'utf8')),
    limits: proxyRuntimeLimits({ commandMs: deps.timeouts.commandMs, maxLineBytes: deps.maxLineBytes }),
    budgetMs: deps.budgetMs ?? PROXY_INSTALL_BUDGET_MS,
    logger: deps.logger,
    ...(deps.allowInsecureCaUrl === undefined ? {} : { allowInsecureCaUrl: deps.allowInsecureCaUrl }),
    ...(deps.certificatesDurationHours === undefined ? {} : { certificatesDurationHours: deps.certificatesDurationHours }),
    ...(deps.extraHosts === undefined ? {} : { extraHosts: deps.extraHosts }),
  };
}

type ProxyProcessor = (job: { readonly data: unknown }) => Promise<{ outcome: ProxyInstallJobOutcome }>;

/** The slice of a BullMQ Worker this module uses; injectable for the unit test. */
export interface ProxyWorkerLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'failed', listener: (job: unknown, error: Error) => void): unknown;
  close(): Promise<void>;
}

export type CreateProxyBullWorker = (name: string, processor: ProxyProcessor, opts: WorkerOptions) => ProxyWorkerLike;

const createBullWorker: CreateProxyBullWorker = (name, processor, opts) =>
  new Worker<unknown, { outcome: ProxyInstallJobOutcome }>(name, (job) => processor(job), opts);

export interface StartProxyWorkerOptions {
  readonly handler: (data: unknown) => Promise<ProxyInstallJobOutcome>;
  /** A dedicated blocking connection (`maxRetriesPerRequest: null`), never the queue's. */
  readonly connection: Redis;
  readonly budgetMs: number;
  readonly concurrency?: number;
  readonly logger: DeployJobLogger;
  readonly createWorker?: CreateProxyBullWorker;
}

/** Only the error's class name: a Redis message can carry a URL or a password. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function startProxyWorker(options: StartProxyWorkerOptions): { close(): Promise<void> } {
  const create = options.createWorker ?? createBullWorker;
  const { logger } = options;
  const worker = create(
    PROXY_QUEUE_NAME,
    async (job) => ({ outcome: await options.handler(job.data) }),
    {
      connection: options.connection,
      prefix: BULLMQ_PREFIX,
      concurrency: options.concurrency ?? 2,
      lockDuration: proxyWorkerLockDurationMs(options.budgetMs),
      // A stalled install is never re-run blindly: the boot sweep fails its row instead (H1).
      maxStalledCount: 0,
    },
  );
  // An EventEmitter 'error' without a listener would crash the process.
  worker.on('error', (error) => {
    logger.error({ errorKind: errorKind(error) }, 'proxy worker error');
  });
  worker.on('failed', (_job, error) => {
    logger.error({ errorKind: errorKind(error) }, 'proxy job failed in the queue');
  });
  return { close: () => worker.close() };
}

export interface ProxySweepDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly events: ServerEventPublisher;
  readonly isPending: (serverId: string) => Promise<boolean>;
  readonly budgetMs: number;
  readonly logger: DeployJobLogger;
}

/** H1 at boot: stale INSTALLING rows end FAILED/PROXY_INSTALL_FAILED; never throws. */
export async function sweepStaleProxyInstalls(deps: ProxySweepDeps): Promise<string[]> {
  let failed: string[];
  try {
    failed = await failStaleInstalls(deps.db, deps.now, { budgetMs: deps.budgetMs, isPending: deps.isPending });
  } catch (error) {
    deps.logger.error({ errorKind: errorKind(error) }, 'proxy install sweep failed');
    return [];
  }
  for (const serverId of failed) {
    try {
      const view = await loadServerView(deps.db, serverId);
      if (view !== null) await publishServerEvent(deps.events, { type: 'server.updated', server: view });
    } catch (error) {
      deps.logger.warn({ serverId, errorKind: errorKind(error) }, 'proxy sweep could not publish');
    }
  }
  return failed;
}
