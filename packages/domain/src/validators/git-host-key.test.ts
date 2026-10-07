import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_GIT_HOST_KEYS,
  bundledGitHostKeysFor,
  gitSshEndpoint,
  knownHostsContent,
  knownHostsHostFor,
  normalizeGitHost,
  parseGitHostKeyLine,
  parseKeyscanOutput,
  sameKnownHostsHost,
  MAX_HOST_KEY_LINE_LENGTH,
  type GitHostKey,
  type GitSshEndpoint,
} from './git-host-key.js';
import { validateRepositoryUrl, type RepositoryUrl } from './git.js';

const ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const ECDSA =
  'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=';

function url(input: string): RepositoryUrl {
  const result = validateRepositoryUrl(input);
  if (!result.ok) throw new Error(`fixture url rejected: ${input}`);
  return result.value;
}

function parsed(line: string): GitHostKey {
  const result = parseGitHostKeyLine(line);
  if (!result.ok) throw new Error(`expected ${line} to parse: ${result.code}`);
  return result.value;
}

function rejection(line: string): string {
  const result = parseGitHostKeyLine(line);
  return result.ok ? 'ACCEPTED' : result.code;
}

function sha256Fingerprint(key: string): string {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

describe('BUNDLED_GIT_HOST_KEYS (H1)', () => {
  it('bundles ed25519, ecdsa and rsa keys for github.com, gitlab.com and bitbucket.org', () => {
    const summary = BUNDLED_GIT_HOST_KEYS.map((entry) => `${entry.host} ${entry.type}`).sort();

    expect(summary).toEqual(
      [
        'bitbucket.org ecdsa-sha2-nistp256',
        'bitbucket.org ssh-ed25519',
        'bitbucket.org ssh-rsa',
        'github.com ecdsa-sha2-nistp256',
        'github.com ssh-ed25519',
        'github.com ssh-rsa',
        'gitlab.com ecdsa-sha2-nistp256',
        'gitlab.com ssh-ed25519',
        'gitlab.com ssh-rsa',
      ].sort(),
    );
    expect(Object.isFrozen(BUNDLED_GIT_HOST_KEYS)).toBe(true);
  });

  it.each(BUNDLED_GIT_HOST_KEYS.map((entry) => [`${entry.host} ${entry.type}`, entry] as const))(
    '%s parses, has its declared type and matches the vendor-published fingerprint',
    (_label, entry) => {
      const key = parsed(entry.line);

      expect(key.host).toBe(entry.host);
      expect(key.type).toBe(entry.type);
      expect(sha256Fingerprint(key.key)).toBe(entry.fingerprint);
    },
  );

  it.each(BUNDLED_GIT_HOST_KEYS.map((entry) => [`${entry.host} ${entry.type}`, entry] as const))(
    '%s records an official https publication URL and fetch date',
    (_label, entry) => {
      expect(entry.provenance.url).toMatch(/^https:\/\/[a-z.]+\//);
      expect(entry.provenance.fingerprintUrl).toMatch(/^https:\/\/[a-z.]+\//);
      expect(entry.provenance.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );

  it('detects a substituted key: one changed base64 character changes the fingerprint', () => {
    const entry = BUNDLED_GIT_HOST_KEYS[0];
    if (!entry) throw new Error('no bundled keys');
    const key = parsed(entry.line).key;
    const tampered = `${key.slice(0, 40)}${key[40] === 'A' ? 'B' : 'A'}${key.slice(41)}`;

    expect(sha256Fingerprint(tampered)).not.toBe(entry.fingerprint);
  });
});

describe('parseGitHostKeyLine (A1, H2)', () => {
  it('parses a plain host line', () => {
    const key = parsed(`github.com ssh-ed25519 ${ED25519}`);

    expect(key).toEqual({ host: 'github.com', type: 'ssh-ed25519', key: ED25519 });
  });

  it('parses an ecdsa line with base64 padding', () => {
    expect(parsed(`example.com ecdsa-sha2-nistp256 ${ECDSA}`).type).toBe('ecdsa-sha2-nistp256');
  });

  it('normalizes case and trailing dots of the host', () => {
    expect(parsed(`GitHub.COM. ssh-ed25519 ${ED25519}`).host).toBe('github.com');
  });

  it('keeps [host]:port for a non-default port and folds [host]:22 to host', () => {
    expect(parsed(`[Git.Example.com.]:2222 ssh-ed25519 ${ED25519}`).host).toBe(
      '[git.example.com]:2222',
    );
    expect(parsed(`[git.example.com]:22 ssh-ed25519 ${ED25519}`).host).toBe('git.example.com');
  });

  it('accepts IPv4 and IPv6 literals', () => {
    expect(parsed(`203.0.113.7 ssh-ed25519 ${ED25519}`).host).toBe('203.0.113.7');
    expect(parsed(`[2001:DB8::1]:2222 ssh-ed25519 ${ED25519}`).host).toBe('[2001:db8::1]:2222');
    expect(parsed(`2001:db8::1 ssh-ed25519 ${ED25519}`).host).toBe('2001:db8::1');
  });

  it.each([
    ['non-string input', 42 as unknown as string, 'HOST_KEY_LINE_MALFORMED'],
    ['empty line', '', 'HOST_KEY_LINE_MALFORMED'],
    ['over-long input', `a.com ssh-ed25519 ${'A'.repeat(MAX_HOST_KEY_LINE_LENGTH)}`, 'HOST_KEY_LINE_TOO_LONG'],
    ['embedded newline', `github.com ssh-ed25519 ${ED25519}\nevil.com ssh-ed25519 ${ED25519}`, 'HOST_KEY_LINE_CONTROL_CHARACTER'],
    ['carriage return', `github.com ssh-ed25519 ${ED25519}\r`, 'HOST_KEY_LINE_CONTROL_CHARACTER'],
    ['tab separator', `github.com\tssh-ed25519 ${ED25519}`, 'HOST_KEY_LINE_CONTROL_CHARACTER'],
    ['NUL byte', `github.com\0 ssh-ed25519 ${ED25519}`, 'HOST_KEY_LINE_CONTROL_CHARACTER'],
    ['@cert-authority marker', `@cert-authority github.com ssh-ed25519 ${ED25519}`, 'HOST_KEY_LINE_MARKER'],
    ['@revoked marker', `@revoked github.com ssh-ed25519 ${ED25519}`, 'HOST_KEY_LINE_MARKER'],
    ['authorized_keys style option', `command="sh" ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['comment field', `github.com ssh-ed25519 ${ED25519} comment`, 'HOST_KEY_LINE_MALFORMED'],
    ['double space', `github.com  ssh-ed25519 ${ED25519}`, 'HOST_KEY_LINE_MALFORMED'],
    ['missing key', 'github.com ssh-ed25519', 'HOST_KEY_LINE_MALFORMED'],
    ['hashed host', `|1|F1E1KeoE/eEWhi10WpGv4OdiO6Y=|3988QV0VE8wmZL7suNrYQLITLCg= ssh-ed25519 ${ED25519}`, 'HOST_KEY_HASHED_HOST'],
    ['wildcard *', `*.github.com ssh-ed25519 ${ED25519}`, 'HOST_KEY_WILDCARD_HOST'],
    ['wildcard ?', `github.co? ssh-ed25519 ${ED25519}`, 'HOST_KEY_WILDCARD_HOST'],
    ['negation !', `!github.com ssh-ed25519 ${ED25519}`, 'HOST_KEY_WILDCARD_HOST'],
    ['host list', `github.com,140.82.112.3 ssh-ed25519 ${ED25519}`, 'HOST_KEY_MULTIPLE_HOSTS'],
    ['leading dash host', `-oProxyCommand=sh ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['$() host', `$(touch /tmp/x) ssh-ed25519 ${ED25519}`, 'HOST_KEY_LINE_MALFORMED'],
    ['$() host without spaces', `$(id).com ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['backtick host', `\`id\`.com ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['semicolon host', `a.com;id ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['underscore label', `bad_host.com ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['empty label', `bad..com ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['over-long hostname', `${`${'a'.repeat(60)}.`.repeat(5)}com ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['unterminated bracket', `[github.com:2222 ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['bracket without port', `[github.com] ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['bracket port 0', `[github.com]:0 ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['bracket port 65536', `[github.com]:65536 ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['bracket port with letters', `[github.com]:22a ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['nested bracket', `[[github.com]]:2222 ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['ipv6 with one colon', `[db8:1]:2222 ssh-ed25519 ${ED25519}`, 'HOST_KEY_INVALID_HOST'],
    ['unsupported type', `github.com ssh-dss ${ED25519}`, 'HOST_KEY_UNSUPPORTED_TYPE'],
    ['certificate type', `github.com ssh-ed25519-cert-v01@openssh.com ${ED25519}`, 'HOST_KEY_UNSUPPORTED_TYPE'],
    ['non-base64 body', `github.com ssh-ed25519 AAAA$(id)AAAA`, 'HOST_KEY_INVALID_BASE64'],
    ['bad base64 length', `github.com ssh-ed25519 ${ED25519}A`, 'HOST_KEY_INVALID_BASE64'],
    ['misplaced padding', `github.com ssh-ed25519 AA=A${ED25519.slice(4)}`, 'HOST_KEY_INVALID_BASE64'],
    ['type and blob mismatch', `github.com ssh-rsa ${ED25519}`, 'HOST_KEY_TYPE_MISMATCH'],
    ['truncated blob', 'github.com ssh-ed25519 AAAA', 'HOST_KEY_TYPE_MISMATCH'],
    ['blob type length beyond blob', 'github.com ssh-ed25519 AAAAf3Nz', 'HOST_KEY_TYPE_MISMATCH'],
  ])('rejects %s', (_label, line, code) => {
    expect(rejection(line)).toBe(code);
  });
});

describe('normalizeGitHost and sameKnownHostsHost (H4)', () => {
  it('lowercases and strips trailing dots', () => {
    expect(normalizeGitHost('GitHub.Com..')).toBe('github.com');
  });

  it('compares case-insensitively and ignores trailing dots, including bracketed forms', () => {
    expect(sameKnownHostsHost('github.com', 'GITHUB.COM.')).toBe(true);
    expect(sameKnownHostsHost('[git.example.com]:2222', '[GIT.example.com.]:2222')).toBe(true);
    expect(sameKnownHostsHost('[git.example.com]:2222', 'git.example.com')).toBe(false);
    expect(sameKnownHostsHost('github.com', 'github.com.evil.com')).toBe(false);
  });
});

describe('knownHostsHostFor (H4)', () => {
  it('uses the bare host on port 22 and [host]:port otherwise', () => {
    expect(knownHostsHostFor('GitHub.com.', 22)).toBe('github.com');
    expect(knownHostsHostFor('git.example.com', 2222)).toBe('[git.example.com]:2222');
  });
});

describe('gitSshEndpoint (H4)', () => {
  it.each([
    ['git@github.com:org/repo.git', 'github.com', 22, 'github.com'],
    ['git@GitHub.COM:org/repo.git', 'github.com', 22, 'github.com'],
    ['ssh://git@github.com/org/repo.git', 'github.com', 22, 'github.com'],
    ['ssh://git@git.example.com:2222/org/repo.git', 'git.example.com', 2222, '[git.example.com]:2222'],
    ['ssh://git@git.example.com:22/org/repo.git', 'git.example.com', 22, 'git.example.com'],
    ['ssh://git@[2001:db8::1]:2222/org/repo.git', '2001:db8::1', 2222, '[2001:db8::1]:2222'],
    ['git@[2001:db8::1]:org/repo.git', '2001:db8::1', 22, '2001:db8::1'],
    ['ssh://git@[2001:db8::1]/org/repo.git', '2001:db8::1', 22, '2001:db8::1'],
  ])('%s -> %s:%d', (input, host, port, knownHosts) => {
    expect(gitSshEndpoint(url(input))).toEqual({ host, port, knownHostsHost: knownHosts });
  });

  it('returns null for an https URL (no SSH host key involved)', () => {
    expect(gitSshEndpoint(url('https://github.com/org/repo.git'))).toBeNull();
  });
});

describe('bundledGitHostKeysFor', () => {
  it('returns the three bundled keys for github.com on port 22', () => {
    const endpoint = gitSshEndpoint(url('git@github.com:org/repo.git'));
    if (!endpoint) throw new Error('no endpoint');

    const keys = bundledGitHostKeysFor(endpoint);

    expect(keys.map((key) => key.type).sort()).toEqual(
      ['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa'].sort(),
    );
    expect(keys.every((key) => key.host === 'github.com')).toBe(true);
  });

  it('returns nothing for a bundled host on a non-default port or an unknown host', () => {
    const port = gitSshEndpoint(url('ssh://git@github.com:2222/org/repo.git'));
    const other = gitSshEndpoint(url('git@git.example.com:org/repo.git'));
    if (!port || !other) throw new Error('no endpoint');

    expect(bundledGitHostKeysFor(port)).toEqual([]);
    expect(bundledGitHostKeysFor(other)).toEqual([]);
  });

  it('does not treat a lookalike host as bundled', () => {
    const endpoint = gitSshEndpoint(url('git@github.com.evil.com:org/repo.git'));
    if (!endpoint) throw new Error('no endpoint');

    expect(bundledGitHostKeysFor(endpoint)).toEqual([]);
  });
});

describe('parseKeyscanOutput (H3)', () => {
  const endpoint = {
    host: 'git.example.com',
    port: 2222,
    knownHostsHost: '[git.example.com]:2222',
  } as unknown as GitSshEndpoint;

  it('keeps only the requested host key lines of an accepted type', () => {
    const output = [
      '# git.example.com:2222 SSH-2.0-OpenSSH_9.6p1',
      `[git.example.com]:2222 ssh-ed25519 ${ED25519}`,
      `[git.example.com]:2222 ecdsa-sha2-nistp256 ${ECDSA}`,
      `[evil.example.com]:2222 ssh-ed25519 ${ED25519}`,
      `git.example.com ssh-ed25519 ${ED25519}`,
      `[git.example.com]:2222 ssh-dss ${ED25519}`,
      `[git.example.com]:2222 ssh-ed25519 ${ED25519} trailing-garbage`,
      '',
      'garbage line',
    ].join('\n');

    const keys = parseKeyscanOutput(output, endpoint);

    expect(keys).toEqual([
      { host: '[git.example.com]:2222', type: 'ssh-ed25519', key: ED25519 },
      { host: '[git.example.com]:2222', type: 'ecdsa-sha2-nistp256', key: ECDSA },
    ]);
  });

  it('matches the requested host case-insensitively and drops duplicates', () => {
    const output = `[GIT.example.com.]:2222 ssh-ed25519 ${ED25519}\n[git.example.com]:2222 ssh-ed25519 ${ED25519}\n`;

    expect(parseKeyscanOutput(output, endpoint)).toHaveLength(1);
  });

  it('returns nothing for empty, non-string or over-long output', () => {
    expect(parseKeyscanOutput('', endpoint)).toEqual([]);
    expect(parseKeyscanOutput(undefined as unknown as string, endpoint)).toEqual([]);
    const flood = `[git.example.com]:2222 ssh-ed25519 ${ED25519}\n`.repeat(2000);
    expect(parseKeyscanOutput(flood, endpoint)).toEqual([]);
  });

  it('returns nothing when the endpoint host cannot be expressed as a known_hosts host', () => {
    const bad = {
      host: 'git.example.com',
      port: 22,
      knownHostsHost: 'bad host',
    } as unknown as GitSshEndpoint;

    expect(parseKeyscanOutput(`git.example.com ssh-ed25519 ${ED25519}`, bad)).toEqual([]);
  });
});

describe('knownHostsContent (H2)', () => {
  it('writes one validated line per key', () => {
    const keys = [parsed(`[git.example.com]:2222 ssh-ed25519 ${ED25519}`), parsed(`github.com ecdsa-sha2-nistp256 ${ECDSA}`)];

    expect(knownHostsContent(keys)).toBe(
      `[git.example.com]:2222 ssh-ed25519 ${ED25519}\ngithub.com ecdsa-sha2-nistp256 ${ECDSA}\n`,
    );
  });

  it('re-validates every key and drops anything that is not a clean host key', () => {
    const hostile = [
      { host: '$(touch /tmp/pwn)', type: 'ssh-ed25519', key: ED25519 },
      { host: 'a.com;id', type: 'ssh-ed25519', key: ED25519 },
      { host: '`id`', type: 'ssh-ed25519', key: ED25519 },
      { host: 'a.com b.com', type: 'ssh-ed25519', key: ED25519 },
      { host: 'a.com', type: 'ssh-ed25519', key: `${ED25519}\n* ssh-ed25519 ${ED25519}` },
    ] as unknown as GitHostKey[];

    expect(knownHostsContent(hostile)).toBe('');
  });

  it('is empty for no keys', () => {
    expect(knownHostsContent([])).toBe('');
  });
});
