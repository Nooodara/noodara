import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 31-07 (rc.1 F1): the runner stage of apps/control-plane/Dockerfile copies each workspace
// package's dist/ by hand, and rc.1 forgot packages/ai. tests/integration/boot/
// control-plane-image.test.ts builds and boots the real image; this is the fast static twin that
// runs on every `pnpm test`.

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as Manifest;

const workspaceDeps = (manifest: Manifest): string[] =>
  Object.entries(manifest.dependencies ?? {})
    .filter(([name, range]) => name.startsWith('@noodara/') && range.startsWith('workspace:'))
    .map(([name]) => name.slice('@noodara/'.length));

/** packages/<dir> names apps/control-plane needs at runtime, following dependencies transitively. */
function runtimeWorkspacePackages(): string[] {
  const seen = new Set<string>();
  const queue = workspaceDeps(readManifest('apps/control-plane'));
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...workspaceDeps(readManifest(`packages/${next}`)));
  }
  return [...seen].sort();
}

/** packages/<dir> names whose dist/ the runner stage copies from the builder. */
function runnerDistCopies(dockerfile: string): string[] {
  const runner = dockerfile.split(/^FROM .* AS runner$/m)[1] ?? '';
  return [...runner.matchAll(/^COPY --from=builder\b.*\s\/app\/packages\/([^/\s]+)\/dist\s+\/app\/packages\/\1\/dist\s*$/gm)]
    .map((match) => match[1]!)
    .sort();
}

describe('apps/control-plane/Dockerfile runner layout (31-07)', () => {
  const dockerfile = readFileSync('apps/control-plane/Dockerfile', 'utf8');

  it('copies the dist of every workspace package the control plane imports at runtime', () => {
    const needed = runtimeWorkspacePackages();
    expect(needed).toEqual(expect.arrayContaining(['ai', 'docker', 'domain', 'git', 'ssh']));
    expect(runnerDistCopies(dockerfile)).toEqual(expect.arrayContaining(needed));
  });

  it('flags the rc.1 runner stage that left packages/ai/dist behind', () => {
    const rc1 = dockerfile.replace(/^COPY --from=builder .*\/app\/packages\/ai\/dist.*\n/m, '');
    expect(rc1).not.toBe(dockerfile);
    const missing = runtimeWorkspacePackages().filter((name) => !runnerDistCopies(rc1).includes(name));
    expect(missing).toEqual(['ai']);
  });
});
