// 06-06-PLAN.md: install.sh's version/public-URL/image-prefix resolution -- the three values the
// installer cannot know in advance (06-CONTEXT.md D-04/D-07/D-19). Exercised under every available
// real POSIX interpreter (/bin/sh, plus dash when present), never bash (06-RESEARCH.md Pitfall 1),
// mirroring preflight.test.ts's and env-file.test.ts's own conventions.
//
// hard_rule #8: no test here ever performs a real network call. Every case that would otherwise
// reach out defines its own noodara_fetch_url (and, for the local-IP fallback, `ip`) shell function
// after sourcing install.sh, shadowing the real one -- the one injectable seam every resolution
// function in install.sh goes through.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTALL_SH, posixInterpreters, runInstallerShell, type RunInstallerShellResult } from './sh-harness.js';

/** POSIX single-quote escaping for embedding an arbitrary value into a shell snippet. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveVersion(
  interpreter: string,
  stubSnippet: string,
  extraEnv: Record<string, string> = {},
): RunInstallerShellResult {
  const snippet = `${stubSnippet}\nnoodara_resolve_version`;
  return runInstallerShell(interpreter, snippet, { env: extraEnv });
}

function resolvePublicUrl(
  interpreter: string,
  stubSnippet: string,
  extraEnv: Record<string, string> = {},
): RunInstallerShellResult {
  const snippet = `${stubSnippet}\nnoodara_resolve_public_url`;
  return runInstallerShell(interpreter, snippet, { env: extraEnv });
}

// Structural acceptance criterion (06-06-PLAN.md Task 1): every `curl` invocation outside a
// comment lives inside noodara_fetch_url -- the single injectable network seam. Not scoped to any
// interpreter since it only reads install.sh's own source text.
describe('install.sh curl call-site discipline (06-06-PLAN.md Task 1)', () => {
  it('every non-comment curl invocation lives inside noodara_fetch_url', () => {
    // 06-06-PLAN.md's own literal acceptance text (`grep -v '^[[:space:]]*#' install.sh | grep -c
    // 'curl '`) false-positives against Plan 06-02's pre-existing (out-of-scope)
    // noodara_check_base_commands, whose `for cmd in curl openssl ss ip awk grep; do` line lists
    // "curl" as a required base-command *name*, not a curl invocation -- the literal command
    // returns 3, not 2, on this file today, confirmed by running it directly. Matching on `curl -`
    // (every genuine invocation in this file passes at least one flag) instead of the bare
    // substring `curl ` preserves the criterion's actual intent -- "no other function may call
    // curl directly" -- without being defeated by that pre-existing, unrelated line.
    const source = readFileSync(INSTALL_SH, 'utf8');
    const lines = source.split('\n');
    const nonCommentLines = lines.filter((line) => !line.trim().startsWith('#'));
    const totalCurlCalls = nonCommentLines.filter((line) => line.includes('curl -')).length;

    const startIndex = source.indexOf('noodara_fetch_url() {');
    expect(startIndex).toBeGreaterThan(-1);
    const afterStart = source.slice(startIndex);
    const endIndex = afterStart.indexOf('\n}\n');
    expect(endIndex).toBeGreaterThan(-1);
    const functionBody = afterStart.slice(0, endIndex);
    const curlCallsInFunction = functionBody
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => line.includes('curl -')).length;

    expect(totalCurlCalls).toBeGreaterThan(0);
    expect(totalCurlCalls).toBe(curlCallsInFunction);
    // Locked exact count so a future accidental second call site anywhere in the file is caught
    // even if it happened to land inside noodara_fetch_url's own body too.
    expect(totalCurlCalls).toBe(2);
  });

  it('install.sh contains NOODARA_INTERNAL_IMAGE_PREFIX and noodara_resolve_image_prefix', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');
    expect(source).toContain('NOODARA_INTERNAL_IMAGE_PREFIX');
    expect(source).toContain('noodara_resolve_image_prefix');
  });

  it('install.sh contains ifconfig.io, icanhazip.com and ipecho.net', () => {
    const source = readFileSync(INSTALL_SH, 'utf8');
    expect(source).toContain('ifconfig.io');
    expect(source).toContain('icanhazip.com');
    expect(source).toContain('ipecho.net');
  });
});

describe.each(posixInterpreters())('install.sh noodara_validate_tag (%s)', (interpreter) => {
  const rejections: Array<[string, string]> = [
    ['an embedded newline', '0.1.0\nEVIL=1'],
    ['a space', '0.1.0 evil'],
    ['an equals sign', '0.1.0=evil'],
    ['a semicolon', '0.1.0;evil'],
    ['a slash', '0.1.0/evil'],
    ['a command substitution open', '0.1.0$(evil)'],
    ['the literal latest', 'latest'],
  ];

  it.each(rejections)('rejects a tag containing %s with exit code 40', (_label, tag) => {
    const result = runInstallerShell(interpreter, `noodara_validate_tag ${shQuote(tag)}`);

    expect(result.status).toBe(40);
  });

  it('never echoes the rejected value in its failure message', () => {
    const result = runInstallerShell(interpreter, `noodara_validate_tag ${shQuote('0.1.0\nEVIL=1')}`);

    expect(result.status).toBe(40);
    expect(result.stderr).not.toContain('EVIL');
  });

  it('accepts a plain semver tag and exits 0', () => {
    const result = runInstallerShell(interpreter, 'noodara_validate_tag 0.1.0');

    expect(result.status).toBe(0);
  });
});

describe.each(posixInterpreters())('install.sh noodara_resolve_version (%s)', (interpreter) => {
  it('never calls the network when NOODARA_VERSION is set (invocation count is 0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-resolution-'));
    const logFile = join(dir, 'calls.log');
    const stub = [
      'noodara_fetch_url() {',
      '  printf "%s %s\\n" "$1" "$2" >> "$NOODARA_TEST_CALL_LOG"',
      '  return 1',
      '}',
    ].join('\n');

    const result = resolveVersion(interpreter, stub, {
      NOODARA_VERSION: '0.1.0',
      NOODARA_TEST_CALL_LOG: logFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.0');
    expect(existsSync(logFile)).toBe(false);
  });

  it('resolves via the releases/latest redirect tail when NOODARA_VERSION is unset', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  if [ "$1" = "redirect" ]; then',
      '    printf "https://github.com/example/repo/releases/tag/0.1.0"',
      '    return 0',
      '  fi',
      '  return 1',
      '}',
    ].join('\n');

    const result = resolveVersion(interpreter, stub);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.0');
  });

  it('falls back to the grep/sed-parsed API body when the redirect fails', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  case "$1" in',
      '    redirect) return 1 ;;',
      '    body) printf \'%s\' \'{"tag_name": "0.1.0", "name": "Release 0.1.0"}\' ;;',
      '  esac',
      '}',
    ].join('\n');

    const result = resolveVersion(interpreter, stub);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.0');
  });

  it('exits 40 naming NOODARA_VERSION when both resolution paths fail', () => {
    const stub = 'noodara_fetch_url() { return 1; }';

    const result = resolveVersion(interpreter, stub);

    expect(result.status).toBe(40);
    expect(result.stderr).toContain('NOODARA_VERSION');
  });

  it('rejects a hostile API body whose tag_name value is itself disallowed characters', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  case "$1" in',
      '    redirect) return 1 ;;',
      '    body) printf \'%s\' \'{"tag_name": "0.1.0; rm -rf /"}\' ;;',
      '  esac',
      '}',
    ].join('\n');

    const result = resolveVersion(interpreter, stub);

    expect(result.status).toBe(40);
  });

  it('rejects an HTML error page API body (no tag_name field to extract)', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  case "$1" in',
      '    redirect) return 1 ;;',
      '    body) printf \'%s\' \'<html><body>503 Service Unavailable</body></html>\' ;;',
      '  esac',
      '}',
    ].join('\n');

    const result = resolveVersion(interpreter, stub);

    expect(result.status).toBe(40);
  });

  it('rejects an empty API body', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  case "$1" in',
      '    redirect) return 1 ;;',
      '    body) printf \'\' ;;',
      '  esac',
      '}',
    ].join('\n');

    const result = resolveVersion(interpreter, stub);

    expect(result.status).toBe(40);
  });

  it('rejects a truncated API body split across a newline inside the tag_name value', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  case "$1" in',
      '    redirect) return 1 ;;',
      '    body) printf \'{"tag_name": "0.1.0\\nEVIL=1"}\' ;;',
      '  esac',
      '}',
    ].join('\n');

    const result = resolveVersion(interpreter, stub);

    expect(result.status).toBe(40);
  });

  it('never resolves to the literal "latest" even when the redirect tail says so', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  if [ "$1" = "redirect" ]; then',
      '    printf "https://github.com/example/repo/releases/tag/latest"',
      '    return 0',
      '  fi',
      '  return 1',
      '}',
    ].join('\n');

    const result = resolveVersion(interpreter, stub);

    expect(result.status).toBe(40);
  });

  it.each([
    ['0.1.0', '0.1.0'],
    ['v0.1.0', '0.1.0'],
    ['0.1.0-rc.1', '0.1.0-rc.1'],
  ])('normalises and validates operator-supplied %s -> %s', (input, expected) => {
    const result = runInstallerShell(interpreter, 'noodara_resolve_version', {
      env: { NOODARA_VERSION: input },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it('writes no file anywhere when NOODARA_VERSION carries a line-injection payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-resolution-'));

    const result = runInstallerShell(interpreter, 'noodara_resolve_version', {
      env: { NOODARA_VERSION: '0.1.0\nEVIL=1' },
      cwd: dir,
    });

    expect(result.status).toBe(40);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe.each(posixInterpreters())('install.sh noodara_resolve_image_prefix (%s)', (interpreter) => {
  it('defaults to NOODARA_REGISTRY/NOODARA_REPO_OWNER when no override is set', () => {
    const result = runInstallerShell(interpreter, 'noodara_resolve_image_prefix', {
      env: { NOODARA_REPO_OWNER: 'acme', NOODARA_REGISTRY: 'ghcr.io' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ghcr.io/acme');
  });

  it('returns NOODARA_INTERNAL_IMAGE_PREFIX verbatim when set (D-19, test-only)', () => {
    const result = runInstallerShell(interpreter, 'noodara_resolve_image_prefix', {
      env: { NOODARA_INTERNAL_IMAGE_PREFIX: 'localhost:5000/noodara' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('localhost:5000/noodara');
  });

  it.each([
    ['a space', 'ghcr.io/no space'],
    ['a double quote', 'ghcr.io/no"quote'],
    ['a dollar sign', 'ghcr.io/$evil'],
    ['a backtick', 'ghcr.io/`evil`'],
    ['a single quote', "ghcr.io/no'quote"],
    ['an embedded newline', 'ghcr.io/no\nquote'],
  ])('rejects an override containing %s', (_label, value) => {
    const result = runInstallerShell(interpreter, 'noodara_resolve_image_prefix', {
      env: { NOODARA_INTERNAL_IMAGE_PREFIX: value },
    });

    expect(result.status).toBe(30);
  });
});

describe.each(posixInterpreters())('install.sh noodara_get_public_ip (%s)', (interpreter) => {
  it('tries ifconfig.io, then icanhazip.com, then ipecho.net/plain, in exactly that order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodara-resolution-'));
    const logFile = join(dir, 'calls.log');
    const stub = [
      'noodara_fetch_url() {',
      '  printf "%s\\n" "$2" >> "$NOODARA_TEST_CALL_LOG"',
      '  case "$2" in',
      '    https://ipecho.net/plain) printf "203.0.113.9"; return 0 ;;',
      '    *) return 1 ;;',
      '  esac',
      '}',
      'noodara_get_public_ip',
    ].join('\n');

    const result = runInstallerShell(interpreter, stub, { env: { NOODARA_TEST_CALL_LOG: logFile } });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('203.0.113.9');
    const calls = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(calls).toEqual(['https://ifconfig.io', 'https://icanhazip.com', 'https://ipecho.net/plain']);
  });

  it('rejects an HTML body from the first service and consults the second', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  case "$2" in',
      '    https://ifconfig.io) printf "<html>captive portal</html>"; return 0 ;;',
      '    https://icanhazip.com) printf "203.0.113.9"; return 0 ;;',
      '    *) return 1 ;;',
      '  esac',
      '}',
      'noodara_get_public_ip',
    ].join('\n');

    const result = runInstallerShell(interpreter, stub);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('203.0.113.9');
  });

  it('returns non-zero when all three services fail', () => {
    // install.sh runs under `set -eu`: a bare `noodara_get_public_ip` failing as a plain top-level
    // command would abort the whole script before a following `printf` could report its exit
    // status. Wrapping it in `if`/`else` is the -e-safe way to observe a deliberate failure.
    const stub = [
      'noodara_fetch_url() { return 1; }',
      'if noodara_get_public_ip; then printf "STATUS=0\\n"; else printf "STATUS=1\\n"; fi',
    ].join('\n');

    const result = runInstallerShell(interpreter, stub);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STATUS=1');
  });
});

describe.each(posixInterpreters())('install.sh noodara_get_local_ip (%s)', (interpreter) => {
  it('extracts the src address from ip route get 1.1.1.1', () => {
    const stub = [
      'ip() {',
      '  printf "1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0\\n"',
      '}',
      'noodara_get_local_ip',
    ].join('\n');

    const result = runInstallerShell(interpreter, stub);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('10.0.0.5');
  });
});

describe.each(posixInterpreters())('install.sh noodara_resolve_public_url (%s)', (interpreter) => {
  it('returns NOODARA_PUBLIC_URL byte-identical, with no scheme normalisation, when set', () => {
    const result = runInstallerShell(interpreter, 'noodara_resolve_public_url', {
      env: { NOODARA_PUBLIC_URL: 'https://noodara.example.com' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('https://noodara.example.com');
  });

  it('does not call the public-IP or local-IP chain at all when the override is set', () => {
    const stub = ['noodara_fetch_url() { printf "SHOULD_NOT_BE_CALLED"; return 1; }', 'ip() { return 1; }'].join(
      '\n',
    );

    const result = resolvePublicUrl(interpreter, stub, { NOODARA_PUBLIC_URL: 'http://198.51.100.1:3000' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('http://198.51.100.1:3000');
  });

  it('resolves via the public-IP chain and includes the resolved port, with no trailing slash', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  case "$2" in',
      '    https://ifconfig.io) printf "203.0.113.9"; return 0 ;;',
      '    *) return 1 ;;',
      '  esac',
      '}',
    ].join('\n');

    const result = resolvePublicUrl(interpreter, stub, { NOODARA_PORT: '4000' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('http://203.0.113.9:4000');
    expect(result.stdout.trim().endsWith('/')).toBe(false);
    expect(result.stderr).toContain('203.0.113.9:4000');
    expect(result.stderr).toContain('NOODARA_PUBLIC_URL');
  });

  it('falls back to the local route IP and warns when every public-IP service fails', () => {
    const stub = [
      'noodara_fetch_url() { return 1; }',
      'ip() {',
      '  if [ "$1" = "route" ] && [ "$2" = "get" ]; then',
      '    printf "1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0\\n"',
      '    return 0',
      '  fi',
      '  return 1',
      '}',
    ].join('\n');

    const result = resolvePublicUrl(interpreter, stub);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('http://10.0.0.5:3000');
    expect(result.stderr).toContain('private');
  });

  it('exits 41 naming NOODARA_PUBLIC_URL as the manual remedy when every source fails', () => {
    const stub = ['noodara_fetch_url() { return 1; }', 'ip() { return 1; }'].join('\n');

    const result = resolvePublicUrl(interpreter, stub);

    expect(result.status).toBe(41);
    expect(result.stderr).toContain('NOODARA_PUBLIC_URL');
  });

  it('prints the resolved URL exactly once across combined stdout+stderr note text', () => {
    const stub = [
      'noodara_fetch_url() {',
      '  case "$2" in',
      '    https://ifconfig.io) printf "203.0.113.9"; return 0 ;;',
      '    *) return 1 ;;',
      '  esac',
      '}',
    ].join('\n');

    const result = resolvePublicUrl(interpreter, stub, { NOODARA_PORT: '3000' });

    expect(result.status).toBe(0);
    // The return-value line on stdout is the single line consumers capture via $(...); the note
    // (URL + remedy) lives on stderr instead, so it never corrupts that capture.
    expect(result.stdout.trim()).toBe('http://203.0.113.9:3000');
    const stdoutOccurrences = result.stdout.split('203.0.113.9:3000').length - 1;
    const stderrOccurrences = result.stderr.split('203.0.113.9:3000').length - 1;
    expect(stdoutOccurrences).toBe(1);
    expect(stderrOccurrences).toBe(1);
  });
});
