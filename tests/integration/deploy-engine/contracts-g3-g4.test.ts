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
