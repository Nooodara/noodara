// 12-11b: the pure half of the real `loadTarget` port. Rows in, a DeployTarget or a closed code
// out; a corrupt source snapshot throws a fixed-message error (the job handler ends it as
// WORKER_CRASHED). Credentials are decrypted here and leave only as SecretValue.
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { revealSecret, secretValue } from '@noodara/domain/security';
import type { Database } from '../db/client.js';
import { credentials } from '../db/schema/credentials.js';
import { deployments } from '../db/schema/deployments.js';
import { services } from '../db/schema/services.js';
import { encodeServiceCredential } from '../services/service-credentials.js';
import {
  createLoadTarget,
  DeployTargetError,
  resolveDeployTarget,
  sourceFromSnapshot,
  type DeployTargetRows,
} from './deploy-target.js';

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
    // 17-02: no stored healthcheck keeps the v0.2 post-start polls.
    expect(result.target.healthcheck).toBeNull();
  });

  it('carries the service healthcheck config into the target (17-02 A2)', () => {
    const healthcheck = {
      type: 'http',
      path: '/healthz',
      port: 3000,
      expectedStatuses: [200],
      probeTimeoutS: 2,
      intervalS: 1,
      retries: 3,
      startPeriodS: 0,
    };
    const base = rows();
    const result = resolveDeployTarget({ ...base, service: { ...base.service, healthcheck } }, masterKeys, PANEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.healthcheck).toMatchObject({ type: 'http', path: '/healthz', port: 3000 });
  });

  it('a stored healthcheck that does not validate throws a fixed-message DeployTargetError', () => {
    const base = rows();
    const corrupt = { ...base, service: { ...base.service, healthcheck: { type: 'http', path: 'evil', port: -1 } } };
    expect(() => resolveDeployTarget(corrupt, masterKeys, PANEL)).toThrow(DeployTargetError);
    expect(() => resolveDeployTarget(corrupt, masterKeys, PANEL)).not.toThrow(/evil/);
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

const PREVIOUS_ID = '0190a3c4-5555-7aaa-8bbb-000000000005';
const runtimeConfig = {
  version: 1,
  imageRef: `noodara/${SERVICE_ID}:${PREVIOUS_ID}`,
  internalPort: 3000,
  publishedPort: 8080,
  healthcheck: { type: 'container', probeTimeoutS: 5, intervalS: 2, retries: 3, startPeriodS: 0 },
};

describe('resolveDeployTarget: rollback inputs (17-03 P4)', () => {
  it('defaults autoRollback to true and previousSuccess to null when the rows carry neither', () => {
    const result = resolveDeployTarget(rows(), masterKeys, PANEL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.autoRollback).toBe(true);
    expect(result.target.previousSuccess).toBeNull();
  });

  it('carries services.autoRollback false', () => {
    const base = rows();
    const result = resolveDeployTarget({ ...base, service: { ...base.service, autoRollback: false } }, masterKeys, PANEL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.autoRollback).toBe(false);
  });

  it('carries the previous SUCCESS deployment as {id, runtimeConfig} with a validated snapshot', () => {
    const result = resolveDeployTarget(rows({ previousSuccess: { id: PREVIOUS_ID, runtimeConfig } }), masterKeys, PANEL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.previousSuccess).toEqual({ id: PREVIOUS_ID, runtimeConfig });
  });

  it.each([
    ['a null snapshot (a v0.2 deployment)', null],
    ['an unsupported version', { ...runtimeConfig, version: 2 }],
    ['an unknown field', { ...runtimeConfig, env: { TOKEN: 'canary' } }],
    ['an invalid image ref', { ...runtimeConfig, imageRef: '--evil' }],
    ['not an object', 'evil'],
  ])('gives runtimeConfig null for %s, never an error', (_label, snapshot) => {
    const result = resolveDeployTarget(rows({ previousSuccess: { id: PREVIOUS_ID, runtimeConfig: snapshot } }), masterKeys, PANEL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.previousSuccess).toEqual({ id: PREVIOUS_ID, runtimeConfig: null });
  });

  it('never offers the current deployment as its own previous success', () => {
    const result = resolveDeployTarget(rows({ previousSuccess: { id: DEPLOYMENT_ID, runtimeConfig } }), masterKeys, PANEL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.previousSuccess).toBeNull();
  });

  it('a previous success id that is not a UUID is a corrupt row', () => {
    expect(() =>
      resolveDeployTarget(rows({ previousSuccess: { id: 'not-a-uuid', runtimeConfig } }), masterKeys, PANEL),
    ).toThrow(DeployTargetError);
  });
});

interface LoadQuery {
  readonly table: unknown;
  readonly fields: Record<string, unknown> | undefined;
  readonly calls: { method: string; args: unknown[] }[];
}

/** A recording select-only fake: each `select()` chain answers from `answers` by table. */
function loadDb(answers: { deployments: unknown[][]; services: unknown[][] }) {
  const queries: LoadQuery[] = [];
  const queues = { deployments: [...answers.deployments], services: [...answers.services] };
  const respond = (query: LoadQuery): unknown[] => {
    if (query.table === deployments) return queues.deployments.shift() ?? [];
    if (query.table === services) return queues.services.shift() ?? [];
    if (query.table === credentials) return [];
    return [];
  };
  const db = {
    select: (fields?: Record<string, unknown>) => {
      const query: LoadQuery = { table: undefined, fields, calls: [] };
      queries.push(query);
      const chain: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) => {
                resolve(respond(query));
              };
            }
            return (...args: unknown[]) => {
              if (prop === 'from') (query as { table: unknown }).table = args[0];
              query.calls.push({ method: String(prop), args });
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { db: db as unknown as Database, queries };
}

const render = (fragment: unknown): { sql: string; params: unknown[] } => new PgDialect().sqlToQuery(fragment as SQL);
const argOf = (query: LoadQuery | undefined, method: string): unknown[] =>
  query?.calls.find((call) => call.method === method)?.args ?? [];

describe('createLoadTarget: rollback inputs (17-03 P4)', () => {
  const deploymentRow = { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, source: gitSnapshot };
  const serviceRowOf = (autoRollback: boolean) => ({
    id: SERVICE_ID,
    serverId: SERVER_ID,
    repositoryCredentialId: null,
    registryCredentialId: null,
    healthcheck: null,
    autoRollback,
  });
  const load = (fake: ReturnType<typeof loadDb>) =>
    createLoadTarget({ db: fake.db, masterKeys: () => Promise.resolve(masterKeys), panelPorts: PANEL })({
      id: DEPLOYMENT_ID,
      serviceId: SERVICE_ID,
    });

  it('loads services.autoRollback and the latest SUCCESS deployment of the service other than this one', async () => {
    const fake = loadDb({
      deployments: [[deploymentRow], [{ id: PREVIOUS_ID, runtimeConfig }]],
      services: [[serviceRowOf(false)], []],
    });

    const result = await load(fake);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.autoRollback).toBe(false);
    expect(result.target.previousSuccess).toEqual({ id: PREVIOUS_ID, runtimeConfig });

    const serviceQuery = fake.queries.find((q) => q.table === services);
    expect(serviceQuery?.fields).toHaveProperty('autoRollback', services.autoRollback);

    const previousQuery = fake.queries.filter((q) => q.table === deployments)[1];
    expect(previousQuery?.fields).toEqual({ id: deployments.id, runtimeConfig: deployments.runtimeConfig });
    const where = render(argOf(previousQuery, 'where')[0]);
    expect(where.sql).toBe('("deployments"."service_id" = $1 and "deployments"."status" = $2 and "deployments"."id" <> $3)');
    expect(where.params).toEqual([SERVICE_ID, 'SUCCESS', DEPLOYMENT_ID]);
    const order = argOf(previousQuery, 'orderBy').map((fragment) => render(fragment).sql);
    expect(order).toEqual(['"deployments"."created_at" desc', '"deployments"."id" desc']);
    expect(argOf(previousQuery, 'limit')).toEqual([1]);
  });

  it('gives previousSuccess null when the service has no other SUCCESS deployment', async () => {
    const fake = loadDb({ deployments: [[deploymentRow], []], services: [[serviceRowOf(true)], []] });
    const result = await load(fake);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.autoRollback).toBe(true);
    expect(result.target.previousSuccess).toBeNull();
  });

  it('gives runtimeConfig null when the previous SUCCESS snapshot does not validate', async () => {
    const fake = loadDb({
      deployments: [[deploymentRow], [{ id: PREVIOUS_ID, runtimeConfig: { version: 1, imageRef: '--evil' } }]],
      services: [[serviceRowOf(true)], []],
    });
    const result = await load(fake);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.previousSuccess).toEqual({ id: PREVIOUS_ID, runtimeConfig: null });
  });
});

describe('resolveDeployTarget: requested SHA (18-03)', () => {
  const PUSHED = '0123456789abcdef0123456789abcdef01234567';
  const withSha = (commitSha: string | null | undefined): DeployTargetRows => {
    const base = rows();
    return commitSha === undefined ? base : { ...base, deployment: { ...base.deployment, commitSha } };
  };

  it('a manual deploy (no stored SHA) keeps the v0.2 behaviour: requestedSha null', () => {
    for (const value of [null, undefined]) {
      const result = resolveDeployTarget(withSha(value), masterKeys, PANEL);
      if (!result.ok) throw new Error('expected ok');
      expect(result.target.requestedSha).toBeNull();
    }
  });

  it('carries the stored webhook SHA as the validated requestedSha (A1)', () => {
    const result = resolveDeployTarget(withSha(PUSHED), masterKeys, PANEL);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target.requestedSha).toBe(PUSHED);
  });

  it.each(['-oProxyCommand=x', `${PUSHED}a`, PUSHED.slice(0, 7), 'g'.repeat(40), PUSHED.toUpperCase(), ''])(
    'a stored SHA %j that is not 40 lowercase hex is a corrupt row, never echoed (H1)',
    (value) => {
      expect(() => resolveDeployTarget(withSha(value), masterKeys, PANEL)).toThrow(DeployTargetError);
      if (value.length > 0) {
        expect(() => resolveDeployTarget(withSha(value), masterKeys, PANEL)).not.toThrow(value);
      }
    },
  );
});

describe('createLoadTarget: requested SHA (18-03)', () => {
  it('selects deployments.commit_sha and hands it on as requestedSha', async () => {
    const pushed = 'f'.repeat(40);
    const fake = loadDb({
      deployments: [[{ id: DEPLOYMENT_ID, serviceId: SERVICE_ID, source: gitSnapshot, commitSha: pushed }], []],
      services: [
        [
          {
            id: SERVICE_ID,
            serverId: SERVER_ID,
            repositoryCredentialId: null,
            registryCredentialId: null,
            healthcheck: null,
            autoRollback: true,
          },
        ],
        [],
      ],
    });

    const result = await createLoadTarget({ db: fake.db, masterKeys: () => Promise.resolve(masterKeys), panelPorts: PANEL })({
      id: DEPLOYMENT_ID,
      serviceId: SERVICE_ID,
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.target.requestedSha).toBe(pushed);
    expect(fake.queries.find((q) => q.table === deployments)?.fields).toHaveProperty('commitSha', deployments.commitSha);
  });
});
