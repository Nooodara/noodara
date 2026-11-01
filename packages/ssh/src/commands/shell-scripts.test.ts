// 23-04 H1/H3: the env file never leaks through a docker read, and its write is verified.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SHELL_SCRIPTS } from './shell-scripts.js';

const here = dirname(fileURLToPath(import.meta.url));
const templateSources = readdirSync(here)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => ({ file, text: readFileSync(join(here, file), 'utf8') }));

describe('H1: no template reads a container env', () => {
  it.each(templateSources.map(({ file, text }) => [file, text] as const))(
    '%s never selects .Config.Env or the whole .Config',
    (_file, text) => {
      expect(text).not.toMatch(/Config\.Env/);
      expect(text).not.toMatch(/\{\{\s*json\s+\.Config\s*\}\}/);
      expect(text).not.toMatch(/\{\{\s*\.Config\s*\}\}/);
    },
  );

  it('every whole-object `{{json .}}` format belongs to docker ps, image ls or version (no env in their output)', () => {
    const owners: string[] = [];
    for (const { text } of templateSources) {
      for (const match of text.matchAll(/\{\{json \.\}\}/g)) {
        const before = text.slice(0, match.index);
        const name = [...before.matchAll(/["']docker\.([a-z_]+)["']/g)].at(-1)?.[1] ?? 'unknown';
        owners.push(name);
      }
    }
    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners) expect(['ps', 'image_list_service', 'version']).toContain(owner);
  });
});

describe('H3: writeEnvFileFromStdin', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-file-'));
    dirs.push(dir);
    return dir;
  };
  const run = (script: string, args: readonly string[], stdin: string) =>
    spawnSync('/bin/sh', ['-c', script, ...args], { input: stdin, encoding: 'utf8', timeout: 10_000 });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file 0600 under umask 077 through a temp file renamed into place', () => {
    const script = SHELL_SCRIPTS.writeEnvFileFromStdin;
    expect(script.startsWith('umask 077 && ')).toBe(true);
    expect(script).toContain('cat > "$0.tmp"');
    expect(script).toContain('mv -f "$0.tmp" "$0"');
    expect(script).toContain('[ "$n" -eq "$1" ]');
  });

  it('writes exactly stdin when the byte count matches', () => {
    const file = join(tempDir(), 'env');
    const content = 'A=1\nTOKEN=s3cr3t-value\n';
    const result = run(SHELL_SCRIPTS.writeEnvFileFromStdin, [file, String(Buffer.byteLength(content))], content);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('a short write (count mismatch) exits non-zero and leaves neither the file nor the temp', () => {
    const file = join(tempDir(), 'env');
    const content = 'A=1\n';
    const result = run(SHELL_SCRIPTS.writeEnvFileFromStdin, [file, String(Buffer.byteLength(content) + 1)], content);

    expect(result.status).not.toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('a target directory that does not exist exits non-zero', () => {
    const file = join(tempDir(), 'missing', 'env');
    const result = run(SHELL_SCRIPTS.writeEnvFileFromStdin, [file, '4'], 'A=1\n');
    expect(result.status).not.toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});

describe('H2: removeSecretFile', () => {
  it('removes one file and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-env-rm-'));
    try {
      const file = join(dir, 'env');
      const write = spawnSync('/bin/sh', ['-c', SHELL_SCRIPTS.writeSecretFromStdin, file], { input: 'A=1\n' });
      expect(write.status).toBe(0);
      for (let i = 0; i < 2; i += 1) {
        const removed = spawnSync('/bin/sh', ['-c', SHELL_SCRIPTS.removeSecretFile, file], { encoding: 'utf8' });
        expect(removed.status).toBe(0);
      }
      expect(existsSync(file)).toBe(false);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
