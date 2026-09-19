// Task 1 RED (05-15-PLAN.md): `activity-copy.ts` does not exist yet -- every import below fails
// to resolve, which is the right reason for this file to fail before implementation exists.
import { describe, expect, it } from 'vitest';
import { curatedDetailFor, sentenceFor, type ActivityItem, type ServerLookup } from './activity-copy';

function buildItem(overrides: Partial<ActivityItem> & Pick<ActivityItem, 'action'>): ActivityItem {
  return {
    id: 'evt-1',
    occurredAt: '2026-09-19T10:00:00.000Z',
    actorType: 'user',
    actorId: 'admin-1',
    entityType: 'server',
    entityId: 'srv-1',
    outcome: 'success',
    errorCode: null,
    metadata: {},
    ...overrides,
  };
}

const notFoundLookup: ServerLookup = () => null;
const foundLookup: ServerLookup = (entityId) => ({ name: 'db-primary', href: `/servers/${entityId}` });

function fullText(sentence: { before: string; server: { label: string } | null; after: string }): string {
  return sentence.before + (sentence.server?.label ?? '') + sentence.after;
}

describe('sentenceFor -- exact §5.6 copy and actor resolution', () => {
  it('renders auth.setup_completed verbatim for a user actor', () => {
    const item = buildItem({ action: 'auth.setup_completed', actorType: 'user' });
    expect(fullText(sentenceFor(item, notFoundLookup))).toBe('Admin account created');
  });

  it('renders auth.login_succeeded verbatim for a user actor', () => {
    const item = buildItem({ action: 'auth.login_succeeded', actorType: 'user' });
    expect(fullText(sentenceFor(item, notFoundLookup))).toBe('Admin signed in');
  });

  it('renders server.fingerprint_trusted verbatim with a linked server name', () => {
    const item = buildItem({ action: 'server.fingerprint_trusted', actorType: 'user' });
    const sentence = sentenceFor(item, foundLookup);
    expect(fullText(sentence)).toBe('Admin trusted a new host key for db-primary');
    expect(sentence.server).toEqual({ label: 'db-primary', href: '/servers/srv-1', mono: false });
  });

  it('substitutes System for a system actor on an actor-subject sentence', () => {
    const item = buildItem({ action: 'auth.logout', actorType: 'system' });
    expect(fullText(sentenceFor(item, notFoundLookup))).toBe('System signed out');
  });

  it('never mentions the actor on a sentence with no actor subject (login_failed)', () => {
    const item = buildItem({ action: 'auth.login_failed', actorType: 'system' });
    expect(fullText(sentenceFor(item, notFoundLookup))).toBe('Sign-in attempt failed');
  });
});

describe('sentenceFor -- outcome branching for connection_attempted and discovery_completed', () => {
  it('renders the success sentence for server.connection_attempted', () => {
    const item = buildItem({ action: 'server.connection_attempted', outcome: 'success' });
    expect(fullText(sentenceFor(item, foundLookup))).toBe('Admin connected db-primary');
  });

  it('renders the failure sentence for server.connection_attempted', () => {
    const item = buildItem({ action: 'server.connection_attempted', outcome: 'failure' });
    expect(fullText(sentenceFor(item, foundLookup))).toBe('Connection to db-primary failed');
  });

  it('renders the success sentence for server.discovery_completed', () => {
    const item = buildItem({ action: 'server.discovery_completed', outcome: 'success' });
    expect(fullText(sentenceFor(item, foundLookup))).toBe('Discovery completed for db-primary');
  });

  it('renders the failure sentence for server.discovery_completed', () => {
    const item = buildItem({ action: 'server.discovery_completed', outcome: 'failure' });
    expect(fullText(sentenceFor(item, foundLookup))).toBe('Discovery failed for db-primary');
  });
});

describe('sentenceFor -- unknown action degrades safely', () => {
  it('never interpolates the raw action string into the sentence', () => {
    const item = buildItem({ action: 'server.self_destructed', entityType: 'server' });
    const sentence = sentenceFor(item, notFoundLookup);
    expect(fullText(sentence)).not.toContain('self_destructed');
    expect(fullText(sentence).length).toBeGreaterThan(0);
  });

  it('returns no curated detail for an unknown action', () => {
    const item = buildItem({ action: 'server.self_destructed' });
    expect(curatedDetailFor(item)).toEqual([]);
  });
});

describe('curatedDetailFor -- curated keys only, in order, extra keys ignored', () => {
  it('yields pairs for host/port/user/credential only, dropping an unlisted metadata key entirely', () => {
    const item = buildItem({
      action: 'server.created',
      metadata: { host: 'h', sshPort: 22, secretish: 'x' },
    });

    const detail = curatedDetailFor(item);

    expect(detail).toEqual([{ label: 'Host', value: 'h:22', mono: false }]);
    expect(JSON.stringify(detail)).not.toContain('secretish');
    expect(JSON.stringify(detail)).not.toContain('"x"');
  });

  it('returns every curated pair in the §5.6 order for a fully-populated server.created event', () => {
    const item = buildItem({
      action: 'server.created',
      metadata: { host: 'db.internal', sshPort: 22, sshUser: 'root', credentialType: 'ssh_private_key', extra: 'drop-me' },
    });

    expect(curatedDetailFor(item)).toEqual([
      { label: 'Host', value: 'db.internal:22', mono: false },
      { label: 'SSH user', value: 'root', mono: false },
      { label: 'Credential', value: 'Private key', mono: false },
    ]);
  });
});

describe('curatedDetailFor -- empty for the three chevron-less auth actions', () => {
  it.each(['auth.logout', 'auth.session_revoked', 'auth.password_reset'] as const)('%s has no curated detail', (action) => {
    const item = buildItem({ action, metadata: { email: 'admin@example.test' } });
    expect(curatedDetailFor(item)).toEqual([]);
  });
});

describe('curatedDetailFor -- an unexpected value type is dropped, never stringified', () => {
  it('drops a metadata field whose type does not match its expected shape', () => {
    const item = buildItem({
      action: 'server.created',
      metadata: { host: { nested: 'object-where-string-expected' }, sshPort: '22-as-string', sshUser: 42 },
    });

    expect(curatedDetailFor(item)).toEqual([]);
  });

  it('drops changedFields when it is not a string array', () => {
    const item = buildItem({
      action: 'server.updated',
      metadata: { changedFields: 'host,port', credentialReplaced: 'yes' },
    });

    expect(curatedDetailFor(item)).toEqual([]);
  });
});

describe('curatedDetailFor -- mono flags match §5.6', () => {
  it('flags fingerprint values as mono', () => {
    const item = buildItem({
      action: 'server.fingerprint_trusted',
      metadata: { previousFingerprint: 'SHA256:old', newFingerprint: 'SHA256:new' },
    });

    expect(curatedDetailFor(item)).toEqual([
      { label: 'Previous', value: 'SHA256:old', mono: true },
      { label: 'New', value: 'SHA256:new', mono: true },
    ]);
  });

  it('flags the error code as mono on a failed connection attempt', () => {
    const item = buildItem({
      action: 'server.connection_attempted',
      outcome: 'failure',
      errorCode: 'CONNECT_TIMEOUT',
      metadata: { attempts: 2, durationMs: 1400 },
    });

    expect(curatedDetailFor(item)).toEqual([
      { label: 'Attempts', value: '2', mono: false },
      { label: 'Duration', value: '1400ms', mono: false },
      { label: 'Error', value: 'CONNECT_TIMEOUT', mono: true },
    ]);
  });

  it('flags warnings as mono and substitutes "none" for an empty list', () => {
    const item = buildItem({
      action: 'server.discovery_completed',
      outcome: 'success',
      metadata: { warnings: [] },
    });

    expect(curatedDetailFor(item)).toEqual([{ label: 'Warnings', value: 'none', mono: true }]);
  });

  it('never flags Email/IP/Host/SSH user/Credential as mono', () => {
    const item = buildItem({
      action: 'auth.login_succeeded',
      metadata: { email: 'admin@example.test', ip: '10.0.0.1' },
    });

    expect(curatedDetailFor(item)).toEqual([
      { label: 'Email', value: 'admin@example.test', mono: false },
      { label: 'IP', value: '10.0.0.1', mono: false },
    ]);
  });
});
