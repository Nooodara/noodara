// 12-11b: the real `connect` port of the deploy job. A deploy never trusts a host key on first
// use: without a stored fingerprint the server is unreachable for deploys. Every failure is a
// closed code; no driver, SSH or decrypt message leaves this module.
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createRedactor, revealSecret } from '@noodara/domain/security';
import type { ConnectInput, ConnectOutcome, SshDeploySession, SshPort } from '@noodara/ssh';
import { encodeCredential } from '../services/credential-store.js';
import { createDeployConnect, type DeployServerRow } from './deploy-connect.js';

const masterKeys = { current: randomBytes(32) };
const SERVER_ID = '0190a3c4-3333-7aaa-8bbb-000000000003';
const FINGERPRINT = 'ssh-ed25519 SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU';
const PASSWORD = `pw-${randomBytes(12).toString('hex')}`;

function passwordCredential(): DeployServerRow['credential'] {
  const encoded = encodeCredential({ kind: 'password', password: PASSWORD }, { key: masterKeys.current, version: 1 }, createRedactor());
  if (!encoded.ok) throw new Error('encode failed');
  return { type: encoded.type, encryptedValue: encoded.encryptedValue, keyVersion: encoded.keyVersion };
}

function serverRow(overrides: Partial<DeployServerRow> = {}): DeployServerRow {
  return {
    host: '203.0.113.10',
    sshPort: 2222,
    sshUser: 'deploy',
    hostFingerprint: FINGERPRINT,
    dockerInstalled: true,
    credential: passwordCredential(),
    ...overrides,
  };
}

const closeSession = vi.fn(() => Promise.resolve());
const session = { close: closeSession } as unknown as SshDeploySession;

function fakeSsh(outcome: ConnectOutcome<SshDeploySession>): SshPort<SshDeploySession> & { calls: ConnectInput[] } {
  const calls: ConnectInput[] = [];
  return {
    calls,
    connect: (input) => {
      calls.push(input);
      return Promise.resolve(outcome);
    },
  };
}

const okOutcome: ConnectOutcome<SshDeploySession> = {
  ok: true,
  session,
  fingerprint: { keyType: 'ssh-ed25519', fingerprint: 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU' },
  fingerprintCaptured: false,
  attempts: 1,
};
const timeouts = { connectMs: 1000, commandMs: 1000, discoveryMs: 1000 };

function connectWith(row: DeployServerRow | null, ssh = fakeSsh(okOutcome)) {
  const connect = createDeployConnect({
    loadServer: () => Promise.resolve(row),
    ssh,
    timeouts,
    masterKeys: () => Promise.resolve(masterKeys),
  });
  return { connect, ssh };
}

describe('createDeployConnect', () => {
  it('connects with the stored fingerprint as trusted, the decrypted credential and the run redactor', async () => {
    const { connect, ssh } = connectWith(serverRow());
    const redactor = createRedactor();
    const result = await connect(SERVER_ID, redactor, undefined);
    expect(result.ok).toBe(true);
    const input = ssh.calls[0];
    if (input === undefined) throw new Error('expected a connect call');
    expect(input.target).toEqual({ host: '203.0.113.10', port: 2222, user: 'deploy' });
    expect(input.trustedFingerprint).toEqual({ keyType: 'ssh-ed25519', fingerprint: FINGERPRINT.slice('ssh-ed25519 '.length) });
    expect(input.redactor).toBe(redactor);
    expect(input.timeouts).toEqual(timeouts);
    if (input.credential.kind !== 'password') throw new Error('expected a password credential');
    expect(revealSecret(input.credential.password)).toBe(PASSWORD);
    if (!result.ok) return;
    await result.close();
    expect(closeSession).toHaveBeenCalledOnce();
  });

  it('a missing server is SERVER_UNREACHABLE', async () => {
    expect(await connectWith(null).connect(SERVER_ID, createRedactor(), undefined)).toEqual({
      ok: false,
      code: 'SERVER_UNREACHABLE',
    });
  });

  it('never trusts a host key on first use: no stored fingerprint is SERVER_UNREACHABLE without connecting', async () => {
    const { connect, ssh } = connectWith(serverRow({ hostFingerprint: null }));
    expect(await connect(SERVER_ID, createRedactor(), undefined)).toEqual({ ok: false, code: 'SERVER_UNREACHABLE' });
    expect(ssh.calls).toHaveLength(0);
  });

  it('a malformed stored fingerprint is SERVER_UNREACHABLE', async () => {
    const { connect, ssh } = connectWith(serverRow({ hostFingerprint: 'garbage' }));
    expect(await connect(SERVER_ID, createRedactor(), undefined)).toEqual({ ok: false, code: 'SERVER_UNREACHABLE' });
    expect(ssh.calls).toHaveLength(0);
  });

  it('an undecryptable or non-SSH credential is SERVER_UNREACHABLE', async () => {
    const other = { ...passwordCredential(), encryptedValue: passwordCredential().encryptedValue };
    const wrongKey = createDeployConnect({
      loadServer: () => Promise.resolve(serverRow({ credential: other })),
      ssh: fakeSsh(okOutcome),
      timeouts,
      masterKeys: () => Promise.resolve({ current: randomBytes(32) }),
    });
    expect(await wrongKey(SERVER_ID, createRedactor(), undefined)).toEqual({ ok: false, code: 'SERVER_UNREACHABLE' });

    const { connect } = connectWith(serverRow({ credential: { ...passwordCredential(), type: 'registry_password' } }));
    expect(await connect(SERVER_ID, createRedactor(), undefined)).toEqual({ ok: false, code: 'SERVER_UNREACHABLE' });
  });

  it('a server where discovery found no Docker is DOCKER_UNAVAILABLE', async () => {
    const { connect, ssh } = connectWith(serverRow({ dockerInstalled: false }));
    expect(await connect(SERVER_ID, createRedactor(), undefined)).toEqual({ ok: false, code: 'DOCKER_UNAVAILABLE' });
    expect(ssh.calls).toHaveLength(0);
  });

  it('a failed connection (including a changed host key) is SERVER_UNREACHABLE', async () => {
    const ssh = fakeSsh({ ok: false, errorCode: 'HOST_KEY_CHANGED', message: 'host 203.0.113.10 key changed', attempts: 1 });
    const { connect } = connectWith(serverRow(), ssh);
    expect(await connect(SERVER_ID, createRedactor(), undefined)).toEqual({ ok: false, code: 'SERVER_UNREACHABLE' });
  });
});
