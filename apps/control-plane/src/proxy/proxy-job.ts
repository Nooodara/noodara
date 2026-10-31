// 22-02 (A1, H2, H3): the `proxy-install` job. Loads the INSTALLING row, renders the static config
// with the payload's ACME email, connects (stored host key only, the run's Redactor), runs
// installProxy under the job's total budget and records RUNNING or FAILED + code with its
// activity event, then publishes `server.updated`. A row that is no longer INSTALLING (swept, or
// removed) is skipped. Logs carry ids, codes and durations only; nothing here throws.
import { renderStaticConfig, type ProxyStaticConfig } from '@noodara/domain';
import type { Redactor } from '@noodara/domain/security';
import type { ProxyExtraHost } from '@noodara/ssh';
import type { DeployJobDeps, DeployJobLogger } from '../deploy/deploy-worker.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import { parseProxyInstallJobPayload } from '../queue/proxy-job-payload.js';
import type { ServerView } from '../services/server-view.js';
import { installProxy, type ProxyInstallInput, type ProxyInstallResult, type ProxyRuntimeLimits } from './proxy-runtime.js';
import type { ProxyInstallOutcome, ProxyInstallTarget } from './proxy-store.js';

export interface ProxyInstallJobDeps {
  readonly loadTarget: (serverId: string) => Promise<ProxyInstallTarget | null>;
  readonly finish: (serverId: string, outcome: ProxyInstallOutcome, reinstalled: boolean) => Promise<ServerView | null>;
  readonly events: ServerEventPublisher;
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: () => Redactor;
  readonly image: string;
  readonly acmeCaUrl: string;
  /** Test seams (Pebble): plain-http CA, short certificate lifetime. */
  readonly allowInsecureCaUrl?: boolean;
  readonly certificatesDurationHours?: number;
  /** The CA root bundle (NOODARA_ACME_CA_ROOT_FILE); null in production. */
  readonly readCaRoot: () => Promise<string | null>;
  readonly extraHosts?: readonly ProxyExtraHost[];
  readonly limits: ProxyRuntimeLimits;
  /** Total budget of one install (connect included). */
  readonly budgetMs: number;
  readonly logger: DeployJobLogger;
  readonly install?: (input: ProxyInstallInput) => Promise<ProxyInstallResult>;
  readonly now?: () => number;
}

export type ProxyInstallJobOutcome = 'installed' | 'failed' | 'skipped' | 'invalid_payload';

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function failedAt(step: string, durationMs: number): ProxyInstallOutcome {
  return { ok: false, code: 'PROXY_INSTALL_FAILED', step, listener: null, durationMs };
}

export function createProxyInstallJobHandler(deps: ProxyInstallJobDeps): (data: unknown) => Promise<ProxyInstallJobOutcome> {
  const install = deps.install ?? installProxy;
  const now = deps.now ?? Date.now;

  async function run(serverId: string, acmeEmail: string, target: ProxyInstallTarget): Promise<ProxyInstallOutcome> {
    const startedAt = now();
    const elapsed = () => Math.max(0, now() - startedAt);
    const rendered = renderStaticConfig({
      email: acmeEmail,
      caUrl: deps.acmeCaUrl,
      ...(deps.allowInsecureCaUrl === undefined ? {} : { allowInsecureCaUrl: deps.allowInsecureCaUrl }),
      ...(deps.certificatesDurationHours === undefined ? {} : { certificatesDurationHours: deps.certificatesDurationHours }),
    });
    if (!rendered.ok) return failedAt('write_config', elapsed());
    const config: ProxyStaticConfig = rendered.value;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, deps.budgetMs);
    let close: (() => Promise<void>) | null = null;
    try {
      let caRoot: string | null;
      try {
        caRoot = await deps.readCaRoot();
      } catch {
        return failedAt('write_config', elapsed());
      }
      const connected = await deps.connect(serverId, deps.createRedactor(), controller.signal);
      if (!connected.ok) return failedAt('connect', elapsed());
      close = connected.close;
      const result = await install({
        session: connected.session,
        image: deps.image,
        config,
        caRoot,
        ...(deps.extraHosts === undefined ? {} : { extraHosts: deps.extraHosts }),
        routedServiceIds: target.routedServiceIds,
        limits: deps.limits,
        signal: controller.signal,
        now,
      });
      if (result.ok) return { ok: true, durationMs: elapsed() };
      return { ok: false, code: result.code, step: result.step, listener: result.listener, durationMs: elapsed() };
    } catch (error) {
      deps.logger.warn({ serverId, error: errorKind(error) }, 'proxy install could not reach the server');
      return failedAt('connect', elapsed());
    } finally {
      clearTimeout(timer);
      if (close !== null) {
        try {
          await close();
        } catch {
          // A failed close never changes the outcome.
        }
      }
    }
  }

  return async (data) => {
    const parsed = parseProxyInstallJobPayload(data);
    if (!parsed.ok) {
      deps.logger.warn({ reason: parsed.message }, 'proxy install job ignored: invalid payload');
      return 'invalid_payload';
    }
    const { serverId, acmeEmail } = parsed.payload;
    let target: ProxyInstallTarget | null;
    try {
      target = await deps.loadTarget(serverId);
    } catch (error) {
      deps.logger.error({ serverId, error: errorKind(error) }, 'proxy install could not load its server');
      return 'failed';
    }
    if (target?.status !== 'INSTALLING') {
      deps.logger.info({ serverId }, 'proxy install skipped: the server is not installing');
      return 'skipped';
    }

    const outcome = await run(serverId, acmeEmail, target);
    try {
      const view = await deps.finish(serverId, outcome, target.installedAt !== null);
      if (view !== null) await publishServerEvent(deps.events, { type: 'server.updated', server: view });
    } catch (error) {
      deps.logger.warn({ serverId, error: errorKind(error) }, 'proxy install outcome could not be recorded');
    }
    if (outcome.ok) {
      deps.logger.info({ serverId, durationMs: outcome.durationMs }, 'proxy installed');
      return 'installed';
    }
    deps.logger.warn({ serverId, code: outcome.code, step: outcome.step }, 'proxy install failed');
    return 'failed';
  };
}
