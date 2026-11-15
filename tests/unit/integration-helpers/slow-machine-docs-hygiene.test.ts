// 36-02 H5: the slow-machine run reports under docs/testing/slow-machines/ are written from real
// runs on contributor machines, so they must never carry home paths, IP addresses, host or user
// names, token-shaped strings or full UUIDs. This enforces the A1 rule on every `pnpm test`
// instead of leaving it to review. The verdict depends only on the committed text, never on the
// machine running the suite (no os.hostname()/os.userInfo() literals; see MachineIdentities).
// The rules themselves live in docs-hygiene-rules.ts, shared with other evidence directories.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { docFiles, findLeaks } from './docs-hygiene-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS_DIR = 'docs/testing/slow-machines';

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
