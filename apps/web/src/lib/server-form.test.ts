// 05-17-PLAN.md Task 1: server-form.ts's pure form-state to request-body builder. Every request
// body this file produces is checked against an explicit expected key set (T-5-78) since both
// CreateServerBodySchema and UpdateServerBodySchema are `.strict()` -- an extra key is a 400 the
// server would reject, and this test suite is the one place that gets proven before any component
// ever calls these functions.
import { describe, expect, it } from 'vitest';
import { buildCreateBody, buildUpdateBody, emptyServerFormState, validateServerForm, type ServerFormState } from './server-form';

function buildState(overrides: Partial<ServerFormState> = {}): ServerFormState {
  return {
    ...emptyServerFormState(),
    name: 'my-server',
    host: 'example.test',
    credential: { type: 'ssh_password', password: 'diagnostic-only' },
    ...overrides,
  };
}

describe('buildCreateBody', () => {
  it('omits sshPort and sshUser entirely when blank, rather than sending a default or an empty string', () => {
    const body = buildCreateBody(buildState({ sshPort: '', sshUser: '' }));

    expect(body).not.toHaveProperty('sshPort');
    expect(body).not.toHaveProperty('sshUser');
  });

  it('includes sshPort as a real number and sshUser as a trimmed string when set', () => {
    const body = buildCreateBody(buildState({ sshPort: '2222', sshUser: 'deployer' }));

    expect(body.sshPort).toBe(2222);
    expect(body.sshUser).toBe('deployer');
  });

  it('omits a blank passphrase rather than sending an empty string the server\'s .min(1) would reject', () => {
    const body = buildCreateBody(
      buildState({ credential: { type: 'ssh_private_key', privateKey: 'key-material', passphrase: '' } }),
    );

    expect(body.credential).toStrictEqual({ type: 'ssh_private_key', privateKey: 'key-material' });
    expect(body.credential).not.toHaveProperty('passphrase');
  });

  it('includes a non-blank passphrase', () => {
    const body = buildCreateBody(
      buildState({ credential: { type: 'ssh_private_key', privateKey: 'key-material', passphrase: 'unlock-me' } }),
    );

    expect(body.credential).toStrictEqual({
      type: 'ssh_private_key',
      privateKey: 'key-material',
      passphrase: 'unlock-me',
    });
  });

  it('a password credential carries no privateKey/passphrase key from the other branch', () => {
    const body = buildCreateBody(buildState({ credential: { type: 'ssh_password', password: 'diagnostic-only' } }));

    expect(body.credential).toStrictEqual({ type: 'ssh_password', password: 'diagnostic-only' });
    expect(Object.keys(body.credential).sort()).toStrictEqual(['password', 'type']);
  });

  it('switching credential type and then building a body yields no key from the other branch', () => {
    const privateKeyState = buildState({
      credential: { type: 'ssh_private_key', privateKey: 'key-material', passphrase: 'unlock-me' },
    });
    // Simulates the segmented control switching from Private key to Password in the same sheet.
    const switchedToPassword: ServerFormState = {
      ...privateKeyState,
      credential: { type: 'ssh_password', password: 'diagnostic-only' },
    };

    const body = buildCreateBody(switchedToPassword);

    expect(body.credential).not.toHaveProperty('privateKey');
    expect(body.credential).not.toHaveProperty('passphrase');
    expect(body.credential).toStrictEqual({ type: 'ssh_password', password: 'diagnostic-only' });
  });

  it("never includes a key outside CreateServerBodySchema's allowed set", () => {
    const body = buildCreateBody(
      buildState({
        sshPort: '22',
        sshUser: 'root',
        credential: { type: 'ssh_private_key', privateKey: 'key-material', passphrase: 'unlock-me' },
      }),
    );

    expect(Object.keys(body).sort()).toStrictEqual(['credential', 'host', 'name', 'sshPort', 'sshUser']);
  });
});

describe('buildUpdateBody', () => {
  it('includes only the fields the user actually changed', () => {
    const initial = buildState({ sshPort: '22', sshUser: 'root' });
    const current: ServerFormState = { ...initial, name: 'renamed-server' };

    expect(buildUpdateBody(current, initial, false)).toStrictEqual({ name: 'renamed-server' });
  });

  it('omits credential entirely unless Replace was used, even when the credential form state differs', () => {
    const initial = buildState();
    const current: ServerFormState = { ...initial, credential: { type: 'ssh_password', password: 'a-different-one' } };

    const body = buildUpdateBody(current, initial, false);

    expect(body).not.toHaveProperty('credential');
  });

  it('includes credential only once Replace has been used', () => {
    const initial = buildState();
    const current: ServerFormState = { ...initial, credential: { type: 'ssh_password', password: 'a-different-one' } };

    const body = buildUpdateBody(current, initial, true);

    expect(body.credential).toStrictEqual({ type: 'ssh_password', password: 'a-different-one' });
  });

  it('sends an empty body when nothing changed and Replace was not used', () => {
    const initial = buildState();

    expect(buildUpdateBody(initial, initial, false)).toStrictEqual({});
  });

  it('includes a changed sshPort as a real number', () => {
    const initial = buildState({ sshPort: '22' });
    const current: ServerFormState = { ...initial, sshPort: '2222' };

    expect(buildUpdateBody(current, initial, false)).toStrictEqual({ sshPort: 2222 });
  });
});

describe('validateServerForm', () => {
  it('flags a blank name', () => {
    expect(validateServerForm(buildState({ name: '   ' })).name).toBeDefined();
  });

  it('flags a blank host', () => {
    expect(validateServerForm(buildState({ host: '' })).host).toBeDefined();
  });

  it('flags a port outside 1-65535 at both boundaries and accepts both boundaries themselves', () => {
    expect(validateServerForm(buildState({ sshPort: '0' })).sshPort).toBeDefined();
    expect(validateServerForm(buildState({ sshPort: '65536' })).sshPort).toBeDefined();
    expect(validateServerForm(buildState({ sshPort: '1' })).sshPort).toBeUndefined();
    expect(validateServerForm(buildState({ sshPort: '65535' })).sshPort).toBeUndefined();
  });

  it('does not flag a blank port -- blank means "use the server default"', () => {
    expect(validateServerForm(buildState({ sshPort: '' })).sshPort).toBeUndefined();
  });

  it('flags a missing credential value for both credential types', () => {
    const blankKey = validateServerForm(
      buildState({ credential: { type: 'ssh_private_key', privateKey: '', passphrase: '' } }),
    );
    const blankPassword = validateServerForm(buildState({ credential: { type: 'ssh_password', password: '' } }));

    expect(blankKey.credential).toBeDefined();
    expect(blankPassword.credential).toBeDefined();
  });

  it('never blocks submission for a rule only the server can judge, such as name uniqueness', () => {
    // validateServerForm has no way to know "taken-name" collides with an existing server -- that
    // is NAME_TAKEN's job, a real API round trip, never a client-side pre-check.
    expect(validateServerForm(buildState({ name: 'taken-name' })).name).toBeUndefined();
  });
});
