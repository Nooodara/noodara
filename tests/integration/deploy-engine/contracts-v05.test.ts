// v0.5 empirical contracts (26-01, ADR 0012). Permanent: every assertion is what was measured
// against the real sshd + dockerd fixture on Ubuntu 22.04 and 24.04 and fails if a new Docker,
// kernel or Ubuntu changes it. Raw ssh2 as deployer, never the adapter and never a mock.
//   - HOST (A1): one exec per sample: /proc/stat twice, /proc/meminfo, df -B1, /proc/uptime.
//   - CONTAINER (A2): docker inspect with a .State/.HostConfig.Memory-only template, docker stats.
//   - OOM (A3): --memory=32m allocator -> OOMKilled + 137; on-failure crash loop -> RestartCount.
//   - LOGS (A4): docker logs --timestamps --since/--until --tail semantics and cost.
//   - BOUNDED (H1): every remote command is `env -i ... timeout ... | head -c <cap>`, fixtures are
//     built from a digest-pinned base, no probe carries service env or secrets.
// Remote scripts are constant strings; variable parts travel as single-quoted arguments.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@noodara/ssh/testing';
import type { ClientChannel } from '@noodara/ssh/testing';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const FIXTURES = path.resolve(HERE, '../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 330_000;
const OUTPUT_CAP = 65_536;
const LOG_OPTS = '--log-opt max-size=10m --log-opt max-file=3';

// --- Probe shapes ADR 0012 fixes ---------------------------------------------------------------

/** A1: one exec, CPU from the delta of two /proc/stat reads `$1` seconds apart. */
const HOST_SAMPLE = `printf 'CPU %s\\n' "$(head -n1 /proc/stat)"
sleep "$1"
printf 'CPU %s\\n' "$(head -n1 /proc/stat)"
grep -E '^(MemTotal|MemAvailable):' /proc/meminfo | sed 's/^/MEM /'
root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || root=
if [ -n "$root" ]; then set -- / "$root"; else set -- /; fi
df -B1 --output=target,size,used,avail "$@" | tail -n +2 | sed 's/^/DF /'
printf 'UP %s\\n' "$(cat /proc/uptime)"`;

/**
 * A2: one JSON object per container. Only top-level scalars (.Id, .Name, .RestartCount), .State
 * fields and .HostConfig.Memory; Health.Log contributes exit codes only, never its Output.
 * The CLI renders the template over the raw JSON map, so a missing key (no HEALTHCHECK: no
 * .State.Health) is a template error; `index` returns nil instead.
 */
const INSPECT_STATE_TEMPLATE =
  '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},' +
  '"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},' +
  '"restartCount":{{json .RestartCount}},"oomKilled":{{json .State.OOMKilled}},' +
  '"exitCode":{{json .State.ExitCode}},"startedAt":{{json .State.StartedAt}},' +
  '"finishedAt":{{json .State.FinishedAt}},' +
  '"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},' +
  '"healthExitCodes":[{{with index .State "Health"}}{{range $i, $l := .Log}}{{if $i}},{{end}}{{$l.ExitCode}}{{end}}{{end}}],' +
  '"memoryLimit":{{json .HostConfig.Memory}}}';

const STATS_TEMPLATE = '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}';
const DOCKER_ROOT_TEMPLATE = '{{.DockerRootDir}}';

/** A2: one exec: inspect every managed container, stats only the running ones. */
const CONTAINER_SAMPLE = `all=$(docker ps -a -q --no-trunc --filter label=noodara.managed=true)
up=$(docker ps -q --no-trunc --filter label=noodara.managed=true --filter status=running)
[ -n "$all" ] && docker inspect --type container --format "$1" -- $all | sed 's/^/I /'
[ -n "$up" ] && docker stats --no-stream --no-trunc --format "$2" -- $up | sed 's/^/S /'
true`;

const PROBE_TEMPLATES = [INSPECT_STATE_TEMPLATE, STATS_TEMPLATE, DOCKER_ROOT_TEMPLATE] as const;
const FORBIDDEN_SELECTORS = [/\.Config\.Env\b/, /\.Config\.Cmd\b/, /\.Mounts\b/, /\{\{\s*json\s+\.Config\s*\}\}/];

// --- Raw ssh2 plumbing ------------------------------------------------------------------------

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly ms: number;
}

function connect(stack: DeployEngineStack): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => {
      resolve(client);
    });
    client.once('error', reject);
    client.connect({
      host: stack.ssh.host,
      port: stack.ssh.port,
      username: stack.ssh.user,
      privateKey: stack.ssh.privateKey,
      readyTimeout: 20_000,
    });
  });
}

function run(client: Client, command: string): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err !== undefined) {
        reject(err);
        return;
      }
      let stdout = '';
      let exitCode: number | null = null;
      const timer = setTimeout(() => {
        channel.destroy();
        reject(new Error(`ssh exec timed out after ${String(SSH_COMMAND_TIMEOUT_MS)}ms`));
      }, SSH_COMMAND_TIMEOUT_MS);
      timer.unref();
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      channel.on('exit', (code: number | null) => {
        exitCode = code;
      });
      channel.on('close', () => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, ms: Date.now() - startedAt });
      });
      channel.end();
    });
  });
}

/** POSIX single-quote for the remote shell. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const PRELUDE = `now_ms() { date +%s%3N; }`;

/** Bash source with `@{` standing for `${` (keeps TS template syntax out of the scripts). */
function bash(source: string): string {
  return source.replaceAll('@{', '${');
}

/**
 * H1: the only way this file reaches the host. Empty environment, a hard wall-clock cap (124 on
 * timeout) and an output cap (141 when hit). `docker` inherits the same empty environment.
 */
function bounded(
  script: string,
  timeoutSeconds: number,
  args: readonly string[] = [],
  cap = OUTPUT_CAP,
): string {
  return [
    'env',
    '-i',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME=/home/deployer',
    'LC_ALL=C',
    'timeout',
    '-k',
    '1',
    String(timeoutSeconds),
    'bash',
    '--noprofile',
    '--norc',
    '-c',
    `set -o pipefail\n{\n${PRELUDE}\n${script}\n} 2>&1 | head -c ${String(cap)}`,
    'noodara-contract',
    ...args,
  ]
    .map(q)
    .join(' ');
}

/** `M key=value` lines of a script's output. */
function marks(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('M ')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(2, eq)] = line.slice(eq + 1);
  }
  return out;
}

function prefixed(stdout: string, prefix: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function int(value: string | undefined): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new Error(`expected an integer, got '${String(value)}'`);
  }
  return Number(value);
}

function measure(tag: string, ubuntu: string, data: Record<string, unknown>): void {
  const line = `[V05-${tag}] ${JSON.stringify({ ubuntu, ...data })}`;
  console.log(line);
  const file = process.env['NOODARA_MEASUREMENTS_FILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

// --- Parsers the ADR hands to 27-xx (kept here so the contract and the measurement agree) -------

interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

/** `cpu  user nice system idle iowait irq softirq steal guest guest_nice` (guest is in user). */
function parseCpuLine(line: string): CpuTimes {
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== 'cpu') throw new Error(`not an aggregate cpu line: ${line}`);
  const values = fields.slice(1, 9).map((field) => int(field));
  if (values.length !== 8) throw new Error(`short cpu line: ${line}`);
  const [, , , idle = 0, iowait = 0] = values;
  return { idle: idle + iowait, total: values.reduce((sum, value) => sum + value, 0) };
}

function cpuPercent(a: CpuTimes, b: CpuTimes): number {
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (100 * (total - (b.idle - a.idle))) / total));
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  kB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
};

/** docker stats sizes: `12.34MiB`. */
function parseDockerSize(value: string): number {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(value.trim());
  const unit = match?.[2] === undefined ? undefined : SIZE_UNITS[match[2]];
  if (match?.[1] === undefined || unit === undefined) throw new Error(`bad docker size '${value}'`);
  return Math.round(Number(match[1]) * unit);
}

interface StatsRow {
  readonly id: string;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly memoryLimitBytes: number;
}

function parseStatsRow(row: string): StatsRow {
  const [id = '', cpu = '', mem = ''] = row.split('\t');
  const [usage = '', limit = ''] = mem.split(' / ');
  return {
    id,
    cpuPercent: Number(cpu.replace('%', '')),
    memoryBytes: parseDockerSize(usage),
    memoryLimitBytes: parseDockerSize(limit),
  };
}

interface InspectRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly running: boolean;
  readonly restarting: boolean;
  readonly restartCount: number;
  readonly oomKilled: boolean;
  readonly exitCode: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly health: string | null;
  readonly healthExitCodes: readonly number[];
  readonly memoryLimit: number;
}

const INSPECT_KEYS = [
  'exitCode',
  'finishedAt',
  'health',
  'healthExitCodes',
  'id',
  'memoryLimit',
  'name',
  'oomKilled',
  'restartCount',
  'restarting',
  'running',
  'startedAt',
  'status',
];

function parseInspect(stdout: string): InspectRow[] {
  return prefixed(stdout, 'I ').map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(INSPECT_KEYS);
    return parsed as unknown as InspectRow;
  });
}

const DOCKER_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z) (.*)$/;

interface LogLine {
  readonly ts: string;
  readonly text: string;
}

function parseLogLines(lines: readonly string[]): LogLine[] {
  return lines
    .filter((line) => line !== '')
    .map((line) => {
      const match = DOCKER_TS.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new Error(`log line without an RFC3339Nano prefix: ${line}`);
      }
      return { ts: match[1], text: match[2] };
    });
}

/** Source string literals that hold a Go template, from every non-test .ts file under `dir`. */
function templatesIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const text = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
    for (const match of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*\{\{(?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      if (match[2] !== undefined) found.push(match[2]);
    }
  }
  return found;
}

function fixtureFroms(): { readonly fixture: string; readonly from: string }[] {
  const froms: { fixture: string; from: string }[] = [];
  for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dockerfile = readFileSync(path.join(FIXTURES, entry.name, 'Dockerfile'), 'utf8');
    for (const match of dockerfile.matchAll(/^FROM\s+(\S+)/gim)) {
      if (match[1] !== undefined) froms.push({ fixture: entry.name, from: match[1] });
    }
  }
  return froms;
}

// --- Static contracts (no infrastructure) ------------------------------------------------------

describe('ADR 0012 static contracts', () => {
  it('CONTAINER / ADR 0012 / A2: no docker --format template Noodara uses selects .Config.Env, .Config.Cmd or .Mounts', () => {
    const sources = ['packages/ssh/src', 'packages/docker/src', 'apps/control-plane/src'].flatMap(
      (dir) => templatesIn(path.join(REPO_ROOT, dir)),
    );
    // Sanity: the scan finds the templates that exist today, so an empty result cannot pass.
    expect(sources).toEqual(expect.arrayContaining(['{{json .State}}']));
    for (const template of [...sources, ...PROBE_TEMPLATES]) {
      for (const selector of FORBIDDEN_SELECTORS) expect(template, template).not.toMatch(selector);
    }
    // The inspect probe never asks for the whole object or a whole sub-object other than State's
    // scalars: every `.X.Y` it selects is under .State, .HostConfig.Memory, or a top-level scalar.
    const selected = [...INSPECT_STATE_TEMPLATE.matchAll(/(?<![\w$])\.[A-Z][\w.]*/g)].map((m) => m[0]);
    for (const selector of selected) {
      expect(
        // .Status and .Log only appear inside `with index .State "Health"`.
        /^\.(Id|Name|RestartCount|State(\.[A-Za-z]+)*|HostConfig\.Memory|Status|Log)$/.test(selector),
        selector,
      ).toBe(true);
    }
    expect(INSPECT_STATE_TEMPLATE).not.toContain('Output');
    expect(INSPECT_STATE_TEMPLATE).not.toMatch(/\{\{\s*json\s+\.\s*\}\}/);
  });

  it('BOUNDED / ADR 0012 / H1: every fixture image is built from a digest-pinned base, never :latest', () => {
    const froms = fixtureFroms();
    expect(froms.map((entry) => entry.fixture).sort()).toEqual(['crash-loop', 'oom-allocator']);
    for (const { fixture, from } of froms) {
      expect(from, fixture).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
      expect(from, fixture).not.toMatch(/:latest(@|$)/);
    }
  });

  it('HOST / ADR 0012 / A1: CPU % comes from the /proc/stat delta, idle includes iowait', () => {
    const a = parseCpuLine('cpu  100 0 100 700 100 0 0 0 0 0');
    const b = parseCpuLine('cpu  200 0 200 1300 300 0 0 0 0 0');
    expect(cpuPercent(a, b)).toBeCloseTo(20, 5);
    expect(cpuPercent(b, b)).toBe(0);
    expect(() => parseCpuLine('cpu0 1 2 3 4 5 6 7 8')).toThrow();
    expect(parseDockerSize('1.5MiB')).toBe(1_572_864);
    expect(parseDockerSize('0B')).toBe(0);
    expect(() => parseDockerSize('12 parsecs')).toThrow();
  });
});

// --- Contracts on the fixture host -------------------------------------------------------------

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('ADR 0012 contracts on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let client: Client | undefined;
  let nodeImage = '';
  const tags: Record<string, string> = {};
  const id = (): string => randomUUID().slice(0, 12);

  const sh = async (
    script: string,
    timeoutSeconds: number,
    args: readonly string[] = [],
    cap?: number,
  ): Promise<RunResult> => {
    if (client === undefined) throw new Error('client not connected');
    return run(client, bounded(script, timeoutSeconds, args, cap));
  };

  const must = async (
    script: string,
    timeoutSeconds: number,
    args: readonly string[] = [],
    cap?: number,
  ): Promise<RunResult> => {
    const result = await sh(script, timeoutSeconds, args, cap);
    if (result.exitCode !== 0) {
      throw new Error(
        `exit ${String(result.exitCode)}: ${script.slice(0, 80)}: ${result.stdout.slice(-600)}`,
      );
    }
    return result;
  };

  const runManaged = (name: string, flags: string, image: string, cmd: readonly string[] = []) =>
    must(
      bash(
        `docker run --detach --pull never --name "$1" --label noodara.managed=true ${flags} -- "$2" "@{@:3}" >/dev/null`,
      ),
      30,
      [name, image, ...cmd],
    );

  const removeAll = () =>
    sh(
      `ids=$(docker ps -a -q --filter label=noodara.managed=true); [ -z "$ids" ] || docker rm -f $ids >/dev/null; true`,
      30,
    );

  beforeAll(async () => {
    stack = await startDeployEngineStack({ ubuntu });
    client = await connect(stack);
    const node = stack.baseImages.find((ref) => ref.startsWith('node:'));
    if (node === undefined) throw new Error('no node base image preloaded');
    nodeImage = node;
    const versions = await must(
      `docker version --format '{{.Server.Version}}'; docker info --format '{{.LoggingDriver}} {{.CgroupVersion}} {{.CgroupDriver}}'; uname -r; . /etc/os-release; echo "$VERSION_ID"`,
      20,
    );
    for (const { fixture, from } of fixtureFroms()) {
      expect(stack.baseImages, `${fixture} base is preloaded`).toContain(from);
      const dir = path.join(FIXTURES, fixture);
      const [script = ''] = readdirSync(dir).filter((file) => file.endsWith('.sh'));
      const tag = `noodara-test/${fixture}:${id()}`;
      const startedAt = Date.now();
      await must(
        `d=$(mktemp -d); printf '%s' "$1" > "$d/Dockerfile"; printf '%s' "$2" > "$d/$3"
docker build --quiet --tag "$4" "$d" >/dev/null; rc=$?; rm -rf -- "$d"; exit $rc`,
        180,
        [
          readFileSync(path.join(dir, 'Dockerfile'), 'utf8'),
          readFileSync(path.join(dir, script), 'utf8'),
          script,
          tag,
        ],
      );
      tags[fixture] = tag;
      measure('SETUP', ubuntu, { fixture, buildMs: Date.now() - startedAt });
    }
    measure('SETUP', ubuntu, { versions: versions.stdout.trim().split('\n') });
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    if (client !== undefined) await removeAll().catch(() => undefined);
    client?.end();
    await stack?.stop();
    await assertNoStrayTestContainers();
  }, STACK_TIMEOUT_MS);

  // --- A1: host sample -------------------------------------------------------------------------

  it('HOST / ADR 0012 / A1: one bounded exec reads /proc/stat twice, /proc/meminfo, df -B1 for / and the Docker root, /proc/uptime', async () => {
    const runs: { ms: number; bytes: number }[] = [];
    let last: RunResult | undefined;
    for (let i = 0; i < 3; i += 1) {
      last = await must(HOST_SAMPLE, 10, ['1'], 4096);
      runs.push({ ms: last.ms, bytes: Buffer.byteLength(last.stdout) });
    }
    const half = await must(HOST_SAMPLE, 10, ['0.5'], 4096);
    const dockerInfo = await must(`docker info --format "$1"`, 10, [DOCKER_ROOT_TEMPLATE]);
    if (last === undefined) throw new Error('no sample');
    const out = last.stdout;

    const [cpuA = '', cpuB = ''] = prefixed(out, 'CPU ');
    const cpu = cpuPercent(parseCpuLine(cpuA), parseCpuLine(cpuB));
    const mem = Object.fromEntries(
      prefixed(out, 'MEM ').map((line) => {
        const [key = '', value = ''] = line.split(/:\s+/);
        return [key, int(value.replace(/\s*kB$/, '')) * 1024];
      }),
    );
    const df = prefixed(out, 'DF ').map((line) => {
      const [target = '', size = '', used = '', avail = ''] = line.trim().split(/\s+/);
      return { target, size: int(size), used: int(used), avail: int(avail) };
    });
    const [uptime = '', idle = ''] = (prefixed(out, 'UP ')[0] ?? '').split(' ');
    measure('HOST', ubuntu, {
      runs,
      halfSecondMs: half.ms,
      dockerInfoMs: dockerInfo.ms,
      dockerRoot: dockerInfo.stdout.trim(),
      cpu,
      mem,
      df,
      uptime,
      sample: out,
    });

    expect(cpu).toBeGreaterThanOrEqual(0);
    expect(cpu).toBeLessThanOrEqual(100);
    expect(mem['MemTotal']).toBeGreaterThan(0);
    expect(mem['MemAvailable']).toBeGreaterThan(0);
    expect(mem['MemAvailable']).toBeLessThanOrEqual(mem['MemTotal'] ?? 0);
    expect(df.map((row) => row.target)).toEqual(['/', dockerInfo.stdout.trim()]);
    for (const row of df) {
      expect(row.size).toBeGreaterThan(0);
      expect(row.used + row.avail).toBeLessThanOrEqual(row.size);
    }
    expect(Number(uptime)).toBeGreaterThan(0);
    expect(Number(idle)).toBeGreaterThanOrEqual(0);
    for (const sample of runs) {
      expect(sample.ms).toBeGreaterThanOrEqual(1000);
      expect(sample.ms).toBeLessThan(5000);
      expect(sample.bytes).toBeLessThan(1024);
    }
  });

  // --- A2: container sample --------------------------------------------------------------------

  it('CONTAINER / ADR 0012 / A2: inspect yields only the selected State fields and memory limit; stats yields CPU %, usage and limit', async () => {
    const limited = `noodara-v05-lim-${id()}`;
    const unlimited = `noodara-v05-free-${id()}`;
    const canary = `NOODARA_CANARY_${randomUUID()}`;
    await runManaged(
      limited,
      `--memory 64m --env "SVC_SECRET=${canary}" --health-cmd 'exit 1' --health-interval 1s --health-retries 1 --health-start-period 0s`,
      nodeImage,
      ['sh', '-c', 'exec sleep 3600'],
    );
    await runManaged(unlimited, '', nodeImage, ['sh', '-c', 'exec sleep 3600']);
    await must(
      `t=$(now_ms); while [ "$(docker inspect --format '{{.State.Health.Status}}' -- "$1")" != unhealthy ]; do
  [ $(( $(now_ms) - t )) -gt 20000 ] && exit 1; sleep 0.2; done`,
      30,
      [limited],
    );

    const samples: { ms: number; bytes: number }[] = [];
    let out = '';
    for (let i = 0; i < 3; i += 1) {
      const sample = await must(CONTAINER_SAMPLE, 30, [INSPECT_STATE_TEMPLATE, STATS_TEMPLATE]);
      samples.push({ ms: sample.ms, bytes: Buffer.byteLength(sample.stdout) });
      out = sample.stdout;
    }
    const inspect = parseInspect(out);
    const stats = prefixed(out, 'S ').map(parseStatsRow);
    const hostTotal = int(
      // mawk (22.04) prints large products as %g; shell arithmetic is 64-bit.
      (await must(`echo $(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) * 1024 ))`, 10)).stdout.trim(),
    );
    measure('CONTAINER', ubuntu, { samples, inspect, stats, hostTotal });

    expect(out).not.toContain(canary);
    const byName = new Map(inspect.map((row) => [row.name, row]));
    const lim = byName.get(`/${limited}`);
    const free = byName.get(`/${unlimited}`);
    expect(lim).toMatchObject({
      status: 'running',
      running: true,
      restarting: false,
      restartCount: 0,
      oomKilled: false,
      exitCode: 0,
      health: 'unhealthy',
      memoryLimit: 64 * 1024 * 1024,
      finishedAt: '0001-01-01T00:00:00Z',
    });
    expect(lim?.healthExitCodes.length).toBeGreaterThan(0);
    expect(lim?.healthExitCodes.every((code) => code === 1)).toBe(true);
    expect(lim?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    expect(free).toMatchObject({ health: null, healthExitCodes: [], memoryLimit: 0 });

    const statsById = new Map(stats.map((row) => [row.id, row]));
    const limStats = lim === undefined ? undefined : statsById.get(lim.id);
    const freeStats = free === undefined ? undefined : statsById.get(free.id);
    expect(limStats?.memoryLimitBytes).toBe(64 * 1024 * 1024);
    expect(limStats?.memoryBytes).toBeGreaterThan(0);
    expect(limStats?.cpuPercent).toBeGreaterThanOrEqual(0);
    // Without --memory, docker stats reports the host total as the limit (rounded by its units).
    expect(Math.abs((freeStats?.memoryLimitBytes ?? 0) - hostTotal) / hostTotal).toBeLessThan(0.01);
    for (const sample of samples) {
      expect(sample.ms).toBeLessThan(10_000);
      expect(sample.bytes).toBeLessThan(4096);
    }
    await removeAll();
  });

  // --- A3: OOM and crash loop ------------------------------------------------------------------

  it('OOM / ADR 0012 / A3: a --memory=32m allocator exits OOMKilled=true, ExitCode 137 within a bounded time', async () => {
    const name = `noodara-v05-oom-${id()}`;
    const image = tags['oom-allocator'] ?? '';
    const out = await must(
      `t=$(now_ms)
docker run --detach --pull never --name "$1" --label noodara.managed=true --memory 32m --memory-swap 32m -- "$2" >/dev/null
while [ "$(docker inspect --format '{{.State.Status}}' -- "$1")" != exited ]; do
  [ $(( $(now_ms) - t )) -gt 30000 ] && break; sleep 0.1; done
echo "M exited_ms=$(( $(now_ms) - t ))"
docker inspect --type container --format "$3" -- "$1" | sed 's/^/I /'
docker logs -- "$1" 2>&1 | sed 's/^/L /'`,
      45,
      [name, image, INSPECT_STATE_TEMPLATE],
    );
    const [row] = parseInspect(out.stdout);
    const exitedMs = int(marks(out.stdout)['exited_ms']);
    measure('OOM', ubuntu, { exitedMs, row, logs: prefixed(out.stdout, 'L ') });
    expect(prefixed(out.stdout, 'L ')).toContain('NOODARA_OOM_ALLOCATING');
    expect(out.stdout).not.toContain('NOODARA_OOM_SURVIVED');
    expect(row).toMatchObject({
      status: 'exited',
      running: false,
      oomKilled: true,
      exitCode: 137,
      memoryLimit: 32 * 1024 * 1024,
    });
    expect(exitedMs).toBeLessThan(30_000);
    await removeAll();
  });

  it('OOM / ADR 0012 / A3: an on-failure crash loop shows a growing RestartCount, read from the top-level .RestartCount', async () => {
    const name = `noodara-v05-crash-${id()}`;
    const image = tags['crash-loop'] ?? '';
    const out = await must(
      `t=$(now_ms)
docker run --detach --pull never --name "$1" --label noodara.managed=true --restart on-failure -- "$2" >/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  echo "R $(( $(now_ms) - t )) $(docker inspect --format '{{.RestartCount}} {{.State.Status}} {{.State.ExitCode}}' -- "$1")"
done
docker inspect --type container --format "$3" -- "$1" | sed 's/^/I /'
docker inspect --format '{{json .State}}' -- "$1" | sed 's/^/J /'`,
      30,
      [name, image, INSPECT_STATE_TEMPLATE],
    );
    const series = prefixed(out.stdout, 'R ').map((line) => {
      const [at = '', count = '', status = '', exitCode = ''] = line.split(' ');
      return { at: int(at), count: int(count), status, exitCode: int(exitCode) };
    });
    const [row] = parseInspect(out.stdout);
    const stateKeys = Object.keys(JSON.parse(prefixed(out.stdout, 'J ')[0] ?? '{}') as object);
    measure('CRASH', ubuntu, { series, row, stateKeys });
    expect(series).toHaveLength(10);
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]?.count).toBeGreaterThanOrEqual(series[i - 1]?.count ?? 0);
    }
    expect((series.at(-1)?.count ?? 0) - (series[0]?.count ?? 0)).toBeGreaterThanOrEqual(2);
    // A sample that lands in the few ms the container runs reads ExitCode 0; every other one, 3.
    for (const point of series) if (point.status !== 'running') expect(point.exitCode).toBe(3);
    expect(row?.oomKilled).toBe(false);
    expect(row?.restartCount).toBeGreaterThanOrEqual(series.at(-1)?.count ?? 0);
    // RestartCount is not part of .State: the template must select it at the top level.
    expect(stateKeys).not.toContain('RestartCount');
    await removeAll();
  });

  // --- A4: docker logs -------------------------------------------------------------------------

  it('LOGS / ADR 0012 / A4: --timestamps prefixes RFC3339Nano (9 digits, Z); stdout and stderr stay on their own streams; each stream is ordered', async () => {
    const name = `noodara-v05-logs-${id()}`;
    await runManaged(name, LOG_OPTS, nodeImage, [
      'sh',
      '-c',
      'i=0; while [ $i -lt 200 ]; do echo "out $i"; echo "err $i" >&2; i=$((i+1)); done; echo NOODARA_LOGS_DONE; exec sleep 3600',
    ]);
    await must(
      `t=$(now_ms); until docker logs -- "$1" 2>/dev/null | grep -q NOODARA_LOGS_DONE; do
  [ $(( $(now_ms) - t )) -gt 20000 ] && exit 1; sleep 0.1; done`,
      30,
      [name],
    );
    const out = await must(
      `d=$(mktemp -d); docker logs --timestamps -- "$1" >"$d/o" 2>"$d/e"
sed 's/^/O /' "$d/o"; sed 's/^/E /' "$d/e"; rm -rf -- "$d"`,
      30,
      [name],
    );
    const stdout = parseLogLines(prefixed(out.stdout, 'O '));
    const stderr = parseLogLines(prefixed(out.stdout, 'E '));
    const expected = (stream: string) => Array.from({ length: 200 }, (_v, i) => `${stream} ${String(i)}`);
    expect(stdout.map((line) => line.text)).toEqual([...expected('out'), 'NOODARA_LOGS_DONE']);
    expect(stderr.map((line) => line.text)).toEqual(expected('err'));
    for (const lines of [stdout, stderr]) {
      for (let i = 1; i < lines.length; i += 1) {
        expect((lines[i]?.ts ?? '') >= (lines[i - 1]?.ts ?? '')).toBe(true);
      }
    }
    // Merging both streams by timestamp: how often it disagrees with the emission order.
    const merged = [...stdout, ...stderr].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const order = (text: string) => {
      const [stream = '', n = '0'] = text.split(' ');
      return text === 'NOODARA_LOGS_DONE' ? 400 : Number(n) * 2 + (stream === 'err' ? 1 : 0);
    };
    let inversions = 0;
    for (let i = 1; i < merged.length; i += 1) {
      if (order(merged[i]?.text ?? '') < order(merged[i - 1]?.text ?? '')) inversions += 1;
    }
    const sameTs = merged.filter((line, i) => i > 0 && merged[i - 1]?.ts === line.ts).length;
    measure('LOGS', ubuntu, {
      case: 'streams',
      ms: out.ms,
      bytes: Buffer.byteLength(out.stdout),
      inversions,
      sameTs,
      first: stdout[0],
    });
    await removeAll();
  });

  it('LOGS / ADR 0012 / A4: --since and --until are inclusive on RFC3339Nano; --tail N counts before --until filters', async () => {
    const name = `noodara-v05-window-${id()}`;
    await runManaged(name, LOG_OPTS, nodeImage, [
      'sh',
      '-c',
      'i=0; while [ $i -lt 100 ]; do echo "line $i"; i=$((i+1)); sleep 0.01; done; echo NOODARA_LOGS_DONE; exec sleep 3600',
    ]);
    await must(
      `t=$(now_ms); until docker logs --tail 1 -- "$1" 2>/dev/null | grep -q NOODARA_LOGS_DONE; do
  [ $(( $(now_ms) - t )) -gt 30000 ] && exit 1; sleep 0.1; done`,
      40,
      [name],
    );
    const all = parseLogLines(
      (await must(`docker logs --timestamps -- "$1"`, 20, [name])).stdout.split('\n'),
    );
    const since = all[20]?.ts ?? '';
    const until = all[60]?.ts ?? '';
    const window = async (...flags: string[]): Promise<LogLine[]> =>
      parseLogLines(
        (
          await must(bash(`docker logs --timestamps "@{@:2}" -- "$1"`), 20, [
            name,
            ...flags,
          ])
        ).stdout.split('\n'),
      );
    const between = await window('--since', since, '--until', until);
    const sinceTail = await window('--since', since, '--tail', '10');
    const untilTail = await window('--until', until, '--tail', '10');
    const windowTail = await window('--since', since, '--until', until, '--tail', '10');
    const texts = (lines: readonly LogLine[]) => lines.map((line) => line.text);
    measure('LOGS', ubuntu, {
      case: 'window',
      since,
      until,
      between: texts(between).length,
      sinceTail: texts(sinceTail),
      untilTail: texts(untilTail),
      windowTail: texts(windowTail),
    });
    expect(texts(between)).toEqual(texts(all.slice(20, 61)));
    expect(texts(sinceTail)).toEqual(texts(all.slice(-10)));
    // --tail picks the last N lines of the log first; --until then drops all of them.
    expect(texts(untilTail)).toEqual([]);
    expect(texts(windowTail)).toEqual([]);
    await removeAll();
  });

  it('LOGS / ADR 0012 / A4: --tail N on a large rotated json-file log costs a bounded read, not the whole log', async () => {
    const name = `noodara-v05-big-${id()}`;
    const lines = 300_000;
    await runManaged(name, LOG_OPTS, nodeImage, [
      'sh',
      '-c',
      `seq 1 ${String(lines)} | sed 's/^/payload line /'; echo NOODARA_LOGS_DONE; exec sleep 3600`,
    ]);
    await must(
      `t=$(now_ms); until docker logs --tail 1 -- "$1" 2>/dev/null | grep -q NOODARA_LOGS_DONE; do
  [ $(( $(now_ms) - t )) -gt 60000 ] && exit 1; sleep 0.2; done`,
      90,
      [name],
    );
    const out = await must(
      bash(`cost() { local t n; t=$(now_ms); n=$(docker logs --timestamps "@{@:2}" -- "$1" 2>&1 | wc -lc); echo "$(( $(now_ms) - t )) $n"; }
echo "M tail_100=$(cost "$1" --tail 100)"
echo "M tail_1000=$(cost "$1" --tail 1000)"
echo "M tail_10000=$(cost "$1" --tail 10000)"
echo "M full=$(cost "$1")"`),
      120,
      [name],
    );
    const m = marks(out.stdout);
    const parse = (value: string | undefined) => {
      const [costMs = '', count = '', bytes = ''] = (value ?? '').trim().split(/\s+/);
      return { ms: int(costMs), lines: int(count), bytes: int(bytes) };
    };
    const tail100 = parse(m['tail_100']);
    const tail1000 = parse(m['tail_1000']);
    const tail10000 = parse(m['tail_10000']);
    const full = parse(m['full']);
    measure('LOGS', ubuntu, { case: 'cost', tail100, tail1000, tail10000, full });
    expect(tail100.lines).toBe(100);
    expect(tail1000.lines).toBe(1000);
    expect(tail10000.lines).toBe(10_000);
    // max-size=10m, max-file=3 keeps at most ~30 MB: the full read is capped by rotation too.
    expect(full.lines).toBeLessThanOrEqual(lines + 1);
    expect(tail100.ms).toBeLessThan(full.ms);
    expect(tail100.ms).toBeLessThan(2000);
    await removeAll();
  });

  // --- H1: bounded execution, no service env in any probe output --------------------------------

  it('BOUNDED / ADR 0012 / H1: env -i leaves no session variable, timeout caps time (124), head caps output (141); probes carry no service env', async () => {
    const env = await must('env | cut -d= -f1 | sort | tr "\\n" " "', 10);
    const capped = await sh('yes NOODARA | head -c 200000', 10, [], 1024);
    const slow = await sh('sleep 30', 2);
    const canary = `NOODARA_CANARY_${randomUUID()}`;
    const name = `noodara-v05-env-${id()}`;
    await runManaged(name, `--env "TOKEN=${canary}"`, nodeImage, ['sh', '-c', 'exec sleep 3600']);
    const host = await must(HOST_SAMPLE, 10, ['0.2'], 4096);
    const containers = await must(CONTAINER_SAMPLE, 30, [INSPECT_STATE_TEMPLATE, STATS_TEMPLATE]);
    const logs = await must(`docker logs --timestamps --tail 100 -- "$1"`, 10, [name]);
    measure('BOUNDED', ubuntu, {
      env: env.stdout.trim(),
      capped: { exitCode: capped.exitCode, bytes: capped.stdout.length },
      slow: { exitCode: slow.exitCode, ms: slow.ms },
    });
    const keys = env.stdout.trim().split(' ');
    for (const key of keys) expect(['HOME', 'LC_ALL', 'PATH', 'PWD', 'SHLVL', '_']).toContain(key);
    expect(capped.exitCode).toBe(141);
    expect(capped.stdout.length).toBe(1024);
    expect(slow.exitCode).toBe(124);
    expect(slow.ms).toBeLessThan(10_000);
    for (const output of [host.stdout, containers.stdout, logs.stdout]) {
      expect(output).not.toContain(canary);
    }
    for (const probe of [HOST_SAMPLE, CONTAINER_SAMPLE]) {
      expect(probe).not.toMatch(/--env|\.Config|printenv|\/proc\/\d+\/environ|\/proc\/self\/environ/);
    }
    await removeAll();
  });
});
