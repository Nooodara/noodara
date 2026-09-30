// QA-07 end to end on the real sshd + dockerd fixture (11-08-PLAN.md, D-10, D-13, D-14). The three
// official fixtures (fixtures/*, 11-04) are served from the bare Git repo over SSH, cloned with the
// deploy key, built by the nested Docker and run. Raw ssh2 via `@noodara/ssh/testing` only, never
// the adapter and never a mock. Remote scripts are constant strings; the variable parts (fresh-UUID
// paths, tags, names) travel as positional parameters. Measurements go to NOODARA_MEASUREMENTS_FILE.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
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
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 300_000;
const WORKSPACE_ROOT = '/opt/noodara-deploy';
/** D-13 budget for an official fixture's build context. */
const MAX_CONTEXT_BYTES = 1_048_576;
const OFFICIAL_FIXTURES = ['node-api', 'static-app', 'failing-build'] as const;
type FixtureName = (typeof OFFICIAL_FIXTURES)[number];

// --- Raw ssh2 plumbing ------------------------------------------------------------------------

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Running {
  readonly channel: ClientChannel;
  readonly done: Promise<RunResult>;
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

function start(client: Client, command: string): Promise<Running> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err !== undefined) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      channel.on('exit', (code: number | null) => {
        exitCode = code;
      });
      const done = new Promise<RunResult>((settle, fail) => {
        const timer = setTimeout(() => {
          fail(new Error(`ssh exec timed out after ${String(SSH_COMMAND_TIMEOUT_MS)}ms`));
        }, SSH_COMMAND_TIMEOUT_MS);
        timer.unref();
        channel.on('close', () => {
          clearTimeout(timer);
          settle({ exitCode, stdout, stderr });
        });
      });
      resolve({ channel, done });
    });
  });
}

async function run(client: Client, command: string, stdin?: string): Promise<RunResult> {
  const running = await start(client, command);
  if (stdin !== undefined) running.channel.write(stdin);
  running.channel.end();
  return running.done;
}

/** POSIX single-quote for the positional parameters passed to sh -c. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function measure(ubuntu: string, data: Record<string, unknown>): void {
  const line = `[QA-07] ${JSON.stringify({ ubuntu, ...data })}`;
  console.log(line);
  // Vitest hides console output of passing tests; this is how the SUMMARY numbers are collected.
  const file = process.env['NOODARA_MEASUREMENTS_FILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

const UNIT_BYTES: Record<string, number> = { B: 1, kB: 1_000, MB: 1_000_000 };

/**
 * Bytes BuildKit reports for the build context: the last `transferring context:` line of the
 * `[internal] load build context` step. The `.dockerignore` step prints the same phrase, so the
 * step number is resolved first. Units are go-units HumanSize (decimal).
 *
 * Measured: BuildKit only runs that step when an instruction reads the context (COPY/ADD). With
 * none, as in failing-build, nothing is transferred and `line` is null (0 bytes).
 */
function buildContextBytes(output: string): {
  readonly bytes: number;
  readonly line: string | null;
} {
  const lines = output.split('\n');
  const step = lines
    .map((line) => /^#(\d+) \[internal\] load build context$/.exec(line.trim())?.[1])
    .find((found) => found !== undefined);
  if (step === undefined) return { bytes: 0, line: null };
  const sized = lines
    .filter((line) => line.startsWith(`#${step} `))
    .map((line) => ({ line, match: /transferring context: ([\d.]+)(B|kB|MB)/.exec(line) }))
    .filter((entry) => entry.match !== null);
  const last = sized.at(-1);
  const value = last?.match?.[1];
  const unit = last?.match?.[2];
  if (last === undefined || value === undefined || unit === undefined) {
    throw new Error(`no transferring context line for step #${step}`);
  }
  return { bytes: Number(value) * (UNIT_BYTES[unit] ?? Number.NaN), line: last.line.trim() };
}

// Constant remote scripts. $0 is always the workspace.
const MAKE_WORKSPACE = `sh -c 'umask 077 && mkdir -p "$0/secrets" "$0/run"'`;
const WRITE_SECRET = `sh -c 'umask 077 && cat > "$0"'`;
const GIT_CLONE =
  `sh -c 'cd "$0" && GIT_SSH_COMMAND="ssh -i $0/secrets/deploy_key -o IdentitiesOnly=yes ` +
  `-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$0/secrets/known_hosts" ` +
  `git clone --depth 1 --branch main -- "$1" repo'`;
/** Remote wall time around the build, so ssh latency is not counted. */
const DOCKER_BUILD =
  `sh -c 'start=$(date +%s%N); docker build --progress=plain -t "$1" "$0/repo"; rc=$?; ` +
  `end=$(date +%s%N); echo "NOODARA_BUILD_MS=$(( (end - start) / 1000000 ))"; exit $rc'`;
/**
 * `docker run -d` then poll `curl -fsS` every 50 ms for up to 10 s. Prints the time from before
 * `docker run` to the first 2xx, then the body. $0 name, $1 image, $2 host:container port, $3 URL.
 */
const RUN_UNTIL_HEALTHY =
  `sh -c 'start=$(date +%s%N); ` +
  `docker run -d --name "$0" --label noodara.test=true -p "$2" "$1" >/dev/null || exit 90; ` +
  `i=0; until body=$(curl -fsS "$3" 2>/dev/null); do i=$((i + 1)); ` +
  `if [ "$i" -ge 200 ]; then echo "not healthy after 10s" >&2; exit 91; fi; sleep 0.05; done; ` +
  `end=$(date +%s%N); echo "NOODARA_HEALTHY_MS=$(( (end - start) / 1000000 ))"; printf "%s" "$body"'`;

function remoteMs(output: string, key: string): number {
  const match = new RegExp(`${key}=(\\d+)`).exec(output);
  if (match?.[1] === undefined) throw new Error(`${key} missing from output`);
  return Number(match[1]);
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  'QA-07: official fixtures and registry on the sshd+dockerd fixture, Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let client: Client | undefined;
    const workspaces: string[] = [];
    const containers: string[] = [];
    const images: string[] = [];

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const c = (): Client => {
      if (client === undefined) throw new Error('client not connected');
      return client;
    };
    const mustRun = async (command: string, stdin?: string): Promise<string> => {
      const result = await run(c(), command, stdin);
      if (result.exitCode !== 0) {
        throw new Error(`exit ${String(result.exitCode)}: ${command}\n${result.stderr}`);
      }
      return result.stdout.trim();
    };

    /** Fresh workspace, deploy key over stdin (G1), `git clone --depth 1 --branch main`. */
    const cloneFixture = async (name: FixtureName): Promise<string> => {
      const ws = `${WORKSPACE_ROOT}/${randomUUID()}`;
      workspaces.push(ws);
      await mustRun(`${MAKE_WORKSPACE} ${q(ws)}`);
      await mustRun(`${WRITE_SECRET} ${q(`${ws}/secrets/deploy_key`)}`, s().deployKey.privateKey);
      const clone = await run(c(), `${GIT_CLONE} ${q(ws)} ${q(s().gitRepoUrl(name))}`);
      expect(clone.exitCode).toBe(0);
      return ws;
    };

    const build = async (
      ws: string,
      name: FixtureName,
    ): Promise<RunResult & { readonly tag: string; readonly buildMs: number }> => {
      const tag = `noodara-test/${name}:${randomUUID()}`;
      images.push(tag);
      const result = await run(c(), `${DOCKER_BUILD} ${q(ws)} ${q(tag)}`);
      return { ...result, tag, buildMs: remoteMs(result.stdout, 'NOODARA_BUILD_MS') };
    };

    const runUntilHealthy = async (
      image: string,
      publish: string,
      url: string,
    ): Promise<RunResult & { readonly name: string }> => {
      const name = `noodara-test-${randomUUID()}`;
      containers.push(name);
      const result = await run(
        c(),
        `${RUN_UNTIL_HEALTHY} ${q(name)} ${q(image)} ${q(publish)} ${q(url)}`,
      );
      return { ...result, name };
    };

    beforeAll(async () => {
      stack = await startDeployEngineStack({
        ubuntu,
        seedRepositories: OFFICIAL_FIXTURES.map((name) => ({
          name,
          sourceDir: path.join(FIXTURES_DIR, name),
        })),
      });
      client = await connect(stack);
      const versions = await stack.exec([
        'sh',
        '-c',
        'docker version --format "{{.Server.Version}}"; docker buildx version; git --version',
      ]);
      measure(ubuntu, { versions: versions.stdout.trim().split('\n') });
    }, STACK_TIMEOUT_MS);

    afterEach(async () => {
      for (const name of containers.splice(0)) {
        await mustRun(`docker rm -f -- ${q(name)} >/dev/null`);
      }
      for (const tag of images.splice(0)) {
        // A failed build never creates its tag; `|| true` covers exactly that case.
        await mustRun(`sh -c 'docker rmi -f -- "$0" >/dev/null 2>&1 || true' ${q(tag)}`);
      }
      for (const ws of workspaces.splice(0)) {
        await mustRun(`rm -rf -- ${q(ws)}`);
      }
      expect(await mustRun('docker ps -aq --filter label=noodara.test=true')).toBe('');
      expect(await mustRun("docker images -q 'noodara-test/*'")).toBe('');
    });

    afterAll(async () => {
      client?.end();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    describe('QA-07 / D-13: official fixtures cloned over SSH, built and run', () => {
      it('QA-07 / D-13: node-api clones with the deploy key, builds with a BuildKit context < 1 MiB, answers /health `ok` within 10 s and / with its JSON', async () => {
        const ws = await cloneFixture('node-api');

        const built = await build(ws, 'node-api');
        const context = buildContextBytes(built.stderr);
        expect(built.exitCode).toBe(0);
        expect(context.line).toMatch(/transferring context: [\d.]+(B|kB|MB) done/);
        expect(context.bytes).toBeLessThan(MAX_CONTEXT_BYTES);

        const healthy = await runUntilHealthy(
          built.tag,
          '13000:3000',
          'http://127.0.0.1:13000/health',
        );
        const root = await mustRun('curl -fsS http://127.0.0.1:13000/');

        measure(ubuntu, {
          fixture: 'node-api',
          contextLine: context.line,
          contextBytes: context.bytes,
          buildMs: built.buildMs,
          buildExit: built.exitCode,
          runExit: healthy.exitCode,
          healthyMs: healthy.exitCode === 0 ? remoteMs(healthy.stdout, 'NOODARA_HEALTHY_MS') : null,
        });
        expect(healthy.exitCode).toBe(0);
        expect(healthy.stdout.split('\n').at(-1)).toBe('ok');
        expect(JSON.parse(root)).toEqual({ service: 'node-api', ok: true });
      });

      it('QA-07 / D-13: static-app clones with the deploy key, builds with a BuildKit context < 1 MiB and serves its page on :80', async () => {
        const ws = await cloneFixture('static-app');

        const built = await build(ws, 'static-app');
        const context = buildContextBytes(built.stderr);
        expect(built.exitCode).toBe(0);
        expect(context.line).toMatch(/transferring context: [\d.]+(B|kB|MB) done/);
        expect(context.bytes).toBeLessThan(MAX_CONTEXT_BYTES);

        const healthy = await runUntilHealthy(built.tag, '13080:80', 'http://127.0.0.1:13080/');

        measure(ubuntu, {
          fixture: 'static-app',
          contextLine: context.line,
          contextBytes: context.bytes,
          buildMs: built.buildMs,
          buildExit: built.exitCode,
          runExit: healthy.exitCode,
          healthyMs: healthy.exitCode === 0 ? remoteMs(healthy.stdout, 'NOODARA_HEALTHY_MS') : null,
        });
        expect(healthy.exitCode).toBe(0);
        expect(healthy.stdout).toContain('noodara static-app fixture');
      });

      it('QA-07 / D-13: failing-build transfers no build context at all (no COPY/ADD), then fails with `exit code: 42` and NOODARA_FIXTURE_BUILD_FAILURE, twice in a row', async () => {
        const ws = await cloneFixture('failing-build');

        const first = await build(ws, 'failing-build');
        const second = await build(ws, 'failing-build');
        const context = buildContextBytes(first.stderr);

        measure(ubuntu, {
          fixture: 'failing-build',
          contextLine: context.line,
          contextBytes: context.bytes,
          buildMs: [first.buildMs, second.buildMs],
          buildExit: [first.exitCode, second.exitCode],
        });
        // The plan expected a context line before the failure; BuildKit skips the transfer.
        expect(context).toEqual({ bytes: 0, line: null });
        expect(context.bytes).toBeLessThan(MAX_CONTEXT_BYTES);
        for (const attempt of [first, second]) {
          // Measured: the step exits 42 but the docker CLI itself exits 1; 42 is only in stderr.
          expect(attempt.exitCode).toBe(1);
          expect(attempt.stderr).toContain('NOODARA_FIXTURE_BUILD_FAILURE');
          expect(attempt.stderr).toContain('exit code: 42');
        }
      });
    });
  },
);
