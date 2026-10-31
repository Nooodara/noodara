// 22-02 (ADR 0011): the proxy install and removal over an already connected SshDeploySession.
// - installProxy: ports 80/443 preflight, prepare dirs, write the static config (+ API router and
//   the CA root when set), pull the pinned image, recreate noodara-traefik, reconnect the routed
//   service networks, start, then poll the API until it answers. Every step has its own bound and
//   the whole run honours `signal` (the job's total budget).
// - H2: any failure removes the container (best effort), so the retry starts clean; the files are
//   rewritten by the retry and prepare_dirs repairs their modes.
// - removeProxy: `docker rm --force` then the /opt/noodara-proxy purge; both idempotent.
// Nothing here throws, logs or returns remote output: results carry closed codes only. The one
// exception is the foreign listener's process name (A1), sanitized to a short identifier.
import {
  PROXY_API_ROUTER_NAME,
  PROXY_LAYOUT,
  proxyContainerName,
  validateImageRef,
  type ProxyStaticConfig,
  type ResourceId,
} from '@noodara/domain';
import { secretValue } from '@noodara/domain/security';
import {
  dockerPull,
  dockerRemove,
  dockerStart,
  parsePortsInUse,
  parseProxyRouterStatus,
  proxyCreate,
  proxyFileDigest,
  proxyNetworkConnect,
  proxyPortsInUse,
  proxyPrepareDirs,
  proxyRemoveFiles,
  proxyRouterStatus,
  proxyWriteDynamic,
  proxyWriteStatic,
  type ProxyExtraHost,
  type RemoteCommand,
  type SshDeploySession,
} from '@noodara/ssh';

export const PROXY_INSTALL_STEPS = Object.freeze([
  'ports',
  'prepare_dirs',
  'write_config',
  'pull',
  'create',
  'network',
  'start',
  'verify',
] as const);
export type ProxyInstallStep = (typeof PROXY_INSTALL_STEPS)[number];

export interface ProxyRuntimeLimits {
  /** Bound of one short step (scripts, create, start, rm). */
  readonly stepMs: number;
  /** Bound of the image pull. */
  readonly pullMs: number;
  /** How long the API may take to answer after start. */
  readonly verifyMs: number;
  readonly verifyPollMs: number;
  readonly maxLineBytes: number;
}

export interface ProxyInstallInput {
  readonly session: SshDeploySession;
  readonly image: string;
  readonly config: ProxyStaticConfig;
  /** PEM bundle trusted by the ACME client (test seam); null in production. */
  readonly caRoot: string | null;
  readonly extraHosts?: readonly ProxyExtraHost[];
  /** Services with a domain on this server: their networks are reattached to the new container. */
  readonly routedServiceIds: readonly ResourceId[];
  readonly limits: ProxyRuntimeLimits;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ProxyListener {
  readonly port: 80 | 443;
  /** Short identifier (`nginx`, `apache2`); null when ss could not show it. */
  readonly process: string | null;
}

export type ProxyInstallResult =
  | { readonly ok: true; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly code: 'PROXY_PORT_IN_USE' | 'PROXY_INSTALL_FAILED';
      readonly step: ProxyInstallStep;
      readonly listener: ProxyListener | null;
      readonly durationMs: number;
    };

export type ProxyRemoveResult =
  | { readonly ok: true; readonly durationMs: number }
  | { readonly ok: false; readonly code: 'PROXY_UNAVAILABLE'; readonly durationMs: number };

const SMALL_OUTPUT_BYTES = 16_384;
const PULL_OUTPUT_BYTES = 262_144;
const NO_SUCH_CONTAINER = /no such container/i;
const PORT_TAKEN = /address already in use|port is already allocated|bind for .* failed/i;

class StepFailure extends Error {
  constructor(
    readonly step: ProxyInstallStep,
    readonly code: 'PROXY_PORT_IN_USE' | 'PROXY_INSTALL_FAILED' = 'PROXY_INSTALL_FAILED',
    readonly listener: ProxyListener | null = null,
  ) {
    super(`proxy step ${step} failed`);
    this.name = 'StepFailure';
  }
}

interface Ran {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A process name as an identifier only: letters, digits, `_`; never a path or argument. */
export function sanitizeListenerName(raw: string | null): string | null {
  if (raw === null) return null;
  const name = raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? name : null;
}

async function run(
  session: SshDeploySession,
  command: RemoteCommand,
  options: { maxMs: number; maxLineBytes: number; maxBytes?: number; stdin?: string; signal?: AbortSignal | undefined },
): Promise<Ran> {
  const result = await session.stream(command, {
    maxDurationMs: options.maxMs,
    idleTimeoutMs: options.maxMs,
    maxTotalBytes: options.maxBytes ?? SMALL_OUTPUT_BYTES,
    maxLineBytes: options.maxLineBytes,
    ...(options.stdin === undefined ? {} : { stdin: secretValue(options.stdin, 'app_secret') }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onChunk: () => {
      // Proxy output is classified from the tails, never logged (H3).
    },
  });
  return {
    ok: result.outcome === 'completed' && result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdoutTail,
    stderr: result.stderrTail,
  };
}

async function removeContainer(
  session: SshDeploySession,
  limits: ProxyRuntimeLimits,
  signal?: AbortSignal,
): Promise<boolean> {
  const ran = await run(session, dockerRemove(proxyContainerName()), {
    maxMs: limits.stepMs,
    maxLineBytes: limits.maxLineBytes,
    signal,
  });
  return ran.ok || (ran.exitCode !== null && NO_SUCH_CONTAINER.test(ran.stderr));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function installProxy(input: ProxyInstallInput): Promise<ProxyInstallResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const startedAt = now();
  const { session, limits, signal } = input;
  const step = { maxMs: limits.stepMs, maxLineBytes: limits.maxLineBytes, signal };
  const elapsed = () => Math.max(0, now() - startedAt);
  let current: ProxyInstallStep = 'ports';

  const must = async (name: ProxyInstallStep, command: RemoteCommand, marker: string | null, extra: Partial<typeof step> & { stdin?: string; maxBytes?: number } = {}) => {
    current = name;
    const ran = await run(session, command, { ...step, ...extra });
    if (!ran.ok || (marker !== null && !ran.stdout.includes(marker))) throw new StepFailure(name);
    return ran;
  };

  try {
    const image = validateImageRef(input.image);
    if (!image.ok) throw new StepFailure('pull');

    current = 'ports';
    const ports = await run(session, proxyPortsInUse(), step);
    if (ports.ok) {
      const parsed = parsePortsInUse(ports.stdout);
      const foreign = parsed.kind === 'ok' ? parsed.foreign[0] : undefined;
      if (foreign !== undefined) {
        throw new StepFailure('ports', 'PROXY_PORT_IN_USE', {
          port: foreign.port,
          process: sanitizeListenerName(foreign.process),
        });
      }
    }

    await must('prepare_dirs', proxyPrepareDirs(), 'NOODARA_PROXY_DIRS ready');
    const writes: [RemoteCommand, string][] = [
      [proxyWriteStatic({ target: 'traefik', digest: proxyFileDigest(input.config.traefikConfig) }), input.config.traefikConfig],
      [
        proxyWriteDynamic({ path: PROXY_LAYOUT.apiRouterFile, digest: proxyFileDigest(input.config.apiRouterConfig) }),
        input.config.apiRouterConfig,
      ],
    ];
    if (input.caRoot !== null) {
      writes.push([proxyWriteStatic({ target: 'ca_root', digest: proxyFileDigest(input.caRoot) }), input.caRoot]);
    }
    for (const [command, content] of writes) {
      await must('write_config', command, 'NOODARA_PROXY_WRITE ok', { stdin: content });
    }

    await must('pull', dockerPull({ config: null, image: image.value }), null, {
      maxMs: limits.pullMs,
      maxBytes: PULL_OUTPUT_BYTES,
    });

    current = 'create';
    if (!(await removeContainer(session, limits, signal))) throw new StepFailure('create');
    await must(
      'create',
      proxyCreate({
        image: input.image,
        publishedPorts: input.config.publishedPorts,
        caRoot: input.caRoot !== null,
        ...(input.extraHosts === undefined ? {} : { extraHosts: input.extraHosts }),
      }),
      null,
    );

    for (const serviceId of input.routedServiceIds) {
      await must('network', proxyNetworkConnect(serviceId), null);
    }

    current = 'start';
    const started = await run(session, dockerStart(proxyContainerName()), step);
    if (!started.ok) {
      throw PORT_TAKEN.test(started.stderr)
        ? new StepFailure('start', 'PROXY_PORT_IN_USE', null)
        : new StepFailure('start');
    }

    current = 'verify';
    const deadline = now() + limits.verifyMs;
    for (;;) {
      const status = await run(session, proxyRouterStatus(PROXY_API_ROUTER_NAME), step);
      const kind = status.ok ? parseProxyRouterStatus(status.stdout).kind : 'down';
      if (kind === 'present' || kind === 'missing') break;
      if (now() >= deadline || signal?.aborted === true) throw new StepFailure('verify');
      await sleep(limits.verifyPollMs);
    }
    return { ok: true, durationMs: elapsed() };
  } catch (error) {
    const failure = error instanceof StepFailure ? error : new StepFailure(current);
    // H2: never leave a half-installed container behind; a dead session simply skips this.
    if (failure.step !== 'ports' || failure.code !== 'PROXY_PORT_IN_USE') {
      try {
        await removeContainer(session, limits);
      } catch {
        // Best effort.
      }
    }
    return { ok: false, code: failure.code, step: failure.step, listener: failure.listener, durationMs: elapsed() };
  }
}

export interface ProxyRemoveInput {
  readonly session: SshDeploySession;
  readonly limits: Pick<ProxyRuntimeLimits, 'stepMs' | 'maxLineBytes'>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export async function removeProxy(input: ProxyRemoveInput): Promise<ProxyRemoveResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const limits = { ...input.limits, pullMs: 0, verifyMs: 0, verifyPollMs: 0 };
  const failed = (): ProxyRemoveResult => ({ ok: false, code: 'PROXY_UNAVAILABLE', durationMs: Math.max(0, now() - startedAt) });
  try {
    if (!(await removeContainer(input.session, limits, input.signal))) return failed();
    const purge = await run(input.session, proxyRemoveFiles(), {
      maxMs: limits.stepMs,
      maxLineBytes: limits.maxLineBytes,
      signal: input.signal,
    });
    if (!purge.ok || !purge.stdout.includes('NOODARA_PROXY_PURGE ok')) return failed();
    return { ok: true, durationMs: Math.max(0, now() - startedAt) };
  } catch {
    return failed();
  }
}
