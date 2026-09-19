// DISC-02/D-05: RED for `readLatestDiscovery`. Fails today because
// apps/control-plane/src/services/read-discovery.ts does not exist yet.
//
// Not a mutation: no transaction is opened and no activity event is written (ACT-01) — both are
// proven by grep in the plan's own acceptance criteria, not duplicated here.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiscoveryCheck } from '@noodara/domain/discovery';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { discoverySnapshots } from '../../../apps/control-plane/src/db/schema/discovery-snapshots.js';
import { startServiceFixture, type ServiceFixture } from './helpers/service-fixture.js';

let fixture: ServiceFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

type FixtureActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };

const SYSTEM: FixtureActor = { type: 'system' };

function freshPassword(): string {
  return randomUUID().replace(/-/g, '');
}

function uniqueName(suffix: string): string {
  return `srv-${suffix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

async function loadReadDiscovery() {
  return import('../../../apps/control-plane/src/services/read-discovery.js');
}

async function registerFixtureServer(fx: ServiceFixture, name: string): Promise<string> {
  const { registerServer } = await loadRegisterServer();
  const result = await registerServer(fx.deps, {
    actor: SYSTEM,
    name,
    host: uniqueHost(),
    credential: { kind: 'password', password: freshPassword() },
  });
  if (!result.ok) {
    throw new Error(`registerFixtureServer failed unexpectedly: ${result.code} ${result.message}`);
  }
  return result.server.id;
}

function buildCheck(overrides: Partial<DiscoveryCheck> = {}): DiscoveryCheck {
  return { id: 'hostname', status: 'pass', detail: 'ok', durationMs: 5, ...overrides };
}

async function insertSnapshot(
  fx: ServiceFixture,
  serverId: string,
  input: { collectedAt: Date; outcome: 'ok' | 'partial' | 'failed'; payload: unknown },
): Promise<void> {
  await fx.db.insert(discoverySnapshots).values({
    serverId,
    collectedAt: input.collectedAt,
    outcome: input.outcome,
    payload: input.payload,
  });
}

describe('readLatestDiscovery (DISC-02, D-05)', () => {
  it("returns the newer snapshot's collectedAt/outcome/checks for a server with two snapshots", async () => {
    fixture = await startServiceFixture();
    const serverId = await registerFixtureServer(fixture, uniqueName('two'));
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-01-02T00:00:00.000Z');
    const olderChecks = [buildCheck({ id: 'hostname', detail: 'older' })];
    const newerChecks = [buildCheck({ id: 'arch', detail: 'newer' })];
    await insertSnapshot(fixture, serverId, {
      collectedAt: older,
      outcome: 'ok',
      payload: { facts: {}, checks: olderChecks, warnings: [] },
    });
    await insertSnapshot(fixture, serverId, {
      collectedAt: newer,
      outcome: 'partial',
      payload: { facts: {}, checks: newerChecks, warnings: ['UNSUPPORTED_OS'] },
    });

    const { readLatestDiscovery } = await loadReadDiscovery();
    const view = await readLatestDiscovery(fixture.deps, serverId);

    expect(view.collectedAt).toEqual(newer);
    expect(view.outcome).toBe('partial');
    expect(view.checks).toEqual(newerChecks);
    expect(view.warnings).toEqual(['UNSUPPORTED_OS']);
  });

  it('returns the all-null/empty shape for a server with no snapshot', async () => {
    fixture = await startServiceFixture();
    const serverId = await registerFixtureServer(fixture, uniqueName('none'));

    const { readLatestDiscovery } = await loadReadDiscovery();
    const view = await readLatestDiscovery(fixture.deps, serverId);

    expect(view).toEqual({ collectedAt: null, outcome: null, checks: [], warnings: [] });
  });

  it('returns exactly the four allowlisted keys, never forwarding facts', async () => {
    fixture = await startServiceFixture();
    const serverId = await registerFixtureServer(fixture, uniqueName('keys'));
    await insertSnapshot(fixture, serverId, {
      collectedAt: new Date(),
      outcome: 'ok',
      payload: { facts: { hostname: 'sensitive-leak' }, checks: [buildCheck()], warnings: [] },
    });

    const { readLatestDiscovery } = await loadReadDiscovery();
    const view = await readLatestDiscovery(fixture.deps, serverId);

    expect(Object.keys(view).sort()).toEqual(['checks', 'collectedAt', 'outcome', 'warnings']);
    expect(JSON.stringify(view)).not.toContain('sensitive-leak');
  });

  it('returns empty arrays when the stored payload is missing checks/warnings', async () => {
    fixture = await startServiceFixture();
    const serverId = await registerFixtureServer(fixture, uniqueName('malformed'));
    await insertSnapshot(fixture, serverId, {
      collectedAt: new Date(),
      outcome: 'failed',
      payload: { facts: {} },
    });

    const { readLatestDiscovery } = await loadReadDiscovery();
    const view = await readLatestDiscovery(fixture.deps, serverId);

    expect(view.checks).toEqual([]);
    expect(view.warnings).toEqual([]);
  });
});
