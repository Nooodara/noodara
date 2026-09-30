import { describe, expect, it } from 'vitest';
import { validateCommitSha, validateGitBranch, validateRepositoryUrl } from './git.js';

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

describe('validateRepositoryUrl', () => {
  it.each([
    'https://github.com/acme/app',
    'https://github.com/acme/app.git',
    'https://git.example.com:8443/team/sub/app.git',
    'git@github.com:acme/app.git',
    'deploy@gitea.example.org:team/app.git',
    'ssh://git@git.example.com/acme/app.git',
    'ssh://git@git.example.com:2222/acme/app.git',
    'https://203.0.113.10/acme/app.git',
    'git@git.noodara-test.internal:/srv/git/node-api.git',
    'https://[2001:4860::8888]/acme/app.git',
  ])('accepts %s unchanged', (url) => {
    expect(validateRepositoryUrl(url)).toEqual({ ok: true, value: url });
  });

  it('rejects an empty string with REPOSITORY_URL_EMPTY', () => {
    expect(codeOf(validateRepositoryUrl(''))).toBe('REPOSITORY_URL_EMPTY');
  });

  it('rejects a URL longer than 512 characters with REPOSITORY_URL_TOO_LONG', () => {
    const url = `https://github.com/${'a'.repeat(500)}.git`;
    expect(url.length).toBeGreaterThan(512);

    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_TOO_LONG');
  });

  it('rejects a trailing newline with REPOSITORY_URL_CONTAINS_WHITESPACE', () => {
    expect(codeOf(validateRepositoryUrl('https://github.com/acme/app.git\n'))).toBe(
      'REPOSITORY_URL_CONTAINS_WHITESPACE',
    );
  });

  it.each([
    'https://github.com/acme/my app.git',
    'https://github.com/acme/app.git\tx',
    'https://github.com/acme/app.git\r',
    'git@github.com:acme/app.git\nrm',
  ])('rejects whitespace in %j with REPOSITORY_URL_CONTAINS_WHITESPACE', (url) => {
    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_CONTAINS_WHITESPACE');
  });

  it.each([';', '|', '&', '$', '`', '(', ')', '<', '>', '\\', '"', "'", '*', '[', ']', '{', '}', '!'])(
    'rejects the metacharacter %s with REPOSITORY_URL_CONTAINS_METACHARACTER',
    (char) => {
      const result = validateRepositoryUrl(`https://github.com/acme/app${char}x.git`);

      expect(codeOf(result)).toBe('REPOSITORY_URL_CONTAINS_METACHARACTER');
    },
  );

  it('never echoes the full input in a failure message', () => {
    const result = validateRepositoryUrl('https://github.com/acme/app;rm -rf-marker.git');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).not.toContain('rf-marker');
  });

  it.each([
    'http://github.com/acme/app.git',
    'git://github.com/acme/app.git',
    'file:///srv/git/app.git',
    'ftp://github.com/acme/app.git',
    'git+ssh://git@github.com/acme/app.git',
    'HTTPS://github.com/acme/app.git',
    'github.com/acme/app.git',
    '/srv/git/app.git',
    'git@github.com',
  ])('rejects %s with REPOSITORY_URL_UNSUPPORTED_SCHEME', (url) => {
    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_UNSUPPORTED_SCHEME');
  });

  it.each([
    'https://user:token@github.com/acme/app.git',
    'https://token@github.com/acme/app.git',
    'ssh://user:pw@git.example.com/acme/app.git',
    'git:pw@github.com:acme/app.git',
  ])('rejects embedded credentials in %s with REPOSITORY_URL_EMBEDDED_CREDENTIALS', (url) => {
    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_EMBEDDED_CREDENTIALS');
  });

  it.each([
    'https://github.com/acme/app.git?a=b',
    'https://github.com/acme/app.git#main',
    'git@github.com:acme/app.git#x',
  ])('rejects %s with REPOSITORY_URL_QUERY_OR_FRAGMENT (checked before metacharacters)', (url) => {
    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_QUERY_OR_FRAGMENT');
  });

  it.each([
    'https://github.com/acme/../app.git',
    'https://github.com/..',
    'ssh://git@git.example.com/../etc/passwd',
    'git@github.com:../x.git',
    'git@github.com:acme/../../x.git',
  ])('rejects %s with REPOSITORY_URL_PATH_TRAVERSAL', (url) => {
    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_PATH_TRAVERSAL');
  });

  it.each([
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '256.1.1.1',
    '010.1.1.1',
    '127.1',
    '0x7f.0.0.1',
    '2130706433',
    '[::1]',
    '[::]',
    '[fe80::1]',
    '[fd00::1]',
    '[fec0::1]',
    '[::ffff:10.0.0.1]',
    '[not-ipv6]',
    '[2001:db8::1',
    '-github.com',
    'github-.com',
    `${'a'.repeat(64)}.com`,
    `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.com`,
    'git_hub.com',
    'github..com',
    'github.com.',
    'xn--a.com',
    'foo.1',
  ])('rejects the host %s with REPOSITORY_URL_INVALID_HOST', (host) => {
    const result = validateRepositoryUrl(`https://${host}/acme/app.git`);

    expect(codeOf(result)).toBe('REPOSITORY_URL_INVALID_HOST');
  });

  it.each(['git@localhost:acme/app.git', 'git@10.0.0.5:acme/app.git', 'git@[::1]:acme/app.git'])(
    'rejects the scp-like non-public host in %s with REPOSITORY_URL_INVALID_HOST',
    (url) => {
      expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_INVALID_HOST');
    },
  );

  it.each(['ssh://git@127.0.0.1/acme/app.git', 'ssh://git@[fd12::1]:22/acme/app.git'])(
    'rejects the ssh non-public host in %s with REPOSITORY_URL_INVALID_HOST',
    (url) => {
      expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_INVALID_HOST');
    },
  );

  it.each([
    'Git@github.com:acme/app.git',
    '-oProxyCommand@github.com:acme/app.git',
    '1git@github.com:acme/app.git',
    `${'a'.repeat(33)}@github.com:acme/app.git`,
    '@github.com:acme/app.git',
    'ssh://-git@git.example.com/acme/app.git',
    'ssh://Git@git.example.com/acme/app.git',
    'ssh://git.example.com/acme/app.git',
  ])('rejects the user in %s with REPOSITORY_URL_INVALID_USER', (url) => {
    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_INVALID_USER');
  });

  it.each([
    'https://github.com:0/acme/app.git',
    'https://github.com:65536/acme/app.git',
    'https://github.com:abc/acme/app.git',
    'https://github.com:/acme/app.git',
    'ssh://git@git.example.com:123456/acme/app.git',
    'https://[2001:4860::8888]:0/acme/app.git',
    'https://[2001:4860::8888]x/acme/app.git',
  ])('rejects the port in %s with REPOSITORY_URL_INVALID_PORT', (url) => {
    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_INVALID_PORT');
  });

  it.each([
    'https://github.com',
    'https://github.com/',
    'https://github.com/acme//app.git',
    'https://github.com/acme/app/',
    'https://github.com/-acme/app.git',
    'https://github.com/acme/./app.git',
    'https://github.com/acme/app%20x.git',
    'https://github.com/acme/ap@p.git',
    'https://github.com/acme/ap:p.git',
    'git@github.com:',
    'git@github.com:-oProxyCommand.git',
    'git@github.com:acme/-x.git',
    'ssh://git@git.example.com',
  ])('rejects the path in %s with REPOSITORY_URL_INVALID_PATH', (url) => {
    expect(codeOf(validateRepositoryUrl(url))).toBe('REPOSITORY_URL_INVALID_PATH');
  });
});

describe('validateGitBranch', () => {
  it.each(['main', 'release/1.2', 'feature/add-login', 'v1.0.0_rc', 'A-b.c/d_e'])(
    'accepts %s unchanged',
    (branch) => {
      expect(validateGitBranch(branch)).toEqual({ ok: true, value: branch });
    },
  );

  it('rejects an empty branch with GIT_BRANCH_EMPTY', () => {
    expect(codeOf(validateGitBranch(''))).toBe('GIT_BRANCH_EMPTY');
  });

  it('rejects a branch longer than 255 characters with GIT_BRANCH_TOO_LONG', () => {
    expect(codeOf(validateGitBranch('a'.repeat(256)))).toBe('GIT_BRANCH_TOO_LONG');
    expect(validateGitBranch('a'.repeat(255)).ok).toBe(true);
  });

  it.each(['my branch', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a@b', 'a{b', 'a@{1}', 'a;b', 'a\nb', 'ñ'])(
    'rejects %j with GIT_BRANCH_INVALID_CHARACTER',
    (branch) => {
      expect(codeOf(validateGitBranch(branch))).toBe('GIT_BRANCH_INVALID_CHARACTER');
    },
  );

  it.each(['-main', '/main', 'main/', 'main.', 'feature/.hidden', '.hidden'])(
    'rejects %s with GIT_BRANCH_INVALID_BOUNDARY',
    (branch) => {
      expect(codeOf(validateGitBranch(branch))).toBe('GIT_BRANCH_INVALID_BOUNDARY');
    },
  );

  it.each(['a..b', '../main', 'feature/..'])('rejects %s with GIT_BRANCH_PATH_TRAVERSAL', (branch) => {
    expect(codeOf(validateGitBranch(branch))).toBe('GIT_BRANCH_PATH_TRAVERSAL');
  });

  it('rejects a//b with GIT_BRANCH_EMPTY_SEGMENT', () => {
    expect(codeOf(validateGitBranch('a//b'))).toBe('GIT_BRANCH_EMPTY_SEGMENT');
  });

  it.each(['main.lock', 'feature/x.lock/y'])('rejects %s with GIT_BRANCH_LOCK_SUFFIX', (branch) => {
    expect(codeOf(validateGitBranch(branch))).toBe('GIT_BRANCH_LOCK_SUFFIX');
  });

  it('states the accepted subset in every failure message', () => {
    for (const branch of ['', 'a'.repeat(256), 'a b', '-a', 'a..b', 'a//b', 'a.lock']) {
      const result = validateGitBranch(branch);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain('[A-Za-z0-9._/-]');
    }
  });
});

describe('validateCommitSha', () => {
  it('accepts 40 lowercase hex characters', () => {
    const sha = 'a'.repeat(20) + '0123456789';
    const full = `${sha}abcdef0123`;

    expect(validateCommitSha(full)).toEqual({ ok: true, value: full });
  });

  it.each(['A'.repeat(40), 'abc1234', 'a'.repeat(64), 'g'.repeat(40), '', `${'a'.repeat(40)}\n`])(
    'rejects %j with COMMIT_SHA_INVALID',
    (sha) => {
      expect(codeOf(validateCommitSha(sha))).toBe('COMMIT_SHA_INVALID');
    },
  );
});
