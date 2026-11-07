// 31-07 (rc.1 F1): the v0.5.0-rc.1 control-plane image shipped without packages/ai/dist, so the
// api and the worker died with ERR_MODULE_NOT_FOUND '@noodara/ai' before any code ran. The
// installer suite builds the image too, but only on main and nightly; this check runs in the PR
// `integration` job (and the it-boot gate): it builds the real image and starts both entrypoints.
//
// ESM links the whole static import graph before evaluating any module, so reaching env.ts's
// NOODARA_CONFIG_ERROR fail-fast (empty environment) proves every static import resolved inside
// the image. Each @noodara/* runtime dependency is also imported directly, which covers the
// dynamic `import('@noodara/ai')` in the provider key validator.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/boot-process.js';

// Test-only tag, never pushed.
const IMAGE_TAG = 'noodara-control-plane:test-31-07-boot';
const DOCKERFILE = 'apps/control-plane/Dockerfile';
const BUILD_TIMEOUT_MS = 900_000;
const RUN_TIMEOUT_MS = 60_000;
const REQUIRED_VARIABLES = ['NOODARA_MASTER_KEY', 'BETTER_AUTH_SECRET', 'DATABASE_URL', 'REDIS_URL', 'NOODARA_PUBLIC_URL'];

interface RunResult {
  readonly status: number | null;
  readonly output: string;
}

/** Runs a command, collecting stdout+stderr; rejects only on spawn errors or the timeout. */
function run(command: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} exceeded ${String(timeoutMs)} ms\n${output.slice(-4000)}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

/** Runs `node <args>` in the image with no environment beyond the image's own ENV. */
function nodeInImage(args: readonly string[]): Promise<RunResult> {
  return run(
    'docker',
    ['run', '--rm', '--label', 'noodara.test=true', '--entrypoint', 'node', IMAGE_TAG, ...args],
    RUN_TIMEOUT_MS,
  );
}

/** @noodara/* packages apps/control-plane imports at runtime (dependencies, not devDependencies). */
function runtimeWorkspaceDependencies(): string[] {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'apps/control-plane/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@noodara/'));
}

describe('control-plane production image boots its entrypoints (31-07)', () => {
  beforeAll(async () => {
    const build = await run('docker', ['build', '--file', DOCKERFILE, '--tag', IMAGE_TAG, '.'], BUILD_TIMEOUT_MS);
    if (build.status !== 0) throw new Error(`docker build failed (${String(build.status)}):\n${build.output.slice(-4000)}`);
  }, BUILD_TIMEOUT_MS + 30_000);

  afterAll(() => {
    spawnSync('docker', ['rmi', '-f', IMAGE_TAG], { stdio: 'ignore', timeout: 30_000 });
  });

  it.each(['dist/server.js', 'dist/worker.js'])(
    '%s resolves every import and reaches the env fail-fast',
    async (entry) => {
      const result = await nodeInImage([entry]);
      expect(result.output).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
      expect(result.status).toBe(1);
      for (const variable of REQUIRED_VARIABLES) {
        expect(result.output).toContain(`NOODARA_CONFIG_ERROR ${variable}`);
      }
    },
    RUN_TIMEOUT_MS + 10_000,
  );

  it(
    'imports every @noodara/* runtime dependency of apps/control-plane',
    async () => {
      const specifiers = runtimeWorkspaceDependencies();
      expect(specifiers).toContain('@noodara/ai');
      const script = 'for (const s of JSON.parse(process.argv[1])) { await import(s); } console.log("imported");';
      const result = await nodeInImage(['--input-type=module', '-e', script, JSON.stringify(specifiers)]);
      expect(result.output).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
      expect(result.status).toBe(0);
      expect(result.output.trim()).toBe('imported');
    },
    RUN_TIMEOUT_MS + 10_000,
  );
});
