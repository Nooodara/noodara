// 22-04 (ADR 0011): the certificate status reconciler. Per server, one bounded cycle probes the
// server's due domains over a single SSH session and applies decideCertStatus:
//   proxy.status  the API router answers; "down" annotates every due domain CERT_PROXY_UNAVAILABLE
//                 and fails a RUNNING proxy once (H2: the next cycle no longer sees RUNNING)
//   tls.cert_status  per due domain; "issued" / "default" feed the domain decision
//   routers       a routed (APPLIED) service whose `@file` router is missing gets its file
//                 re-applied after the session closed (H4, the applier verifies and restores)
// Rules: two cycles of one server never overlap (H1); any SSH failure aborts the cycle before a
// write (statuses unchanged, logged); every probe answer passes a zod schema first and an
// invalid or truncated answer leaves that domain unchanged (H3). Only status, notAfter and a
// closed cause are stored, never an issuer or a certificate (H1). Logs carry ids and codes only.
//
// Schedule (in memory, so a restart probes once more at worst): a domain is checked 15 s, 30 s
// and 60 s after a change (certCheckDelayMs), then every interval. A change is an `updated_at`
// that is not this reconciler's own write. A PENDING domain's issue timeout runs from when it was
// seen entering PENDING (or its `updated_at` when first seen PENDING).
import {
  CERT_FAILURE_CAUSES,
  CERT_POST_CHANGE_CHECK_DELAYS_MS,
  CERT_RENEWAL_WINDOW_MS,
  PROXY_API_ROUTER_NAME,
  certCheckDelayMs,
  decideCertStatus,
  proxyRouterNamesFor,
  type CertDecision,
  type CertFailureCause,
  type CertProbe,
  type CertStatus,
} from '@noodara/domain';
import {
  PROXY_CERT_STATUS_MAX_BYTES,
  PROXY_STATUS_MAX_BYTES,
  certProbeFromTlsStatus,
  parseProxyRouterStatus,
  parseTlsCertStatus,
  proxyCertStatus,
  proxyRouterStatus,
  type RemoteCommand,
  type SshDeploySession,
} from '@noodara/ssh';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { DeployJobDeps, DeployJobLogger } from '../deploy/deploy-worker.js';
import { buildServiceUpdatedEvent } from '../events/deploy-engine-events.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import type { ServerView } from '../services/server-view.js';
import type { ServiceView } from '../services/service-view.js';
import type { DomainApplier } from './domain-services.js';
import {
  listCertCandidates,
  markProxyUnavailable,
  recordRouteRestored,
  writeCertStatus,
  type CertCandidate,
  type CertStatusWrite,
} from './domain-store.js';

export interface CertReconcilerStore {
  listCandidates(): Promise<CertCandidate[]>;
  writeCertStatus(write: CertStatusWrite): Promise<{ readonly view: ServiceView; readonly updatedAt: Date } | null>;
  markProxyUnavailable(serverId: string, at: Date): Promise<ServerView | null>;
  recordRouteRestored(input: { serviceId: string; durationMs: number; at: Date }): Promise<ServiceView | null>;
}

export function createCertStore(db: Database): CertReconcilerStore {
  return {
    listCandidates: () => listCertCandidates(db),
    writeCertStatus: (write) => writeCertStatus(db, write),
    markProxyUnavailable: (serverId, at) => markProxyUnavailable(db, serverId, at),
    recordRouteRestored: (input) => recordRouteRestored(db, input),
  };
}

export interface CertReconcilerDeps {
  readonly store: CertReconcilerStore;
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: DeployJobDeps['createRedactor'];
  readonly apply: DomainApplier;
  readonly events: ServerEventPublisher;
  readonly logger: DeployJobLogger;
  /** NOODARA_CERT_CHECK_INTERVAL_MS. */
  readonly intervalMs: number;
  /** NOODARA_CERT_ISSUE_TIMEOUT_MS. */
  readonly issueTimeoutMs: number;
  /** NOODARA_SSH_COMMAND_TIMEOUT_MS: the bound of each probe. */
  readonly commandMs: number;
  readonly now?: () => Date;
  /** Test seam: the post-change backoff (defaults to the domain table). */
  readonly checkDelayMs?: (checksSinceChange: number, intervalMs: number) => number;
}

export interface CertRunSummary {
  readonly checked: number;
  readonly written: number;
  readonly skippedInFlight: number;
  readonly sshFailed: number;
  readonly probeInvalid: number;
  readonly restored: number;
}

export interface CertReconciler {
  /** Runs every server's due cycle; never rejects. */
  runDue(): Promise<CertRunSummary>;
}

interface Tracked {
  seenUpdatedAt: number;
  status: CertStatus;
  checks: number;
  nextAt: number;
  pendingSince: Date | null;
}

const POST_CHANGE_TOTAL_MS = CERT_POST_CHANGE_CHECK_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
const LINE_MAX_BYTES = 4_096;
const MAX_ISSUER_LENGTH = 256;
const CAUSES: ReadonlySet<string> = new Set(CERT_FAILURE_CAUSES);

/** H3: the raw tls.cert_status line, then its parsed value; nothing else reaches the decision. */
const CertLineSchema = z
  .string()
  .refine((out) => Buffer.byteLength(out, 'utf8') <= PROXY_CERT_STATUS_MAX_BYTES)
  .refine((out) => /^NOODARA_CERT (?:down|tls notAfter=[^\s]+(?: [^\s=]+)* issuer=[^\r\n]+)\n?$/.test(out));
const TlsCertStatusSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tls'),
    notAfter: z.date().refine((date) => Number.isFinite(date.getTime())),
    issuer: z.string().min(1).max(MAX_ISSUER_LENGTH),
    isDefault: z.boolean(),
  }),
  z.object({ kind: z.literal('down') }),
]);
const RouterStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('present'), status: z.string().max(64), rule: z.string().max(4_096), service: z.string().max(512) }),
  z.object({ kind: z.literal('missing') }),
  z.object({ kind: z.literal('down') }),
]);

type RouterAnswer = z.infer<typeof RouterStatusSchema>;

class SshFailed extends Error {
  constructor() {
    super('ssh failed');
    this.name = 'SshFailed';
  }
}

interface Ran {
  readonly stdout: string;
  readonly withinCap: boolean;
}

async function run(session: SshDeploySession, command: RemoteCommand, commandMs: number, cap: number): Promise<Ran> {
  let result;
  try {
    result = await session.stream(command, {
      maxDurationMs: commandMs,
      idleTimeoutMs: commandMs,
      maxTotalBytes: cap,
      maxLineBytes: LINE_MAX_BYTES,
      onChunk: () => {
        // Probe output is validated from the tail, never logged or stored.
      },
    });
  } catch {
    // A rejected stream is a lost connection; its message may carry remote text, dropped.
    throw new SshFailed();
  }
  const withinCap =
    result.outcome === 'completed' && result.exitCode === 0 && !result.truncated && result.totalBytes <= cap;
  return { stdout: result.stdoutTail, withinCap };
}

async function probeRouter(session: SshDeploySession, router: string, commandMs: number): Promise<RouterAnswer | null> {
  const ran = await run(session, proxyRouterStatus(router), commandMs, PROXY_STATUS_MAX_BYTES);
  if (!ran.withinCap) return null;
  const parsed = RouterStatusSchema.safeParse(parseProxyRouterStatus(ran.stdout));
  return parsed.success ? parsed.data : null;
}

async function probeCert(session: SshDeploySession, hostname: string, commandMs: number): Promise<CertProbe | null> {
  let command: RemoteCommand;
  try {
    command = proxyCertStatus(hostname);
  } catch {
    return null;
  }
  const ran = await run(session, command, commandMs, PROXY_CERT_STATUS_MAX_BYTES);
  if (!ran.withinCap || !CertLineSchema.safeParse(ran.stdout).success) return null;
  const parsed = TlsCertStatusSchema.safeParse(parseTlsCertStatus(ran.stdout));
  return parsed.success ? certProbeFromTlsStatus(parsed.data) : null;
}

function activityFor(previous: CertStatus, decision: CertDecision): CertStatusWrite['activity'] {
  if (!decision.statusChanged) return undefined;
  switch (decision.status) {
    case 'ISSUED':
      return { action: 'domain.certificate_issued', previousStatus: previous };
    case 'FAILED':
      return { action: 'domain.certificate_failed', previousStatus: previous };
    case 'EXPIRED':
      return { action: 'domain.certificate_expired', previousStatus: previous };
    default:
      return undefined;
  }
}

function sameDecision(candidate: CertCandidate, decision: CertDecision): boolean {
  return (
    decision.status === candidate.certStatus &&
    (decision.notAfter?.getTime() ?? null) === (candidate.certNotAfter?.getTime() ?? null) &&
    decision.errorCode === candidate.certErrorCode
  );
}

interface ServerCycle {
  readonly serverId: string;
  readonly due: readonly CertCandidate[];
  readonly all: readonly CertCandidate[];
}

interface ProbeOutcome {
  readonly proxyDown: boolean;
  readonly probes: ReadonlyMap<string, CertProbe>;
  readonly invalid: number;
  readonly missingRoutes: readonly string[];
}

export function createCertReconciler(deps: CertReconcilerDeps): CertReconciler {
  const now = deps.now ?? (() => new Date());
  const delay = deps.checkDelayMs ?? certCheckDelayMs;
  const tracked = new Map<string, Tracked>();
  const inFlight = new Set<string>();
  const timings = { issueTimeoutMs: deps.issueTimeoutMs, renewalWindowMs: CERT_RENEWAL_WINDOW_MS };

  function observe(candidate: CertCandidate, nowMs: number): Tracked {
    const updatedAt = candidate.updatedAt.getTime();
    const previous = tracked.get(candidate.id);
    if (previous === undefined) {
      const settled = nowMs - updatedAt > POST_CHANGE_TOTAL_MS;
      const entry: Tracked = {
        seenUpdatedAt: updatedAt,
        status: candidate.certStatus,
        checks: settled ? CERT_POST_CHANGE_CHECK_DELAYS_MS.length : 0,
        nextAt: settled ? nowMs : updatedAt + delay(0, deps.intervalMs),
        pendingSince: candidate.certStatus === 'PENDING' ? candidate.updatedAt : null,
      };
      tracked.set(candidate.id, entry);
      return entry;
    }
    if (updatedAt !== previous.seenUpdatedAt) {
      // A change made elsewhere (create, PATCH, dns-check, apply): restart the post-change checks.
      previous.seenUpdatedAt = updatedAt;
      previous.checks = 0;
      previous.nextAt = updatedAt + delay(0, deps.intervalMs);
    }
    if (candidate.certStatus !== previous.status) {
      previous.pendingSince = candidate.certStatus === 'PENDING' ? candidate.updatedAt : null;
      previous.status = candidate.certStatus;
    }
    return previous;
  }

  function checked(domainId: string, nowMs: number): void {
    const entry = tracked.get(domainId);
    if (entry === undefined) return;
    entry.checks += 1;
    entry.nextAt = nowMs + delay(entry.checks, deps.intervalMs);
  }

  async function probe(session: SshDeploySession, cycle: ServerCycle): Promise<ProbeOutcome> {
    const api = await probeRouter(session, PROXY_API_ROUTER_NAME, deps.commandMs);
    if (api === null) return { proxyDown: false, probes: new Map(), invalid: 1, missingRoutes: [] };
    if (api.kind === 'down') return { proxyDown: true, probes: new Map(), invalid: 0, missingRoutes: [] };
    const probes = new Map<string, CertProbe>();
    let invalid = 0;
    for (const candidate of cycle.due) {
      const result = await probeCert(session, candidate.hostname, deps.commandMs);
      if (result === null) {
        invalid += 1;
        deps.logger.warn({ serverId: cycle.serverId, domainId: candidate.id, outcome: 'probe_invalid' }, 'certificate probe answer rejected');
      } else {
        probes.set(candidate.id, result);
      }
    }
    // H4: one router per routed service; a missing one means its dynamic file is gone.
    const missingRoutes: string[] = [];
    const routed = new Map<string, CertCandidate>();
    for (const candidate of cycle.all) {
      if (candidate.applyStatus === 'APPLIED' && !routed.has(candidate.serviceId)) routed.set(candidate.serviceId, candidate);
    }
    for (const [serviceId, candidate] of routed) {
      let router: string | undefined;
      try {
        router = proxyRouterNamesFor(serviceId, [{ id: candidate.id }])[0];
      } catch {
        router = undefined;
      }
      if (router === undefined) continue;
      const answer = await probeRouter(session, router, deps.commandMs);
      if (answer?.kind === 'missing') missingRoutes.push(serviceId);
    }
    return { proxyDown: false, probes, invalid, missingRoutes };
  }

  function decide(candidate: CertCandidate, result: CertProbe, at: Date): CertDecision | null {
    const errorCode = candidate.certErrorCode !== null && CAUSES.has(candidate.certErrorCode) ? (candidate.certErrorCode as CertFailureCause) : null;
    try {
      return decideCertStatus(
        {
          status: candidate.certStatus,
          notAfter: candidate.certNotAfter,
          errorCode,
          pendingSince: tracked.get(candidate.id)?.pendingSince ?? null,
          dnsStatus: candidate.dnsStatus,
        },
        result,
        at,
        timings,
      );
    } catch {
      // An illegal transition is a bug in the table; the row stays as it is.
      return null;
    }
  }

  async function writeDecisions(cycle: ServerCycle, outcome: ProbeOutcome, at: Date): Promise<number> {
    let written = 0;
    const views = new Map<string, ServiceView>();
    for (const candidate of cycle.due) {
      const result: CertProbe | undefined = outcome.proxyDown ? { kind: 'down' } : outcome.probes.get(candidate.id);
      if (result === undefined) continue;
      const decision = decide(candidate, result, at);
      if (decision === null || sameDecision(candidate, decision)) continue;
      const activity = activityFor(candidate.certStatus, decision);
      const saved = await deps.store.writeCertStatus({
        domainId: candidate.id,
        serviceId: candidate.serviceId,
        expectedUpdatedAt: candidate.updatedAt,
        status: decision.status,
        notAfter: decision.notAfter,
        errorCode: decision.errorCode,
        at,
        ...(activity === undefined ? {} : { activity }),
      });
      if (saved === null) continue;
      written += 1;
      const entry = tracked.get(candidate.id);
      if (entry !== undefined) {
        // Own write: not a change that restarts the schedule.
        entry.seenUpdatedAt = saved.updatedAt.getTime();
        if (decision.status !== entry.status) {
          entry.pendingSince = decision.status === 'PENDING' ? at : null;
          entry.status = decision.status;
        }
      }
      views.set(candidate.serviceId, saved.view);
    }
    for (const view of views.values()) await publishServerEvent(deps.events, buildServiceUpdatedEvent(view));
    return written;
  }

  async function failProxy(cycle: ServerCycle, at: Date): Promise<void> {
    if (!cycle.all.some((candidate) => candidate.proxyStatus === 'RUNNING')) return;
    const server = await deps.store.markProxyUnavailable(cycle.serverId, at);
    if (server === null) return;
    deps.logger.warn({ serverId: cycle.serverId, outcome: 'proxy_unavailable' }, 'proxy not running during certificate check');
    await publishServerEvent(deps.events, { type: 'server.updated', server });
  }

  async function reapply(cycle: ServerCycle, missingRoutes: readonly string[]): Promise<number> {
    const pending = new Set(cycle.all.filter((candidate) => candidate.applyStatus === 'PENDING').map((candidate) => candidate.serviceId));
    let restored = 0;
    for (const serviceId of new Set([...pending, ...missingRoutes])) {
      const started = now().getTime();
      const result = await deps.apply(serviceId);
      if (!result.ok) {
        deps.logger.warn({ serverId: cycle.serverId, serviceId, outcome: 'reapply_failed', code: result.code }, 'domain route re-apply failed');
        continue;
      }
      if (!missingRoutes.includes(serviceId)) continue;
      restored += 1;
      const at = now();
      const view = await deps.store.recordRouteRestored({ serviceId, durationMs: at.getTime() - started, at });
      deps.logger.info({ serverId: cycle.serverId, serviceId, outcome: 'route_restored' }, 'missing domain route restored');
      if (view !== null) await publishServerEvent(deps.events, buildServiceUpdatedEvent(view));
    }
    return restored;
  }

  async function runServer(cycle: ServerCycle): Promise<Omit<CertRunSummary, 'skippedInFlight'>> {
    const at = now();
    const empty = { checked: 0, written: 0, sshFailed: 0, probeInvalid: 0, restored: 0 };
    let outcome: ProbeOutcome | null = null;
    let close: (() => Promise<void>) | null = null;
    try {
      const connected = await deps.connect(cycle.serverId, deps.createRedactor(), undefined);
      if (connected.ok) {
        close = connected.close;
        outcome = await probe(connected.session, cycle);
      }
    } catch {
      outcome = null;
    } finally {
      if (close !== null) {
        try {
          await close();
        } catch {
          // A failed close never changes the outcome.
        }
      }
    }
    for (const candidate of cycle.due) checked(candidate.id, at.getTime());
    if (outcome === null) {
      // H1: an SSH failure changes nothing (never a FAILED flip); the next due check retries.
      deps.logger.warn({ serverId: cycle.serverId, outcome: 'ssh_failed', domains: cycle.due.length }, 'certificate check could not reach the server');
      return { ...empty, checked: cycle.due.length, sshFailed: 1 };
    }
    if (outcome.invalid > 0 && outcome.probes.size === 0 && !outcome.proxyDown && cycle.due.length > 0 && outcome.missingRoutes.length === 0) {
      deps.logger.warn({ serverId: cycle.serverId, outcome: 'probe_invalid' }, 'certificate check answers rejected');
    }
    const written = await writeDecisions(cycle, outcome, at);
    if (outcome.proxyDown) await failProxy(cycle, at);
    const restored = outcome.proxyDown ? 0 : await reapply(cycle, outcome.missingRoutes);
    return { checked: cycle.due.length, written, sshFailed: 0, probeInvalid: outcome.invalid, restored };
  }

  async function guardedRunServer(cycle: ServerCycle): Promise<Omit<CertRunSummary, 'skippedInFlight'>> {
    try {
      return await runServer(cycle);
    } catch (error) {
      deps.logger.warn(
        { serverId: cycle.serverId, outcome: 'cycle_failed', errorKind: error instanceof Error ? error.name : typeof error },
        'certificate check cycle failed',
      );
      return { checked: cycle.due.length, written: 0, sshFailed: 0, probeInvalid: 0, restored: 0 };
    } finally {
      inFlight.delete(cycle.serverId);
    }
  }

  return {
    async runDue(): Promise<CertRunSummary> {
      const summary = { checked: 0, written: 0, skippedInFlight: 0, sshFailed: 0, probeInvalid: 0, restored: 0 };
      let candidates: CertCandidate[];
      try {
        candidates = await deps.store.listCandidates();
      } catch (error) {
        deps.logger.warn({ outcome: 'list_failed', errorKind: error instanceof Error ? error.name : typeof error }, 'certificate candidates could not be read');
        return summary;
      }
      const nowMs = now().getTime();
      const present = new Set(candidates.map((candidate) => candidate.id));
      for (const id of tracked.keys()) if (!present.has(id)) tracked.delete(id);
      const byServer = new Map<string, CertCandidate[]>();
      for (const candidate of candidates) {
        const list = byServer.get(candidate.serverId) ?? [];
        list.push(candidate);
        byServer.set(candidate.serverId, list);
      }
      const cycles: ServerCycle[] = [];
      for (const [serverId, all] of byServer) {
        if (inFlight.has(serverId)) {
          summary.skippedInFlight += 1;
          continue;
        }
        const due = all.filter((candidate) => observe(candidate, nowMs).nextAt <= nowMs);
        if (due.length === 0) continue;
        inFlight.add(serverId);
        cycles.push({ serverId, due, all });
      }
      const results = await Promise.all(cycles.map((cycle) => guardedRunServer(cycle)));
      for (const result of results) {
        summary.checked += result.checked;
        summary.written += result.written;
        summary.sshFailed += result.sshFailed;
        summary.probeInvalid += result.probeInvalid;
        summary.restored += result.restored;
      }
      return summary;
    },
  };
}

export interface CertReconcileLoopHandle {
  close(): Promise<void>;
}

/** The worker's in-process poll; each poll runs only the due cycles. */
export function startCertReconcileLoop(input: {
  readonly reconciler: CertReconciler;
  readonly pollMs: number;
  readonly logger: DeployJobLogger;
}): CertReconcileLoopHandle {
  let running: Promise<unknown> = Promise.resolve();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    running = input.reconciler.runDue().catch(() => undefined);
  }, input.pollMs);
  timer.unref();
  input.logger.info({ pollMs: input.pollMs }, 'certificate reconcile loop started');
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
