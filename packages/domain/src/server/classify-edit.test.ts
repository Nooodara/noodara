import { describe, expect, it } from 'vitest';
import { classifyServerEdit, type ServerAccessFields, type ServerIdentityFields } from './classify-edit.js';

type EditFields = ServerIdentityFields & ServerAccessFields;

function buildEdit(overrides: Partial<EditFields> = {}): EditFields {
  return {
    host: '203.0.113.10',
    sshPort: 22,
    sshUser: 'deployer',
    credentialReplaced: false,
    ...overrides,
  };
}

describe('classifyServerEdit', () => {
  it('host changed -> identity', () => {
    const before = buildEdit();
    const after = buildEdit({ host: '203.0.113.99' });

    expect(classifyServerEdit(before, after)).toBe('identity');
  });

  it('sshPort changed -> identity', () => {
    const before = buildEdit();
    const after = buildEdit({ sshPort: 2222 });

    expect(classifyServerEdit(before, after)).toBe('identity');
  });

  it('host and sshPort unchanged, sshUser changed -> access', () => {
    const before = buildEdit();
    const after = buildEdit({ sshUser: 'root' });

    expect(classifyServerEdit(before, after)).toBe('access');
  });

  it('host, sshPort, sshUser unchanged, credentialReplaced true -> access', () => {
    const before = buildEdit();
    const after = buildEdit({ credentialReplaced: true });

    expect(classifyServerEdit(before, after)).toBe('access');
  });

  it('nothing relevant changed and credentialReplaced false -> none', () => {
    const before = buildEdit();
    const after = buildEdit();

    expect(classifyServerEdit(before, after)).toBe('none');
  });

  it('identity wins over access when both a host change and a credential replacement happen together', () => {
    const before = buildEdit();
    const after = buildEdit({ host: '203.0.113.99', credentialReplaced: true });

    expect(classifyServerEdit(before, after)).toBe('identity');
  });

  it('identity wins over access when both a port change and a user change happen together', () => {
    const before = buildEdit();
    const after = buildEdit({ sshPort: 2222, sshUser: 'root' });

    expect(classifyServerEdit(before, after)).toBe('identity');
  });

  it('name is not part of the input: classifyServerEdit does not accept it', () => {
    const before = buildEdit();
    const after = buildEdit();

    // @ts-expect-error name is deliberately not part of ServerIdentityFields/ServerAccessFields
    expect(classifyServerEdit({ ...before, name: 'old' }, { ...after, name: 'new' })).toBe('none');
  });

  // Exhaustive 16-row table over (host changed, port changed, user changed, credentialReplaced).
  // This carries the branch-coverage bar (SERV-02).
  const BOOLS = [false, true];
  const rows: {
    hostChanged: boolean;
    portChanged: boolean;
    userChanged: boolean;
    credentialReplaced: boolean;
    expected: 'none' | 'identity' | 'access';
  }[] = [];

  for (const hostChanged of BOOLS) {
    for (const portChanged of BOOLS) {
      for (const userChanged of BOOLS) {
        for (const credentialReplaced of BOOLS) {
          const expected: 'none' | 'identity' | 'access' =
            hostChanged || portChanged
              ? 'identity'
              : userChanged || credentialReplaced
                ? 'access'
                : 'none';
          rows.push({ hostChanged, portChanged, userChanged, credentialReplaced, expected });
        }
      }
    }
  }

  it('has exactly 16 rows in the exhaustive table', () => {
    expect(rows.length).toBe(16);
  });

  it.each(rows)(
    'host=$hostChanged port=$portChanged user=$userChanged credentialReplaced=$credentialReplaced -> $expected',
    ({ hostChanged, portChanged, userChanged, credentialReplaced, expected }) => {
      const before = buildEdit();
      const after = buildEdit({
        host: hostChanged ? '198.51.100.7' : before.host,
        sshPort: portChanged ? 2200 : before.sshPort,
        sshUser: userChanged ? 'other-user' : before.sshUser,
        credentialReplaced,
      });

      expect(classifyServerEdit(before, after)).toBe(expected);
    },
  );
});
