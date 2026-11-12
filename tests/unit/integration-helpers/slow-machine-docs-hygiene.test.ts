// 36-02 H5: the slow-machine run reports under docs/testing/slow-machines/ are written from real
// runs on contributor machines, so they must never carry home paths, IP addresses, the run
// machine's hostname, token-shaped strings or full UUIDs. This enforces the A1 rule on every
// `pnpm test` instead of leaving it to review.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS_DIR = 'docs/testing/slow-machines';

const RULES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'home path', pattern: /[\\/](?:home|Users)[\\/][A-Za-z0-9._-]+/ },
  { name: 'Windows user path', pattern: /\b[A-Za-z]:[\\/]+Users[\\/]/i },
  { name: 'IPv4 address', pattern: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/ },
  { name: 'IPv6 address', pattern: /(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}(?::[0-9a-f]{1,4}){1,7}(?![\w:])|(?<![\w:])::1(?![\w:])/i },
  { name: 'full UUID', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: 'API key', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./ },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'credential assignment', pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"`]{8,}/i },
];

const IGNORED_HOSTNAMES = new Set(['localhost', 'docker-desktop']);

function hostnameRule(hostname: string): { name: string; pattern: RegExp } | undefined {
  const host = hostname.trim().toLowerCase();
  if (host.length < 4 || IGNORED_HOSTNAMES.has(host)) return undefined;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { name: 'run machine hostname', pattern: new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i') };
}

function findLeaks(text: string, hostname: string = os.hostname()): string[] {
  const rules = [...RULES];
  const hostRule = hostnameRule(hostname);
  if (hostRule !== undefined) rules.push(hostRule);
  const leaks: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const rule of rules) if (rule.pattern.test(line)) leaks.push(`line ${String(index + 1)}: ${rule.name}`);
  });
  return leaks;
}

function docFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? docFiles(full) : [full];
  });
}

describe('docs/testing/slow-machines hygiene (36-02 H5)', () => {
  const files = docFiles(path.join(root, DOCS_DIR));

  it('covers at least one run report', () => {
    expect(files.some((file) => file.endsWith('.md'))).toBe(true);
  });

  it.each(files.map((file) => [path.relative(root, file).split(path.sep).join('/'), file]))(
    '%s has no home paths, IPs, hostnames, tokens or full UUIDs',
    (_name, file) => {
      expect(findLeaks(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );

  // Samples are assembled at runtime so this file itself never contains a token-shaped literal.
  const user = ['con', 'tributor'].join('');
  it.each([
    ['home path', `log under /${'home'}/${user}/noodara`],
    ['home path', `macOS /${'Users'}/${user}/src`],
    ['home path', `wsl path \\\\wsl.localhost\\Ubuntu\\${'home'}\\${user}`],
    ['Windows user path', `C:${'\\'}Users${'\\'}${user}`],
    ['IPv4 address', `daemon at ${[10, 0, 0, 12].join('.')}:2375`],
    ['IPv6 address', `bound to ${['fe80', '', '1'].join(':')}`],
    ['full UUID', `owner ${['3f2b8c1d', '9a4e', '4b7f', '8c2d', '1e5f6a7b8c9d'].join('-')}`],
    ['GitHub token', `${'gh'}p_${'A1b2C3d4'.repeat(5)}`],
    ['API key', `${'sk'}-ant-${'x9Y8z7W6'.repeat(4)}`],
    ['AWS access key', `${'AK'}IA${'ABCDEFGH12345678'}`],
    ['Slack token', `${'xo'}xb-${'1234567890'}-abcdef`],
    ['JWT', `${'ey'}J${'hbGciOiJI'}.${'ey'}J${'zdWIiOiIx'}.sig`],
    ['private key', `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`],
    ['credential assignment', `${'pass'}word=${'hunter2hunter2'}`],
  ])('flags a %s', (rule, sample) => {
    expect(findLeaks(sample, 'example')).toContain(`line 1: ${rule}`);
  });

  it('flags the run machine hostname, whatever its case', () => {
    expect(findLeaks('built on Build-Box-07 at night', 'build-box-07')).toEqual(['line 1: run machine hostname']);
  });

  it.each([
    'Ubuntu 22.04 and 24.04, Node 22.12, vitest 3.2.4',
    'Duration 831.23s, 140949 ms against a 120000 ms budget',
    'timestamps 01:59:11 and log 2026-11-12T02-23-18-858Z-gate-it-ssh-contracts.log',
    'owner prefix 3f2b8c1d, short sha 19c4fd70',
    'the token-shaped strings rule and readyTimeout: 5000',
  ])('does not flag ordinary run data: %s', (line) => {
    expect(findLeaks(line, 'example')).toEqual([]);
  });
});
