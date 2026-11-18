// 35-04 A7 regression: the real-Playwright SSH cancellation contract runs in the CI unit job,
// which installs dependencies and runs `pnpm test` with no build step. Its subprocess therefore
// must load the SSH fixture without touching apps/control-plane or any workspace `dist`
// (CI 43043093057 failed with "Cannot find module .../@noodara/domain/dist/server/index.js").
// This walks the fixture module's static and dynamic import graph and fails if it reaches either
// again, and pins the single sshTest definition that stack.ts re-exports.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const relative = (file: string): string => path.relative(root, file).split(path.sep).join('/');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** Workspace code a dist-free checkout cannot load from a plain Node/Playwright process. */
function workspaceViolation(file: string): string | undefined {
  const rel = relative(file);
  if (rel.startsWith('..')) return undefined;
  if (rel.startsWith('apps/')) return `reaches ${rel}`;
  if (/^(?:apps|packages)\/[^/]+\/dist(?:\/|$)/.test(rel)) return `reaches workspace dist ${rel}`;
  return undefined;
}

function resolveLocal(from: string, specifier: string): string | undefined {
  const target = path.resolve(path.dirname(from), specifier);
  const stem = target.replace(/\.(?:m|c)?js$/, '');
  const candidates = [target, ...SOURCE_EXTENSIONS.map((ext) => stem + ext), ...SOURCE_EXTENSIONS.map((ext) => path.join(target, `index${ext}`))];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** Directory the bare specifier resolves to (following pnpm/workspace symlinks), if installed. */
function resolvePackageDir(from: string, name: string): string | undefined {
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(candidate)) return realpathSync(candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
}

interface Graph { readonly files: readonly string[]; readonly violations: readonly string[] }

/** Repo-local module graph from `entry`. External packages are leaves; workspace ones are violations. */
function moduleGraph(entry: string): Graph {
  const files: string[] = [];
  const violations: string[] = [];
  const pending = [entry];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    files.push(relative(file));
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const { fileName: specifier } of importedFiles) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
        const resolved = resolveLocal(file, specifier);
        if (resolved === undefined) {
          violations.push(`${relative(file)}: unresolved ${specifier}`);
          continue;
        }
        const violation = workspaceViolation(resolved);
        if (violation !== undefined) violations.push(`${relative(file)}: ${violation}`);
        else if (!relative(resolved).includes('node_modules/')) pending.push(resolved);
        continue;
      }
      const name = packageName(specifier);
      if (name.startsWith('@noodara/')) {
        violations.push(`${relative(file)}: imports workspace package ${specifier}`);
        continue;
      }
      const dir = resolvePackageDir(file, name);
      if (dir === undefined) {
        violations.push(`${relative(file)}: unresolved package ${specifier}`);
        continue;
      }
      // A non-@noodara name that symlinks into the workspace is still workspace code.
      const rel = relative(dir);
      if (!rel.startsWith('..') && /^(?:apps|packages)\//.test(rel)) {
        violations.push(`${relative(file)}: imports workspace package ${specifier} (${rel})`);
      }
    }
  }
  return { files, violations };
}

const fixtureModule = path.join(root, 'tests/e2e/fixtures/ssh-fixture.ts');
const stackModule = path.join(root, 'tests/e2e/fixtures/stack.ts');

describe('SSH Playwright fixture module graph (35-04 A7)', () => {
  it('loads without apps/control-plane, workspace packages or any workspace dist', () => {
    const graph = moduleGraph(fixtureModule);
    expect(graph.violations).toEqual([]);
    // Non-vacuous: the walk really followed the fixture into the lifecycle helpers it owns.
    expect(graph.files).toEqual(expect.arrayContaining([
      'tests/e2e/fixtures/ssh-fixture.ts',
      'tests/integration/helpers/ssh.ts',
      'tests/integration/helpers/container-start.ts',
      'tests/integration/helpers/test-resources.ts',
    ]));
  });

  it('detects the stack module graph reaching apps/control-plane (detector control)', () => {
    // stack.ts legitimately composes the full E2E stack; it is exactly the graph the
    // subprocess must avoid. If the detector stopped flagging it, the guard above would be vacuous.
    const graph = moduleGraph(stackModule);
    expect(graph.violations.some((violation) => violation.includes('reaches apps/control-plane/'))).toBe(true);
  });

  it('keeps one sshTest definition, re-exported unchanged by stack.ts for the E2E specs', () => {
    const e2eDir = path.join(root, 'tests/e2e');
    const definitions = readdirSync(e2eDir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => /\.(?:m|c)?[jt]sx?$/.test(entry))
      .filter((entry) => /export\s+const\s+sshTest\b|startOwnedSshd\s*:\s*async/.test(readFileSync(path.join(e2eDir, entry), 'utf8')))
      .map((entry) => entry.split(path.sep).join('/'));
    expect(definitions).toEqual(['fixtures/ssh-fixture.ts']);
    const stack = readFileSync(stackModule, 'utf8');
    expect(stack).toMatch(/export\s*\{[^}]*\bsshTest\b[^}]*\}\s*from\s*'\.\/ssh-fixture\.js'/);
    for (const spec of ['critical-path.spec.ts', 'discovery.spec.ts']) {
      expect(readFileSync(path.join(e2eDir, spec), 'utf8')).toMatch(/import\s*\{[^}]*\bsshTest as test\b[^}]*\}\s*from\s*'\.\/fixtures\/stack\.js'/);
    }
  });
});
