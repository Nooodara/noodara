// Discovery orchestration over one reused connection (DISC-01, DISC-04, SERV-08, SEC-05,
// 02-CONTEXT.md D-08/D-11/D-12/D-13). `runDiscovery` turns eleven allowlisted `session.exec()`
// calls into a typed `DiscoverySnapshot`: every check is reported separately (pass/fail/skipped/
// not_applicable), a single failing or timed-out check never aborts the run, and the caller (not
// this module) owns the session's lifecycle — `runDiscovery` never calls `session.close()`.
import type { Redactor } from '@noodara/domain/security';
import type { ServerErrorCode } from '@noodara/domain/server';
import {
  parseArch,
  parseCpuCores,
  parseDiskUsage,
  parseDockerGroupMembership,
  parseDockerVersion,
  parseComposeVersion,
  parseHostname,
  parseMeminfo,
  parseOsRelease,
  parseSudoCheck,
  parseUptimeSeconds,
  DISCOVERY_CHECK_IDS,
  type DiscoveryCheck,
  type DiscoveryCheckId,
  type DiscoveryCheckStatus,
  type DiscoveryFacts,
  type DiscoverySnapshot,
} from '@noodara/domain/discovery';
import type { CommandName } from './commands/index.js';
import type { ExecResult, SshSession } from './ssh-port.js';

/**
 * The subset of `SshTimeouts` this module needs (D-08's third, discovery-total budget). Declared
 * narrowly rather than importing the full `SshTimeouts` so a caller building a partial timeouts
 * object for a test does not have to fabricate `connectMs`/`commandMs` this module never reads.
 */
export interface RunDiscoveryTimeouts {
  readonly discoveryMs: number;
}

export interface RunDiscoveryInput {
  readonly session: SshSession;
  /** The SSH user this session authenticated as — `'root'` is treated as the root case directly
   *  (D-13); no remote `id -u` call is made, since the caller already knows this value and a
   *  twelfth command would fall outside the frozen SEC-04 allowlist. */
  readonly sshUser: string;
  readonly timeouts: RunDiscoveryTimeouts;
  readonly redactor: Redactor;
  /** Injected clock (D-08's discovery-total budget), defaulting to `performance.now`. Never read
   *  anywhere else in this module — no per-command duration is derived from it. */
  readonly now?: () => number;
}

/** Mutable, per-run state a step's `appliesTo`/`evaluate` may read or (rarely) update. */
interface SequenceState {
  readonly sshUser: string;
  /** Set once `docker_version` reports `not_installed` (D-12), so `docker_compose_version`'s
   *  `appliesTo` can skip a round trip that would only reproduce the same absence. */
  dockerNotInstalled: boolean;
}

/** What one step's `evaluate` reports back to the loop. */
interface CheckOutcome {
  readonly status: DiscoveryCheckStatus;
  readonly detail: string;
  readonly facts?: Partial<DiscoveryFacts>;
  readonly warnings?: readonly ServerErrorCode[];
  readonly stateUpdates?: Partial<SequenceState>;
}

interface DiscoveryStepDefinition {
  readonly commandName: CommandName;
  readonly appliesTo: (state: SequenceState) => boolean;
  readonly evaluate: (result: ExecResult, state: SequenceState) => CheckOutcome;
}

/** All-null `DiscoveryFacts` — a step that never ran leaves its field null rather than absent
 *  (`exactOptionalPropertyTypes`), matching the `servers` columns these facts fill (all nullable). */
function emptyFacts(): DiscoveryFacts {
  return {
    hostname: null,
    osDistribution: null,
    osVersion: null,
    arch: null,
    cpuCores: null,
    ramMb: null,
    diskTotalMb: null,
    diskUsedMb: null,
    uptimeSeconds: null,
    dockerInstalled: null,
    dockerVersion: null,
    dockerComposeVersion: null,
  };
}

const ALWAYS_APPLIES = (): boolean => true;

function nonZeroExitDetail(commandLabel: string, result: ExecResult): string {
  return `${commandLabel} exited with code ${result.exitCode === null ? 'null' : String(result.exitCode)}: ${result.stderr}`;
}

/** Shared shape for the seven "run a command, parse its stdout" checks (hostname, arch, cpu,
 *  memory, disk, uptime — os_release has its own evaluate for the UNSUPPORTED_OS warning). */
function simpleCheck<T>(
  commandLabel: string,
  result: ExecResult,
  parse: (stdout: string) => { ok: true; value: T } | { ok: false; message: string },
  onSuccess: (value: T) => { detail: string; facts: Partial<DiscoveryFacts> },
): CheckOutcome {
  if (result.exitCode !== 0) {
    return { status: 'fail', detail: nonZeroExitDetail(commandLabel, result) };
  }
  const parsed = parse(result.stdout);
  if (!parsed.ok) {
    return { status: 'fail', detail: parsed.message };
  }
  const { detail, facts } = onSuccess(parsed.value);
  return { status: 'pass', detail, facts };
}

const DISCOVERY_STEPS = {
  hostname: {
    commandName: 'discovery.hostname',
    appliesTo: ALWAYS_APPLIES,
    evaluate: (result) =>
      simpleCheck('the hostname check', result, parseHostname, (hostname) => ({
        detail: `Hostname: ${hostname}`,
        facts: { hostname },
      })),
  },
  os_release: {
    commandName: 'discovery.os_release',
    appliesTo: ALWAYS_APPLIES,
    evaluate: (result) => {
      if (result.exitCode !== 0) {
        return { status: 'fail', detail: nonZeroExitDetail('the OS release check', result) };
      }
      const parsed = parseOsRelease(result.stdout);
      if (!parsed.ok) {
        return { status: 'fail', detail: parsed.message };
      }
      const { distribution, version, supported } = parsed.value;
      // D-11: the command ran and the output parsed — the check itself passes even when the
      // platform is outside the supported matrix. Marking it `fail` would show a red row for a
      // server that is otherwise working, the opposite of DISC-04's intent.
      return {
        status: 'pass',
        detail: supported
          ? `${distribution} ${version}`
          : `${distribution} ${version} (outside the supported matrix: Ubuntu 22.04/24.04)`,
        facts: { osDistribution: distribution, osVersion: version },
        warnings: supported ? [] : ['UNSUPPORTED_OS'],
      };
    },
  },
  arch: {
    commandName: 'discovery.arch',
    appliesTo: ALWAYS_APPLIES,
    evaluate: (result) =>
      simpleCheck('the architecture check', result, parseArch, (arch) => ({
        detail: `Architecture: ${arch}`,
        facts: { arch },
      })),
  },
  cpu: {
    commandName: 'discovery.cpu',
    appliesTo: ALWAYS_APPLIES,
    evaluate: (result) =>
      simpleCheck('the CPU count check', result, parseCpuCores, (cpuCores) => ({
        detail: `CPU cores: ${String(cpuCores)}`,
        facts: { cpuCores },
      })),
  },
  memory: {
    commandName: 'discovery.memory',
    appliesTo: ALWAYS_APPLIES,
    evaluate: (result) =>
      simpleCheck('the memory check', result, parseMeminfo, ({ ramMb }) => ({
        detail: `RAM: ${String(ramMb)} MB`,
        facts: { ramMb },
      })),
  },
  disk: {
    commandName: 'discovery.disk',
    appliesTo: ALWAYS_APPLIES,
    evaluate: (result) =>
      simpleCheck('the disk usage check', result, parseDiskUsage, ({ totalMb, usedMb }) => ({
        detail: `Disk: ${String(usedMb)}/${String(totalMb)} MB used`,
        facts: { diskTotalMb: totalMb, diskUsedMb: usedMb },
      })),
  },
  uptime: {
    commandName: 'discovery.uptime',
    appliesTo: ALWAYS_APPLIES,
    evaluate: (result) =>
      simpleCheck('the uptime check', result, parseUptimeSeconds, (uptimeSeconds) => ({
        detail: `Uptime: ${String(uptimeSeconds)}s`,
        facts: { uptimeSeconds },
      })),
  },
  docker_version: {
    commandName: 'docker.version',
    appliesTo: ALWAYS_APPLIES,
    evaluate: (result) => {
      const parsed = parseDockerVersion({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? -1,
      });
      switch (parsed.kind) {
        case 'not_installed':
          // D-12: a warning, not an error — no ServerErrorCode exists for "Docker absent",
          // because it is a fact (`dockerInstalled: false`), not a connection failure.
          return {
            status: 'fail',
            detail: 'Docker is not installed on this server.',
            facts: { dockerInstalled: false, dockerVersion: null },
            stateUpdates: { dockerNotInstalled: true },
          };
        case 'daemon_unreachable':
          // The client binary is present and its version parsed cleanly — the check itself
          // succeeded; the daemon being unreachable is a fact carried in the detail, not a
          // reason to fail a check whose command and parse both worked.
          return {
            status: 'pass',
            detail: `Docker client ${parsed.clientVersion} installed; the daemon is unreachable.`,
            facts: { dockerInstalled: true, dockerVersion: parsed.clientVersion },
          };
        case 'installed':
          return {
            status: 'pass',
            detail: `Docker ${parsed.clientVersion} (daemon ${parsed.serverVersion})`,
            facts: { dockerInstalled: true, dockerVersion: parsed.clientVersion },
          };
        case 'unparseable':
          // D-12/Pitfall 2: never collapse "could not understand the output" into "not
          // installed" — dockerInstalled stays null, never false.
          return {
            status: 'fail',
            detail: `Docker version output could not be parsed: ${parsed.reason}`,
          };
      }
    },
  },
  docker_compose_version: {
    commandName: 'docker.compose_version',
    appliesTo: (state) => !state.dockerNotInstalled,
    evaluate: (result) => {
      const parsed = parseComposeVersion({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? -1,
      });
      switch (parsed.kind) {
        case 'installed':
          return {
            status: 'pass',
            detail: `Docker Compose ${parsed.version}`,
            facts: { dockerComposeVersion: parsed.version },
          };
        case 'not_installed':
          return { status: 'fail', detail: 'The Docker Compose plugin is not installed on this server.' };
        case 'unparseable':
          return {
            status: 'fail',
            detail: `Docker Compose version output could not be parsed: ${parsed.reason}`,
          };
      }
    },
  },
  sudo: {
    commandName: 'access.sudo',
    appliesTo: (state) => state.sshUser !== 'root',
    evaluate: (result) => {
      if (result.exitCode === null) {
        return { status: 'fail', detail: '"sudo -n true" did not report an exit code.' };
      }
      const parsed = parseSudoCheck({ exitCode: result.exitCode, stderr: result.stderr });
      return {
        status: parsed.status,
        detail: parsed.status === 'pass' ? 'Passwordless sudo is available.' : parsed.detail,
      };
    },
  },
  docker_group: {
    commandName: 'access.docker_group',
    appliesTo: (state) => state.sshUser !== 'root',
    evaluate: (result) => {
      if (result.exitCode !== 0) {
        return { status: 'fail', detail: nonZeroExitDetail('the docker group check', result) };
      }
      const isMember = parseDockerGroupMembership(result.stdout);
      return isMember
        ? { status: 'pass', detail: 'User is a member of the docker group.' }
        : { status: 'fail', detail: 'User is not a member of the docker group.' };
    },
  },
} as const satisfies Record<DiscoveryCheckId, DiscoveryStepDefinition>;

export interface DiscoverySequenceEntry extends DiscoveryStepDefinition {
  readonly id: DiscoveryCheckId;
}

/**
 * Frozen, ordered list of every discovery step, one per `DiscoveryCheckId` — order comes from the
 * canonical `DISCOVERY_CHECK_IDS` tuple, not object property order. Declaring `DISCOVERY_STEPS`
 * with `satisfies Record<DiscoveryCheckId, ...>` makes a missing or extra id a type error;
 * `run-discovery.test.ts` additionally asserts each `CommandName` is used at most once, which the
 * type system alone cannot guarantee.
 */
export const DISCOVERY_SEQUENCE: readonly DiscoverySequenceEntry[] = DISCOVERY_CHECK_IDS.map(
  (id) => ({ id, ...DISCOVERY_STEPS[id] }),
);

const NOT_APPLICABLE_DETAIL: Partial<Record<DiscoveryCheckId, string>> = {
  sudo: 'Not applicable: connected as root, which already has full privileges.',
  docker_group: 'Not applicable: connected as root, which does not need docker group membership.',
};

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs every applicable step of `DISCOVERY_SEQUENCE`, strictly in order, over the one `session`
 * passed in. Never rejects and never throws: a failing command, a parser failure or a rejected
 * `exec()` all become a failed check, and the loop continues. The caller owns `session`'s
 * lifecycle — this function never calls `session.close()`.
 */
export async function runDiscovery(input: RunDiscoveryInput): Promise<DiscoverySnapshot> {
  const { session, sshUser, timeouts, redactor } = input;
  const now = input.now ?? ((): number => performance.now());

  const state: SequenceState = { sshUser, dockerNotInstalled: false };
  let facts = emptyFacts();
  const checks: DiscoveryCheck[] = [];
  const warnings = new Set<ServerErrorCode>();
  const startedAt = now();
  let budgetAlreadyAborted = false;

  for (const entry of DISCOVERY_SEQUENCE) {
    if (!entry.appliesTo(state)) {
      checks.push({
        id: entry.id,
        status: 'not_applicable',
        detail: redactor.redact(NOT_APPLICABLE_DETAIL[entry.id] ?? 'Not applicable for this user.'),
        durationMs: 0,
      });
      continue;
    }

    if (budgetAlreadyAborted) {
      checks.push({
        id: entry.id,
        status: 'skipped',
        detail: redactor.redact('Skipped: the discovery time budget was already exceeded.'),
        durationMs: 0,
      });
      continue;
    }

    if (now() - startedAt >= timeouts.discoveryMs) {
      budgetAlreadyAborted = true;
      warnings.add('COMMAND_TIMEOUT');
      checks.push({
        id: entry.id,
        status: 'fail',
        detail: redactor.redact(
          `Discovery aborted: exceeded its ${String(timeouts.discoveryMs)}ms total time budget while this check was next in line.`,
        ),
        durationMs: 0,
      });
      continue;
    }

    let outcome: CheckOutcome;
    let durationMs = 0;
    try {
      // A plain, sequentially-awaited loop, not a concurrent one: D-13's narrative requires a
      // fixed order, and running these concurrently would also open concurrent channels over one
      // connection for no benefit on an eleven-command run.
      const result = await session.exec(entry.commandName);
      durationMs = result.durationMs;
      outcome = entry.evaluate(result, state);
    } catch (err) {
      // A rejection (e.g. the adapter's classified `COMMAND_TIMEOUT`/`CONNECTION_LOST` failure)
      // becomes a failed check, never an abandoned run — the reason is preserved verbatim.
      outcome = { status: 'fail', detail: failureMessage(err) };
    }

    if (outcome.stateUpdates) {
      Object.assign(state, outcome.stateUpdates);
    }
    if (outcome.facts) {
      facts = { ...facts, ...outcome.facts };
    }
    if (outcome.warnings) {
      for (const code of outcome.warnings) {
        warnings.add(code);
      }
    }

    checks.push({
      id: entry.id,
      status: outcome.status,
      detail: redactor.redact(outcome.detail),
      durationMs,
    });
  }

  return { facts, checks, warnings: [...warnings] };
}
