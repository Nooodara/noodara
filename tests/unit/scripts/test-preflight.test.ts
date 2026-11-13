// 36-03 A2/A3/H1-H6: `pnpm test:doctor` (scripts/test-preflight.mjs over test-preflight-lib.mjs).
// Every branch runs against injected probes; only the port probe binds real loopback sockets.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseTimeoutScale } from '../../support/timeout-scale.js';
import {
  EXIT_OK,
  EXIT_PREREQ_MISSING,
  EXIT_USAGE,
  MAX_LISTED_RESOURCES,
  MESSAGES,
  READ_ONLY_COMMANDS,
  USAGE,
  assertTierPrerequisites,
  createExec,
  createHostProbes,
  exitCodeFor,
  formatReport,
  formatResourceList,
  guarded,
  isAllowedCommand,
  parseArgs,
  parseEnginesNode,
  parsePackageManager,
  parseVersion,
  probePort,
  resolvePortVar,
  runPreflight,
  sanitizeName,
  suggestTimeoutScale,
} from '../../../scripts/test-preflight-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const GIB = 2 ** 30;
const TIERS = ['unit', 'integration', 'e2e'] as const;
type Tier = (typeof TIERS)[number];

type Probes = ReturnType<typeof createHostProbes>;

function fakeProbes(overrides: Partial<Record<keyof Probes, unknown>> = {}): Probes {
  const base = {
    packageJson: () => ({ engines: { node: '>=22.18.0' }, packageManager: 'pnpm@10.34.5' }),
    nodeVersion: () => 'v24.1.0',
    pnpmVersion: () => '10.34.5',
    docker: () => ({ state: 'reachable', version: '28.1.1' }),
    dockerHost: () => ({ source: 'docker', cpus: 16, memBytes: 32 * GIB }),
    unzip: () => 'present',
    chromium: () => 'present',
    leftovers: () => [],
    port: () => 'free',
  };
  return { ...base, ...overrides } as unknown as Probes;
}

async function report(tier: Tier, overrides: Partial<Record<keyof Probes, unknown>> = {}, env: Record<string, string> = {}) {
  return runPreflight({ tier, probes: fakeProbes(overrides), env, probeTimeoutMs: 200 });
}

function check(r: Awaited<ReturnType<typeof report>>, id: string) {
  const found = r.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

describe('CLI contract (H2)', () => {
  it('uses three distinct exit codes', () => {
    expect(new Set([EXIT_OK, EXIT_PREREQ_MISSING, EXIT_USAGE]).size).toBe(3);
    expect([EXIT_OK, EXIT_PREREQ_MISSING, EXIT_USAGE]).toEqual([0, 1, 2]);
    expect(USAGE).toContain('--tier unit|integration|e2e');
  });

  it.each(TIERS)('accepts --tier %s in both spellings', (tier) => {
    expect(parseArgs(['--tier', tier])).toEqual({ ok: true, tier, help: false });
    expect(parseArgs([`--tier=${tier}`])).toEqual({ ok: true, tier, help: false });
    expect(parseArgs(['--', '--tier', tier])).toEqual({ ok: true, tier, help: false });
  });

  it('defaults to the strictest tier when --tier is absent', () => {
    expect(parseArgs([])).toEqual({ ok: true, tier: 'e2e', help: false });
    expect(parseArgs(['--help'])).toEqual({ ok: true, tier: 'e2e', help: true });
  });

  it.each([[['--tier']], [['--tier=']], [['--tier', 'Unit']], [['--tier', 'smoke']], [['--tier', 'unit', '--tier', 'e2e']], [['--fix']], [['e2e']], [['--tier', 'unit', '-v']]])(
    'rejects %j as a usage error',
    (argv) => {
      expect(parseArgs(argv)).toEqual({ ok: false });
    },
  );
});

describe('tier evaluation (A2)', () => {
  it.each(TIERS)('a ready machine exits 0 for the %s tier', async (tier) => {
    const r = await report(tier);
    expect(r.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(exitCodeFor(r)).toBe(EXIT_OK);
  });

  it('reports every check the doctor promises', async () => {
    const ids = (await report('e2e')).checks.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'node',
        'pnpm',
        'docker',
        'unzip',
        'chromium',
        'port:NOODARA_TEST_PORT_OVERRIDE',
        'port:NOODARA_E2E_WEB_PORT',
        'port:NOODARA_E2E_API_PORT',
        'leftovers',
        'machine',
      ]),
    );
  });

  it('fails every tier when Node is older than engines.node', async () => {
    for (const tier of TIERS) {
      const r = await report(tier, { nodeVersion: () => 'v20.11.0' });
      expect(check(r, 'node')).toMatchObject({ status: 'fail', hard: true, message: MESSAGES.nodeTooOld });
      expect(exitCodeFor(r)).toBe(EXIT_PREREQ_MISSING);
    }
  });

  // The unit suite runs scripts/fixture-images.mjs, which imports a .ts helper through unflagged
  // type stripping (Node 22.18+). The floor lives only in package.json engines.node; the doctor
  // reads it through the real packageJson probe and the library hardcodes no Node release.
  it('judges Node against the package.json floor: 22.17.x fails, 22.18.0 passes', async () => {
    const realPackageJson = createHostProbes({ env: {} }).packageJson;
    expect(parseEnginesNode(realPackageJson())).toEqual([22, 18, 0]);
    for (const tier of TIERS) {
      const old = await report(tier, { packageJson: realPackageJson, nodeVersion: () => 'v22.17.1' });
      expect(check(old, 'node')).toMatchObject({ status: 'fail', hard: true, message: MESSAGES.nodeTooOld });
      expect(exitCodeFor(old)).toBe(EXIT_PREREQ_MISSING);
      const floor = await report(tier, { packageJson: realPackageJson, nodeVersion: () => 'v22.18.0' });
      expect(check(floor, 'node')).toMatchObject({ status: 'ok', hard: true });
    }
    const lib = readFileSync(path.join(ROOT, 'scripts/test-preflight-lib.mjs'), 'utf8');
    expect(lib).not.toMatch(/\b22\.\d+/);
  });

  it('distinguishes a pnpm major mismatch (hard) from a minor drift (warning)', async () => {
    const major = await report('unit', { pnpmVersion: () => '9.15.0' });
    expect(check(major, 'pnpm')).toMatchObject({ status: 'fail', message: MESSAGES.pnpmMajor });
    expect(exitCodeFor(major)).toBe(EXIT_PREREQ_MISSING);
    const minor = await report('unit', { pnpmVersion: () => '10.30.0' });
    expect(check(minor, 'pnpm')).toMatchObject({ status: 'warn', message: MESSAGES.pnpmMinor });
    expect(exitCodeFor(minor)).toBe(EXIT_OK);
  });

  it.each([
    ['missing', 'missing', MESSAGES.dockerMissing, 'fail'],
    ['failed', 'failed', MESSAGES.dockerUnreachable, 'fail'],
    ['timeout', 'timeout', MESSAGES.dockerUnknown, 'unknown'],
  ])('maps a Docker probe that is %s to a fixed message', async (_name, state, message, status) => {
    const integration = await report('integration', { docker: () => ({ state }) });
    expect(check(integration, 'docker')).toMatchObject({ status, message, hard: true });
    expect(exitCodeFor(integration)).toBe(EXIT_PREREQ_MISSING);
    const unit = await report('unit', { docker: () => ({ state }) });
    expect(check(unit, 'docker').hard).toBe(false);
    expect(exitCodeFor(unit)).toBe(EXIT_OK);
  });

  it('names the component that spawns unzip and requires it only for e2e', async () => {
    expect(MESSAGES.unzipMissing).toContain('tests/e2e/deploy.spec.ts');
    expect(MESSAGES.unzipMissing).toContain('artifactText');
    const source = readFileSync(path.join(ROOT, 'tests/e2e/deploy.spec.ts'), 'utf8');
    expect(source).toMatch(/async function artifactText[\s\S]{0,300}execFileAsync\('unzip'/);
    const e2e = await report('e2e', { unzip: () => 'missing' });
    expect(check(e2e, 'unzip')).toMatchObject({ status: 'fail', hard: true });
    expect(exitCodeFor(e2e)).toBe(EXIT_PREREQ_MISSING);
    const integration = await report('integration', { unzip: () => 'missing' });
    expect(check(integration, 'unzip').hard).toBe(false);
    expect(exitCodeFor(integration)).toBe(EXIT_OK);
  });

  it('requires Playwright Chromium only for e2e', async () => {
    const e2e = await report('e2e', { chromium: () => 'missing' });
    expect(check(e2e, 'chromium')).toMatchObject({ status: 'fail', message: MESSAGES.chromiumMissing });
    expect(exitCodeFor(e2e)).toBe(EXIT_PREREQ_MISSING);
    expect(exitCodeFor(await report('unit', { chromium: () => 'missing' }))).toBe(EXIT_OK);
  });

  it('treats a busy port as hard only for the tier that binds it', async () => {
    const busy3000 = { port: (p: number) => (p === 3000 ? 'in-use' : 'free') };
    expect(exitCodeFor(await report('integration', busy3000))).toBe(EXIT_PREREQ_MISSING);
    expect(exitCodeFor(await report('e2e', busy3000))).toBe(EXIT_PREREQ_MISSING);
    expect(exitCodeFor(await report('unit', busy3000))).toBe(EXIT_OK);
    const busyApi = { port: (p: number) => (p === 3100 ? 'in-use' : 'free') };
    expect(exitCodeFor(await report('integration', busyApi))).toBe(EXIT_OK);
    expect(exitCodeFor(await report('e2e', busyApi))).toBe(EXIT_PREREQ_MISSING);
  });

  it('honours the port override variables', async () => {
    const seen: number[] = [];
    const port = (p: number) => {
      seen.push(p);
      return 'free';
    };
    await report('e2e', { port }, { NOODARA_TEST_PORT_OVERRIDE: '33992', NOODARA_E2E_WEB_PORT: '4300', NOODARA_E2E_API_PORT: '4400' });
    // The integration override names no port the harness binds: it is never probed.
    expect(seen.sort()).toEqual([4300, 4400].sort());
    const r = await report('e2e', { port: () => 'in-use' }, { NOODARA_E2E_WEB_PORT: '4300' });
    expect(check(r, 'port:NOODARA_E2E_WEB_PORT').message).toBe(MESSAGES.portInUse('The port from NOODARA_E2E_WEB_PORT'));
  });

  it('a valid NOODARA_TEST_PORT_OVERRIDE only skips the port 3000 precheck: nothing is probed or hard-failed', async () => {
    const seen: number[] = [];
    const port = (p: number) => {
      seen.push(p);
      return 'in-use';
    };
    const r = await report('integration', { port }, { NOODARA_TEST_PORT_OVERRIDE: '33992' });
    // Only the (soft, for this tier) E2E defaults are probed; the override value never is.
    expect(seen.sort()).toEqual([3000, 3100]);
    expect(check(r, 'port:NOODARA_TEST_PORT_OVERRIDE')).toMatchObject({ status: 'ok', hard: true, message: MESSAGES.portPrecheckSkipped });
    expect(exitCodeFor(r)).toBe(EXIT_OK);
    expect(JSON.stringify(r)).not.toContain('33992');
    // Unset, the doctor probes port 3000 like the integration precheck does.
    const unset = await report('integration', { port: (p: number) => (p === 3000 ? 'in-use' : 'free') });
    expect(check(unset, 'port:NOODARA_TEST_PORT_OVERRIDE')).toMatchObject({ status: 'fail', message: MESSAGES.portInUse('Port 3000') });
  });

  it.each(['0', '65536', 'abc', '3000x', ''])('an invalid NOODARA_TEST_PORT_OVERRIDE (%j) still hard-fails the integration tier', async (value) => {
    const r = await report('integration', {}, { NOODARA_TEST_PORT_OVERRIDE: value });
    expect(check(r, 'port-var:NOODARA_TEST_PORT_OVERRIDE')).toMatchObject({ status: 'fail', hard: true });
    expect(exitCodeFor(r)).toBe(EXIT_PREREQ_MISSING);
  });

  it('fails e2e when the web and API ports collide', async () => {
    const r = await report('e2e', {}, { NOODARA_E2E_WEB_PORT: '4300', NOODARA_E2E_API_PORT: '4300' });
    expect(check(r, 'port-distinct')).toMatchObject({ status: 'fail', hard: true, message: MESSAGES.portsNotDistinct });
    expect(exitCodeFor(r)).toBe(EXIT_PREREQ_MISSING);
  });

  it('fails integration and e2e on leftover noodara.test resources, never unit', async () => {
    const leftovers = () => ['noodara-mirror-1', 'noodara-deploy-engine-2'];
    expect(exitCodeFor(await report('integration', { leftovers }))).toBe(EXIT_PREREQ_MISSING);
    expect(exitCodeFor(await report('e2e', { leftovers }))).toBe(EXIT_PREREQ_MISSING);
    const unit = await report('unit', { leftovers });
    expect(exitCodeFor(unit)).toBe(EXIT_OK);
    expect(check(unit, 'leftovers').details).toEqual(['noodara-mirror-1', 'noodara-deploy-engine-2']);
  });

  it('suggests a timeout scale from the Docker host size as an advisory only', async () => {
    const r = await report('integration', { dockerHost: () => ({ source: 'docker', cpus: 4, memBytes: 6 * GIB }) });
    expect(check(r, 'machine')).toMatchObject({ status: 'warn', hard: false });
    expect(check(r, 'machine').message).toContain('NOODARA_TEST_TIMEOUT_SCALE=3');
    expect(check(r, 'machine').message).toContain('CI never sets it');
    expect(exitCodeFor(r)).toBe(EXIT_OK);
    const unknown = await report('unit', { dockerHost: () => ({ source: 'docker', cpus: Number.NaN, memBytes: 6 * GIB }) });
    expect(check(unknown, 'machine')).toMatchObject({ status: 'unknown', message: MESSAGES.machineUnknown });
  });
});

describe('bounded, fail-closed probes (A3, H6)', () => {
  it.each([
    ['missing engines', { packageJson: () => ({ packageManager: 'pnpm@10.34.5' }) }, 'node'],
    ['range engines', { packageJson: () => ({ engines: { node: '^22 || ^24' }, packageManager: 'pnpm@10.34.5' }) }, 'node'],
    ['unreadable package.json', { packageJson: () => { throw new Error('ENOENT /secret/path'); } }, 'node'],
    ['garbage node version', { nodeVersion: () => 'twenty-two' }, 'node'],
    ['missing packageManager', { packageJson: () => ({ engines: { node: '>=22.18.0' } }) }, 'pnpm'],
    ['yarn packageManager', { packageJson: () => ({ engines: { node: '>=22.18.0' }, packageManager: 'yarn@4.1.0' }) }, 'pnpm'],
    ['garbage pnpm output', { pnpmVersion: () => 'Corepack is about to download' }, 'pnpm'],
    ['pnpm unavailable', { pnpmVersion: () => undefined }, 'pnpm'],
  ])('%s yields could-not-determine and a hard failure', async (_name, overrides, id) => {
    const r = await report('unit', overrides);
    expect(check(r, id).status).toBe('unknown');
    expect(check(r, id).message).toBe(id === 'node' ? MESSAGES.nodeUnknown : MESSAGES.pnpmUnknown);
    expect(exitCodeFor(r)).toBe(EXIT_PREREQ_MISSING);
  });

  it('treats unparseable Docker version output as could-not-determine, not ok', async () => {
    const r = await report('integration', { docker: () => ({ state: 'reachable', version: 'Cannot connect\u001b[31m' }) });
    expect(check(r, 'docker')).toMatchObject({ status: 'unknown', message: MESSAGES.dockerUnknown });
  });

  it('bounds a probe that hangs and one that throws', async () => {
    const hang = () => new Promise(() => undefined);
    const boom = () => {
      throw new Error('stderr: credential helper said token=abc123');
    };
    const started = Date.now();
    const r = await runPreflight({
      tier: 'e2e',
      probes: fakeProbes({ docker: hang, unzip: boom, chromium: hang, leftovers: boom, dockerHost: hang, port: hang, pnpmVersion: hang }),
      env: {},
      probeTimeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const id of ['docker', 'unzip', 'chromium', 'leftovers', 'machine', 'pnpm', 'port:NOODARA_E2E_WEB_PORT']) {
      expect(check(r, id).status).toBe('unknown');
    }
    expect(formatReport(r)).not.toContain('abc123');
    expect(exitCodeFor(r)).toBe(EXIT_PREREQ_MISSING);
  });

  it('guarded() resolves within its deadline and maps throws', async () => {
    await expect(guarded(() => new Promise(() => undefined), 20)).resolves.toEqual({ ok: false, reason: 'timeout' });
    await expect(guarded(() => Promise.reject(new Error('x')), 20)).resolves.toEqual({ ok: false, reason: 'error' });
    await expect(guarded(() => 7, 20)).resolves.toEqual({ ok: true, value: 7 });
  });

  it('parses only well-formed versions and pins', () => {
    expect(parseVersion('v22.12.0')).toEqual([22, 12, 0]);
    expect(parseVersion('10.34.5\n')).toEqual([10, 34, 5]);
    expect(parseVersion('10.34')).toBeUndefined();
    expect(parseVersion(undefined)).toBeUndefined();
    expect(parseEnginesNode({ engines: { node: '>=22.18.0' } })).toEqual([22, 18, 0]);
    expect(parseEnginesNode({ engines: { node: 22 } })).toBeUndefined();
    expect(parseEnginesNode(null)).toBeUndefined();
    expect(parsePackageManager({ packageManager: 'pnpm@10.34.5+sha512.abc' })).toEqual([10, 34, 5]);
    expect(parsePackageManager({ packageManager: 'pnpm@latest' })).toBeUndefined();
  });

  it('reads the real package.json pins', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as unknown;
    expect(parseEnginesNode(pkg)).toBeDefined();
    expect(parsePackageManager(pkg)).toBeDefined();
  });
});

describe('safe output (A3, H3, H5)', () => {
  const SECRET = 'hunter2-SECRET-VALUE';

  it('never prints env values, home paths or ANSI codes when not a TTY', async () => {
    const env = { NOODARA_TEST_PORT_OVERRIDE: SECRET, NOODARA_E2E_WEB_PORT: `${SECRET}:1`, NOODARA_E2E_API_PORT: '70000', HOME: os.homedir() };
    const r = await report('e2e', { leftovers: () => [`evil\u001b[31mred\u0007name`] }, env);
    const text = formatReport(r, { color: false });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('70000');
    expect(text).not.toContain(os.homedir());
    expect(text).not.toContain(ROOT);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(text).toContain('evilredname');
    expect(formatReport(r, { color: true })).toContain('\u001b[');
  });

  it.each([
    ['NOODARA_TEST_PORT_OVERRIDE', 'integration'],
    ['NOODARA_E2E_WEB_PORT', 'e2e'],
    ['NOODARA_E2E_API_PORT', 'e2e'],
  ] as const)('an invalid %s is a hard failure for the %s tier, naming the variable only', async (name, tier) => {
    for (const bad of ['0', '65536', '-1', '3000.5', ' 3000', '1e3', 'abc', '']) {
      const r = await report(tier, {}, { [name]: bad });
      expect(check(r, `port-var:${name}`)).toMatchObject({ status: 'fail', hard: true, message: MESSAGES.portInvalid(name) });
      expect(exitCodeFor(r)).toBe(EXIT_PREREQ_MISSING);
    }
    const other = tier === 'e2e' ? 'integration' : 'e2e';
    expect(exitCodeFor(await report(other, {}, { [name]: 'abc' }))).toBe(EXIT_OK);
  });

  it('accepts the full valid port range', () => {
    expect(resolvePortVar({ P: '1' }, 'P', 3000)).toEqual({ ok: true, port: 1, fromEnv: true });
    expect(resolvePortVar({ P: '65535' }, 'P', 3000)).toEqual({ ok: true, port: 65535, fromEnv: true });
    expect(resolvePortVar({}, 'P', 3000)).toEqual({ ok: true, port: 3000, fromEnv: false });
  });

  it('bounds and sanitises the leftover list', () => {
    const names = Array.from({ length: MAX_LISTED_RESOURCES + 7 }, (_, i) => `res-${String(i)}`);
    const listed = formatResourceList(names);
    expect(listed).toHaveLength(MAX_LISTED_RESOURCES + 1);
    expect(listed.at(-1)).toBe('... and 7 more');
    expect(sanitizeName('a\u001b[1;31mb\u001b]0;title\u0007c\r\nd')).not.toMatch(/[\u0000-\u001f]/);
    expect(sanitizeName('x'.repeat(500)).length).toBeLessThanOrEqual(83);
  });
});

describe('suggestTimeoutScale (H4)', () => {
  const table: readonly [number, number, number][] = [
    [16, 32, 1],
    [8, 16, 1],
    [8, 8, 2],
    [4, 8, 2],
    [4, 6, 3],
    [2, 4, 3],
    [2, 2, 4],
    [1, 64, 4],
  ];
  it.each(table)('%i CPUs / %i GiB -> %s', (cpus, gib, expected) => {
    expect(suggestTimeoutScale({ cpus, memBytes: gib * GIB })).toBe(expected);
  });

  it('is deterministic, within [1, 10] and round-trips through the 36-01 parser', () => {
    for (let cpus = 1; cpus <= 128; cpus += 1) {
      for (const gib of [0.25, 1, 2, 3.5, 4, 6, 7.5, 8, 12, 15, 16, 64, 1024]) {
        const s = suggestTimeoutScale({ cpus, memBytes: gib * GIB });
        expect(s).toBe(suggestTimeoutScale({ cpus, memBytes: gib * GIB }));
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(10);
        expect(parseTimeoutScale(String(s))).toBe(s);
      }
    }
  });

  it.each([
    [{}],
    [{ cpus: 4 }],
    [{ memBytes: 8 * GIB }],
    [{ cpus: 0, memBytes: 8 * GIB }],
    [{ cpus: 2.5, memBytes: 8 * GIB }],
    [{ cpus: 4, memBytes: Number.POSITIVE_INFINITY }],
    [{ cpus: '4', memBytes: 8 * GIB }],
  ])('suggests nothing for %j', (machine) => {
    expect(suggestTimeoutScale(machine)).toBeUndefined();
  });
});

describe('read-only command allowlist (H1, A3)', () => {
  const FORBIDDEN = /\b(rm|rmi|prune|pull|build|stop|kill|start|run|create|install|exec|push|login|logout|context|tag|load|save|update)\b/;

  it('contains only version and listing commands', () => {
    for (const c of READ_ONLY_COMMANDS) {
      expect(['docker', 'pnpm', 'unzip']).toContain(c.file);
      for (const arg of c.args) expect(arg).not.toMatch(FORBIDDEN);
    }
  });

  it('every command the real probes issue is on the allowlist, as an argument array with a timeout', async () => {
    const calls: { file: string; args: string[]; timeout: unknown; shell: unknown }[] = [];
    const execFileImpl = vi.fn((file: string, args: string[], options: { timeout?: number; shell?: unknown }, cb: (err: unknown, out: string) => void) => {
      calls.push({ file, args, timeout: options.timeout, shell: options.shell });
      cb(null, file === 'docker' && args[0] === 'info' ? '4 6000000000' : '1.2.3');
    });
    const probes = createHostProbes({ exec: createExec({ execFileImpl: execFileImpl as never }), env: {} });
    for (const tier of TIERS) await runPreflight({ tier, probes: { ...probes, port: () => Promise.resolve('free') }, env: {} });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(isAllowedCommand(call.file, call.args)).toBe(true);
      expect(call.timeout).toBeGreaterThan(0);
      expect(call.shell).toBeUndefined();
    }
  });

  it('refuses anything off the allowlist without spawning it', async () => {
    const execFileImpl = vi.fn();
    const exec = createExec({ execFileImpl: execFileImpl as never });
    for (const args of [['rm', '-f', 'x'], ['system', 'prune', '-f'], ['pull', 'ubuntu'], ['build', '.'], ['ps', '-a', '; rm -rf /']]) {
      await expect(exec('docker', args)).resolves.toEqual({ ok: false, reason: 'not-allowed' });
    }
    await expect(exec('sh', ['-c', 'docker ps'])).resolves.toEqual({ ok: false, reason: 'not-allowed' });
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('maps exec failures to reasons and never surfaces stderr', async () => {
    const make = (err: unknown) =>
      createExec({ execFileImpl: ((_f: string, _a: string[], _o: unknown, cb: (e: unknown, out: string, errOut: string) => void) => cb(err, '', 'secret stderr')) as never });
    await expect(make({ code: 'ENOENT' })('unzip', ['-v'])).resolves.toEqual({ ok: false, reason: 'missing' });
    await expect(make({ killed: true, signal: 'SIGKILL' })('unzip', ['-v'])).resolves.toEqual({ ok: false, reason: 'timeout' });
    await expect(make({ code: 1 })('unzip', ['-v'])).resolves.toEqual({ ok: false, reason: 'failed' });
    const throwing = createExec({ execFileImpl: (() => { throw new Error('spawn EPERM'); }) as never });
    await expect(throwing('unzip', ['-v'])).resolves.toEqual({ ok: false, reason: 'error' });
  });

  it('the doctor sources never write, remove, install or spawn a shell', () => {
    for (const file of ['scripts/test-preflight-lib.mjs', 'scripts/test-preflight.mjs']) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      expect(source).not.toMatch(/\b(writeFile|writeFileSync|appendFile|mkdir|rmSync|rm\(|unlink|rename|copyFile|spawnSync|execSync|shell:\s*true)\b/);
      expect(source).not.toMatch(/import\s*\{[^}]*\b(exec|execSync|spawn|spawnSync)\b[^}]*\}\s*from\s*'node:child_process'/);
    }
  });
});

describe('probePort (H3)', () => {
  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((resolve) => s.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return port;
  }
  const bindable = async (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen({ port, host: '127.0.0.1' }, () => s.close(() => resolve(true)));
    });

  it('reports a free port and leaves it bindable', async () => {
    const port = await freePort();
    await expect(probePort(port)).resolves.toBe('free');
    await expect(bindable(port)).resolves.toBe(true);
  });

  it('reports EADDRINUSE and leaves the port bindable once the holder closes', async () => {
    const port = await freePort();
    const holder: Server = createServer();
    await new Promise<void>((resolve) => holder.listen({ port, host: '127.0.0.1' }, resolve));
    await expect(probePort(port)).resolves.toBe('in-use');
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    await expect(bindable(port)).resolves.toBe(true);
  });

  it('binds on loopback only and closes the listener on timeout', async () => {
    const close = vi.fn((cb: () => void) => cb());
    const listen = vi.fn();
    const fake = { once: vi.fn(), listen, close };
    await expect(probePort(4321, { timeoutMs: 20, createServerImpl: (() => fake) as never })).resolves.toBe('unknown');
    expect(listen.mock.calls[0]?.[0]).toEqual({ port: 4321, host: '127.0.0.1', exclusive: true });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('assertTierPrerequisites (A4)', () => {
  it('runs only the hard checks of the tier, never ports, leftovers or machine size', async () => {
    const touched: string[] = [];
    const spy = (name: string, value: unknown) => () => {
      touched.push(name);
      return value;
    };
    const probes = fakeProbes({ port: spy('port', 'in-use'), leftovers: spy('leftovers', ['x']), dockerHost: spy('dockerHost', {}), unzip: spy('unzip', 'missing') });
    await expect(assertTierPrerequisites('integration', { probes, env: {}, probeTimeoutMs: 200 })).resolves.toBeUndefined();
    expect(touched).toEqual([]);
  });

  it('throws the same fixed messages the doctor prints', async () => {
    const probes = fakeProbes({ docker: () => ({ state: 'failed' }), unzip: () => 'missing' });
    const err = await assertTierPrerequisites('e2e', { probes, env: { NOODARA_E2E_API_PORT: 'nope' }, probeTimeoutMs: 200 }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    for (const m of [MESSAGES.dockerUnreachable, MESSAGES.unzipMissing, MESSAGES.portInvalid('NOODARA_E2E_API_PORT')]) expect(message).toContain(m);
    expect(message).toContain('pnpm test:doctor --tier e2e');
    expect(message).not.toContain('nope');
  });
});
