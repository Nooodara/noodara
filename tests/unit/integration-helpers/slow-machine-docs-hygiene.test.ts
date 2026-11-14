// 36-02 H5: the slow-machine run reports under docs/testing/slow-machines/ are written from real
// runs on contributor machines, so they must never carry home paths, IP addresses, host or user
// names, token-shaped strings or full UUIDs. This enforces the A1 rule on every `pnpm test`
// instead of leaving it to review. The verdict depends only on the committed text, never on the
// machine running the suite (no os.hostname()/os.userInfo() literals; see MachineIdentities).
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  { name: 'user@host prompt', pattern: /\b[a-z_][a-z0-9_.-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,62}:[~/]/ },
  { name: 'Windows default hostname', pattern: /\b(?:DESKTOP|LAPTOP)-[A-Z0-9]{7,8}\b/ },
];

/**
 * Literal machine identities (a hostname or user name) are optional, injected inputs; they are
 * never read from the machine running the suite, so the verdict on a committed report does not
 * depend on who runs `pnpm test`. An injected value is only matched when it is distinctive
 * (6+ characters with a digit or a hyphen, e.g. `build-box-07`): ordinary words such as `ubuntu`,
 * `test` or `noodara` legitimately appear in a run report. Host and user names are otherwise
 * caught structurally: home paths, `user@host:` prompts and Windows default hostnames.
 */
interface MachineIdentities { readonly hostname?: string; readonly username?: string }

function identityRule(name: string, value: string | undefined): { name: string; pattern: RegExp } | undefined {
  const literal = (value ?? '').trim().toLowerCase();
  if (literal.length < 6 || !/[0-9-]/.test(literal)) return undefined;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { name, pattern: new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i') };
}

function findLeaks(text: string, identities: MachineIdentities = {}): string[] {
  const rules = [...RULES];
  for (const rule of [
    identityRule('run machine hostname', identities.hostname),
    identityRule('run machine user name', identities.username),
  ]) if (rule !== undefined) rules.push(rule);
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
    expect(findLeaks(sample)).toContain(`line 1: ${rule}`);
  });

  // The verdict on a committed report must not depend on the machine running the suite: ordinary
  // hostnames and user names that also appear as words in a report never flag it.
  it.each(files.filter((file) => file.endsWith('.md')).flatMap((file) => [
    'ubuntu', 'docker', 'test', 'noodara', 'wsl2', 'local', 'build',
  ].map((word) => [path.basename(file), word, file])))(
    '%s is not flagged when the runner hostname and user name are the ordinary word %s', (_name, word, file) => {
      expect(findLeaks(readFileSync(file, 'utf8'), { hostname: word, username: word })).toEqual([]);
    },
  );

  it('does not read the live machine: an injected ordinary hostname or user name never flags a line', () => {
    expect(findLeaks('Ubuntu 24.04 test run on the noodara VM', { hostname: 'ubuntu', username: 'test' })).toEqual([]);
  });

  it('flags a distinctive injected hostname, whatever its case', () => {
    expect(findLeaks('built on Build-Box-07 at night', { hostname: 'build-box-07' }))
      .toEqual(['line 1: run machine hostname']);
  });

  it('flags a distinctive injected user name', () => {
    expect(findLeaks('owned by dev-user42 today', { username: 'dev-user42' })).toEqual(['line 1: run machine user name']);
  });

  it.each([
    ['user@host prompt', `${user}@${'build-box'}:~/noodara$ pnpm test`],
    ['Windows default hostname', `${'DESKTOP'}-${'A1B2C3D'} ran the suite`],
  ])('flags a %s structurally, without any injected identity', (rule, sample) => {
    expect(findLeaks(sample)).toContain(`line 1: ${rule}`);
  });

  it.each([
    'Ubuntu 22.04 and 24.04, Node 22.12, vitest 3.2.4',
    'Duration 831.23s, 140949 ms against a 120000 ms budget',
    'timestamps 01:59:11 and log 2026-11-12T02-23-18-858Z-gate-it-ssh-contracts.log',
    'owner prefix 3f2b8c1d, short sha 19c4fd70',
    'the token-shaped strings rule and readyTimeout: 5000',
  ])('does not flag ordinary run data: %s', (line) => {
    expect(findLeaks(line)).toEqual([]);
  });
});
