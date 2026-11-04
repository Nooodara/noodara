// 27-01 observability templates (ADR 0012) on the real sshd + dockerd fixture, Ubuntu 22.04 and
// 24.04. Every step under test is the rendered allowlisted template; raw ssh2 commands only set up
// the fixture containers. A2: each template returns parseable output for a running, a stopped, a
// restarting and an OOM-killed container, and no output ever carries the canary env value.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseContainerSample,
  parseHostSample,
  type ContainerSample,
  type ResourceId,
} from '@noodara/domain';
import { Client } from '@noodara/ssh/testing';
import type { ClientChannel } from '@noodara/ssh/testing';
import { renderRemoteCommand, type RemoteCommand } from '@noodara/ssh/testing/deploy-templates';
import {
  OBSERVABILITY_LIMITS,
  dockerInspectStateSample,
  dockerLogsWindow,
  dockerStatsSample,
  metricsHostSample,
  parseLogsWindow,
  type LogsWindow,
} from '../../../packages/ssh/src/commands/metrics.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const SHELL_TIMEOUT_SECONDS = 180;
const SSH_COMMAND_TIMEOUT_MS = (SHELL_TIMEOUT_SECONDS + 30) * 1_000;
const LOG_OPTS = '--log-opt max-size=10m --log-opt max-file=3';
const EPOCH = '2000-01-01T00:00:00Z';

type Case = 'running' | 'stopped' | 'restarting' | 'oom';
const CASES: readonly Case[] = ['running', 'stopped', 'restarting', 'oom'];

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
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

function runLine(client: Client, commandLine: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    client.exec(commandLine, (err: Error | undefined, channel: ClientChannel) => {
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
        resolve({ exitCode, stdout, stderr });
      });
      channel.end();
    });
  });
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fixtureScript(fixture: string): { dockerfile: string; script: string; name: string } {
  const dir = path.join(FIXTURES, fixture);
  const [name = ''] = readdirSync(dir).filter((file) => file.endsWith('.sh'));
  return {
    dockerfile: readFileSync(path.join(dir, 'Dockerfile'), 'utf8'),
    script: readFileSync(path.join(dir, name), 'utf8'),
    name,
  };
}

function samples(stdout: string): ContainerSample[] {
  const parsed = parseContainerSample(stdout);
  if (!parsed.ok) throw new Error(`unparseable container sample: ${parsed.code} ${parsed.message}`);
  return [...parsed.value];
}

function windowLines(window: LogsWindow): string[] {
  if (window.kind !== 'ok') throw new Error(`expected a log window, got ${window.kind}`);
  return window.lines.map((line) => line.text);
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('27-01 metrics templates on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let client: Client | undefined;
  const canary = `NOODARA_CANARY_${randomUUID()}`;
  const ids = Object.fromEntries(CASES.map((name) => [name, randomUUID() as ResourceId])) as Record<
    Case,
    ResourceId
  >;
  const container = (name: Case): string => `noodara-${ids[name]}`;
  /** Every byte any template under test returned, for the canary check. */
  const transcript: string[] = [];

  const c = (): Client => {
    if (client === undefined) throw new Error('client not connected');
    return client;
  };
  const run = async (command: RemoteCommand): Promise<RunResult> => {
    const result = await runLine(c(), renderRemoteCommand(command));
    transcript.push(result.stdout, result.stderr);
    return result;
  };
  const mustRun = async (command: RemoteCommand): Promise<string> => {
    const result = await run(command);
    expect(result.exitCode, `${command.name}: ${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
    return result.stdout;
  };
  /** Fixture setup only; never a template under test. */
  const shell = async (script: string, args: readonly string[] = []): Promise<string> => {
    const line = [
      'timeout',
      String(SHELL_TIMEOUT_SECONDS),
      'bash',
      '--noprofile',
      '--norc',
      '-c',
      script,
      'noodara-test',
      ...args,
    ]
      .map(q)
      .join(' ');
    const result = await runLine(c(), line);
    if (result.exitCode !== 0) {
      throw new Error(`exit ${String(result.exitCode)}: ${script.slice(0, 80)}: ${result.stderr}${result.stdout}`);
    }
    return result.stdout;
  };
  const build = async (fixture: string): Promise<string> => {
    const { dockerfile, script, name } = fixtureScript(fixture);
    const tag = `noodara-test/${fixture}:${randomUUID().slice(0, 12)}`;
    await shell(
      `d=$(mktemp -d); printf '%s' "$1" > "$d/Dockerfile"; printf '%s' "$2" > "$d/$3"
docker build --quiet --tag "$4" "$d" >/dev/null; rc=$?; rm -rf -- "$d"; exit $rc`,
      [dockerfile, script, name, tag],
    );
    return tag;
  };
  const runManaged = (name: Case, flags: string, image: string, cmd: readonly string[] = []) =>
    shell(
      `docker run --detach --pull never --name "$1" --label noodara.managed=true --label "noodara.service_id=$2" --env "SVC_SECRET=$3" ${LOG_OPTS} ${flags} -- "$4" "\${@:5}" >/dev/null`,
      [container(name), ids[name], canary, image, ...cmd],
    );
  const waitFor = (name: Case, condition: string) =>
    shell(
      `t=$(date +%s); until [ "$(docker inspect --format "$2" -- "$1")" ${condition} ]; do
  [ $(( $(date +%s) - t )) -gt 60 ] && exit 1; sleep 0.2; done`,
      [container(name), name === 'restarting' ? '{{.RestartCount}}' : '{{.State.Status}}'],
    );
  const logs = async (name: Case, tail = 100, until?: string): Promise<LogsWindow> => {
    const command = dockerLogsWindow({
      serviceId: ids[name],
      since: EPOCH,
      tail,
      ...(until === undefined ? {} : { until }),
    });
    const result = await run(command);
    expect([0, 141]).toContain(result.exitCode);
    return parseLogsWindow(result.stdout, {
      exitCode: result.exitCode,
      ...(until === undefined ? {} : { until }),
    });
  };

  beforeAll(async () => {
    stack = await startDeployEngineStack({ ubuntu });
    client = await connect(stack);
    const nodeImage = stack.baseImages.find((ref) => ref.startsWith('node:'));
    if (nodeImage === undefined) throw new Error('no node base image preloaded');
    const oomImage = await build('oom-allocator');
    const crashImage = await build('crash-loop');

    await runManaged('running', '--memory 64m', nodeImage, [
      'sh',
      '-c',
      'echo NOODARA_RUNNING_OUT; echo NOODARA_RUNNING_ERR >&2; exec sleep 3600',
    ]);
    await runManaged('stopped', '', nodeImage, ['sh', '-c', 'echo NOODARA_STOPPED_OUT; exec sleep 3600']);
    await shell('docker stop --time 1 -- "$1" >/dev/null', [container('stopped')]);
    await runManaged('restarting', '--restart on-failure', crashImage);
    await runManaged('oom', '--memory 32m --memory-swap 32m', oomImage);
    await waitFor('running', '= running');
    await waitFor('stopped', '= exited');
    await waitFor('restarting', '-ge 1');
    await waitFor('oom', '= exited');
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    if (client !== undefined) {
      await shell(
        'ids=$(docker ps -a -q --filter label=noodara.managed=true); [ -z "$ids" ] || docker rm -f $ids >/dev/null; true',
      ).catch(() => undefined);
    }
    client?.end();
    await stack?.stop();
    await assertNoStrayTestContainers();
  }, STACK_TIMEOUT_MS);

  it('A2: metrics.host_sample returns a parseable host sample within its bounds', async () => {
    const stdout = await mustRun(metricsHostSample({ deltaSeconds: 1 }));
    const sample = parseHostSample(stdout);

    expect(sample.ok, sample.ok ? '' : sample.message).toBe(true);
    expect(Buffer.byteLength(stdout)).toBeLessThan(OBSERVABILITY_LIMITS.hostSample.capBytes);
  });

  it('A2: docker.stats reads running, stopped, restarting and OOM-killed containers; stats only for running ones', async () => {
    const stdout = await mustRun(dockerStatsSample());
    const byName = new Map(samples(stdout).map((sample) => [sample.name, sample]));

    const running = byName.get(container('running'));
    expect(running).toMatchObject({ status: 'running', running: true, oomKilled: false });
    expect(running?.memoryLimitBytes).toBe(64 * 1024 * 1024);
    expect(running?.stats?.memoryBytes).toBeGreaterThan(0);

    expect(byName.get(container('stopped'))).toMatchObject({ status: 'exited', running: false, stats: null });
    expect(byName.get(container('restarting'))?.restartCount).toBeGreaterThanOrEqual(1);
    expect(byName.get(container('restarting'))?.oomKilled).toBe(false);
    expect(byName.get(container('oom'))).toMatchObject({
      status: 'exited',
      running: false,
      oomKilled: true,
      exitCode: 137,
      memoryLimitBytes: 32 * 1024 * 1024,
      stats: null,
    });
    expect(stdout).not.toContain(canary);
  });

  it('A2: a service filter narrows docker.stats and docker.inspect_state to that service', async () => {
    for (const name of CASES) {
      const stats = samples(await mustRun(dockerStatsSample({ serviceId: ids[name] })));
      const inspect = samples(await mustRun(dockerInspectStateSample({ serviceId: ids[name] })));
      expect(stats.map((sample) => sample.name)).toEqual([container(name)]);
      expect(inspect.map((sample) => sample.name)).toEqual([container(name)]);
    }
  });

  it('A2: docker.inspect_state reads every state without stats and without env values', async () => {
    const stdout = await mustRun(dockerInspectStateSample());
    const byName = new Map(samples(stdout).map((sample) => [sample.name, sample]));

    expect(stdout.split('\n').some((line) => line.startsWith('S '))).toBe(false);
    for (const name of CASES) expect(byName.get(container(name))?.stats ?? null).toBeNull();
    expect(byName.get(container('running'))?.running).toBe(true);
    expect(byName.get(container('stopped'))?.status).toBe('exited');
    expect(byName.get(container('oom'))).toMatchObject({ oomKilled: true, exitCode: 137 });
    expect(stdout).not.toContain(canary);
    expect(stdout).not.toContain('SVC_SECRET');
  });

  it('A2: docker.logs_window reads both streams of every container, ordered by timestamp', async () => {
    const running = await logs('running');
    expect(running).toMatchObject({ kind: 'ok', capped: false, dropped: 0 });
    if (running.kind === 'ok') {
      expect(running.lines.map((line) => [line.stream, line.text])).toEqual(
        expect.arrayContaining([
          ['stdout', 'NOODARA_RUNNING_OUT'],
          ['stderr', 'NOODARA_RUNNING_ERR'],
        ]),
      );
      for (const line of running.lines) expect(line.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
    expect(windowLines(await logs('stopped'))).toContain('NOODARA_STOPPED_OUT');
    expect(windowLines(await logs('restarting'))).toContain('NOODARA_CRASH_LOOP');
    expect(windowLines(await logs('oom'))).toContain('NOODARA_OOM_ALLOCATING');
  });

  it('A2: tail bounds the window, until filters it, and a missing container is reported as missing', async () => {
    const all = await logs('restarting', 100);
    if (all.kind !== 'ok') throw new Error('expected a log window');
    expect(all.lines.length).toBeGreaterThanOrEqual(2);
    const last = await logs('restarting', 1);
    expect(windowLines(last)).toHaveLength(1);

    const first = all.lines[0];
    if (first === undefined) throw new Error('expected a first line');
    const untilFirst = await logs('restarting', 100, first.timestamp);
    if (untilFirst.kind !== 'ok') throw new Error('expected a log window');
    expect(untilFirst.lines.length).toBeGreaterThanOrEqual(1);
    expect(untilFirst.lines.length).toBeLessThan(all.lines.length);

    const result = await run(dockerLogsWindow({ serviceId: randomUUID() as ResourceId, since: EPOCH, tail: 10 }));
    expect(result.exitCode).toBe(0);
    expect(parseLogsWindow(result.stdout, { exitCode: result.exitCode })).toEqual({ kind: 'missing' });
  });

  it('A2: no template output ever carried the canary env value', () => {
    expect(transcript.length).toBeGreaterThan(0);
    for (const output of transcript) expect(output).not.toContain(canary);
  });
});
