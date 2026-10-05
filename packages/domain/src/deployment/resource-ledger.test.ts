import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_EXITS,
  classifyCleanupOutcome,
  cleanupSetFor,
  createResourceLedger,
  isCleanupSettled,
  recordResource,
  type CleanupResource,
  type DeploymentExit,
  type LedgerEvent,
  type ResourceLedger,
} from './resource-ledger.js';

const SERVICE_ID = 'c6f053d9-77ca-4ea6-86df-105f47c7d9fb';
const DEPLOYMENT_ID = 'ca11b80a-9630-49f9-90f2-06a316ab8698';
const PREVIOUS_DEPLOYMENT_ID = '0b5e6c1d-2f3a-4b5c-8d9e-0f1a2b3c4d5e';

const WORKSPACE = `/opt/noodara-deploy/${DEPLOYMENT_ID}`;
const IMAGE = `noodara/${SERVICE_ID}:${DEPLOYMENT_ID}`;
const PREVIOUS_IMAGE = `noodara/${SERVICE_ID}:${PREVIOUS_DEPLOYMENT_ID}`;
const NETWORK = `noodara-net-${SERVICE_ID}`;
const CONTAINER = `noodara-${SERVICE_ID}`;

const FAILED_EXITS = [
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
] as const satisfies readonly DeploymentExit[];

function ledger(...events: LedgerEvent[]): ResourceLedger {
  const created = createResourceLedger(SERVICE_ID, DEPLOYMENT_ID);
  if (!created.ok) {
    throw new Error(created.code);
  }
  return events.reduce(recordResource, created.value);
}

/** A full first deploy: nothing existed for the service before this attempt. */
const FIRST_DEPLOY: LedgerEvent[] = [
  { kind: 'workspace_created' },
  { kind: 'secrets_file_written', name: 'deploy_key' },
  { kind: 'secrets_file_written', name: 'known_hosts' },
  { kind: 'image_created' },
  { kind: 'network_created' },
  { kind: 'container_created' },
];

/** A redeploy that replaced the running per-service container. */
const REDEPLOY: LedgerEvent[] = [
  { kind: 'workspace_created' },
  { kind: 'secrets_file_written', name: 'docker_config' },
  { kind: 'image_created' },
  { kind: 'previous_container_removed', imageRef: PREVIOUS_IMAGE },
  { kind: 'container_created' },
];

const containsContainer = (set: readonly CleanupResource[]) =>
  set.some((r) => JSON.stringify(r).includes(`"${CONTAINER}"`));

describe('createResourceLedger', () => {
  it('derives the deterministic names from the service and deployment ids', () => {
    const l = ledger();

    expect(l.names).toEqual({
      workspace: WORKSPACE,
      image: IMAGE,
      network: NETWORK,
      container: CONTAINER,
    });
  });

  it('starts with nothing recorded', () => {
    const l = ledger();

    expect(l.workspaceCreated).toBe(false);
    expect(l.secretsFiles).toEqual([]);
    expect(l.imageCreated).toBe(false);
    expect(l.networkCreatedByAttempt).toBe(false);
    expect(l.containerCreated).toBe(false);
    expect(l.replacedImage).toBeNull();
  });

  it.each([
    ['service', 'not-a-uuid', DEPLOYMENT_ID],
    ['deployment', SERVICE_ID, '../../etc'],
  ])('rejects an invalid %s id with RESOURCE_ID_INVALID', (_label, serviceId, deploymentId) => {
    const result = createResourceLedger(serviceId, deploymentId);

    expect(result).toMatchObject({ ok: false, code: 'RESOURCE_ID_INVALID' });
  });
});

describe('recordResource', () => {
  it('records workspace, secrets files, per-attempt image, network and container', () => {
    const l = ledger(...FIRST_DEPLOY);

    expect(l.workspaceCreated).toBe(true);
    expect(l.secretsFiles).toEqual([
      `${WORKSPACE}/secrets/deploy_key`,
      `${WORKSPACE}/secrets/known_hosts`,
    ]);
    expect(l.imageCreated).toBe(true);
    expect(l.networkCreatedByAttempt).toBe(true);
    expect(l.containerCreated).toBe(true);
  });

  it('maps the registry login config to the per-workspace docker config dir', () => {
    const l = ledger({ kind: 'secrets_file_written', name: 'docker_config' });

    expect(l.secretsFiles).toEqual([`${WORKSPACE}/secrets/docker`]);
  });

  it('records a secrets file once even when it is written twice', () => {
    const l = ledger(
      { kind: 'secrets_file_written', name: 'https_token' },
      { kind: 'secrets_file_written', name: 'https_token' },
    );

    expect(l.secretsFiles).toEqual([`${WORKSPACE}/secrets/https_token`]);
  });

  it('never mutates the ledger it is given', () => {
    const before = ledger();

    const after = recordResource(before, { kind: 'workspace_created' });

    expect(before.workspaceCreated).toBe(false);
    expect(after).not.toBe(before);
  });

  it('records the image of the per-service container the attempt replaced', () => {
    const l = ledger({ kind: 'previous_container_removed', imageRef: PREVIOUS_IMAGE });

    expect(l.replacedImage).toBe(PREVIOUS_IMAGE);
  });

  it.each([
    ['a foreign image', 'nginx:1.27'],
    ['another service image', `noodara/0b5e6c1d-2f3a-4b5c-8d9e-0f1a2b3c4d5e:${DEPLOYMENT_ID}`],
    ['a non-uuid tag', `noodara/${SERVICE_ID}:latest`],
    ['this attempt image', IMAGE],
    ['an unknown image', null],
  ])('never adopts %s as a replaced image', (_label, imageRef) => {
    const l = ledger({ kind: 'previous_container_removed', imageRef });

    expect(l.replacedImage).toBeNull();
  });
});

describe('cleanupSetFor', () => {
  it('lists every exit the engine can end in', () => {
    expect([...DEPLOYMENT_EXITS]).toEqual([
      'SUCCESS',
      'FAILED',
      'CANCELLED',
      'TIMEOUT',
      'WORKER_CRASHED',
    ]);
  });

  it('on SUCCESS removes secrets and workspace and keeps image, network and container', () => {
    const set = cleanupSetFor(ledger(...FIRST_DEPLOY), 'SUCCESS');

    expect(set).toEqual([
      { kind: 'secrets_file', path: `${WORKSPACE}/secrets/deploy_key` },
      { kind: 'secrets_file', path: `${WORKSPACE}/secrets/known_hosts` },
      { kind: 'workspace', path: WORKSPACE },
    ]);
  });

  it('on SUCCESS of a redeploy also removes the image of the replaced container', () => {
    const set = cleanupSetFor(ledger(...REDEPLOY), 'SUCCESS');

    expect(set).toEqual([
      { kind: 'secrets_file', path: `${WORKSPACE}/secrets/docker` },
      { kind: 'workspace', path: WORKSPACE },
      { kind: 'image', ref: PREVIOUS_IMAGE },
    ]);
  });

  it.each(FAILED_EXITS)(
    'on %s before any container was touched removes secrets, workspace, image and the new network',
    (exit) => {
      const l = ledger(
        { kind: 'workspace_created' },
        { kind: 'secrets_file_written', name: 'deploy_key' },
        { kind: 'image_created' },
        { kind: 'network_created' },
      );

      const set = cleanupSetFor(l, exit);

      expect(set).toEqual([
        { kind: 'secrets_file', path: `${WORKSPACE}/secrets/deploy_key` },
        { kind: 'workspace', path: WORKSPACE },
        { kind: 'image', ref: IMAGE },
        { kind: 'network', name: NETWORK },
      ]);
    },
  );

  it.each(FAILED_EXITS)(
    'on %s keeps the network the service already had (its running container is attached)',
    (exit) => {
      const l = ledger({ kind: 'workspace_created' }, { kind: 'image_created' });

      const set = cleanupSetFor(l, exit);

      expect(set).toEqual([
        { kind: 'workspace', path: WORKSPACE },
        { kind: 'image', ref: IMAGE },
      ]);
    },
  );

  it.each(FAILED_EXITS)(
    'on %s after the new per-service container exists keeps it, its image and its network',
    (exit) => {
      const set = cleanupSetFor(ledger(...FIRST_DEPLOY), exit);

      expect(set).toEqual([
        { kind: 'secrets_file', path: `${WORKSPACE}/secrets/deploy_key` },
        { kind: 'secrets_file', path: `${WORKSPACE}/secrets/known_hosts` },
        { kind: 'workspace', path: WORKSPACE },
      ]);
    },
  );

  it.each(FAILED_EXITS)(
    'on %s after the old container was removed but before the new one existed drops both images',
    (exit) => {
      const l = ledger(
        { kind: 'workspace_created' },
        { kind: 'image_created' },
        { kind: 'previous_container_removed', imageRef: PREVIOUS_IMAGE },
      );

      const set = cleanupSetFor(l, exit);

      expect(set).toEqual([
        { kind: 'workspace', path: WORKSPACE },
        { kind: 'image', ref: IMAGE },
        { kind: 'image', ref: PREVIOUS_IMAGE },
      ]);
    },
  );

  it.each(FAILED_EXITS)('on %s with nothing recorded removes only the workspace path', (exit) => {
    expect(cleanupSetFor(ledger(), exit)).toEqual([{ kind: 'workspace', path: WORKSPACE }]);
  });

  it('on WORKER_CRASHED ignores the (lost) in-job records and uses the deterministic names', () => {
    const fresh = cleanupSetFor(ledger(), 'WORKER_CRASHED');
    const recorded = cleanupSetFor(ledger(...FIRST_DEPLOY), 'WORKER_CRASHED');

    expect(fresh).toEqual([
      { kind: 'workspace', path: WORKSPACE },
      { kind: 'image', ref: IMAGE },
    ]);
    expect(recorded).toEqual(fresh);
  });

  it.each(DEPLOYMENT_EXITS)(
    'never puts the per-service container or its network in the %s cleanup set when it runs',
    (exit) => {
      for (const events of [FIRST_DEPLOY, REDEPLOY]) {
        const set = cleanupSetFor(ledger(...events), exit);

        expect(containsContainer(set)).toBe(false);
        expect(set).not.toContainEqual({ kind: 'network', name: NETWORK });
      }
    },
  );

  it.each(DEPLOYMENT_EXITS)(
    'always removes secrets before the workspace and images (%s)',
    (exit) => {
      const set = cleanupSetFor(ledger(...FIRST_DEPLOY), exit);
      const kinds = set.map((r) => r.kind);
      const lastSecret = kinds.lastIndexOf('secrets_file');
      const workspace = kinds.indexOf('workspace');

      expect(workspace).toBeGreaterThan(lastSecret);
      expect(kinds.slice(0, workspace).every((k) => k === 'secrets_file')).toBe(true);
    },
  );
});

describe('classifyCleanupOutcome', () => {
  const out = (exitCode: number, stderr = '') => ({ stdout: '', stderr, exitCode });

  it.each<[CleanupResource, ReturnType<typeof out>, string]>([
    [{ kind: 'workspace', path: WORKSPACE }, out(0), 'removed'],
    [{ kind: 'secrets_file', path: `${WORKSPACE}/secrets/deploy_key` }, out(0), 'removed'],
    [
      { kind: 'workspace', path: WORKSPACE },
      out(1, `rm: cannot remove '${WORKSPACE}': No such file or directory`),
      'already_absent',
    ],
    [
      { kind: 'workspace', path: WORKSPACE },
      out(1, 'rm: cannot remove: Permission denied'),
      'failed',
    ],
    [{ kind: 'image', ref: IMAGE }, out(0), 'removed'],
    [
      { kind: 'image', ref: IMAGE },
      out(1, `Error response from daemon: No such image: ${IMAGE}`),
      'already_absent',
    ],
    [
      { kind: 'image', ref: IMAGE },
      out(
        1,
        'Error response from daemon: conflict: unable to remove repository reference (must force) - container 4fb0 is using its referenced image 1a2b',
      ),
      'in_use',
    ],
    [{ kind: 'image', ref: IMAGE }, out(1, 'Cannot connect to the Docker daemon'), 'failed'],
    [{ kind: 'network', name: NETWORK }, out(0), 'removed'],
    [
      { kind: 'network', name: NETWORK },
      out(1, `Error response from daemon: network ${NETWORK} not found`),
      'already_absent',
    ],
    [
      { kind: 'network', name: NETWORK },
      out(1, `Error: No such network: ${NETWORK}`),
      'already_absent',
    ],
    [
      { kind: 'network', name: NETWORK },
      out(
        1,
        `Error response from daemon: error while removing network: network ${NETWORK} id abc has active endpoints`,
      ),
      'in_use',
    ],
    [{ kind: 'network', name: NETWORK }, out(127, 'sh: docker: not found'), 'failed'],
  ])('classifies %o with %o as %s', (resource, output, expected) => {
    expect(classifyCleanupOutcome(resource, output)).toBe(expected);
  });

  it('treats every outcome but failed as settled', () => {
    expect(isCleanupSettled('removed')).toBe(true);
    expect(isCleanupSettled('already_absent')).toBe(true);
    expect(isCleanupSettled('in_use')).toBe(true);
    expect(isCleanupSettled('failed')).toBe(false);
  });
});

describe('cleanup idempotency (H1)', () => {
  /** An in-memory remote host: removal succeeds once, then reports the resource as absent. */
  function fakeRemote(initial: readonly string[]) {
    const present = new Set(initial);
    const key = (r: CleanupResource) =>
      r.kind === 'image' ? r.ref : r.kind === 'network' ? r.name : r.path;
    return (r: CleanupResource) => {
      const k = key(r);
      if (present.delete(k)) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (r.kind === 'image') {
        return {
          stdout: '',
          stderr: `Error response from daemon: No such image: ${k}`,
          exitCode: 1,
        };
      }
      if (r.kind === 'network') {
        return {
          stdout: '',
          stderr: `Error response from daemon: network ${k} not found`,
          exitCode: 1,
        };
      }
      // `rm -rf` of a missing path exits 0.
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  }

  it.each(DEPLOYMENT_EXITS)(
    'computing and executing the %s cleanup twice yields the same set and no error',
    (exit) => {
      const l = ledger(
        { kind: 'workspace_created' },
        { kind: 'secrets_file_written', name: 'deploy_key' },
        { kind: 'image_created' },
        { kind: 'network_created' },
        { kind: 'previous_container_removed', imageRef: PREVIOUS_IMAGE },
      );
      const remote = fakeRemote([
        WORKSPACE,
        `${WORKSPACE}/secrets/deploy_key`,
        IMAGE,
        PREVIOUS_IMAGE,
        NETWORK,
      ]);

      const first = cleanupSetFor(l, exit);
      const firstOutcomes = first.map((r) => classifyCleanupOutcome(r, remote(r)));
      const second = cleanupSetFor(l, exit);
      const secondOutcomes = second.map((r) => classifyCleanupOutcome(r, remote(r)));

      expect(second).toEqual(first);
      expect(firstOutcomes.every(isCleanupSettled)).toBe(true);
      expect(secondOutcomes.every(isCleanupSettled)).toBe(true);
      expect(secondOutcomes.filter((o) => o === 'removed')).toEqual(
        second
          .filter((r) => r.kind === 'workspace' || r.kind === 'secrets_file')
          .map(() => 'removed'),
      );
    },
  );
});
