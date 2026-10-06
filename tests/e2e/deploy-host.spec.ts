// 13-06: smoke for the e2e deploy host (fixtures/deploy-host.ts). Starts it once for this file
// through the worker-scoped `deployHost` fixture, checks the handle (A2), readiness (H2),
// redaction and secret placement (H1/H3), and the run-scoped, idempotent sweep (H1).
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { inspect, promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { REGISTRY_IMAGE } from '../integration/helpers/registry.js';
import {
  DeployHostExecTimeoutError,
  DeployHostStartupError,
  RUN_DIR_ENV,
  RUN_ID_ENV,
  RUN_LABEL_KEY,
  expect,
  startDeployHost,
  sweepRunResources,
  test,
} from './fixtures/deploy-host.js';
import { RUN_MANIFEST_PATH } from './global-setup.js';

const execFileAsync = promisify(execFile);

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', [...args], { timeout: 60_000 });
  return stdout.trim();
}

test.describe('@deploy-host e2e deploy host', () => {
  test('runs docker info inside the deploy host', async ({ deployHost }) => {
    const result = await deployHost.exec(['docker', 'info', '--format', '{{.ServerVersion}}'], { user: 'deployer' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);
  });

  test('exposes ssh data, repo urls and listings', async ({ deployHost }) => {
    expect(deployHost.ssh.user).toBe('deployer');
    expect(deployHost.ssh.port).toBeGreaterThan(0);
    expect(deployHost.ssh.privateKey).toContain('PRIVATE KEY');
    expect(deployHost.repos.nodeApi).toMatch(/node-api\.git$/);
    expect(deployHost.repos.failingBuild).toMatch(/failing-build\.git$/);

    const images = await deployHost.listImages();
    for (const ref of deployHost.preloadedImages) expect(images).toContain(ref);
    expect(await deployHost.listNetworks()).toContain('bridge');
    expect(await deployHost.listWorkspaces()).toEqual([]);
    expect(Array.isArray(await deployHost.listContainers())).toBe(true);
  });

  test('curls a port published inside the deploy host', async ({ deployHost }) => {
    const nginx = deployHost.preloadedImages.find((ref) => ref.includes('/nginx'));
    expect(nginx, 'an nginx base image is preloaded').toBeDefined();
    const name = `e2e-smoke-${randomUUID().slice(0, 8)}`;
    const run = await deployHost.exec(['docker', 'run', '-d', '--name', name, '-p', '18080:80', String(nginx)], {
      user: 'deployer',
    });
    expect(run.exitCode, run.stderr).toBe(0);
    try {
      expect(await deployHost.listContainers()).toContain(name);
      await expect
        .poll(async () => (await deployHost.curlPublishedPort(18080, '/')).status, { timeout: 20_000 })
        .toBe(200);
    } finally {
      await deployHost.exec(['docker', 'rm', '-f', name], { user: 'deployer' });
    }
  });

  test('exec redacts per-run secrets and enforces a per-call timeout', async ({ deployHost }) => {
    const echoed = await deployHost.exec(['sh', '-c', 'printf "%s\\n%s" "$1" "$2"', 'sh', deployHost.registry.password, deployHost.ssh.privateKey]);
    expect(echoed.exitCode).toBe(0);
    expect(echoed.stdout).not.toContain(deployHost.registry.password);
    expect(echoed.stdout).not.toContain('PRIVATE KEY');
    expect(echoed.stdout).toContain('<redacted>');

    const failed = await deployHost.exec(['sh', '-c', 'exit 3']);
    expect(failed.exitCode).toBe(3);

    await expect(deployHost.exec(['sleep', '10'], { timeoutMs: 500 })).rejects.toBeInstanceOf(DeployHostExecTimeoutError);
  });

  test('keeps per-run secrets out of serialized handles and inside the run temp dir', async ({ deployHost }) => {
    const runDir = String(process.env[RUN_DIR_ENV]);
    const secrets = [deployHost.ssh.privateKey, deployHost.deployKey.privateKey, deployHost.registry.password];
    // Crypto-grade, per-run: never a fixed literal, never the same across the two keys.
    expect(deployHost.registry.password.length).toBeGreaterThanOrEqual(24);
    expect(deployHost.ssh.privateKey).not.toBe(deployHost.deployKey.privateKey);

    const views = [JSON.stringify(deployHost), inspect(deployHost, { depth: 5 }), readFileSync(RUN_MANIFEST_PATH, 'utf8')];
    for (const view of views) for (const secret of secrets) expect(view).not.toContain(secret);

    expect(deployHost.ssh.privateKeyPath.startsWith(`${runDir}/`)).toBe(true);
    expect(statSync(deployHost.ssh.privateKeyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(deployHost.ssh.privateKeyPath, 'utf8')).toBe(deployHost.ssh.privateKey);
  });

  test('labels its resources with the run id so teardown finds them', async ({ deployHost }) => {
    const runId = String(process.env[RUN_ID_ENV]);
    expect(deployHost.runId).toBe(runId);
    const filter = `label=${RUN_LABEL_KEY}=${runId}`;
    expect(await docker(['ps', '-q', '--filter', filter])).not.toBe('');
    expect(await docker(['network', 'ls', '-q', '--filter', filter])).not.toBe('');
    expect(await docker(['volume', 'ls', '-q', '--filter', filter])).not.toBe('');
  });

  test('sweep is run-scoped and idempotent', async ({ deployHost }) => {
    // The deploy host already pulled REGISTRY_IMAGE for its registry; reuse it (create only, no run).
    expect(deployHost.registry.host).not.toBe('');
    const fakeRun = randomUUID();
    const otherRun = randomUUID();
    const network = `noodara-e2e-sweep-${fakeRun}`;
    await docker(['network', 'create', '--label', `${RUN_LABEL_KEY}=${fakeRun}`, network]);
    const volume = await docker(['volume', 'create', '--label', `${RUN_LABEL_KEY}=${fakeRun}`]);
    const labelled = await docker(['create', '--label', `${RUN_LABEL_KEY}=${fakeRun}`, '--label', 'noodara.test=true', '--network', network, REGISTRY_IMAGE]);
    // Mirrors the registry/mirror containers: no run label, only the run's network.
    const attached = await docker(['create', '--label', 'noodara.test=true', '--network', network, REGISTRY_IMAGE]);
    // Another run's container (e.g. a concurrent suite) must survive.
    const sibling = await docker(['create', '--label', `${RUN_LABEL_KEY}=${otherRun}`, '--label', 'noodara.test=true', REGISTRY_IMAGE]);
    try {
      await sweepRunResources(fakeRun);
      await sweepRunResources(fakeRun);
      expect(await docker(['ps', '-aq', '--filter', `id=${labelled}`])).toBe('');
      expect(await docker(['ps', '-aq', '--filter', `id=${attached}`])).toBe('');
      expect(await docker(['network', 'ls', '-q', '--filter', `name=${network}`])).toBe('');
      expect(await docker(['volume', 'ls', '-q', '--filter', `name=${volume}`])).toBe('');
      expect(await docker(['ps', '-aq', '--filter', `id=${sibling}`])).not.toBe('');
    } finally {
      await sweepRunResources(otherRun);
      await sweepRunResources(fakeRun);
    }
    await expect(sweepRunResources('')).rejects.toThrow(/invalid e2e run id/);
  });

  test('fails with a named error when the run environment is missing', async () => {
    const saved = process.env[RUN_ID_ENV];
    delete process.env[RUN_ID_ENV];
    try {
      const error = await startDeployHost().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(DeployHostStartupError);
      expect((error as DeployHostStartupError).stage).toBe('environment');
    } finally {
      process.env[RUN_ID_ENV] = saved;
    }
  });
});
