// Contributor test preflight (36-03): the logic behind `pnpm test:doctor` and the fail-fast checks
// in tests/integration/global-setup.ts and tests/e2e/global-setup.ts.
//
// Every host interaction goes through an injectable probe, so each branch is unit-tested without
// touching the host (tests/unit/scripts/test-preflight.test.ts). Rules this file keeps:
// - Strictly read-only: the only external commands are the fixed READ_ONLY_COMMANDS below, run with
//   execFile and argument arrays (no shell), each with an explicit timeout. Nothing is removed,
//   stopped, pulled, built, installed or written.
// - Safe output: messages are fixed strings. Environment variable values, paths, Docker contexts and
//   command stderr are never printed; a port taken from a variable is reported by the variable name.
// - Bounded: a probe that throws or hangs becomes "could not determine", never a crash or a hang.
// Only `node:` builtins are imported (plus @playwright/test, lazily, for the Chromium probe).

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_PREREQ_MISSING = 1;
export const EXIT_USAGE = 2;

export const TIERS = /** @type {const} */ (['unit', 'integration', 'e2e']);

export const USAGE = [
  'Usage: pnpm test:doctor [--tier unit|integration|e2e]',
  '',
  '  --tier <tier>  which test tier the hard prerequisites are checked for (default: e2e, the strictest)',
  '  --help         print this message',
  '',
  `Exit codes: ${EXIT_OK} ok, ${EXIT_PREREQ_MISSING} hard prerequisite missing, ${EXIT_USAGE} usage error.`,
].join('\n');

const LABEL_FILTER = 'label=noodara.test=true';

/** The only commands any probe may run. Exact argument arrays: read-only listings and versions. */
export const READ_ONLY_COMMANDS = Object.freeze([
  Object.freeze({ file: 'pnpm', args: Object.freeze(['--version']) }),
  Object.freeze({ file: 'unzip', args: Object.freeze(['-v']) }),
  Object.freeze({ file: 'docker', args: Object.freeze(['version', '--format', '{{.Server.Version}}']) }),
  Object.freeze({ file: 'docker', args: Object.freeze(['info', '--format', '{{.NCPU}} {{.MemTotal}}']) }),
  Object.freeze({ file: 'docker', args: Object.freeze(['ps', '-a', '--filter', LABEL_FILTER, '--format', '{{.Names}}']) }),
  Object.freeze({ file: 'docker', args: Object.freeze(['network', 'ls', '--filter', LABEL_FILTER, '--format', '{{.Name}}']) }),
  Object.freeze({ file: 'docker', args: Object.freeze(['volume', 'ls', '--filter', LABEL_FILTER, '--format', '{{.Name}}']) }),
]);

export const COMMAND_TIMEOUT_MS = 15_000;
export const PROBE_TIMEOUT_MS = 20_000;
export const PORT_PROBE_TIMEOUT_MS = 3_000;
export const MAX_LISTED_RESOURCES = 10;
const MAX_NAME_LENGTH = 80;

/** Port variables and the tier that uses each one. */
export const PORT_VARS = Object.freeze([
  Object.freeze({ name: 'NOODARA_TEST_PORT_OVERRIDE', fallback: 3000, tier: 'integration' }),
  Object.freeze({ name: 'NOODARA_E2E_WEB_PORT', fallback: 3000, tier: 'e2e' }),
  Object.freeze({ name: 'NOODARA_E2E_API_PORT', fallback: 3100, tier: 'e2e' }),
]);

/** Fixed messages: the only text the report and the global setups can print about a check. */
export const MESSAGES = Object.freeze({
  nodeUnknown: 'Node.js version: could not determine (package.json engines.node missing or malformed, or version unreadable).',
  nodeTooOld: 'Node.js is older than package.json engines.node requires. Install a matching Node.js (see .nvmrc or engines).',
  pnpmUnknown: 'pnpm version: could not determine (package.json packageManager missing or malformed, or pnpm unreadable).',
  pnpmMajor: 'pnpm major version differs from package.json packageManager. Run: corepack enable && corepack install',
  pnpmMinor: 'pnpm version differs from package.json packageManager (same major). Prefer the pinned version.',
  dockerMissing: 'Docker CLI not found. Integration and E2E tests need Docker Engine.',
  dockerUnreachable: 'Docker daemon is not reachable. Start Docker Engine (inside the WSL distro on Windows).',
  dockerUnknown: 'Docker daemon: could not determine (the probe timed out or its output was unreadable).',
  unzipMissing:
    'unzip not found. The E2E artifact secret scan (artifactText in tests/e2e/deploy.spec.ts) spawns unzip to read Playwright trace archives. Install it, e.g. apt-get install unzip.',
  unzipUnknown: 'unzip: could not determine (the probe timed out).',
  chromiumMissing: 'Playwright Chromium is not installed. Run: pnpm e2e:install',
  chromiumUnknown: 'Playwright Chromium: could not determine (the probe failed or timed out).',
  portInvalid: (/** @type {string} */ name) => `${name} must be a decimal port in range 1..65535.`,
  portsNotDistinct: 'NOODARA_E2E_WEB_PORT and NOODARA_E2E_API_PORT must be distinct.',
  portInUse: (/** @type {string} */ subject) => `${subject} is in use. Free it or choose another port with the override variable.`,
  portUnknown: (/** @type {string} */ subject) => `${subject}: could not determine availability (bind failed or timed out).`,
  portPrecheckSkipped: 'NOODARA_TEST_PORT_OVERRIDE is set: the integration port 3000 precheck is skipped (the variable names no port the tests bind).',
  leftoversUnknown: 'Leftover noodara.test resources: could not determine (Docker not reachable or the listing timed out).',
  leftoversFound:
    'Leftover noodara.test resources from an earlier run. Integration and E2E setups refuse to start; inspect and remove them yourself (this tool never removes anything).',
  machineUnknown: 'Docker host CPU/memory: could not determine; no NOODARA_TEST_TIMEOUT_SCALE suggested.',
});

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** @param {unknown} raw @returns {[number, number, number] | undefined} */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return undefined;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]*)?$/.exec(raw.trim());
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** `>=X.Y.Z` only; anything else is malformed. @param {unknown} pkg */
export function parseEnginesNode(pkg) {
  const raw = /** @type {any} */ (pkg)?.engines?.node;
  if (typeof raw !== 'string') return undefined;
  const m = /^>=\s*(\d+\.\d+\.\d+)$/.exec(raw.trim());
  return m === null ? undefined : parseVersion(m[1]);
}

/** `pnpm@X.Y.Z[+sha...]` only. @param {unknown} pkg */
export function parsePackageManager(pkg) {
  const raw = /** @type {any} */ (pkg)?.packageManager;
  if (typeof raw !== 'string') return undefined;
  const m = /^pnpm@(\d+\.\d+\.\d+)(?:\+[0-9A-Za-z.:-]+)?$/.exec(raw.trim());
  return m === null ? undefined : parseVersion(m[1]);
}

/** @param {[number, number, number]} a @param {[number, number, number]} b */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return /** @type {number} */ (a[i]) < /** @type {number} */ (b[i]) ? -1 : 1;
  return 0;
}

/** @param {[number, number, number]} v */
const versionText = (v) => v.join('.');

/**
 * Validates a port variable. Never echoes the value.
 * @param {Readonly<Record<string, string | undefined>>} env @param {string} name @param {number} fallback
 * @returns {{ ok: true, port: number, fromEnv: boolean } | { ok: false }}
 */
export function resolvePortVar(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return { ok: true, port: fallback, fromEnv: false };
  if (!/^[0-9]{1,5}$/.test(raw)) return { ok: false };
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? { ok: true, port, fromEnv: true } : { ok: false };
}

/**
 * Suggested NOODARA_TEST_TIMEOUT_SCALE for the Docker host: pure, deterministic, in [1, 10], always
 * plain decimal notation; undefined when CPU or memory is unknown (never a guess).
 * @param {{ cpus?: unknown, memBytes?: unknown }} machine
 * @returns {number | undefined}
 */
export function suggestTimeoutScale(machine) {
  const { cpus, memBytes } = machine;
  if (typeof cpus !== 'number' || !Number.isSafeInteger(cpus) || cpus < 1) return undefined;
  if (typeof memBytes !== 'number' || !Number.isFinite(memBytes) || memBytes <= 0) return undefined;
  const gib = memBytes / 2 ** 30;
  if (cpus >= 8 && gib >= 15) return 1;
  if (cpus >= 4 && gib >= 7.5) return 2;
  if (cpus >= 2 && gib >= 3.5) return 3;
  return 4;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Strips ANSI sequences and control characters; caps the length. @param {string} name */
export function sanitizeName(name) {
  const clean = String(name).replace(ANSI_RE, '').replace(CONTROL_RE, '');
  return clean.length > MAX_NAME_LENGTH ? `${clean.slice(0, MAX_NAME_LENGTH)}...` : clean;
}

/** At most `max` sanitised names, then a count of the rest. @param {readonly string[]} names */
export function formatResourceList(names, max = MAX_LISTED_RESOURCES) {
  const shown = names.slice(0, max).map(sanitizeName);
  const rest = names.length - shown.length;
  return rest > 0 ? [...shown, `... and ${String(rest)} more`] : shown;
}

/** @param {string} file @param {readonly string[]} args */
export function isAllowedCommand(file, args) {
  return READ_ONLY_COMMANDS.some(
    (c) => c.file === file && c.args.length === args.length && c.args.every((a, i) => a === args[i]),
  );
}

/**
 * Runs `fn` with a hard deadline. Throws and hangs both become a bounded `{ ok: false }`.
 * @template T @param {() => T | Promise<T>} fn @param {number} timeoutMs
 * @returns {Promise<{ ok: true, value: T } | { ok: false, reason: 'error' | 'timeout' }>}
 */
export async function guarded(fn, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(fn)
        .then(
          (value) => /** @type {const} */ ({ ok: true, value }),
          () => /** @type {const} */ ({ ok: false, reason: 'error' }),
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(/** @type {const} */ ({ ok: false, reason: 'timeout' })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Host probes
// ---------------------------------------------------------------------------------------------

/**
 * execFile wrapper: allowlisted commands only, argument arrays, explicit timeout, stderr discarded.
 * @param {{ execFileImpl?: typeof execFile, timeoutMs?: number }} [options]
 * @returns {(file: string, args: readonly string[]) => Promise<{ ok: true, stdout: string } | { ok: false, reason: string }>}
 */
export function createExec({ execFileImpl = execFile, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return (file, args) =>
    new Promise((resolve) => {
      if (!isAllowedCommand(file, args)) {
        resolve({ ok: false, reason: 'not-allowed' });
        return;
      }
      try {
        execFileImpl(
          file,
          [...args],
          { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' },
          (/** @type {any} */ err, /** @type {unknown} */ stdout) => {
            if (err) {
              const reason = err.code === 'ENOENT' ? 'missing' : err.killed || err.signal ? 'timeout' : 'failed';
              resolve({ ok: false, reason });
              return;
            }
            resolve({ ok: true, stdout: String(stdout) });
          },
        );
      } catch {
        resolve({ ok: false, reason: 'error' });
      }
    });
}

/**
 * Loopback-only bind probe; the listener is closed on every path.
 * @param {number} port
 * @param {{ timeoutMs?: number, createServerImpl?: typeof createServer }} [options]
 * @returns {Promise<'free' | 'in-use' | 'unknown'>}
 */
export function probePort(port, { timeoutMs = PORT_PROBE_TIMEOUT_MS, createServerImpl = createServer } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {any} */
    let server;
    /** @param {'free' | 'in-use' | 'unknown'} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // close() always calls back, with ERR_SERVER_NOT_RUNNING when it never listened; the
      // fallback only bounds a close that never calls back.
      const fallback = setTimeout(() => resolve(result), timeoutMs);
      const done = () => {
        clearTimeout(fallback);
        resolve(result);
      };
      try {
        if (server === undefined) done();
        else server.close(done);
      } catch {
        done();
      }
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    try {
      server = createServerImpl();
      server.once('error', (/** @type {any} */ err) => finish(err?.code === 'EADDRINUSE' ? 'in-use' : 'unknown'));
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => finish('free'));
    } catch {
      finish('unknown');
    }
  });
}

/** @param {string} stdout */
const nonEmptyLines = (stdout) =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The real probes. Each returns plain data; the evaluator maps it to fixed messages.
 * @param {{ exec?: ReturnType<typeof createExec>, env?: Readonly<Record<string, string | undefined>> }} [options]
 */
export function createHostProbes({ exec = createExec(), env = process.env } = {}) {
  return {
    packageJson: () => JSON.parse(readFileSync(`${REPO_ROOT}package.json`, 'utf8')),
    nodeVersion: () => process.version,
    pnpmVersion: async () => {
      // pnpm sets npm_config_user_agent ("pnpm/X.Y.Z ...") for every script; read, never printed.
      const ua = /^pnpm\/(\S+)/.exec(env.npm_config_user_agent ?? '');
      if (ua !== null) return ua[1];
      const r = await exec('pnpm', ['--version']);
      return r.ok ? r.stdout.trim() : undefined;
    },
    docker: async () => {
      const r = await exec('docker', ['version', '--format', '{{.Server.Version}}']);
      return r.ok ? { state: 'reachable', version: r.stdout.trim() } : { state: r.reason };
    },
    dockerHost: async () => {
      const r = await exec('docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}']);
      const m = r.ok ? /^(\d+)\s+(\d+)$/.exec(r.stdout.trim()) : null;
      if (m !== null) return { source: 'docker', cpus: Number(m[1]), memBytes: Number(m[2]) };
      return { source: 'local', cpus: os.cpus().length, memBytes: os.totalmem() };
    },
    unzip: async () => {
      const r = await exec('unzip', ['-v']);
      return r.ok ? 'present' : r.reason === 'missing' ? 'missing' : 'unknown';
    },
    chromium: async () => {
      const { chromium } = await import('@playwright/test');
      const exe = chromium.executablePath();
      return typeof exe === 'string' && exe !== '' && existsSync(exe) ? 'present' : 'missing';
    },
    leftovers: async () => {
      const lists = await Promise.all([
        exec('docker', ['ps', '-a', '--filter', LABEL_FILTER, '--format', '{{.Names}}']),
        exec('docker', ['network', 'ls', '--filter', LABEL_FILTER, '--format', '{{.Name}}']),
        exec('docker', ['volume', 'ls', '--filter', LABEL_FILTER, '--format', '{{.Name}}']),
      ]);
      if (lists.some((l) => !l.ok)) return undefined;
      return lists.flatMap((l) => (l.ok ? nonEmptyLines(l.stdout) : []));
    },
    port: (/** @type {number} */ port) => probePort(port),
  };
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {'ok' | 'warn' | 'fail' | 'unknown'} CheckStatus
 * @typedef {{ id: string, label: string, status: CheckStatus, hard: boolean, message: string, details?: string[] }} Check
 */

/** @param {string} tier @param {readonly string[]} hardIn */
const isHard = (tier, hardIn) => hardIn.includes(tier);

/**
 * Runs every check for `tier`. `mode: 'setup'` (the global setups) runs only the hard checks of the
 * tier and leaves port availability, leftovers and machine size to the existing prechecks.
 * @param {{ tier: string, probes: ReturnType<typeof createHostProbes>, env?: Readonly<Record<string, string | undefined>>, mode?: 'doctor' | 'setup', probeTimeoutMs?: number }} options
 * @returns {Promise<{ tier: string, checks: Check[] }>}
 */
export async function runPreflight({ tier, probes, env = {}, mode = 'doctor', probeTimeoutMs = PROBE_TIMEOUT_MS }) {
  if (!TIERS.includes(/** @type {any} */ (tier))) throw new Error('unknown tier');
  const g = (/** @type {() => any} */ fn) => guarded(fn, probeTimeoutMs);
  const setup = mode === 'setup';
  const want = (/** @type {readonly string[]} */ hardIn) => !setup || isHard(tier, hardIn);
  /** @type {Promise<Check | Check[] | undefined>[]} */
  const pending = [];

  const pkgResult = await g(probes.packageJson);
  const pkg = pkgResult.ok ? pkgResult.value : undefined;

  pending.push(
    (async () => {
      const required = parseEnginesNode(pkg);
      const r = await g(probes.nodeVersion);
      const actual = r.ok ? parseVersion(r.value) : undefined;
      const base = { id: 'node', label: 'Node.js', hard: true };
      if (required === undefined || actual === undefined) return { ...base, status: 'unknown', message: MESSAGES.nodeUnknown };
      if (compareVersions(actual, required) < 0) return { ...base, status: 'fail', message: MESSAGES.nodeTooOld };
      return { ...base, status: 'ok', message: `${versionText(actual)} satisfies >=${versionText(required)}` };
    })(),
  );

  pending.push(
    (async () => {
      const pinned = parsePackageManager(pkg);
      const r = await g(probes.pnpmVersion);
      const actual = r.ok ? parseVersion(r.value) : undefined;
      const base = { id: 'pnpm', label: 'pnpm', hard: true };
      if (pinned === undefined || actual === undefined) return { ...base, status: 'unknown', message: MESSAGES.pnpmUnknown };
      if (actual[0] !== pinned[0]) return { ...base, status: 'fail', message: MESSAGES.pnpmMajor };
      if (compareVersions(actual, pinned) !== 0) return { ...base, status: 'warn', message: MESSAGES.pnpmMinor };
      return { ...base, status: 'ok', message: `${versionText(actual)} matches packageManager` };
    })(),
  );

  if (want(['integration', 'e2e'])) {
    pending.push(
      (async () => {
        const r = await g(probes.docker);
        const base = { id: 'docker', label: 'Docker daemon', hard: isHard(tier, ['integration', 'e2e']) };
        const d = r.ok ? r.value : undefined;
        if (d?.state === 'reachable') {
          return /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]*)?$/.test(String(d.version))
            ? { ...base, status: 'ok', message: `reachable (server ${String(d.version)})` }
            : { ...base, status: 'unknown', message: MESSAGES.dockerUnknown };
        }
        if (d?.state === 'missing') return { ...base, status: 'fail', message: MESSAGES.dockerMissing };
        if (d?.state === 'failed') return { ...base, status: 'fail', message: MESSAGES.dockerUnreachable };
        return { ...base, status: 'unknown', message: MESSAGES.dockerUnknown };
      })(),
    );
  }

  if (want(['e2e'])) {
    pending.push(
      (async () => {
        const r = await g(probes.unzip);
        const base = { id: 'unzip', label: 'unzip', hard: isHard(tier, ['e2e']) };
        if (r.ok && r.value === 'present') return { ...base, status: 'ok', message: 'present' };
        if (r.ok && r.value === 'missing') return { ...base, status: 'fail', message: MESSAGES.unzipMissing };
        return { ...base, status: 'unknown', message: MESSAGES.unzipUnknown };
      })(),
      (async () => {
        const r = await g(probes.chromium);
        const base = { id: 'chromium', label: 'Playwright Chromium', hard: isHard(tier, ['e2e']) };
        if (r.ok && r.value === 'present') return { ...base, status: 'ok', message: 'installed' };
        if (r.ok && r.value === 'missing') return { ...base, status: 'fail', message: MESSAGES.chromiumMissing };
        return { ...base, status: 'unknown', message: MESSAGES.chromiumUnknown };
      })(),
    );
  }

  pending.push(portChecks({ tier, env, probes, g, setup }));

  if (!setup) {
    pending.push(
      (async () => {
        const r = await g(probes.leftovers);
        const base = { id: 'leftovers', label: 'Leftover noodara.test resources', hard: isHard(tier, ['integration', 'e2e']) };
        if (!r.ok || !Array.isArray(r.value)) return { ...base, status: 'unknown', message: MESSAGES.leftoversUnknown };
        const names = /** @type {unknown[]} */ (r.value).map(String);
        if (names.length === 0) return { ...base, status: 'ok', message: 'none' };
        return { ...base, status: 'fail', message: MESSAGES.leftoversFound, details: formatResourceList(names) };
      })(),
      (async () => {
        const r = await g(probes.dockerHost);
        const base = { id: 'machine', label: 'Docker host size', hard: false };
        const m = r.ok ? r.value : undefined;
        const scale = m === undefined ? undefined : suggestTimeoutScale(m);
        if (m === undefined || scale === undefined) return { ...base, status: 'unknown', message: MESSAGES.machineUnknown };
        const where = m.source === 'docker' ? 'Docker host' : 'This machine (Docker not reachable)';
        const size = `${where}: ${String(m.cpus)} CPUs, ${(m.memBytes / 2 ** 30).toFixed(1)} GiB memory.`;
        return scale === 1
          ? { ...base, status: 'ok', message: `${size} No timeout scale needed.` }
          : {
              ...base,
              status: 'warn',
              message: `${size} Suggested for local runs: NOODARA_TEST_TIMEOUT_SCALE=${String(scale)} (CI never sets it).`,
            };
      })(),
    );
  }

  const checks = (await Promise.all(pending)).flat().filter((c) => c !== undefined);
  return { tier, checks: /** @type {Check[]} */ (checks) };
}

/**
 * Port variable validation (hard for the tier that uses the variable) and, in doctor mode,
 * loopback availability of each port.
 * @param {{ tier: string, env: Readonly<Record<string, string | undefined>>, probes: ReturnType<typeof createHostProbes>, g: (fn: () => any) => Promise<any>, setup: boolean }} ctx
 * @returns {Promise<Check[]>}
 */
async function portChecks({ tier, env, probes, g, setup }) {
  /** @type {Check[]} */
  const checks = [];
  /** @type {Map<string, number>} */
  const valid = new Map();
  for (const v of PORT_VARS) {
    const hard = v.tier === tier;
    if (setup && !hard) continue;
    const r = resolvePortVar(env, v.name, v.fallback);
    if (!r.ok) {
      checks.push({ id: `port-var:${v.name}`, label: v.name, status: 'fail', hard, message: MESSAGES.portInvalid(v.name) });
      continue;
    }
    valid.set(v.name, r.port);
    if (setup) continue;
    // The integration override only bypasses the port 3000 precheck; it names no port of its own,
    // so a valid value is never probed (tests/integration/helpers/port-checker.ts).
    if (v.name === 'NOODARA_TEST_PORT_OVERRIDE' && r.fromEnv) {
      checks.push({ id: `port:${v.name}`, label: `Port 3000 precheck (${v.tier})`, hard, status: 'ok', message: MESSAGES.portPrecheckSkipped });
      continue;
    }
    const subject = r.fromEnv ? `The port from ${v.name}` : `Port ${String(r.port)}`;
    const probe = await g(() => probes.port(r.port));
    const state = probe.ok ? probe.value : 'unknown';
    const base = { id: `port:${v.name}`, label: `${subject} (${v.tier})`, hard };
    if (state === 'free') checks.push({ ...base, status: 'ok', message: 'available' });
    else if (state === 'in-use') checks.push({ ...base, status: 'fail', message: MESSAGES.portInUse(subject) });
    else checks.push({ ...base, status: 'unknown', message: MESSAGES.portUnknown(subject) });
  }
  const web = valid.get('NOODARA_E2E_WEB_PORT');
  const api = valid.get('NOODARA_E2E_API_PORT');
  if (web !== undefined && api !== undefined && web === api) {
    checks.push({ id: 'port-distinct', label: 'E2E ports', status: 'fail', hard: tier === 'e2e', message: MESSAGES.portsNotDistinct });
  }
  return checks;
}

/** @param {{ checks: readonly Check[] }} report */
export function hardFailures(report) {
  return report.checks.filter((c) => c.hard && (c.status === 'fail' || c.status === 'unknown'));
}

/** @param {{ checks: readonly Check[] }} report */
export function exitCodeFor(report) {
  return hardFailures(report).length > 0 ? EXIT_PREREQ_MISSING : EXIT_OK;
}

const TAGS = { ok: ['ok  ', '32'], warn: ['warn', '33'], fail: ['FAIL', '31'], unknown: ['??  ', '31'] };

/** @param {{ tier: string, checks: readonly Check[] }} report @param {{ color?: boolean }} [options] */
export function formatReport(report, { color = false } = {}) {
  const paint = (/** @type {string} */ code, /** @type {string} */ text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const lines = [`Noodara test doctor, tier: ${report.tier}`, ''];
  for (const c of report.checks) {
    const [tag, code] = TAGS[c.status];
    const shownTag = c.status === 'ok' || c.hard ? tag : c.status === 'warn' ? tag : 'note';
    lines.push(`  ${paint(code, shownTag)}  ${c.label}${c.hard ? '' : ' (advisory)'}: ${c.message}`);
    for (const d of c.details ?? []) lines.push(`          - ${d}`);
  }
  const failed = hardFailures(report).length;
  lines.push('');
  lines.push(
    failed === 0
      ? `Result: ready for the ${report.tier} tier (exit ${String(EXIT_OK)}).`
      : `Result: ${String(failed)} hard prerequisite(s) missing for the ${report.tier} tier (exit ${String(EXIT_PREREQ_MISSING)}).`,
  );
  return lines.join('\n');
}

/**
 * CLI arguments. Anything unexpected is a usage error: no silent fallback to a weaker tier.
 * @param {readonly string[]} argv
 * @returns {{ ok: true, tier: string, help: boolean } | { ok: false }}
 */
export function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  /** @type {string | undefined} */
  let tier;
  let help = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = /** @type {string} */ (args[i]);
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--tier' || a.startsWith('--tier=')) {
      if (tier !== undefined) return { ok: false };
      const value = a === '--tier' ? args[(i += 1)] : a.slice('--tier='.length);
      if (value === undefined || !TIERS.includes(/** @type {any} */ (value))) return { ok: false };
      tier = value;
    } else return { ok: false };
  }
  return { ok: true, tier: tier ?? 'e2e', help };
}

/**
 * Fail-fast for the global setups: throws with the same fixed messages `pnpm test:doctor` prints,
 * before any container, build or port is touched.
 * @param {'integration' | 'e2e'} tier
 * @param {{ probes?: ReturnType<typeof createHostProbes>, env?: Readonly<Record<string, string | undefined>>, probeTimeoutMs?: number }} [options]
 */
export async function assertTierPrerequisites(tier, { probes = createHostProbes(), env = process.env, probeTimeoutMs } = {}) {
  const report = await runPreflight({ tier, probes, env, mode: 'setup', ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }) });
  const failed = hardFailures(report);
  if (failed.length === 0) return;
  const message = [
    `PRECHECK FAILURE: ${String(failed.length)} hard prerequisite(s) of the ${tier} tier missing`,
    ...failed.map((c) => `  - ${c.message}`),
    `Run: pnpm test:doctor --tier ${tier}`,
  ].join('\n');
  throw new Error(message);
}
