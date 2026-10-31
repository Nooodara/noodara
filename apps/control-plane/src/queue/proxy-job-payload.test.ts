import { describe, expect, it } from 'vitest';
import { ProxyInstallJobPayloadSchema, jobIdForProxyInstall, parseProxyInstallJobPayload } from './proxy-job-payload.js';

const SERVER = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const valid = { serverId: SERVER, acmeEmail: 'ops@example.com', jobId: `proxy-install-${SERVER}` };

describe('proxy-install job payload (22-02 H3)', () => {
  it('job id is deterministic per server', () => {
    expect(jobIdForProxyInstall(SERVER)).toBe(`proxy-install-${SERVER}`);
  });

  it('accepts exactly serverId, acmeEmail and the job id', () => {
    expect(parseProxyInstallJobPayload(valid)).toEqual({ ok: true, payload: valid });
    expect(Object.keys(ProxyInstallJobPayloadSchema.shape).sort()).toEqual(['acmeEmail', 'jobId', 'serverId']);
  });

  it.each([
    ['a credential', { ...valid, privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' }],
    ['a password', { ...valid, sshPassword: 'hunter2' }],
    ['a decrypted key', { ...valid, credential: { type: 'ssh_private_key', value: 'x' } }],
    ['a host', { ...valid, host: '10.0.0.1' }],
    ['a mismatched job id', { ...valid, jobId: 'proxy-install-other' }],
    ['a non-uuid server', { ...valid, serverId: 'srv-1', jobId: 'proxy-install-srv-1' }],
    ['a malformed email', { ...valid, acmeEmail: 'not an email' }],
    ['no email', { serverId: SERVER, jobId: valid.jobId }],
  ])('rejects %s and never echoes the value', (_, data) => {
    const result = parseProxyInstallJobPayload(data);
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain('BEGIN OPENSSH');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('10.0.0.1');
  });
});
