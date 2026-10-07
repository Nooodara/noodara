// 14-07: the pure half of the TOFU store (row <-> keys, URL edits). The conditional write, the
// race and the migration run against Postgres in tests/integration/deploy-engine/runtime-pipeline.
import { randomBytes } from 'node:crypto';
import { parseGitHostKeyLine, type GitHostKey } from '@noodara/domain/validators';
import { describe, expect, it } from 'vitest';
import {
  columnsFromPinned,
  gitHostKeyColumnsForUrlChange,
  knownHostsHostOfUrl,
  pinnedFromColumns,
} from './git-host-key-store.js';

function ed25519Blob(): string {
  const u32 = (n: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(n);
    return buffer;
  };
  return Buffer.concat([u32(11), Buffer.from('ssh-ed25519'), u32(32), randomBytes(32)]).toString('base64');
}

function key(host: string, blob = ed25519Blob()): GitHostKey {
  const parsed = parseGitHostKeyLine(`${host} ssh-ed25519 ${blob}`);
  if (!parsed.ok) throw new Error('fixture key does not parse');
  return parsed.value;
}

describe('knownHostsHostOfUrl', () => {
  it('maps ssh URLs to their known_hosts host and https or invalid URLs to null', () => {
    expect(knownHostsHostOfUrl('git@git.example.com:acme/api.git')).toBe('git.example.com');
    expect(knownHostsHostOfUrl('ssh://git@Git.Example.com:2222/acme/api.git')).toBe('[git.example.com]:2222');
    expect(knownHostsHostOfUrl('https://git.example.com/acme/api.git')).toBeNull();
    expect(knownHostsHostOfUrl('not a url')).toBeNull();
    expect(knownHostsHostOfUrl(null)).toBeNull();
  });
});

describe('stored columns <-> pinned keys', () => {
  it('round-trips every key of the host', () => {
    const keys = [key('git.example.com'), key('git.example.com')];
    const columns = columnsFromPinned({ host: 'git.example.com', keys });
    expect(columns.gitHostKeyHost).toBe('git.example.com');
    expect(pinnedFromColumns(columns)).toEqual({ host: 'git.example.com', keys });
  });

  it('stores only keys for the pinned host and refuses an empty pin', () => {
    const own = key('git.example.com');
    const columns = columnsFromPinned({ host: 'git.example.com', keys: [own, key('other.example.com')] });
    expect(pinnedFromColumns(columns)?.keys).toEqual([own]);
    expect(() => columnsFromPinned({ host: 'git.example.com', keys: [key('other.example.com')] })).toThrow(TypeError);
  });

  it('no stored host means no pin', () => {
    expect(pinnedFromColumns({ gitHostKeyHost: null, gitHostKey: null })).toBeNull();
  });

  it('drops tampered lines (other host, marker, garbage), so a corrupt row pins nothing usable', () => {
    const blob = ed25519Blob();
    const pinned = pinnedFromColumns({
      gitHostKeyHost: 'git.example.com',
      gitHostKey: `other.example.com ssh-ed25519 ${blob}\n@revoked git.example.com ssh-ed25519 ${blob}\ngarbage\n`,
    });
    expect(pinned).toEqual({ host: 'git.example.com', keys: [] });
  });
});

describe('gitHostKeyColumnsForUrlChange (H2)', () => {
  const pinned = { gitHostKeyHost: 'git.example.com', gitHostKey: 'line' };

  it('keeps the pin when the new URL is on the same host', () => {
    expect(gitHostKeyColumnsForUrlChange(pinned, 'git@GIT.example.com:acme/other.git')).toEqual({});
  });

  it('clears the pin for another host, another port, https or an image source', () => {
    const cleared = { gitHostKeyHost: null, gitHostKey: null };
    expect(gitHostKeyColumnsForUrlChange(pinned, 'git@git.other.com:acme/api.git')).toEqual(cleared);
    expect(gitHostKeyColumnsForUrlChange(pinned, 'ssh://git@git.example.com:2222/acme/api.git')).toEqual(cleared);
    expect(gitHostKeyColumnsForUrlChange(pinned, 'https://git.example.com/acme/api.git')).toEqual(cleared);
    expect(gitHostKeyColumnsForUrlChange(pinned, null)).toEqual(cleared);
  });

  it('writes nothing when nothing is pinned', () => {
    expect(gitHostKeyColumnsForUrlChange({ gitHostKeyHost: null, gitHostKey: null }, 'git@x.example.com:a/b.git')).toEqual({});
  });
});
