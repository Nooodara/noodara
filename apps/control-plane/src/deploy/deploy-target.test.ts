// 12-11b: the pure half of the real `loadTarget` port. Rows in, a DeployTarget or a closed code
// out; a corrupt source snapshot throws a fixed-message error (the job handler ends it as
// WORKER_CRASHED). Credentials are decrypted here and leave only as SecretValue.
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { revealSecret, secretValue } from '@noodara/domain/security';
import { encodeServiceCredential } from '../services/service-credentials.js';
import { DeployTargetError, resolveDeployTarget, sourceFromSnapshot, type DeployTargetRows } from './deploy-target.js';

const masterKeys = { current: randomBytes(32) };
const key = { key: masterKeys.current, version: 1 };
const SERVICE_ID = '0190a3c4-1111-7aaa-8bbb-000000000001';
const DEPLOYMENT_ID = '0190a3c4-2222-7aaa-8bbb-000000000002';
const SERVER_ID = '0190a3c4-3333-7aaa-8bbb-000000000003';
const PANEL = [{ port: 3000, label: 'Noodara panel' }];

const gitSnapshot = {
  sourceType: 'git',
  repositoryUrl: 'ssh://git@git.example.com/acme/api.git',
  branch: 'main',
  buildContext: null,
  dockerfilePath: null,
  buildTarget: 'runtime',
  imageRef: null,
  internalPort: 3000,
  publishedPort: 8080,
};

const imageSnapshot = {
  sourceType: 'image',
  repositoryUrl: null,
  branch: null,
  buildContext: null,
  dockerfilePath: null,
  buildTarget: null,
  imageRef: 'registry.example.com/acme/web:1.2',
  internalPort: 80,
  publishedPort: null,
};

function rows(overrides: Partial<DeployTargetRows> = {}): DeployTargetRows {
  return {
    deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, source: gitSnapshot },
    service: { id: SERVICE_ID, serverId: SERVER_ID, repositoryCredentialId: null, registryCredentialId: null },
    repositoryCredential: null,
    registryCredential: null,
    otherServices: [{ serviceId: '0190a3c4-4444-7aaa-8bbb-000000000004', publishedPort: 9000 }],
    ...overrides,
  };
}

describe('sourceFromSnapshot', () => {
  it('maps a git snapshot, defaulting null build context and Dockerfile and keeping the target', () => {
    expect(sourceFromSnapshot(gitSnapshot)).toEqual({
      kind: 'git',
      repositoryUrl: gitSnapshot.repositoryUrl,
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      target: 'runtime',
    });
  });

  it('maps an image snapshot', () => {
    expect(sourceFromSnapshot(imageSnapshot)).toEqual({ kind: 'image', imageRef: imageSnapshot.imageRef });
  });

  it.each([
    ['not an object', 'nope'],
    ['unknown source type', { ...gitSnapshot, sourceType: 'zip' }],
    ['an invalid branch', { ...gitSnapshot, branch: '--upload-pack=evil' }],
    ['a missing image ref', { ...imageSnapshot, imageRef: null }],
    ['a non-numeric port', { ...gitSnapshot, internalPort: '3000' }],
  ])('throws a fixed-message DeployTargetError for %s', (_label, snapshot) => {
    expect(() => sourceFromSnapshot(snapshot)).toThrow(DeployTargetError);
    try {
      sourceFromSnapshot(snapshot);
    } catch (error) {
      // Never echoes the stored value back.
      expect((error as Error).message).not.toContain('evil');
    }
  });
});

describe('resolveDeployTarget', () => {
  it('resolves a public git source with ports, other services and panel ports', () => {
    const result = resolveDeployTarget(rows(), masterKeys, PANEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.serverId).toBe(SERVER_ID);
    expect(result.target.serviceId).toBe(SERVICE_ID);
    expect(result.target.deploymentId).toBe(DEPLOYMENT_ID);
    expect(result.target.internalPort).toBe(3000);
    expect(result.target.publishedPort).toBe(8080);
    expect(result.target.credential).toEqual({ kind: 'none' });
    expect(result.target.otherServices).toEqual(rows().otherServices);
    expect(result.target.panelPorts).toEqual(PANEL);
    expect(result.target.source.kind).toBe('git');
  });

  it('decrypts a deploy key into a SecretValue that never prints', () => {
    const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${randomBytes(48).toString('base64')}\n-----END OPENSSH PRIVATE KEY-----`;
    const encoded = encodeServiceCredential(
      { kind: 'deploy_key', privateKey: secretValue(privateKey, 'ssh_private_key'), publicKey: 'ssh-ed25519 AAAA test' },
      key,
    );
    const result = resolveDeployTarget(
      rows({
        service: { id: SERVICE_ID, serverId: SERVER_ID, repositoryCredentialId: 'c1', registryCredentialId: null },
        repositoryCredential: encoded,
      }),
      masterKeys,
      PANEL,
    );
    if (!result.ok) throw new Error('expected ok');
    const { credential } = result.target;
    if (credential.kind !== 'deploy_key') throw new Error('expected a deploy key');
    expect(revealSecret(credential.privateKey)).toBe(privateKey);
    expect(inspect(result)).not.toContain(privateKey.slice(40, 80));
    expect(JSON.stringify(result)).not.toContain(privateKey.slice(40, 80));
  });

  it('decrypts an https token', () => {
    const token = randomBytes(20).toString('hex');
    const encoded = encodeServiceCredential({ kind: 'https_token', token: secretValue(token, 'api_key') }, key);
    const result = resolveDeployTarget(
      rows({
        deployment: {
          id: DEPLOYMENT_ID,
          serviceId: SERVICE_ID,
          source: { ...gitSnapshot, repositoryUrl: 'https://git.example.com/acme/api.git' },
        },
        service: { id: SERVICE_ID, serverId: SERVER_ID, repositoryCredentialId: 'c1', registryCredentialId: null },
        repositoryCredential: encoded,
      }),
      masterKeys,
      PANEL,
    );
    if (!result.ok || result.target.credential.kind !== 'https_token') throw new Error('expected an https token');
    expect(revealSecret(result.target.credential.token)).toBe(token);
  });

  it('decrypts a registry credential for an image source', () => {
    const password = randomBytes(18).toString('base64url');
    const encoded = encodeServiceCredential(
      { kind: 'registry', host: 'registry.example.com', username: 'robot', password: secretValue(password, 'api_key') },
      key,
    );
    const result = resolveDeployTarget(
      rows({
        deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, source: imageSnapshot },
        service: { id: SERVICE_ID, serverId: SERVER_ID, repositoryCredentialId: null, registryCredentialId: 'r1' },
        registryCredential: encoded,
      }),
      masterKeys,
      PANEL,
    );
    if (!result.ok || result.target.credential.kind !== 'registry') throw new Error('expected a registry credential');
    expect(result.target.credential.registry.host).toBe('registry.example.com');
    expect(result.target.credential.registry.username).toBe('robot');
    expect(revealSecret(result.target.credential.registry.password)).toBe(password);
    expect(result.target.publishedPort).toBeNull();
  });

  it('an image source without a registry credential pulls anonymously', () => {
    const result = resolveDeployTarget(
      rows({ deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, source: imageSnapshot } }),
      masterKeys,
      PANEL,
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.credential).toEqual({ kind: 'none' });
  });

  it('never sends a registry password to a registry other than the image host', () => {
    const encoded = encodeServiceCredential(
      { kind: 'registry', host: 'evil.example.net', username: 'robot', password: secretValue('pw-123456', 'api_key') },
      key,
    );
    const result = resolveDeployTarget(
      rows({
        deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, source: imageSnapshot },
        service: { id: SERVICE_ID, serverId: SERVER_ID, repositoryCredentialId: null, registryCredentialId: 'r1' },
        registryCredential: encoded,
      }),
      masterKeys,
      PANEL,
    );
    expect(result).toEqual({ ok: false, code: 'REGISTRY_AUTH_FAILED' });
  });

  it('a credential id whose row is missing is a closed auth failure', () => {
    const result = resolveDeployTarget(
      rows({ service: { id: SERVICE_ID, serverId: SERVER_ID, repositoryCredentialId: 'gone', registryCredentialId: null } }),
      masterKeys,
      PANEL,
    );
    expect(result).toEqual({ ok: false, code: 'REPOSITORY_AUTH_FAILED' });
  });

  it('an undecryptable repository credential is REPOSITORY_AUTH_FAILED', () => {
    const encoded = encodeServiceCredential({ kind: 'https_token', token: secretValue('tok-abcdef', 'api_key') }, {
      key: randomBytes(32),
      version: 1,
    });
    const result = resolveDeployTarget(
      rows({
        service: { id: SERVICE_ID, serverId: SERVER_ID, repositoryCredentialId: 'c1', registryCredentialId: null },
        repositoryCredential: encoded,
      }),
      masterKeys,
      PANEL,
    );
    expect(result).toEqual({ ok: false, code: 'REPOSITORY_AUTH_FAILED' });
  });

  it('a registry envelope in the repository slot is REPOSITORY_AUTH_FAILED', () => {
    const encoded = encodeServiceCredential(
      { kind: 'registry', host: 'registry.example.com', username: 'robot', password: secretValue('pw-123456', 'api_key') },
      key,
    );
    const result = resolveDeployTarget(
      rows({
        service: { id: SERVICE_ID, serverId: SERVER_ID, repositoryCredentialId: 'c1', registryCredentialId: null },
        repositoryCredential: encoded,
      }),
      masterKeys,
      PANEL,
    );
    expect(result).toEqual({ ok: false, code: 'REPOSITORY_AUTH_FAILED' });
  });

  it('a deployment whose ids are not lowercase UUIDs throws (caller bug, WORKER_CRASHED)', () => {
    expect(() =>
      resolveDeployTarget(rows({ deployment: { id: 'not-a-uuid', serviceId: SERVICE_ID, source: gitSnapshot } }), masterKeys, PANEL),
    ).toThrow(DeployTargetError);
  });
});
