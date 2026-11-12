// 36-04 H4/H8/H9: scripts/fixture-images.mjs. `list` must print exactly the identities the SSH
// helper computes (one shared implementation), and `publish` must build and push
// `<registry>/<name>:<hash>` without ever overwriting an existing tag, logging in, or echoing
// Docker stderr or a credential-shaped registry value. Docker is a fake runner here: no daemon,
// no registry, nothing is pushed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_IDENTITY_BUILD_ARG,
  FIXTURE_IMAGES_CONTEXT,
  FIXTURE_REGISTRY_ENV,
  computeFixtureIdentitySync,
  listFixtureImageSpecs,
  localFixtureRef,
  remoteFixtureRef,
} from '../../integration/helpers/fixture-image.js';
import {
  FIXTURE_IMAGE_COMMAND_TIMEOUTS_MS,
  listFixtureImages,
  main,
  publishFixtureImages,
} from '../../../scripts/fixture-images.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts/fixture-images.mjs');
const REGISTRY = 'ghcr.io/acme/noodara-test-fixtures';
// Assembled at runtime so no credential-shaped literal sits in the source.
const CANARY = ['ghp', 'CANARY', 'fixture', 'images', 'x9Y8z7W6'].join('_');

/** Literal arguments, written out independently of sshdFixtureImageSpec (parity, not tautology). */
const VARIANTS = ['22.04', '24.04'].flatMap((ubuntu) =>
  [
    { WITH_DOCKER_CLI: 'false', WITH_SLOW_DF: 'false' },
    { WITH_DOCKER_CLI: 'false', WITH_SLOW_DF: 'true' },
    { WITH_DOCKER_CLI: 'true', WITH_SLOW_DF: 'false' },
    { WITH_DOCKER_CLI: 'true', WITH_SLOW_DF: 'true' },
  ].map((buildArgs) => ({
    name: `sshd-ubuntu-${ubuntu}`,
    identity: computeFixtureIdentitySync({
      contextDir: path.join(ROOT, 'tests/integration/images'),
      dockerfile: `sshd-ubuntu-${ubuntu}/Dockerfile`,
      buildArgs,
    }),
  })),
);

interface Call {
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

interface FakeDockerOptions {
  readonly existing?: Iterable<string>;
  /** stderr of a failed `manifest inspect` for a missing tag. */
  readonly absentStderr?: string;
  /** Makes `manifest inspect` fail with something other than "absent". */
  readonly inspectFailure?: string;
  /** Label the built image carries; defaults to the identity passed as build arg. */
  readonly label?: (ref: string, buildIdentity: string) => string;
  readonly buildFailure?: { readonly stderr: string; readonly killed?: boolean; readonly signal?: string; readonly code?: number };
  readonly pushFailure?: string;
  /** Tags that appear in the registry right after they are built (a concurrent publisher). */
  readonly appearAfterBuild?: ReadonlySet<string>;
}

function commandError(stderr: string, extra: { code?: number; killed?: boolean; signal?: string } = {}): Error {
  return Object.assign(new Error(`Command failed: docker\n${stderr}`), { code: 1, stderr, stdout: '', ...extra });
}

function fakeDocker(options: FakeDockerOptions = {}) {
  const registry = new Set(options.existing ?? []);
  const built = new Map<string, string>();
  const calls: Call[] = [];
  const pushed: string[] = [];
  const run = vi.fn((args: readonly string[], runOptions: { timeoutMs: number }) => {
    calls.push({ args: [...args], timeoutMs: runOptions.timeoutMs });
    const ref = args.at(-1) ?? '';
    if (args[0] === 'manifest' && args[1] === 'inspect') {
      if (options.inspectFailure !== undefined) return Promise.reject(commandError(options.inspectFailure));
      if (registry.has(ref)) return Promise.resolve('{"schemaVersion":2}');
      return Promise.reject(commandError(options.absentStderr ?? `no such manifest: ${ref}`));
    }
    if (args[0] === 'build') {
      if (options.buildFailure !== undefined) {
        const { stderr, ...extra } = options.buildFailure;
        return Promise.reject(commandError(stderr, extra));
      }
      const tag = args[args.indexOf('--tag') + 1] ?? '';
      const identityArg = args.find((a) => a.startsWith(`${FIXTURE_IDENTITY_BUILD_ARG}=`)) ?? '';
      const identity = identityArg.slice(FIXTURE_IDENTITY_BUILD_ARG.length + 1);
      built.set(tag, options.label ? options.label(tag, identity) : identity);
      if (options.appearAfterBuild?.has(tag)) registry.add(tag);
      return Promise.resolve('sha256:0123\n');
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      return Promise.resolve(`${built.get(ref) ?? ''}\n`);
    }
    if (args[0] === 'push') {
      if (options.pushFailure !== undefined) return Promise.reject(commandError(options.pushFailure));
      pushed.push(ref);
      registry.add(ref);
      return Promise.resolve('');
    }
    return Promise.reject(new Error(`unexpected docker call: ${args.join(' ')}`));
  });
  return { run, calls, pushed, registry };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('list (H8: one shared identity implementation)', () => {
  it('lists every committed SSH fixture variant with the identity the SSH helper computes', async () => {
    const listed = await listFixtureImages();

    expect(listed.map((e: { name: string; identity: string }) => ({ name: e.name, identity: e.identity }))).toEqual(
      expect.arrayContaining(VARIANTS),
    );
    expect(listed).toHaveLength(VARIANTS.length);
    expect(new Set(listed.map((e: { identity: string }) => e.identity)).size).toBe(VARIANTS.length);
    for (const entry of listed) {
      expect(entry.identity).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.tag).toBe(localFixtureRef(entry.name, entry.identity));
    }
  });

  it('uses the same context, Dockerfile and args as the helper spec', async () => {
    const listed = await listFixtureImages();
    const specs = listFixtureImageSpecs();
    expect(path.resolve(FIXTURE_IMAGES_CONTEXT)).toBe(path.join(ROOT, 'tests/integration/images'));
    expect(listed.map((e: { name: string; dockerfile: string; buildArgs: unknown }) => [e.name, e.dockerfile, e.buildArgs])).toEqual(
      specs.map((s) => [s.name, s.dockerfile, s.buildArgs]),
    );
  });

  it('prints the registry tag when --registry is given, still without Docker', async () => {
    const listed = await listFixtureImages({ registry: REGISTRY });
    for (const entry of listed) expect(entry.tag).toBe(remoteFixtureRef(REGISTRY, entry.name, entry.identity));
  });

  it('the CLI under plain Node (type stripping) prints the same identities, with no docker on PATH', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[FIXTURE_REGISTRY_ENV];
    // Linux/macOS take exec bits from file modes, so not even git is needed; Windows needs git.
    if (process.platform !== 'win32') env.PATH = '';
    const stdout = execFileSync(process.execPath, [SCRIPT, 'list'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.split(/\s+/));
    expect(rows).toHaveLength(VARIANTS.length);
    for (const row of rows) {
      const [name, identity, tag] = row;
      expect(VARIANTS).toContainEqual({ name, identity });
      expect(tag).toBe(localFixtureRef(name as string, identity as string));
    }
  });

  it('the script imports the helper module instead of carrying its own hash code', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("from '../tests/integration/helpers/fixture-image.ts'");
    expect(source).not.toMatch(/createHash|sha256|node:crypto/);
    const ssh = readFileSync(path.join(ROOT, 'tests/integration/helpers/ssh.ts'), 'utf8');
    expect(ssh).toMatch(/sshdFixtureImageSpec\(ubuntu, \{ dockerCli, slowDf \}\)/);
    expect(ssh).toMatch(/computeFixtureIdentitySync\(\{ contextDir: IMAGES_CONTEXT, dockerfile, buildArgs \}\)/);
  });
});

describe('publish (A4/H9: build and push under the content hash, never overwrite)', () => {
  it('builds, verifies the label and pushes every absent tag with argument arrays', async () => {
    const docker = fakeDocker();
    const io = capture();

    const result = await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: io.stdout });

    const expected = VARIANTS.map((v) => remoteFixtureRef(REGISTRY, v.name, v.identity));
    expect(docker.pushed).toEqual(expect.arrayContaining(expected));
    expect(docker.pushed).toHaveLength(expected.length);
    expect(result.published).toEqual(docker.pushed);
    expect(result.skipped).toEqual([]);

    const spec = listFixtureImageSpecs()[0];
    const ref = docker.pushed[0] as string;
    const identity = ref.slice(ref.lastIndexOf(':') + 1);
    const forRef = docker.calls.filter((c) => c.args.includes(ref)).map((c) => c.args);
    expect(forRef).toEqual([
      ['manifest', 'inspect', '--', ref],
      [
        'build', '--quiet', '--file', path.join(FIXTURE_IMAGES_CONTEXT, spec?.dockerfile ?? ''),
        '--build-arg', 'WITH_DOCKER_CLI=false', '--build-arg', 'WITH_SLOW_DF=false',
        '--build-arg', `${FIXTURE_IDENTITY_BUILD_ARG}=${identity}`,
        '--tag', ref, '--', FIXTURE_IMAGES_CONTEXT,
      ],
      ['image', 'inspect', '--format', '{{index .Config.Labels "noodara.test.fixture-identity"}}', '--', ref],
      ['manifest', 'inspect', '--', ref],
      ['push', '--quiet', '--', ref],
    ]);
  });

  it('skips a tag that already exists: no build, no push, reported as skipped', async () => {
    const existing = VARIANTS.slice(0, 3).map((v) => remoteFixtureRef(REGISTRY, v.name, v.identity));
    const docker = fakeDocker({ existing });
    const io = capture();

    const result = await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: io.stdout });

    expect(result.skipped).toEqual(existing);
    for (const ref of existing) {
      expect(docker.pushed).not.toContain(ref);
      expect(docker.calls.filter((c) => c.args.includes(ref)).map((c) => c.args[0])).toEqual(['manifest']);
      expect(io.out.some((line) => line.includes(ref) && /already published/.test(line))).toBe(true);
    }
    expect(docker.pushed).toHaveLength(VARIANTS.length - existing.length);
  });

  it('does not push when the tag appears while it was being built', async () => {
    const racing = remoteFixtureRef(REGISTRY, VARIANTS[0]?.name ?? '', VARIANTS[0]?.identity ?? '');
    const docker = fakeDocker({ appearAfterBuild: new Set([racing]) });

    const result = await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: () => undefined });

    expect(docker.pushed).not.toContain(racing);
    expect(result.skipped).toContain(racing);
  });

  it.each([
    ['manifest unknown', 'manifest unknown: manifest unknown'],
    ['name unknown', 'name unknown: repository name not known to registry'],
    ['not found', 'errors: not found'],
  ])('treats "%s" as an absent tag', async (_label, stderr) => {
    const docker = fakeDocker({ absentStderr: stderr });
    await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: () => undefined });
    expect(docker.pushed).toHaveLength(VARIANTS.length);
  });

  it('fails closed when the existence check is inconclusive (never builds or pushes blind)', async () => {
    const docker = fakeDocker({ inspectFailure: `unauthorized: authentication required ${CANARY}` });
    const error = await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: () => undefined }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/could not check whether .* exists/);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(CANARY);
    expect(docker.calls.some((c) => c.args[0] === 'build' || c.args[0] === 'push')).toBe(false);
  });

  it('refuses to push an image whose identity label does not match', async () => {
    const docker = fakeDocker({ label: () => 'unset' });
    const error = await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: () => undefined }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/identity label/);
    expect(docker.pushed).toEqual([]);
  });

  it.each([
    ['exit code', { stderr: `failed to solve ${CANARY}`, code: 17 }, /build failed .*exit code 17/],
    ['timeout', { stderr: `still building ${CANARY}`, killed: true, signal: 'SIGTERM' }, /build failed .*timed out/],
  ])('reports a failed build (%s) with a fixed message, never its stderr', async (_label, failure, pattern) => {
    const docker = fakeDocker({ buildFailure: failure });
    const error = await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: () => undefined }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(pattern);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(CANARY);
    expect(docker.pushed).toEqual([]);
  });

  it('reports a failed push with a fixed message, never its stderr', async () => {
    const docker = fakeDocker({ pushFailure: `denied: ${CANARY}` });
    const error = await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: () => undefined }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/push failed/);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(CANARY);
  });

  it('bounds every Docker call with an explicit timeout and never logs in or reads Docker config', async () => {
    const docker = fakeDocker();
    await publishFixtureImages({ registry: REGISTRY, run: docker.run, log: () => undefined });

    const bounds = Object.values(FIXTURE_IMAGE_COMMAND_TIMEOUTS_MS) as number[];
    expect(bounds.length).toBeGreaterThan(0);
    for (const call of docker.calls) {
      expect(Number.isFinite(call.timeoutMs) && call.timeoutMs > 0, call.args.join(' ')).toBe(true);
      expect(bounds).toContain(call.timeoutMs);
      expect(call.args[0]).not.toBe('login');
      expect(call.args.join(' ')).not.toMatch(/config\.json|\.docker\b|credential/);
    }
  });

  it('rejects an invalid registry before any Docker call', async () => {
    const docker = fakeDocker();
    const error = await publishFixtureImages({ registry: `https://user:${CANARY}@ghcr.io/acme`, run: docker.run, log: () => undefined }).catch(
      (e: unknown) => e,
    );

    expect((error as Error).message).toMatch(/not a valid registry reference/);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(CANARY);
    expect(docker.run).not.toHaveBeenCalled();
  });
});

describe('CLI entry point', () => {
  it('publish --registry prints published and skipped refs and exits 0', async () => {
    const existing = remoteFixtureRef(REGISTRY, VARIANTS[0]?.name ?? '', VARIANTS[0]?.identity ?? '');
    const docker = fakeDocker({ existing: [existing] });
    const io = capture();

    const code = await main(['publish', '--registry', REGISTRY], { run: docker.run, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out.join('\n')).toContain(existing);
    expect(docker.pushed).toHaveLength(VARIANTS.length - 1);
  });

  it.each([
    [[]],
    [['publish']],
    [['publish', '--registry']],
    [['publish', '--registry', REGISTRY, 'extra']],
    [['push', '--registry', REGISTRY]],
    [['list', '--force']],
  ])('exits 2 with usage for %j and never calls Docker', async (argv) => {
    const docker = fakeDocker();
    const io = capture();
    expect(await main(argv, { run: docker.run, stdout: io.stdout, stderr: io.stderr })).toBe(2);
    expect(io.err.join('\n')).toMatch(/usage/i);
    expect(docker.run).not.toHaveBeenCalled();
  });

  it('exits 2 for a credential-shaped registry without echoing it', async () => {
    const docker = fakeDocker();
    const io = capture();
    const log = vi.spyOn(console, 'log');
    const errorLog = vi.spyOn(console, 'error');

    const code = await main(['publish', '--registry', `${CANARY}:pw@ghcr.io/acme`], { run: docker.run, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(2);
    expect([...io.out, ...io.err].join('\n')).not.toContain(CANARY);
    expect(io.err.join('\n')).toMatch(/not a valid registry reference/);
    for (const spy of [log, errorLog]) expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY);
    expect(docker.run).not.toHaveBeenCalled();
  });

  it('exits 1 on a Docker failure and prints only the fixed message', async () => {
    const docker = fakeDocker({ pushFailure: `denied: ${CANARY}` });
    const io = capture();

    const code = await main(['publish', '--registry', REGISTRY], { run: docker.run, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(1);
    expect(io.err.join('\n')).toMatch(/push failed/);
    expect([...io.out, ...io.err].join('\n')).not.toContain(CANARY);
  });

  it('the script source never logs in, never uses a shell and never forwards Docker output', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/['"]login['"]/);
    expect(source).not.toMatch(/shell:\s*true|\bexecSync\b|\bspawnSync\b|\bexec\(/);
    expect(source).not.toMatch(/stdio:\s*['"]inherit['"]/);
    // stderr is only classified (absent tag vs. anything else), never interpolated or printed.
    expect(source).not.toMatch(/\$\{[^}]*stderr[^}]*\}|(?:log|stdout|stderr|console\.\w+)\([^)]*\.stderr/);
  });
});
