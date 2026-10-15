// v0.3 empirical contracts (16-01, ADR 0010). Permanent: every assertion is what was measured
// against the real sshd + dockerd fixture (11-03) on Ubuntu 22.04 and 24.04 and fails if a new
// Docker, bash or Ubuntu changes it. Raw ssh2 as deployer, never the adapter and never a mock.
//   - HC (A1, H1, H2): healthcheck probes from the host to the container IP on
//     noodara-net-<serviceId>, through bash /dev/tcp under `env -i` + `timeout`; no curl, no image.
//   - PREV (A2): a stopped container renamed to noodara-<serviceId>-prev frees its name and port.
//   - RETRY (A3 evidence): which steps collide when re-run after a crash mid-step.
// Remote commands are constant strings; the variable parts (fresh UUIDs, container IPs) travel as
// single-quoted arguments.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Client } from '@noodara/ssh/testing';
import type { ClientChannel } from '@noodara/ssh/testing';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 180_000;
const SERVER_PORT = 8080;
const CLOSED_PORT = 9;
const PUBLISHED_PORT = 18080;

// --- Raw ssh2 plumbing ------------------------------------------------------------------------

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
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

function run(client: Client, command: string, stdin?: string): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err !== undefined) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
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
        stderr += chunk.toString('utf8');
      });
      channel.on('exit', (code: number | null) => {
        exitCode = code;
      });
      channel.on('close', () => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, ms: Date.now() - startedAt });
      });
      if (stdin !== undefined) channel.write(stdin);
      channel.end();
    });
  });
}

/** POSIX single-quote for the remote shell. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function argv(...parts: readonly string[]): string {
  return parts.map(q).join(' ');
}

function measure(
  tag: 'HC' | 'PREV' | 'RETRY',
  ubuntu: string,
  data: Record<string, unknown>,
): void {
  const line = `[V03-${tag}] ${JSON.stringify({ ubuntu, ...data })}`;
  console.log(line);
  // Vitest hides console output of passing tests; this is how the ADR numbers are collected.
  const file = process.env['NOODARA_MEASUREMENTS_FILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

// --- The probe chosen by ADR 0010 ------------------------------------------------------------

/**
 * HTTP probe: one HTTP/1.0 GET over bash /dev/tcp; only the status line is read (at most 64
 * bytes) and reduced to one `NOODARA_PROBE ...` line. Nothing follows a 3xx, nothing reads the
 * body, and the request headers are fixed: no cookie, credential or cache header can be added.
 * $1 = container IP, $2 = port, $3 = domain-validated path (leading '/', no whitespace or CR/LF).
 */
const HTTP_PROBE_SCRIPT = String.raw`{ exec 3<>"/dev/tcp/$1/$2"; } 2>/dev/null || { echo "NOODARA_PROBE refused"; exit 0; }
printf 'GET %s HTTP/1.0\r\nHost: %s:%s\r\nUser-Agent: noodara-healthcheck/1\r\nAccept: */*\r\nConnection: close\r\n\r\n' "$3" "$1" "$2" >&3 2>/dev/null || { echo "NOODARA_PROBE error"; exit 0; }
IFS= read -r -n 64 line <&3 || [ -n "$line" ] || { echo "NOODARA_PROBE empty"; exit 0; }
line=${'$'}{line%$'\r'}
case $line in
  "HTTP/1."[01]" "[1-5][0-9][0-9]|"HTTP/1."[01]" "[1-5][0-9][0-9]" "*) echo "NOODARA_PROBE http ${'$'}{line:9:3}" ;;
  *) echo "NOODARA_PROBE malformed" ;;
esac`;

/** TCP probe: connect only. */
const TCP_PROBE_SCRIPT = String.raw`{ exec 3<>"/dev/tcp/$1/$2"; } 2>/dev/null && echo "NOODARA_PROBE open" || echo "NOODARA_PROBE refused"`;

/**
 * Every probe runs as `env -i PATH=/usr/bin:/bin timeout -k 1 <s> bash --noprofile --norc -c`:
 * an empty environment (no BASH_ENV, proxy, locale or session secret reaches it) and a hard
 * wall-clock cap that also covers a connect that would otherwise wait for the kernel SYN timeout.
 */
function probeCommand(script: string, timeoutSeconds: number, ...args: readonly string[]): string {
  return argv(
    'env',
    '-i',
    'PATH=/usr/bin:/bin',
    'timeout',
    '-k',
    '1',
    String(timeoutSeconds),
    'bash',
    '--noprofile',
    '--norc',
    '-c',
    script,
    'noodara-probe',
    ...args,
  );
}

function httpProbe(ip: string, port: number, path: string, timeoutSeconds = 5): string {
  return probeCommand(HTTP_PROBE_SCRIPT, timeoutSeconds, ip, String(port), path);
}

function tcpProbe(ip: string, port: number, timeoutSeconds = 5): string {
  return probeCommand(TCP_PROBE_SCRIPT, timeoutSeconds, ip, String(port));
}

type ProbeResult =
  | { readonly kind: 'http'; readonly status: number }
  | {
      readonly kind: 'open' | 'refused' | 'empty' | 'malformed' | 'error' | 'timeout' | 'garbage';
    };

/** Mirror of the parser ADR 0010 hands to 16-03: total, one line, timeout from the exit code. */
function parseProbe(result: RunResult): ProbeResult {
  if (result.exitCode === 124 || result.exitCode === 137) return { kind: 'timeout' };
  if (result.exitCode !== 0 || result.stdout.length > 64) return { kind: 'garbage' };
  const match =
    /^NOODARA_PROBE (?:http ([1-5][0-9]{2})|(open|refused|empty|malformed|error))\n$/.exec(
      result.stdout,
    );
  if (match === null) return { kind: 'garbage' };
  if (match[1] !== undefined) return { kind: 'http', status: Number(match[1]) };
  return {
    kind: match[2] as 'open' | 'refused' | 'empty' | 'malformed' | 'error',
  };
}

// --- Probe target ------------------------------------------------------------------------------

/**
 * Test-only HTTP server run from the preloaded node base (no pull): logs every request (raw
 * headers) and answers by path. HEALTH_STATUS tells two versions of one service apart.
 */
const TARGET_SERVER_JS = String.raw`
const http = require('http');
const status = Number(process.env.HEALTH_STATUS || '200');
const canary = process.env.BODY_CANARY || '';
const redirect = process.env.REDIRECT_TO || 'http://127.0.0.1/';
process.on('SIGTERM', () => process.exit(0));
http.createServer((req, res) => {
  console.log('REQ ' + JSON.stringify({ method: req.method, url: req.url, version: req.httpVersion, headers: req.rawHeaders }));
  const url = req.url || '';
  if (url === '/health') { res.writeHead(status, { 'content-type': 'text/plain' }); res.end('ok ' + canary + '\n'); return; }
  if (url.startsWith('/status/')) { res.writeHead(Number(url.slice(8))); res.end(canary); return; }
  if (url === '/redirect') { res.writeHead(302, { location: redirect }); res.end(); return; }
  if (url === '/hang') return;
  if (url === '/big') { res.writeHead(200); res.end(canary.repeat(20000)); return; }
  if (url === '/stream') {
    res.writeHead(200);
    const timer = setInterval(() => res.write(canary + '\n'), 50);
    res.on('close', () => clearInterval(timer));
    return;
  }
  res.writeHead(404); res.end();
}).listen(${String(SERVER_PORT)}, '0.0.0.0', () => console.log('LISTENING'));
`;

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly version: string;
  readonly headers: readonly string[];
}

function capturedRequests(logs: string): CapturedRequest[] {
  return logs
    .split('\n')
    .filter((line) => line.startsWith('REQ '))
    .map((line) => JSON.parse(line.slice(4)) as CapturedRequest);
}

function headerNames(request: CapturedRequest): string[] {
  return request.headers
    .filter((_value, index) => index % 2 === 0)
    .map((name) => name.toLowerCase());
}

// --- Stock images: what a probe can rely on (A1) ---------------------------------------------

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  'HC / ADR 0010: stock ubuntu:%s ships bash with /dev/tcp and coreutils timeout, not curl',
  (ubuntu) => {
    let container: StartedTestContainer | undefined;

    beforeAll(async () => {
      container = await new GenericContainer(`ubuntu:${ubuntu}`)
        .withName(`noodara-v03-stock-${ubuntu}-${randomUUID()}`)
        .withLabels({ 'noodara.test': 'true' })
        .withCommand(['sleep', 'infinity'])
        .start();
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      await container?.stop();
    }, STACK_TIMEOUT_MS);

    it('HC / ADR 0010 / A1: curl and wget are absent, bash 5 and timeout are present, /dev/tcp connects', async () => {
      if (container === undefined) throw new Error('stock container not started');
      const tools = await container.exec([
        'sh',
        '-c',
        'for t in curl wget nc bash timeout; do printf "%s=%s\\n" "$t" "$(command -v "$t" || echo none)"; done; ' +
          'bash -c "echo bash_version=\\$BASH_VERSION"; ' +
          'bash -c "exec 3<>/dev/tcp/127.0.0.1/1" 2>&1 | head -n 1',
      ]);
      measure('HC', ubuntu, {
        case: 'stock image tools',
        output: tools.output.trim().split('\n'),
      });
      expect(tools.output).toContain('curl=none');
      expect(tools.output).toContain('wget=none');
      expect(tools.output).toMatch(/bash=\/(usr\/)?bin\/bash/);
      expect(tools.output).toMatch(/timeout=\/(usr\/)?bin\/timeout/);
      expect(tools.output).toMatch(/bash_version=5\./);
      // /dev/tcp is compiled in: a closed port is a real connect error, not "No such file".
      expect(tools.output).toContain('connect: Connection refused');
    });
  },
);

// --- Deploy host contracts ---------------------------------------------------------------------

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('ADR 0010 contracts on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let client: Client | undefined;
  let nodeImage = '';
  const serviceId = randomUUID();
  const container = `noodara-${serviceId}`;
  const network = `noodara-net-${serviceId}`;
  const witness = `noodara-v03-witness-${randomUUID()}`;
  const bodyCanary = `NOODARA_BODY_CANARY_${randomUUID().replace(/-/g, '')}`;
  let targetIp = '';
  let witnessIp = '';

  const c = (): Client => {
    if (client === undefined) throw new Error('client not connected');
    return client;
  };

  const must = async (command: string, stdin?: string): Promise<RunResult> => {
    const result = await run(c(), command, stdin);
    if (result.exitCode !== 0) {
      throw new Error(
        `exit ${String(result.exitCode)}: ${command.slice(0, 120)}: ${result.stderr.trim()}`,
      );
    }
    return result;
  };

  const networksOf = async (name: string): Promise<Record<string, { IPAddress?: string }>> => {
    const inspected = await must(
      argv(
        'docker',
        'inspect',
        '--type',
        'container',
        '--format',
        '{{json .NetworkSettings.Networks}}',
        '--',
        name,
      ),
    );
    return JSON.parse(inspected.stdout) as Record<string, { IPAddress?: string }>;
  };

  const ipOn = async (name: string, net: string): Promise<string> =>
    (await networksOf(name))[net]?.IPAddress ?? '';

  const waitFor = async (
    probe: () => Promise<boolean>,
    label: string,
    timeoutMs = 30_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const runTarget = async (input: {
    readonly name: string;
    readonly net: string;
    readonly env: Readonly<Record<string, string>>;
    readonly publish?: number;
    readonly serviceLabel?: string;
    readonly deploymentLabel?: string;
    readonly detach?: 'run' | 'create';
  }): Promise<void> => {
    const labels = [
      ...(input.serviceLabel === undefined
        ? []
        : [
            '--label',
            'noodara.managed=true',
            '--label',
            `noodara.service_id=${input.serviceLabel}`,
          ]),
      ...(input.deploymentLabel === undefined
        ? []
        : ['--label', `noodara.deployment_id=${input.deploymentLabel}`]),
    ];
    const env = Object.entries(input.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    const publish =
      input.publish === undefined
        ? []
        : ['--publish', `${String(input.publish)}:${String(SERVER_PORT)}`];
    const mode = input.detach ?? 'run';
    await must(
      argv(
        'docker',
        ...(mode === 'run' ? ['run', '--detach'] : ['create']),
        '--pull',
        'never',
        '--name',
        input.name,
        '--network',
        input.net,
        '--restart',
        'unless-stopped',
        ...labels,
        ...env,
        ...publish,
        '--',
        nodeImage,
        'node',
        '-e',
        TARGET_SERVER_JS,
      ),
    );
  };

  const logsOf = async (name: string): Promise<string> =>
    (await must(argv('docker', 'logs', '--', name))).stdout;

  const imageAndContainerSet = async (): Promise<string> =>
    (
      await must(
        'docker image ls --all --quiet --no-trunc | sort; echo ---; docker ps --all --quiet --no-trunc | sort',
      )
    ).stdout;

  beforeAll(async () => {
    stack = await startDeployEngineStack({ ubuntu });
    client = await connect(stack);
    const node = stack.baseImages.find((ref) => ref.startsWith('node:'));
    if (node === undefined) throw new Error('no node base image preloaded');
    nodeImage = node;
    await must(
      argv('docker', 'network', 'create', '--label', 'noodara.managed=true', '--', network),
    );
    await runTarget({ name: witness, net: network, env: {} });
    witnessIp = await ipOn(witness, network);
    await runTarget({
      name: container,
      net: network,
      serviceLabel: serviceId,
      deploymentLabel: randomUUID(),
      env: {
        BODY_CANARY: bodyCanary,
        REDIRECT_TO: `http://${witnessIp}:${String(SERVER_PORT)}/hit`,
      },
    });
    targetIp = await ipOn(container, network);
    await waitFor(async () => (await logsOf(container)).includes('LISTENING'), 'target listening');
    await waitFor(async () => (await logsOf(witness)).includes('LISTENING'), 'witness listening');
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    client?.end();
    await stack?.stop();
    await assertNoStrayTestContainers();
  }, STACK_TIMEOUT_MS);

  // --- HC: probe mechanism (A1) ----------------------------------------------------------------

  it('HC / ADR 0010 / A1: the deploy host has bash 5 with /dev/tcp; curl is only there because the fixture installs it', async () => {
    const tools = await must(
      'for t in curl wget nc bash timeout; do printf "%s=%s\\n" "$t" "$(command -v "$t" || echo none)"; done; ' +
        'bash -c "echo bash_version=\\$BASH_VERSION"; curl --version 2>/dev/null | head -n 1',
    );
    measure('HC', ubuntu, {
      case: 'deploy host tools',
      output: tools.stdout.trim().split('\n'),
    });
    expect(tools.stdout).toMatch(/bash_version=5\./);
    expect(tools.stdout).toMatch(/timeout=\/(usr\/)?bin\/timeout/);
  });

  it('HC / ADR 0010 / A1: service base images have no bash, and node:22-alpine no curl, so `docker exec` probes cannot be relied on', async () => {
    const report: Record<string, string> = {};
    for (const image of stack?.baseImages ?? []) {
      const tools = await must(
        argv(
          'docker',
          'run',
          '--rm',
          '--pull',
          'never',
          '--entrypoint',
          'sh',
          '--',
          image,
          '-c',
          'for t in curl wget bash; do printf "%s=%s " "$t" "$(command -v "$t" || echo none)"; done',
        ),
      );
      report[image.split('@')[0] ?? image] = tools.stdout.trim();
      expect(tools.stdout).toContain('bash=none');
    }
    measure('HC', ubuntu, { case: 'service base image tools', report });
    expect(report['node:22-alpine']).toContain('curl=none');
  });

  it('HC / ADR 0010 / A1: the host reaches the container IP on noodara-net-<serviceId> on an unpublished port; HTTP and TCP probes pull no image and start no container', async () => {
    expect(targetIp).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    const ports = await must(argv('docker', 'port', '--', container));
    expect(ports.stdout.trim()).toBe('');
    const before = await imageAndContainerSet();

    const http = await run(c(), httpProbe(targetIp, SERVER_PORT, '/health'));
    const tcpOpen = await run(c(), tcpProbe(targetIp, SERVER_PORT));
    const tcpClosed = await run(c(), tcpProbe(targetIp, CLOSED_PORT));
    const httpClosed = await run(c(), httpProbe(targetIp, CLOSED_PORT, '/health'));
    const notFound = await run(c(), httpProbe(targetIp, SERVER_PORT, '/missing'));
    const wrong = await run(c(), httpProbe(targetIp, SERVER_PORT, '/status/500'));
    // A non-HTTP listener (the host's own sshd banner) is a malformed answer, never a pass.
    const ssh = await run(c(), httpProbe('127.0.0.1', 22, '/health'));

    expect(parseProbe(http)).toEqual({ kind: 'http', status: 200 });
    expect(parseProbe(tcpOpen)).toEqual({ kind: 'open' });
    expect(parseProbe(tcpClosed)).toEqual({ kind: 'refused' });
    expect(parseProbe(httpClosed)).toEqual({ kind: 'refused' });
    expect(parseProbe(notFound)).toEqual({ kind: 'http', status: 404 });
    expect(parseProbe(wrong)).toEqual({ kind: 'http', status: 500 });
    expect(parseProbe(ssh)).toEqual({ kind: 'malformed' });
    for (const result of [http, tcpOpen, tcpClosed, httpClosed, notFound, wrong, ssh]) {
      expect(result.stderr).toBe('');
    }
    expect(await imageAndContainerSet()).toBe(before);
    measure('HC', ubuntu, {
      case: 'probe results',
      http: http.stdout.trim(),
      tcpOpen: tcpOpen.stdout.trim(),
      tcpClosed: tcpClosed.stdout.trim(),
      ssh: ssh.stdout.trim(),
    });
  });

  it('HC / ADR 0010 / H1: probe cost per SSH exec (inspect, HTTP, TCP) over 10 runs', async () => {
    const inspectMs: number[] = [];
    const httpMs: number[] = [];
    const tcpMs: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const inspectStart = Date.now();
      await networksOf(container);
      inspectMs.push(Date.now() - inspectStart);
      const http = await run(c(), httpProbe(targetIp, SERVER_PORT, '/health'));
      expect(parseProbe(http)).toEqual({ kind: 'http', status: 200 });
      httpMs.push(http.ms);
      const tcp = await run(c(), tcpProbe(targetIp, SERVER_PORT));
      expect(parseProbe(tcp)).toEqual({ kind: 'open' });
      tcpMs.push(tcp.ms);
    }
    measure('HC', ubuntu, {
      case: 'probe cost ms (ssh round trip included)',
      inspect: { median: median(inspectMs), max: Math.max(...inspectMs) },
      http: { median: median(httpMs), max: Math.max(...httpMs) },
      tcp: { median: median(tcpMs), max: Math.max(...tcpMs) },
    });
    expect(Math.max(...httpMs, ...tcpMs, ...inspectMs)).toBeLessThan(5_000);
  });

  it('HC / ADR 0010 / H1: a hung endpoint and an unanswered connect end at the timeout cap (exit 124), never later', async () => {
    const hung = await run(c(), httpProbe(targetIp, SERVER_PORT, '/hang', 2));
    // An address on the service subnet with no container behind it (no SYN-ACK, no RST).
    const silent = targetIp.replace(/\.\d+$/, '.250');
    const unanswered = await run(c(), httpProbe(silent, SERVER_PORT, '/health', 2));
    measure('HC', ubuntu, {
      case: 'timeout cap 2 s',
      hung: { exitCode: hung.exitCode, ms: hung.ms },
      unanswered: {
        exitCode: unanswered.exitCode,
        ms: unanswered.ms,
        stdout: unanswered.stdout.trim(),
      },
    });
    expect(parseProbe(hung)).toEqual({ kind: 'timeout' });
    expect(hung.stdout).toBe('');
    expect(hung.ms).toBeGreaterThanOrEqual(1_900);
    expect(hung.ms).toBeLessThan(4_500);
    expect(['timeout', 'refused']).toContain(parseProbe(unanswered).kind);
    expect(unanswered.ms).toBeLessThan(4_500);
  });

  it('HC / ADR 0010 / H1: output is one status line; a large or never-ending body is not read and its content never appears', async () => {
    const big = await run(c(), httpProbe(targetIp, SERVER_PORT, '/big', 5));
    const stream = await run(c(), httpProbe(targetIp, SERVER_PORT, '/stream', 5));
    const health = await run(c(), httpProbe(targetIp, SERVER_PORT, '/health', 5));
    measure('HC', ubuntu, {
      case: 'output cap',
      big: { stdout: big.stdout.trim(), ms: big.ms },
      stream: { stdout: stream.stdout.trim(), ms: stream.ms },
    });
    for (const result of [big, stream, health]) {
      expect(parseProbe(result)).toEqual({ kind: 'http', status: 200 });
      expect(result.stdout.split('\n')).toHaveLength(2);
      expect(`${result.stdout}${result.stderr}`).not.toContain(bodyCanary);
    }
    // The stream is not drained until the timeout: the probe returns on the status line.
    expect(stream.ms).toBeLessThan(2_500);
  });

  it('HC / ADR 0010 / H2: a 3xx is a status result; the redirect target is never contacted', async () => {
    const result = await run(c(), httpProbe(targetIp, SERVER_PORT, '/redirect'));
    expect(parseProbe(result)).toEqual({ kind: 'http', status: 302 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const hits = capturedRequests(await logsOf(witness));
    expect(hits).toEqual([]);
  });

  it('HC / ADR 0010 / H1 / H2: the request is fixed (Host, User-Agent, Accept, Connection over HTTP/1.0); session env, BASH_ENV and proxies never reach it', async () => {
    const envCanary = `NOODARA_ENV_CANARY_${randomUUID().replace(/-/g, '')}`;
    const bashEnvFile = `/tmp/noodara-v03-bashenv-${randomUUID()}.sh`;
    const marker = `/tmp/noodara-v03-marker-${randomUUID()}`;
    await must(
      `umask 077 && printf '%s\\n' ${argv(`touch ${marker}`, `export NOODARA_FROM_BASH_ENV=${envCanary}`)} > ${q(bashEnvFile)}`,
    );
    try {
      // Control: inside an SSH session a child bash at SHLVL < 2 sees SSH_CLIENT and (Debian and
      // Ubuntu build bash with SSH_SOURCE_BASHRC) reads ~/.bashrc instead of BASH_ENV; without
      // SSH_CLIENT it runs BASH_ENV. `env -i` closes the second path, `--norc` the first.
      await must(`BASH_ENV=${q(bashEnvFile)} bash -c true`);
      const viaSsh = await run(c(), argv('test', '-e', marker));
      await must(`env -u SSH_CLIENT -u SSH2_CLIENT BASH_ENV=${q(bashEnvFile)} bash -c true`);
      const control = await run(c(), argv('test', '-e', marker));
      measure('HC', ubuntu, {
        case: 'BASH_ENV control',
        runsUnderSshClient: viaSsh.exitCode === 0,
        runsWithoutSshClient: control.exitCode === 0,
      });
      expect(control.exitCode).toBe(0);
      await must(argv('rm', '-f', marker));

      const path = '/health';
      const hostile = [
        `BASH_ENV=${q(bashEnvFile)}`,
        `NOODARA_SECRET_CANARY=${q(envCanary)}`,
        `http_proxy=${q(`http://${witnessIp}:${String(SERVER_PORT)}`)}`,
        `HTTP_PROXY=${q(`http://${witnessIp}:${String(SERVER_PORT)}`)}`,
        `no_proxy=''`,
      ].join(' ');
      const result = await run(c(), `${hostile} ${httpProbe(targetIp, SERVER_PORT, path)}`);
      expect(parseProbe(result)).toEqual({ kind: 'http', status: 200 });
      expect((await run(c(), argv('test', '-e', marker))).exitCode).not.toBe(0);

      const requests = capturedRequests(await logsOf(container));
      const last = requests.at(-1);
      if (last === undefined) throw new Error('no request captured');
      measure('HC', ubuntu, { case: 'captured request', request: last });
      expect(last.method).toBe('GET');
      expect(last.url).toBe(path);
      expect(last.version).toBe('1.0');
      expect(headerNames(last)).toEqual(['host', 'user-agent', 'accept', 'connection']);
      expect(last.headers).toEqual([
        'Host',
        `${targetIp}:${String(SERVER_PORT)}`,
        'User-Agent',
        'noodara-healthcheck/1',
        'Accept',
        '*/*',
        'Connection',
        'close',
      ]);
      expect(JSON.stringify(requests)).not.toContain(envCanary);
      // The proxy in the session env was not used: the witness saw nothing.
      expect(capturedRequests(await logsOf(witness))).toEqual([]);
    } finally {
      await run(c(), argv('rm', '-f', bashEnvFile, marker));
    }
  });

  it('HC / ADR 0010 / A1: a stopped container has no IP on its network (the probe sees "exited", not a stale address)', async () => {
    const other = `noodara-v03-stopped-${randomUUID()}`;
    await runTarget({ name: other, net: network, env: {} });
    try {
      expect(await ipOn(other, network)).toMatch(/^\d/);
      await must(argv('docker', 'stop', '--timeout', '5', '--', other));
      const state = await must(
        argv(
          'docker',
          'inspect',
          '--type',
          'container',
          '--format',
          '{{.State.Status}}',
          '--',
          other,
        ),
      );
      expect(state.stdout.trim()).toBe('exited');
      expect(await ipOn(other, network)).toBe('');
    } finally {
      await run(c(), argv('docker', 'rm', '--force', '--', other));
    }
  });

  it('HC / ADR 0010 / rejected: curl diverges on the deploy host (drains a streaming body to the timeout; ~/.curlrc can make it follow redirects)', async () => {
    const hasCurl = await run(c(), 'command -v curl');
    if (hasCurl.exitCode !== 0) {
      measure('HC', ubuntu, { case: 'curl rejected', curl: 'absent' });
      return;
    }
    const stream = await run(
      c(),
      argv(
        'curl',
        '-q',
        '--silent',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        '--max-time',
        '2',
        '--',
        `http://${targetIp}:${String(SERVER_PORT)}/stream`,
      ),
    );
    expect(stream.exitCode).toBe(28);
    const curlrc = '.curlrc';
    await must(`umask 077 && cat > ${curlrc}`, 'location\n');
    try {
      const followed = await run(
        c(),
        argv(
          'curl',
          '--silent',
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          '--max-time',
          '5',
          '--',
          `http://${targetIp}:${String(SERVER_PORT)}/redirect`,
        ),
      );
      expect(followed.stdout).toBe('404');
      const hits = capturedRequests(await logsOf(witness)).filter((r) => r.url === '/hit');
      expect(hits.length).toBeGreaterThan(0);
      measure('HC', ubuntu, {
        case: 'curl rejected',
        stream: { exitCode: stream.exitCode, ms: stream.ms },
        curlrcLocation: {
          finalStatus: followed.stdout,
          witnessHits: hits.length,
        },
      });
    } finally {
      await run(c(), argv('rm', '-f', curlrc));
    }
  });

  // --- PREV: previous-container preservation (A2) -----------------------------------------------

  interface PrevScenario {
    readonly svc: string;
    readonly name: string;
    readonly prev: string;
    readonly net: string;
    readonly deploymentA: string;
    readonly stopMs: number;
    readonly renameMs: number;
    readonly createAndStartMs: number;
    readonly swapToFirstAnswerMs: number;
  }

  const healthOnPort = async (): Promise<ProbeResult> =>
    parseProbe(await run(c(), httpProbe('127.0.0.1', PUBLISHED_PORT, '/health', 2)));

  const listeners = async (): Promise<number> =>
    (await must(argv('ss', '-Hltn', `sport = :${String(PUBLISHED_PORT)}`))).stdout
      .trim()
      .split('\n')
      .filter(Boolean).length;

  const networkNames = async (name: string): Promise<string[]> =>
    Object.keys(await networksOf(name)).sort();

  /** Version A (201) on the published port, then the v0.3 swap: stop, rename -prev, B (202). */
  const swapToB = async (svc: string): Promise<PrevScenario> => {
    const name = `noodara-${svc}`;
    const prev = `${name}-prev`;
    const net = `noodara-net-${svc}`;
    const deploymentA = randomUUID();
    await must(argv('docker', 'network', 'create', '--label', 'noodara.managed=true', '--', net));
    await runTarget({
      name,
      net,
      publish: PUBLISHED_PORT,
      serviceLabel: svc,
      deploymentLabel: deploymentA,
      env: { HEALTH_STATUS: '201' },
    });
    await waitFor(async () => (await healthOnPort()).kind === 'http', 'version A answering');
    expect(await healthOnPort()).toEqual({ kind: 'http', status: 201 });

    const swapStart = Date.now();
    const stop = await must(argv('docker', 'stop', '--timeout', '10', '--', name));
    const rename = await must(argv('docker', 'rename', '--', name, prev));
    const createB = Date.now();
    await runTarget({
      name,
      net,
      publish: PUBLISHED_PORT,
      serviceLabel: svc,
      deploymentLabel: randomUUID(),
      env: { HEALTH_STATUS: '202' },
    });
    const createAndStartMs = Date.now() - createB;
    await waitFor(async () => (await healthOnPort()).kind === 'http', 'version B answering');
    const swapToFirstAnswerMs = Date.now() - swapStart;
    expect(await healthOnPort()).toEqual({ kind: 'http', status: 202 });
    return {
      svc,
      name,
      prev,
      net,
      deploymentA,
      stopMs: stop.ms,
      renameMs: rename.ms,
      createAndStartMs,
      swapToFirstAnswerMs,
    };
  };

  const cleanupScenario = async (svc: string): Promise<void> => {
    const name = `noodara-${svc}`;
    await run(c(), argv('docker', 'rm', '--force', '--', name, `${name}-prev`));
    await run(c(), argv('docker', 'network', 'rm', '--', `noodara-net-${svc}`));
  };

  it('PREV / ADR 0010 / A2: a stopped container renamed to -prev frees the name and its published port; the new one binds it; restoring -prev brings the port back', async () => {
    const svc = randomUUID();
    const name = `noodara-${svc}`;
    const prev = `${name}-prev`;
    const net = `noodara-net-${svc}`;
    const deploymentA = randomUUID();
    await must(argv('docker', 'network', 'create', '--label', 'noodara.managed=true', '--', net));
    try {
      await runTarget({
        name,
        net,
        publish: PUBLISHED_PORT,
        serviceLabel: svc,
        deploymentLabel: deploymentA,
        env: { HEALTH_STATUS: '201' },
      });
      await waitFor(async () => (await healthOnPort()).kind === 'http', 'version A answering');

      // Stop + rename: the name and the host port are free, -prev keeps labels and policy.
      const swapStart = Date.now();
      const stop = await must(argv('docker', 'stop', '--timeout', '10', '--', name));
      const rename = await must(argv('docker', 'rename', '--', name, prev));
      expect(
        (await run(c(), argv('docker', 'inspect', '--type', 'container', '--', name))).exitCode,
      ).not.toBe(0);
      expect(await listeners()).toBe(0);
      expect(await healthOnPort()).toEqual({ kind: 'refused' });
      const prevInfo = JSON.parse(
        (
          await must(
            argv(
              'docker',
              'inspect',
              '--type',
              'container',
              '--format',
              '{"status":{{json .State.Status}},"labels":{{json .Config.Labels}},"bindings":{{json .HostConfig.PortBindings}},"ports":{{json .NetworkSettings.Ports}},"restart":{{json .HostConfig.RestartPolicy.Name}}}',
              '--',
              prev,
            ),
          )
        ).stdout,
      ) as {
        status: string;
        labels: Record<string, string>;
        bindings: Record<string, unknown>;
        ports: Record<string, unknown> | null;
        restart: string;
      };
      expect(prevInfo.status).toBe('exited');
      expect(prevInfo.labels['noodara.deployment_id']).toBe(deploymentA);
      expect(prevInfo.labels['noodara.service_id']).toBe(svc);
      expect(prevInfo.restart).toBe('unless-stopped');
      expect(Object.keys(prevInfo.bindings)).toEqual([`${String(SERVER_PORT)}/tcp`]);
      expect(Object.keys(prevInfo.ports ?? {})).toEqual([]);
      // -prev keeps the managed labels: label filters (reconcile, cleanup) list it.
      const managed = await must(
        argv(
          'docker',
          'ps',
          '--all',
          '--filter',
          `label=noodara.service_id=${svc}`,
          '--format',
          '{{.Names}}',
        ),
      );
      expect(managed.stdout.trim().split('\n').sort()).toEqual([prev]);

      // The new container takes the name and the port.
      const createB = Date.now();
      await runTarget({
        name,
        net,
        publish: PUBLISHED_PORT,
        serviceLabel: svc,
        deploymentLabel: randomUUID(),
        env: { HEALTH_STATUS: '202' },
      });
      const createAndStartMs = Date.now() - createB;
      await waitFor(async () => (await healthOnPort()).kind === 'http', 'version B answering');
      const swapMs = Date.now() - swapStart;
      expect(await healthOnPort()).toEqual({ kind: 'http', status: 202 });
      // A rename never overwrites: onto an existing name it is a Conflict.
      const conflict = await run(c(), argv('docker', 'rename', '--', prev, name));
      expect(conflict.exitCode).not.toBe(0);
      expect(conflict.stderr).toMatch(/Conflict/);

      // Roll back: remove the new container first, rename -prev back, start it.
      const restoreStart = Date.now();
      await must(argv('docker', 'rm', '--force', '--', name));
      await must(argv('docker', 'rename', '--', prev, name));
      await must(argv('docker', 'start', '--', name));
      await waitFor(async () => (await healthOnPort()).kind === 'http', 'version A restored');
      const restoreMs = Date.now() - restoreStart;
      expect(await healthOnPort()).toEqual({ kind: 'http', status: 201 });
      expect(await listeners()).toBeGreaterThan(0);
      expect(await networkNames(name)).toEqual([net]);
      const restored = await must(argv('docker', 'port', '--', name));
      expect(restored.stdout).toContain(`:${String(PUBLISHED_PORT)}`);
      const labels = await must(
        argv(
          'docker',
          'inspect',
          '--type',
          'container',
          '--format',
          '{{index .Config.Labels "noodara.deployment_id"}}',
          '--',
          name,
        ),
      );
      expect(labels.stdout.trim()).toBe(deploymentA);

      measure('PREV', ubuntu, {
        case: 'swap and restore',
        stopMs: stop.ms,
        renameMs: rename.ms,
        createAndStartMs,
        swapToFirstAnswerMs: swapMs,
        restoreToFirstAnswerMs: restoreMs,
        renameConflict: conflict.stderr.trim().split('\n')[0],
      });
    } finally {
      await cleanupScenario(svc);
    }
  });

  it('PREV / ADR 0010 / A2: starting -prev while the new container holds the port fails AND detaches -prev from its network; it comes back only after `docker network connect`', async () => {
    const svc = randomUUID();
    try {
      const scenario = await swapToB(svc);
      const { name, prev, net } = scenario;
      const blocked = await run(c(), argv('docker', 'start', '--', prev));
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stderr).toMatch(/port is already allocated|address already in use/);
      expect(await healthOnPort()).toEqual({ kind: 'http', status: 202 });
      // The failed start leaves -prev with no network endpoint at all.
      expect(await networkNames(prev)).toEqual([]);

      // A plain restore now "succeeds" but runs the container with no network and no port.
      await must(argv('docker', 'rm', '--force', '--', name));
      await must(argv('docker', 'rename', '--', prev, name));
      await must(argv('docker', 'start', '--', name));
      const state = await must(
        argv(
          'docker',
          'inspect',
          '--type',
          'container',
          '--format',
          '{{.State.Status}}',
          '--',
          name,
        ),
      );
      expect(state.stdout.trim()).toBe('running');
      expect(await networkNames(name)).toEqual([]);
      expect((await must(argv('docker', 'port', '--', name))).stdout.trim()).toBe('');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await healthOnPort()).toEqual({ kind: 'refused' });

      // Repair: stop, reconnect to noodara-net-<serviceId>, start: version A on the port again.
      await must(argv('docker', 'stop', '--timeout', '10', '--', name));
      await must(argv('docker', 'network', 'connect', '--', net, name));
      await must(argv('docker', 'start', '--', name));
      await waitFor(async () => (await healthOnPort()).kind === 'http', 'version A repaired');
      expect(await healthOnPort()).toEqual({ kind: 'http', status: 201 });
      expect(await networkNames(name)).toEqual([net]);

      measure('PREV', ubuntu, {
        case: 'failed start detaches network',
        blockedStart: blocked.stderr.trim().split('\n')[0],
        swapToFirstAnswerMs: scenario.swapToFirstAnswerMs,
      });
    } finally {
      await cleanupScenario(svc);
    }
  });

  // --- RETRY: what collides when a step is re-run after a crash (A3 evidence) -----------------------

  it('RETRY / ADR 0010 / A3: clone into an existing workspace fails, a same-tag rebuild yields a new image id and drops the first one, create on an existing name is a Conflict, start on a running container exits 0', async () => {
    const svc = randomUUID();
    const deployment = randomUUID();
    const ws = `.noodara/deploy/${deployment}`;
    const src = `/tmp/noodara-v03-src-${randomUUID()}`;
    const image = `noodara/${svc}:${deployment}`;
    const name = `noodara-${svc}`;
    const net = `noodara-net-${svc}`;
    let firstId = '';
    try {
      await must(
        `git init -q ${q(src)} && printf 'FROM %s\\nCMD ["node","-e","setInterval(()=>{},1000)"]\\n' ${q(nodeImage)} > ${q(`${src}/Dockerfile`)} && ` +
          `git -C ${q(src)} add Dockerfile && git -C ${q(src)} -c user.name=t -c user.email=t@noodara.invalid -c commit.gpgsign=false commit -q -m seed`,
      );
      await must(`umask 077 && mkdir -p ${q(`${ws}/secrets`)} ${q(`${ws}/run`)}`);
      const clone = argv('git', 'clone', '-q', '--depth', '1', '--', `file://${src}`, `${ws}/repo`);
      await must(clone);
      const again = await run(c(), clone);
      expect(again.exitCode).toBe(128);
      expect(again.stderr).toMatch(/already exists and is not an empty directory/);

      const build = argv('docker', 'build', '--quiet', '--tag', image, '--', `${ws}/repo`);
      const first = await must(build);
      const idOf = async (): Promise<string> =>
        (
          await must(argv('docker', 'image', 'inspect', '--format', '{{.Id}}', '--', image))
        ).stdout.trim();
      firstId = await idOf();
      const dangling = async (): Promise<string[]> =>
        (await must('docker image ls --filter dangling=true --quiet --no-trunc')).stdout
          .trim()
          .split('\n')
          .filter(Boolean);
      expect(await dangling()).not.toContain(firstId);
      // Docker 29 (containerd image store, BuildKit attestations): a fully cached rebuild is a new
      // image id under the same tag, and the first id is dropped, not left dangling. Re-running the
      // build is leak-free but not idempotent: never key anything on the image id of an attempt.
      const second = await must(build);
      const secondId = await idOf();
      expect(secondId).not.toBe(firstId);
      expect(await dangling()).not.toContain(firstId);
      const gone = await run(c(), argv('docker', 'image', 'inspect', '--', firstId));
      expect(gone.exitCode).not.toBe(0);
      const storage = (await must("docker info --format '{{json .DriverStatus}}'")).stdout.trim();

      await must(argv('docker', 'network', 'create', '--label', 'noodara.managed=true', '--', net));
      const create = argv(
        'docker',
        'create',
        '--name',
        name,
        '--network',
        net,
        '--label',
        'noodara.managed=true',
        '--label',
        `noodara.service_id=${svc}`,
        '--label',
        `noodara.deployment_id=${deployment}`,
        '--',
        image,
      );
      await must(create);
      const createAgain = await run(c(), create);
      expect(createAgain.exitCode).toBe(1);
      expect(createAgain.stderr).toMatch(
        /Conflict\. The container name "\/noodara-[0-9a-f-]+" is already in use/,
      );
      await must(argv('docker', 'start', '--', name));
      const startAgain = await run(c(), argv('docker', 'start', '--', name));
      expect(startAgain.exitCode).toBe(0);
      // The existing container carries the attempt's deployment id: it is identifiable as "ours".
      const owner = await must(
        argv(
          'docker',
          'inspect',
          '--type',
          'container',
          '--format',
          '{{index .Config.Labels "noodara.deployment_id"}}',
          '--',
          name,
        ),
      );
      expect(owner.stdout.trim()).toBe(deployment);

      measure('RETRY', ubuntu, {
        cloneAgain: {
          exitCode: again.exitCode,
          stderr: again.stderr.trim().split('\n')[0],
        },
        build: {
          firstMs: first.ms,
          sameTagAgainMs: second.ms,
          newIdOnRebuild: secondId !== firstId,
          firstIdDropped: true,
          storage,
        },
        createAgain: {
          exitCode: createAgain.exitCode,
          stderr: createAgain.stderr.trim().split('\n')[0],
        },
        startAgain: startAgain.exitCode,
      });
    } finally {
      await run(c(), argv('docker', 'rm', '--force', '--', name));
      await run(c(), argv('docker', 'network', 'rm', '--', net));
      await run(c(), argv('docker', 'image', 'rm', '--force', '--', image));
      if (firstId !== '') await run(c(), argv('docker', 'image', 'rm', '--force', '--', firstId));
      await run(c(), argv('rm', '-rf', ws, src));
    }
  });
});
