// G3/G4 empirical contracts (11-07-PLAN.md, QA-10, D-02, D-03). Permanent: every assertion is what
// was measured against the real sshd + dockerd fixture (11-03) on Ubuntu 22.04 and 24.04, and fails
// if a new Docker, buildx or Ubuntu changes it. Raw ssh2 via `@noodara/ssh/testing`, as deployer,
// never the adapter and never a mock. Remote commands are constant strings; the only variable parts
// (fresh-UUID paths and names) travel as single-quoted arguments.
//
// NOODARA_CAPTURE_FIXTURES=1 rewrites the captures under packages/domain/src/{discovery,deployment}/
// fixtures/ubuntu-<version>/; normal mode asserts the live output still has the captured shape.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
const DISCOVERY_FIXTURES = path.join(REPO_ROOT, 'packages/domain/src/discovery/fixtures');
const CAPTURE_FIXTURES = process.env['NOODARA_CAPTURE_FIXTURES'] === '1';
const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 180_000;

// --- Raw ssh2 plumbing ------------------------------------------------------------------------

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

function run(client: Client, command: string, stdin?: string): Promise<RunResult> {
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
        resolve({ exitCode, stdout, stderr });
      });
      if (stdin !== undefined) channel.write(stdin);
      channel.end();
    });
  });
}

/** POSIX single-quote for the few UUID paths/names passed to the remote shell. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function measure(tag: 'G3' | 'G4', ubuntu: string, data: Record<string, unknown>): void {
  const line = `[${tag}] ${JSON.stringify({ ubuntu, ...data })}`;
  console.log(line);
  // Vitest hides console output of passing tests; this is how the SUMMARY numbers are collected.
  const file = process.env['NOODARA_MEASUREMENTS_FILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

// --- G3 -----------------------------------------------------------------------------------------

/**
 * The discovery command chosen by this spike (packages/domain/src/discovery/fixtures/README.md,
 * `docker_buildkit`). `docker build` is dispatched by the CLI to `buildx build` only when BuildKit
 * is the effective builder, and `--help` goes through that same dispatch, so the Usage line
 * reports the builder a real `docker build` would use, without building anything.
 */
const BUILDKIT_CHECK = 'docker build --help';
const BUILDKIT_ACTIVE_USAGE = /^Usage:\s+docker buildx build /;
const BUILDKIT_LEGACY_USAGE = /^Usage:\s+docker build /;

/** Every candidate measured in every state; only BUILDKIT_CHECK is captured as a fixture. */
const BUILDKIT_CANDIDATES = {
  buildx_version: 'docker buildx version',
  info_plugins: "docker info --format '{{json .ClientInfo.Plugins}}'",
  buildx_inspect: 'docker buildx inspect',
  build_help: BUILDKIT_CHECK,
} as const;
type Candidate = keyof typeof BUILDKIT_CANDIDATES;

/** How the three measured states differ; the env state is a deployer session env, never a template. */
type BuildKitState = 'active' | 'legacy_env' | 'plugin_missing';
const STATE_PREFIX: Record<BuildKitState, string> = {
  active: '',
  legacy_env: 'DOCKER_BUILDKIT=0 ',
  plugin_missing: '',
};
const FIXTURE_SUFFIX: Record<BuildKitState, string> = {
  active: '',
  legacy_env: '.legacy_env',
  plugin_missing: '.plugin_missing',
};

const WRITE_DOCKERFILE = `sh -c 'mkdir -p "$0" && cat > "$0/Dockerfile"'`;
const BUILDKIT_PROGRESS = /#1 \[internal\] load build definition from Dockerfile/;
const LEGACY_PROGRESS = /Step 1\/2 : FROM /;

interface BuildKitMeta {
  readonly command: string;
  readonly sessionEnv: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly dockerVersion: string;
  readonly buildxVersion: string;
  readonly capturedAt: string;
}

function buildKitFixture(ubuntu: string, state: BuildKitState): { txt: string; meta: string } {
  const base = path.join(
    DISCOVERY_FIXTURES,
    `ubuntu-${ubuntu}`,
    `docker_buildkit${FIXTURE_SUFFIX[state]}`,
  );
  return { txt: `${base}.txt`, meta: `${base}.meta.json` };
}

describe('G3 / ADR 0008 / D-03: install.sh never forces the builder', () => {
  it('G3 / ADR 0008 / D-03: install.sh does not mention DOCKER_BUILDKIT and installs docker-buildx-plugin', () => {
    const installer = readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');

    expect(installer).not.toContain('DOCKER_BUILDKIT');
    expect(installer).toMatch(/docker-ce-cli containerd\.io docker-buildx-plugin/);
  });
});

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  'G3 / ADR 0008 / D-03: BuildKit is the default builder and is detectable on Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let client: Client | undefined;
    let dockerVersion = '';
    const buildDir = `/tmp/noodara-g3-${randomUUID()}`;

    const c = (): Client => {
      if (client === undefined) throw new Error('client not connected');
      return client;
    };

    const plainBuild = (state: BuildKitState): Promise<RunResult> =>
      run(c(), `cd ${q(buildDir)} && ${STATE_PREFIX[state]}docker build .`);

    const candidates = async (state: BuildKitState): Promise<Record<Candidate, RunResult>> => {
      const out: Partial<Record<Candidate, RunResult>> = {};
      for (const [name, command] of Object.entries(BUILDKIT_CANDIDATES) as [Candidate, string][]) {
        out[name] = await run(c(), `${STATE_PREFIX[state]}${command}`);
      }
      return out as Record<Candidate, RunResult>;
    };

    const recordCandidates = (
      state: BuildKitState,
      results: Record<Candidate, RunResult>,
    ): void => {
      measure('G3', ubuntu, {
        state,
        candidates: Object.fromEntries(
          Object.entries(results).map(([name, r]) => [
            name,
            {
              exitCode: r.exitCode,
              stdoutFirstLine: firstLine(r.stdout),
              stderrFirstLine: firstLine(r.stderr),
            },
          ]),
        ),
      });
    };

    /** Capture mode writes the chosen command's output; normal mode asserts the captured shape. */
    const checkCapture = async (state: BuildKitState, usage: RegExp): Promise<void> => {
      const live = await run(c(), `${STATE_PREFIX[state]}${BUILDKIT_CHECK}`);
      const fixture = buildKitFixture(ubuntu, state);
      if (CAPTURE_FIXTURES) {
        const buildx = await run(c(), 'docker buildx version');
        const meta: BuildKitMeta = {
          command: BUILDKIT_CHECK,
          sessionEnv: STATE_PREFIX[state].trim(),
          exitCode: live.exitCode,
          stderr: live.stderr,
          dockerVersion,
          buildxVersion: buildx.exitCode === 0 ? buildx.stdout.trim() : '(not installed)',
          capturedAt: new Date().toISOString().slice(0, 10),
        };
        mkdirSync(path.dirname(fixture.txt), { recursive: true });
        writeFileSync(fixture.txt, live.stdout);
        writeFileSync(fixture.meta, `${JSON.stringify(meta, null, 2)}\n`);
      }
      const captured = readFileSync(fixture.txt, 'utf8');
      const meta = JSON.parse(readFileSync(fixture.meta, 'utf8')) as BuildKitMeta;

      expect(meta.command).toBe(BUILDKIT_CHECK);
      expect(firstLine(captured)).toMatch(usage);
      expect(firstLine(live.stdout)).toBe(firstLine(captured));
      expect(live.exitCode).toBe(meta.exitCode);
      expect(live.stderr).toBe(meta.stderr);
    };

    beforeAll(async () => {
      stack = await startDeployEngineStack({ ubuntu });
      client = await connect(stack);
      const base = stack.baseImages[0];
      if (base === undefined) throw new Error('no base image preloaded');
      const written = await run(
        c(),
        `${WRITE_DOCKERFILE} ${q(buildDir)}`,
        `FROM ${base}\nRUN echo ok\n`,
      );
      expect(written.exitCode).toBe(0);
      const versions = await run(
        c(),
        'docker version --format "{{.Server.Version}}"; docker buildx version',
      );
      dockerVersion = firstLine(versions.stdout).trim();
      measure('G3', ubuntu, { versions: versions.stdout.trim().split('\n') });
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      client?.end();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it('G3 / ADR 0008 / D-03: a plain `docker build .` (no flags, no env) uses BuildKit: `load build definition` progress, never `Step 1/`', async () => {
      const startedAt = Date.now();
      const build = await plainBuild('active');
      const output = `${build.stdout}${build.stderr}`;
      measure('G3', ubuntu, {
        case: 'plain docker build',
        exitCode: build.exitCode,
        ms: Date.now() - startedAt,
        buildkit: BUILDKIT_PROGRESS.test(output),
        legacy: output.includes('Step 1/'),
      });

      expect(build.exitCode).toBe(0);
      expect(output).toMatch(BUILDKIT_PROGRESS);
      expect(output).not.toContain('Step 1/');
    });

    it('G3 / ADR 0008 / D-03: DOCKER_BUILDKIT=0 in the session env flips the same build to the legacy builder with a deprecation warning, not an error', async () => {
      const build = await plainBuild('legacy_env');
      measure('G3', ubuntu, {
        case: 'DOCKER_BUILDKIT=0 docker build',
        exitCode: build.exitCode,
        stderr: build.stderr,
        stdoutFirstLine: firstLine(build.stdout),
      });

      expect(build.exitCode).toBe(0);
      expect(build.stdout).toMatch(LEGACY_PROGRESS);
      expect(build.stdout).not.toMatch(BUILDKIT_PROGRESS);
      expect(build.stderr).toContain('The legacy builder is deprecated');
      expect(build.stderr).toContain('BuildKit is currently disabled');
    });

    it('G3 / ADR 0008: every candidate detection command is deterministic across two runs', async () => {
      const first = await candidates('active');
      const second = await candidates('active');
      recordCandidates('active', first);

      for (const name of Object.keys(BUILDKIT_CANDIDATES) as Candidate[]) {
        expect(second[name], name).toEqual(first[name]);
        expect(first[name].exitCode, name).toBe(0);
      }
      expect(first.buildx_version.stdout).toMatch(/^github\.com\/docker\/buildx v\d+\.\d+\.\d+ /);
      const plugins = JSON.parse(first.info_plugins.stdout) as { Name: string }[];
      expect(plugins.map((p) => p.Name)).toContain('buildx');
      expect(first.buildx_inspect.stdout).toMatch(/^Driver:\s+docker$/m);
    });

    it('G3 / ADR 0008 / D-03: the chosen check reports BuildKit active and matches the capture', async () => {
      await checkCapture('active', BUILDKIT_ACTIVE_USAGE);
    });

    it('G3 / ADR 0008 / D-03: with DOCKER_BUILDKIT=0 the chosen check reports legacy while buildx version and docker info still report the plugin (their false positive)', async () => {
      const results = await candidates('legacy_env');
      recordCandidates('legacy_env', results);

      expect(results.buildx_version.exitCode).toBe(0);
      expect(results.info_plugins.stdout).toContain('"Name":"buildx"');
      expect(results.build_help.exitCode).toBe(0);
      expect(firstLine(results.build_help.stdout)).toMatch(BUILDKIT_LEGACY_USAGE);
      await checkCapture('legacy_env', BUILDKIT_LEGACY_USAGE);
    });

    // Runs last: removing the plugin changes the host for good.
    describe('after `apt-get remove docker-buildx-plugin`', () => {
      beforeAll(async () => {
        const removed = await run(
          c(),
          'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get remove -y docker-buildx-plugin',
        );
        expect(removed.exitCode).toBe(0);
      }, STACK_TIMEOUT_MS);

      it('G3 / ADR 0008 / D-03: a plain `docker build .` silently falls back to the legacy builder (exit 0, `Step 1/`, deprecation on stderr)', async () => {
        const build = await plainBuild('plugin_missing');
        measure('G3', ubuntu, {
          case: 'plugin missing: plain docker build',
          exitCode: build.exitCode,
          stderr: build.stderr,
          stdoutFirstLine: firstLine(build.stdout),
        });

        expect(build.exitCode).toBe(0);
        expect(build.stdout).toMatch(LEGACY_PROGRESS);
        expect(build.stdout).not.toMatch(BUILDKIT_PROGRESS);
        expect(build.stderr).toContain(
          'Install the buildx component to build images with BuildKit',
        );
      });

      it('G3 / ADR 0008 / D-03: candidates without the plugin; the chosen check reports legacy and matches the capture', async () => {
        const first = await candidates('plugin_missing');
        const second = await candidates('plugin_missing');
        recordCandidates('plugin_missing', first);

        for (const name of Object.keys(BUILDKIT_CANDIDATES) as Candidate[]) {
          expect(second[name], name).toEqual(first[name]);
        }
        expect(first.buildx_version.exitCode).toBe(1);
        expect(first.buildx_version.stderr).toContain('unknown command: docker buildx');
        expect(first.buildx_inspect.exitCode).toBe(1);
        expect(first.info_plugins.exitCode).toBe(0);
        expect(first.info_plugins.stdout).not.toContain('"Name":"buildx"');
        expect(first.build_help.exitCode).toBe(0);
        await checkCapture('plugin_missing', BUILDKIT_LEGACY_USAGE);
      });
    });
  },
);

// --- G4 -----------------------------------------------------------------------------------------

const DEPLOYMENT_FIXTURES = path.join(REPO_ROOT, 'packages/domain/src/deployment/fixtures');

/**
 * The docker.ps template 11-10/11-13 adopt. `--size=false` is required, not decorative: measured,
 * the CLI turns size computation ON by itself whenever the template references `.Size`, and
 * `{{json .}}` does (research assumption A3 was wrong). Only an explicit `--size=false` stops it.
 */
const DOCKER_PS = `docker ps --all --no-trunc --size=false --filter label=noodara.managed=true --format '{{json .}}'`;
/** Same without any size flag: what A3 assumed was cheap. */
const DOCKER_PS_DEFAULT = `docker ps --all --no-trunc --filter label=noodara.managed=true --format '{{json .}}'`;
const DOCKER_PS_SIZE = `docker ps --all --no-trunc --size --filter label=noodara.managed=true --format '{{json .}}'`;
/** Files written into the running container's writable layer so the size walk has a real cost. */
const CHURN_FILES = 50_000;
const CHURN = `sh -c 'mkdir /churn && cd /churn && seq 1 "$0" | xargs touch'`;
const DOCKER_INSPECT_STATE = `docker inspect --type container --format '{{json .State}}' --`;
/** Remote wall time of one command in ms, so ssh round-trips do not pollute the Size comparison. */
const TIMED = `sh -c 's=$(date +%s%N); eval "$0" >/dev/null; e=$(date +%s%N); echo $(( (e - s) / 1000000 ))'`;

/** Fields the parser in 11-10 relies on; the full set per version is in the fixture README. */
const REQUIRED_PS_KEYS = [
  'CreatedAt',
  'ID',
  'Image',
  'Labels',
  'Names',
  'Ports',
  'State',
  'Status',
];
const REQUIRED_STATE_KEYS = [
  'ExitCode',
  'FinishedAt',
  'OOMKilled',
  'Running',
  'StartedAt',
  'Status',
];
const TIMING_RUNS = 5;

function labelArgs(serviceId: string, deploymentId: string): string {
  return [
    'noodara.managed=true',
    `noodara.service_id=${serviceId}`,
    `noodara.deployment_id=${deploymentId}`,
    'noodara.test=true',
  ]
    .map((label) => `--label ${q(label)}`)
    .join(' ');
}

function parseNdjson(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function keySet(objects: readonly Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const object of objects) for (const key of Object.keys(object)) keys.add(key);
  return [...keys].sort();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function deploymentFixture(ubuntu: string, file: string): string {
  return path.join(DEPLOYMENT_FIXTURES, `ubuntu-${ubuntu}`, file);
}

/** Writes in capture mode, then always reads back: normal mode compares against the capture. */
function captureOrRead(file: string, content: string): string {
  if (CAPTURE_FIXTURES) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return readFileSync(file, 'utf8');
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  'G4 / ADR 0008: docker ps NDJSON field stability on Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let client: Client | undefined;
    let created: { running: string; exited: string; created: string; network: string } | undefined;

    const c = (): Client => {
      if (client === undefined) throw new Error('client not connected');
      return client;
    };
    const mustRun = async (command: string, expectedExit = 0): Promise<string> => {
      const result = await run(c(), command);
      expect(result.exitCode, `${command}\n${result.stderr}`).toBe(expectedExit);
      return result.stdout;
    };

    /** running (published port, own network), exited non-zero, created never started. */
    const createTrio = async (): Promise<NonNullable<typeof created>> => {
      const base = stack?.baseImages[0];
      if (base === undefined) throw new Error('no base image preloaded');
      const [a, b, cc] = [randomUUID(), randomUUID(), randomUUID()];
      const trio = {
        running: `noodara-${a}`,
        exited: `noodara-${b}`,
        created: `noodara-${cc}`,
        network: `noodara-net-${a}`,
      };
      created = trio;
      await mustRun(`docker network create --label noodara.test=true -- ${q(trio.network)}`);
      await mustRun(
        `docker run -d --name ${q(trio.running)} --network ${q(trio.network)} -p 18080:3000 ` +
          `${labelArgs(a, randomUUID())} ${q(base)} sleep 3600`,
      );
      await mustRun(
        `docker run --name ${q(trio.exited)} ${labelArgs(b, randomUUID())} ${q(base)} sh -c 'exit 3'`,
        3,
      );
      await mustRun(
        `docker create --name ${q(trio.created)} ${labelArgs(cc, randomUUID())} ${q(base)} sleep 3600`,
      );
      return trio;
    };

    beforeAll(async () => {
      stack = await startDeployEngineStack({ ubuntu });
      client = await connect(stack);
      const versions = await run(
        c(),
        'docker version --format "{{.Client.Version}} {{.Server.Version}} {{.Server.APIVersion}}"',
      );
      measure('G4', ubuntu, { dockerClientServerApi: versions.stdout.trim() });
    }, STACK_TIMEOUT_MS);

    afterEach(async () => {
      if (created !== undefined) {
        const trio = created;
        created = undefined;
        await mustRun(
          `docker rm -f -- ${q(trio.running)} ${q(trio.exited)} ${q(trio.created)} >/dev/null`,
        );
        await mustRun(`docker network rm -- ${q(trio.network)} >/dev/null`);
      }
      expect(await mustRun('docker ps -aq --filter label=noodara.test=true')).toBe('');
      expect(await mustRun('docker network ls -q --filter label=noodara.test=true')).toBe('');
    });

    afterAll(async () => {
      client?.end();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it(`G4 / ADR 0008: \`docker ps --all --no-trunc --size=false --filter label=noodara.managed=true --format '{{json .}}'\` is NDJSON, one object per container, with running / exited / created states and the captured key set`, async () => {
      const trio = await createTrio();

      const stdout = await mustRun(DOCKER_PS);
      const lines = stdout.split('\n').filter((line) => line !== '');
      const objects = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const byName = new Map(objects.map((o) => [o['Names'], o]));
      measure('G4', ubuntu, { case: 'docker ps', keySet: keySet(objects), lines: lines.length });

      expect(stdout.endsWith('\n')).toBe(true);
      expect(lines).toHaveLength(3);
      for (const object of objects) {
        for (const key of REQUIRED_PS_KEYS) expect(object, key).toHaveProperty(key);
        expect(String(object['Labels'])).toContain('noodara.managed=true');
        expect(String(object['ID'])).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(byName.get(trio.running)?.['State']).toBe('running');
      expect(String(byName.get(trio.running)?.['Ports'])).toContain('18080->3000/tcp');
      expect(String(byName.get(trio.running)?.['Networks'])).toBe(trio.network);
      expect(byName.get(trio.exited)?.['State']).toBe('exited');
      expect(String(byName.get(trio.exited)?.['Status'])).toMatch(/^Exited \(3\) /);
      expect(byName.get(trio.created)?.['State']).toBe('created');
      expect(byName.get(trio.created)?.['Status']).toBe('Created');

      const captured = captureOrRead(deploymentFixture(ubuntu, 'docker_ps.ndjson'), stdout);
      expect(keySet(parseNdjson(captured))).toEqual(keySet(objects));
      expect(
        parseNdjson(captured)
          .map((o) => o['State'])
          .sort(),
      ).toEqual(['created', 'exited', 'running']);
    });

    it('G4 / ADR 0008: `{{json .}}` computes Size unless `--size=false` is passed; the chosen template passes it and gets "0B"', async () => {
      const trio = await createTrio();
      const churnStarted = Date.now();
      await mustRun(`docker exec ${q(trio.running)} ${CHURN} ${String(CHURN_FILES)}`);
      const churnMs = Date.now() - churnStarted;

      const variants = { chosen: DOCKER_PS, noFlag: DOCKER_PS_DEFAULT, withSize: DOCKER_PS_SIZE };
      const parsed: Record<string, Record<string, unknown>[]> = {};
      const timings: Record<string, number[]> = {};
      for (const [name, command] of Object.entries(variants)) {
        parsed[name] = parseNdjson(await mustRun(command));
        timings[name] = [];
      }
      for (let i = 0; i < TIMING_RUNS; i += 1) {
        for (const [name, command] of Object.entries(variants)) {
          timings[name]?.push(Number((await mustRun(`${TIMED} ${q(command)}`)).trim()));
        }
      }
      const sizes = (name: string): unknown[] =>
        (parsed[name] ?? []).map((o) => [o['Names'], o['Size'] ?? '(absent)']);
      measure('G4', ubuntu, {
        case: 'size',
        churnFiles: CHURN_FILES,
        churnMs,
        sizes: { chosen: sizes('chosen'), noFlag: sizes('noFlag'), withSize: sizes('withSize') },
        timingsMs: timings,
        medianMs: Object.fromEntries(
          Object.entries(timings).map(([name, values]) => [name, median(values)]),
        ),
      });

      expect(DOCKER_PS).toContain('--size=false');
      expect(keySet(parsed['noFlag'] ?? [])).toEqual(keySet(parsed['chosen'] ?? []));
      expect(keySet(parsed['withSize'] ?? [])).toEqual(keySet(parsed['chosen'] ?? []));
      for (const object of parsed['chosen'] ?? []) expect(object['Size']).toBe('0B');
      for (const name of ['noFlag', 'withSize']) {
        for (const object of parsed[name] ?? []) {
          expect(String(object['Size']), name).toMatch(/^\S+ \(virtual \S+\)$/);
        }
      }
    });

    it('G4 / ADR 0008: `docker inspect --type container --format {{json .State}}` of the running and exited containers is captured with the state fields', async () => {
      const trio = await createTrio();

      const running = JSON.parse(
        await mustRun(`${DOCKER_INSPECT_STATE} ${q(trio.running)}`),
      ) as Record<string, unknown>;
      const exitedRaw = await mustRun(`${DOCKER_INSPECT_STATE} ${q(trio.exited)}`);
      const exited = JSON.parse(exitedRaw) as Record<string, unknown>;
      measure('G4', ubuntu, {
        case: 'inspect state',
        runningKeys: Object.keys(running).sort(),
        exitedKeys: Object.keys(exited).sort(),
      });

      for (const state of [running, exited]) {
        for (const key of REQUIRED_STATE_KEYS) expect(state, key).toHaveProperty(key);
      }
      expect(running).toMatchObject({
        Status: 'running',
        Running: true,
        ExitCode: 0,
        OOMKilled: false,
      });
      expect(exited).toMatchObject({
        Status: 'exited',
        Running: false,
        ExitCode: 3,
        OOMKilled: false,
      });

      const runningCaptured = captureOrRead(
        deploymentFixture(ubuntu, 'docker_inspect_state_running.json'),
        await mustRun(`${DOCKER_INSPECT_STATE} ${q(trio.running)}`),
      );
      const exitedCaptured = captureOrRead(
        deploymentFixture(ubuntu, 'docker_inspect_state_exited.json'),
        exitedRaw,
      );
      expect(Object.keys(JSON.parse(runningCaptured) as object).sort()).toEqual(
        Object.keys(running).sort(),
      );
      expect(Object.keys(JSON.parse(exitedCaptured) as object).sort()).toEqual(
        Object.keys(exited).sort(),
      );
    });
  },
);

describe('G4 / ADR 0008: docker ps captures agree across Ubuntu versions', () => {
  it('G4 / ADR 0008: 22.04 and 24.04 docker ps captures have the same key set, each line valid JSON', () => {
    const [jammy, noble] = (['22.04', '24.04'] as const).map((ubuntu) =>
      parseNdjson(readFileSync(deploymentFixture(ubuntu, 'docker_ps.ndjson'), 'utf8')),
    );

    expect(jammy).toHaveLength(3);
    expect(noble).toHaveLength(3);
    expect(keySet(noble ?? [])).toEqual(keySet(jammy ?? []));
  });
});
