import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// D-13: the three official fixtures (node-api, static-app, failing-build) must exist with a
// .dockerignore, a digest-pinned FROM, a tiny build context and no build-time secrets surface.
// Paths are resolved from this file's own URL, never process.cwd(), so the test behaves the
// same regardless of which directory `vitest` is invoked from.
const TESTS_UNIT_FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_UNIT_FIXTURES_DIR, '..', '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

const FIXTURE_NAMES = ['node-api', 'static-app', 'failing-build', 'env-api'] as const;

const MAX_CONTEXT_BYTES = 1_048_576;

const FROM_DIGEST_PATTERN = /^FROM [a-z0-9./:-]+:[A-Za-z0-9_.-]+@sha256:[a-f0-9]{64}( AS [a-z]+)?$/;

const REQUIRED_DOCKERIGNORE_LINES = ['.git', 'node_modules', '*.md', '.env', '.env*', '*.pem', '*.key'];

function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function fixtureDir(name: string): string {
  return join(FIXTURES_DIR, name);
}

function readFixtureFile(name: string, relativePath: string): string {
  return readFileSync(join(fixtureDir(name), relativePath), 'utf8');
}

function fromLines(dockerfile: string): string[] {
  return dockerfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('FROM '));
}

describe('official fixtures (D-13)', () => {
  it.each(FIXTURE_NAMES)('%s has a Dockerfile and a .dockerignore', (name) => {
    expect(() => readFixtureFile(name, 'Dockerfile')).not.toThrow();
    expect(() => readFixtureFile(name, '.dockerignore')).not.toThrow();
  });

  it.each(FIXTURE_NAMES)('%s build context is under %d bytes', (name) => {
    const totalBytes = walkFiles(fixtureDir(name)).reduce((sum, filePath) => sum + statSync(filePath).size, 0);

    expect(totalBytes).toBeLessThan(MAX_CONTEXT_BYTES);
  });

  it.each(FIXTURE_NAMES)('%s .dockerignore excludes secrets and VCS/build noise', (name) => {
    const dockerignore = readFixtureFile(name, '.dockerignore');
    const lines = dockerignore.split('\n').map((line) => line.trim());

    for (const requiredLine of REQUIRED_DOCKERIGNORE_LINES) {
      expect(lines).toContain(requiredLine);
    }
  });

  it.each(FIXTURE_NAMES)('%s pins every FROM by sha256 digest', (name) => {
    const dockerfile = readFixtureFile(name, 'Dockerfile');
    const lines = fromLines(dockerfile);

    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect(line).toMatch(FROM_DIGEST_PATTERN);
    }
  });

  it.each(FIXTURE_NAMES)('%s Dockerfile has no build args or secret-shaped env values', (name) => {
    const dockerfile = readFixtureFile(name, 'Dockerfile');

    expect(dockerfile).not.toMatch(/^ARG /m);
    expect(dockerfile).not.toContain('--build-arg');
    expect(dockerfile).not.toMatch(/^ENV .*(SECRET|TOKEN|PASSWORD)/m);
    expect(dockerfile).not.toContain(':latest');
  });

  it('failing-build fails deterministically with the recognizable marker and exit code 42', () => {
    const dockerfile = readFixtureFile('failing-build', 'Dockerfile');

    expect(dockerfile).toContain('exit 42');
    expect(dockerfile).toContain('NOODARA_FIXTURE_BUILD_FAILURE');
  });

  it('node-api exposes port 3000 and drops to a non-root user', () => {
    const dockerfile = readFixtureFile('node-api', 'Dockerfile');

    expect(dockerfile).toContain('EXPOSE 3000');
    expect(dockerfile).toMatch(/^USER (?!root)\S+$/m);
  });

  it('static-app exposes port 80', () => {
    const dockerfile = readFixtureFile('static-app', 'Dockerfile');

    expect(dockerfile).toContain('EXPOSE 80');
  });

  it('env-api exposes port 3000, drops to a non-root user and answers digests, never values (23-04 A5)', () => {
    const dockerfile = readFixtureFile('env-api', 'Dockerfile');
    expect(dockerfile).toMatch(/^EXPOSE 3000$/m);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/^ENV /m);
    const server = readFixtureFile('env-api', 'server.js');
    expect(server).toContain("url.pathname === '/health'");
    expect(server).toContain("url.pathname === '/env-digest'");
    expect(server).toContain("createHash('sha256')");
    // The response is the digest: the raw variable is never written back.
    expect(server).not.toMatch(/res\.end\(value\)/);
  });

  it.each([false, true])('env-api runtime emission requires explicit test opt-in (%s)', (enabled) => {
    const value = 'ordinary-fixture-value';
    const output: string[] = [];
    interface Response { writeHead(status: number): void; end(body?: string): void }
    let handler: ((request: { method: string; url: string }, response: Response) => void) | undefined;
    const source = readFixtureFile('env-api', 'server.js').replace(/^import .*;\n/gm, '');
    runInNewContext(source, {
      createHash, URL, Buffer,
      createServer: (callback: typeof handler) => {
        handler = callback;
        return { listen: () => undefined, close: () => undefined };
      },
      process: {
        env: { API_TOKEN: value, ...(enabled ? { NOODARA_TEST_EMIT_SECRET_NAME: 'API_TOKEN' } : {}) },
        stdout: { write: (text: string) => output.push(text) },
        stderr: { write: (text: string) => output.push(text) },
        on: () => undefined,
      },
    });
    const request = (method: string, url: string) => {
      let status = 0;
      let body = '';
      if (!handler) throw new Error('fixture handler missing');
      handler({ method, url }, { writeHead: (code) => { status = code; }, end: (text) => { body = text ?? ''; } });
      return { status, body };
    };
    expect(request('GET', '/env-digest?name=API_TOKEN')).toEqual({
      status: 200, body: createHash('sha256').update(value).digest('hex'),
    });
    expect(output).toEqual([]);
    expect(request('GET', '/test-emit-secret').status).toBe(404);
    const emitted = request('POST', '/test-emit-secret');
    expect(emitted).toEqual({ status: enabled ? 204 : 404, body: enabled ? '' : 'not found' });
    if (enabled) {
      expect(output.join('')).toContain(value);
      expect(output.join('')).toContain(Buffer.from(value).toString('base64'));
    } else {
      expect(output).toEqual([]);
    }
  });

  it('pnpm-workspace.yaml does not turn fixtures/* into workspace packages', () => {
    const workspaceYaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');

    expect(workspaceYaml).not.toMatch(/fixtures\/\*/);
  });
});
