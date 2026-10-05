// 12-09 unit proof: deploy-key generation (H1), write-only input validation (H3), the encrypted
// envelope per credential type (A1, A2, H1, H2) and the source-change plan (A3).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedactor, encryptSecret, revealSecret, secretValue } from '@noodara/domain/security';
import { loadPrivateKey } from '@noodara/ssh';
import { CredentialDecryptError } from './credential-store.js';
import {
  HTTPS_TOKEN_MAX_LENGTH,
  REGISTRY_PASSWORD_MAX_LENGTH,
  decodeServiceCredential,
  encodeServiceCredential,
  generateDeployKey,
  planCredentialsForSourceChange,
  registryHostOfImageRef,
  repositoryCredentialFits,
  validateHttpsToken,
  validateRegistryCredential,
} from './service-credentials.js';

const masterKeys = { current: randomBytes(32) };
const key = { key: masterKeys.current, version: 1 };

function canary(): string {
  return `canary${randomBytes(12).toString('hex')}`;
}

function everySurface(value: unknown): string {
  return [JSON.stringify(value), inspect(value, { depth: 8 }), String(value)].join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateDeployKey (A1, H1)', () => {
  it('produces an OpenSSH ed25519 key that @noodara/ssh loads, wrapped as a SecretValue', () => {
    const generated = generateDeployKey('noodara-service-test');
    expect(generated.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* noodara-service-test$/);
    const raw = revealSecret(generated.privateKey);
    expect(raw.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(everySurface(generated.privateKey)).not.toContain('OPENSSH PRIVATE KEY');

    const loaded = loadPrivateKey({ kind: 'private_key', privateKey: generated.privateKey }, createRedactor());
    expect(loaded.ok).toBe(true);
  });

  it('derives the same public key as ssh-keygen does from the private half', () => {
    const generated = generateDeployKey('noodara-service-test');
    const dir = mkdtempSync(join(tmpdir(), 'noodara-deploy-key-test-'));
    try {
      const keyPath = join(dir, 'id_ed25519');
      writeFileSync(keyPath, revealSecret(generated.privateKey), { mode: 0o600 });
      const derived = execFileSync('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8' }).trim();
      const [type, blob] = generated.publicKey.split(' ');
      expect(derived.startsWith(`${String(type)} ${String(blob)}`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses node:crypto only and gives every call a distinct key', () => {
    const random = vi.spyOn(Math, 'random');
    const keys = Array.from({ length: 5 }, () => generateDeployKey('c'));
    expect(random).not.toHaveBeenCalled();
    expect(new Set(keys.map((entry) => entry.publicKey)).size).toBe(5);
    expect(new Set(keys.map((entry) => revealSecret(entry.privateKey))).size).toBe(5);
  });
});

describe('validateHttpsToken (H3)', () => {
  it('accepts a printable token and returns it as a SecretValue', () => {
    const token = `ghp_${randomBytes(18).toString('hex')}`;
    const result = validateHttpsToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(revealSecret(result.value)).toBe(token);
  });

  it.each([
    ['', 'HTTPS_TOKEN_EMPTY'],
    ['a'.repeat(HTTPS_TOKEN_MAX_LENGTH + 1), 'HTTPS_TOKEN_TOO_LONG'],
    ['tok en', 'HTTPS_TOKEN_INVALID'],
    ['token\nsecond', 'HTTPS_TOKEN_INVALID'],
    ['tok\u0000en', 'HTTPS_TOKEN_INVALID'],
  ])('rejects %j with %s and never echoes it', (token, reason) => {
    const result = validateHttpsToken(token);
    expect(result).toMatchObject({ ok: false, reason });
    if (!result.ok && token.length > 0) expect(result.message).not.toContain(token);
  });

  it('accepts exactly the maximum length', () => {
    expect(validateHttpsToken('a'.repeat(HTTPS_TOKEN_MAX_LENGTH)).ok).toBe(true);
  });
});

describe('registryHostOfImageRef', () => {
  it.each([
    ['nginx:1.27', 'docker.io'],
    ['acme/api:1', 'docker.io'],
    ['ghcr.io/acme/api:1.0', 'ghcr.io'],
    ['localhost:5000/api@sha256:' + 'a'.repeat(64), 'localhost:5000'],
    ['registry.example.com:8443/team/api:2', 'registry.example.com:8443'],
  ])('%s is pulled from %s', (imageRef, host) => {
    expect(registryHostOfImageRef(imageRef)).toBe(host);
  });
});

describe('validateRegistryCredential (H3)', () => {
  const password = canary();

  it('defaults the host to the image registry', () => {
    const result = validateRegistryCredential({ username: 'acme-bot', password }, 'ghcr.io/acme/api:1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.host).toBe('ghcr.io');
      expect(result.value.username).toBe('acme-bot');
      expect(revealSecret(result.value.password)).toBe(password);
      expect(everySurface(result.value)).not.toContain(password);
    }
  });

  it('accepts a Docker Hub alias for an image without a registry', () => {
    const result = validateRegistryCredential({ host: 'index.docker.io', username: 'acme', password }, 'acme/api:1');
    expect(result).toMatchObject({ ok: true, value: { host: 'docker.io' } });
  });

  it.each([
    [{ username: '-bad', password: 'p' }, 'REGISTRY_USERNAME_INVALID'],
    [{ username: 'u', password: 'p', host: 'https://ghcr.io' }, 'REGISTRY_HOST_INVALID'],
    [{ username: 'u', password: 'p', host: 'quay.io' }, 'REGISTRY_HOST_MISMATCH'],
    [{ username: 'u', password: '' }, 'REGISTRY_PASSWORD_EMPTY'],
    [{ username: 'u', password: 'p'.repeat(REGISTRY_PASSWORD_MAX_LENGTH + 1) }, 'REGISTRY_PASSWORD_TOO_LONG'],
    [{ username: 'u', password: 'line\nbreak' }, 'REGISTRY_PASSWORD_INVALID'],
  ])('rejects %j with %s', (input, reason) => {
    const result = validateRegistryCredential(input, 'ghcr.io/acme/api:1');
    expect(result).toMatchObject({ ok: false, reason });
    if (!result.ok && input.password.length > 1) expect(result.message).not.toContain(input.password);
  });
});

describe('repositoryCredentialFits', () => {
  it('pairs a deploy key with ssh URLs and a token with https URLs', () => {
    expect(repositoryCredentialFits('git_deploy_key', 'git@github.com:acme/api.git')).toBe(true);
    expect(repositoryCredentialFits('git_deploy_key', 'ssh://git@github.com/acme/api.git')).toBe(true);
    expect(repositoryCredentialFits('git_deploy_key', 'https://github.com/acme/api.git')).toBe(false);
    expect(repositoryCredentialFits('git_https_token', 'https://github.com/acme/api.git')).toBe(true);
    expect(repositoryCredentialFits('git_https_token', 'git@github.com:acme/api.git')).toBe(false);
  });
});

describe('encodeServiceCredential / decodeServiceCredential (A1, A2, H1, H2)', () => {
  it('round-trips an HTTPS token without plaintext in the envelope', () => {
    const token = canary();
    const encoded = encodeServiceCredential({ kind: 'https_token', token: secretValue(token, 'api_key') }, key);
    expect(encoded).toMatchObject({ type: 'git_https_token', keyVersion: 1, publicKey: null });
    expect(encoded.encryptedValue).not.toContain(token);
    const decoded = decodeServiceCredential(encoded, masterKeys);
    expect(decoded.kind).toBe('https_token');
    if (decoded.kind === 'https_token') expect(revealSecret(decoded.token)).toBe(token);
    expect(everySurface(decoded)).not.toContain(token);
  });

  it('round-trips a deploy key and keeps only the public half in plaintext', () => {
    const generated = generateDeployKey('c');
    const encoded = encodeServiceCredential({ kind: 'deploy_key', ...generated }, key);
    expect(encoded.type).toBe('git_deploy_key');
    expect(encoded.publicKey).toBe(generated.publicKey);
    expect(encoded.encryptedValue).not.toContain('OPENSSH');
    const decoded = decodeServiceCredential(encoded, masterKeys);
    expect(decoded.kind).toBe('deploy_key');
    if (decoded.kind === 'deploy_key') {
      expect(revealSecret(decoded.privateKey)).toBe(revealSecret(generated.privateKey));
    }
    expect(everySurface(decoded)).not.toContain('OPENSSH');
  });

  it('round-trips a registry credential with only the password secret', () => {
    const password = canary();
    const encoded = encodeServiceCredential(
      { kind: 'registry', host: 'ghcr.io', username: 'acme-bot', password: secretValue(password, 'api_key') },
      key,
    );
    expect(encoded).toMatchObject({ type: 'registry_password', publicKey: null });
    expect(encoded.encryptedValue).not.toContain(password);
    expect(encoded.encryptedValue).not.toContain('acme-bot');
    const decoded = decodeServiceCredential(encoded, masterKeys);
    expect(decoded).toMatchObject({ kind: 'registry', host: 'ghcr.io', username: 'acme-bot' });
    if (decoded.kind === 'registry') expect(revealSecret(decoded.password)).toBe(password);
    expect(everySurface(decoded)).not.toContain(password);
  });

  it('uses a fresh nonce for every write of the same value', () => {
    const token = secretValue(canary(), 'api_key');
    const first = encodeServiceCredential({ kind: 'https_token', token }, key);
    const second = encodeServiceCredential({ kind: 'https_token', token }, key);
    expect(first.encryptedValue).not.toBe(second.encryptedValue);
    expect(first.encryptedValue.split(':')[1]).not.toBe(second.encryptedValue.split(':')[1]);
  });

  it('detects a tampered envelope with a closed code', () => {
    const token = canary();
    const encoded = encodeServiceCredential({ kind: 'https_token', token: secretValue(token, 'api_key') }, key);
    const segments = encoded.encryptedValue.split(':');
    const tag = Buffer.from(segments[3] ?? '', 'base64');
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    const tampered = { ...encoded, encryptedValue: [segments[0], segments[1], segments[2], tag.toString('base64')].join(':') };
    expect(() => decodeServiceCredential(tampered, masterKeys)).toThrow(CredentialDecryptError);
    try {
      decodeServiceCredential(tampered, masterKeys);
    } catch (error) {
      expect((error as CredentialDecryptError).code).toBe('CREDENTIAL_TAMPERED');
      expect(everySurface(error)).not.toContain(token);
    }
  });

  it('reports an undecodable registry payload as CREDENTIAL_MALFORMED without echoing it', () => {
    const secret = canary();
    const row = { type: 'registry_password' as const, encryptedValue: encryptSecret(secret, key), keyVersion: 1 };
    let caught: unknown;
    try {
      decodeServiceCredential(row, masterKeys);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialDecryptError);
    expect((caught as CredentialDecryptError).code).toBe('CREDENTIAL_MALFORMED');
    expect(everySurface(caught)).not.toContain(secret);
    expect((caught as Error).stack).not.toContain(secret);
  });

  it('refuses a server credential type', () => {
    const row = { type: 'ssh_password' as const, encryptedValue: encryptSecret('x', key), keyVersion: 1 };
    expect(() => decodeServiceCredential(row, masterKeys)).toThrow(CredentialDecryptError);
  });
});

describe('planCredentialsForSourceChange (A3)', () => {
  const git = { sourceType: 'git' as const, repositoryUrl: 'git@github.com:acme/api.git', imageRef: null };
  const image = { sourceType: 'image' as const, repositoryUrl: null, imageRef: 'ghcr.io/acme/api:1' };

  it('keeps everything when the repository URL and registry are unchanged', () => {
    expect(planCredentialsForSourceChange(git, git, 'git_deploy_key', false)).toEqual({ repository: 'keep', registry: 'keep' });
    expect(
      planCredentialsForSourceChange(image, { ...image, imageRef: 'ghcr.io/acme/api:2' }, null, true),
    ).toEqual({ repository: 'keep', registry: 'keep' });
  });

  it('rotates a deploy key when the repository moves to another ssh URL', () => {
    const next = { ...git, repositoryUrl: 'git@github.com:acme/other.git' };
    expect(planCredentialsForSourceChange(git, next, 'git_deploy_key', false).repository).toBe('rotate');
  });

  it('removes a deploy key when the repository moves to https', () => {
    const next = { ...git, repositoryUrl: 'https://github.com/acme/api.git' };
    expect(planCredentialsForSourceChange(git, next, 'git_deploy_key', false).repository).toBe('remove');
  });

  it('removes an HTTPS token whenever the repository URL changes', () => {
    const current = { ...git, repositoryUrl: 'https://github.com/acme/api.git' };
    const next = { ...git, repositoryUrl: 'https://github.com/acme/other.git' };
    expect(planCredentialsForSourceChange(current, next, 'git_https_token', false).repository).toBe('remove');
  });

  it('removes the repository credential when the source becomes an image', () => {
    expect(planCredentialsForSourceChange(git, image, 'git_deploy_key', false).repository).toBe('remove');
  });

  it('removes the registry credential when the image registry changes or the source becomes git', () => {
    expect(
      planCredentialsForSourceChange(image, { ...image, imageRef: 'quay.io/acme/api:1' }, null, true).registry,
    ).toBe('remove');
    expect(planCredentialsForSourceChange(image, git, null, true).registry).toBe('remove');
  });

  it('plans nothing for absent credentials', () => {
    expect(planCredentialsForSourceChange(git, image, null, false)).toEqual({ repository: 'keep', registry: 'keep' });
  });
});
