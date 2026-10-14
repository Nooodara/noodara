// 14-30 (UAT finding 4): the probe runs the constant script against throwaway local repos, so the
// LFS rule is checked on real `git grep` output. LFS counts only from real evidence: a `filter=lfs`
// attribute on a non-comment .gitattributes line, or a file whose first line is the pointer header.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SHELL_SCRIPTS } from './shell-scripts.js';

const POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';
const POINTER = `${POINTER_HEADER}\noid sha256:${'a'.repeat(64)}\nsize 12\n`;

const repos: string[] = [];

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'noodara-probe-'));
  repos.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git('add', '-A');
  return dir;
}

function probe(dir: string): string {
  return execFileSync('sh', ['-c', SHELL_SCRIPTS.probeFeatures, dir], { encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('probeFeatures LFS detection (real evidence only)', () => {
  it.each([
    ['a root .gitattributes filter=lfs rule', { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' }],
    ['an indented rule in a nested .gitattributes', { 'assets/.gitattributes': '  *.psd filter=lfs -text\n' }],
    ['a rule whose filter=lfs is the last attribute', { '.gitattributes': '*.zip -text filter=lfs\n' }],
    ['a pointer file (first line is the spec header)', { 'model.bin': POINTER }],
    ['a pointer file in a subdirectory', { 'data/weights/model.bin': POINTER }],
  ])('reports lfs=1 for %s', (_label, files) => {
    expect(probe(repoWith({ 'README.md': 'x\n', ...files }))).toBe('submodules=0\nlfs=1\n');
  });

  it.each([
    ['docs that mention the spec header mid-file', { 'docs/lfs.md': `# LFS\n\nPointers start with:\n${POINTER_HEADER}\n` }],
    ['source code quoting the header', { 'src/probe.ts': `const header = '${POINTER_HEADER}';\n` }],
    ['the header indented on the first line', { 'notes.txt': `  ${POINTER_HEADER}\n` }],
    ['the header with trailing text on the first line', { 'notes.txt': `${POINTER_HEADER} (example)\n` }],
    ['a commented-out .gitattributes rule', { '.gitattributes': '# *.bin filter=lfs diff=lfs merge=lfs -text\n' }],
    ['an indented commented-out rule', { '.gitattributes': '   # *.bin filter=lfs -text\n* text=auto\n' }],
    ['filter=lfs in a file that is not .gitattributes', { 'scripts/setup.sh': 'echo "*.bin filter=lfs" >> .gitattributes\n' }],
    ['filter=lfs in a *.gitattributes-suffixed file', { 'example.gitattributes': '*.bin filter=lfs -text\n' }],
    ['a different filter in .gitattributes', { '.gitattributes': '*.bin filter=lfsx -text\n*.c filter=indent\n' }],
  ])('reports lfs=0 for %s', (_label, files) => {
    expect(probe(repoWith({ 'README.md': 'x\n', ...files }))).toBe('submodules=0\nlfs=0\n');
  });

  it('reports lfs=0 for a repository that only mentions the header after other content (this repo)', () => {
    const dir = repoWith({ 'README.md': `See ${POINTER_HEADER}\n`, 'a.ts': `\n${POINTER_HEADER}\n` });

    expect(probe(dir)).toBe('submodules=0\nlfs=0\n');
  });
});
