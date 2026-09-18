// D-19: RED for `getServerView`/`listServerViews`. Both fail today for the same reason —
// apps/control-plane/src/services/read-servers.ts does not exist yet.
//
// Neither function is a mutation: no transaction is opened and no activity event is written
// (ACT-01) — both are proven by grep in the plan's own acceptance criteria, not duplicated here.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { SERVER_VIEW_KEYS } from '../../../apps/control-plane/src/services/server-view.js';
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

async function loadReadServers() {
  return import('../../../apps/control-plane/src/services/read-servers.js');
}

async function loadServerServices() {
  return import('../../../apps/control-plane/src/services/server-services.js');
}

async function registerFixtureServer(fx: ServiceFixture, name: string) {
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
  return result.server;
}

describe('getServerView (D-19)', () => {
  it('returns the ServerView for an existing server, with a matching credentialType', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture, uniqueName('get'));

    const { getServerView } = await loadReadServers();
    const view = await getServerView(fixture.deps, server.id);

    expect(view).not.toBeNull();
    expect(view?.id).toBe(server.id);
    expect(view?.credentialType).toBe('ssh_password');
  });

  it('returns null for an unknown serverId', async () => {
    fixture = await startServiceFixture();

    const { getServerView } = await loadReadServers();
    const view = await getServerView(fixture.deps, randomUUID());

    expect(view).toBeNull();
  });

  it('projects through toServerView: the key set equals SERVER_VIEW_KEYS exactly', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture, uniqueName('keys'));

    const { getServerView } = await loadReadServers();
    const view = await getServerView(fixture.deps, server.id);

    expect(view).not.toBeNull();
    expect(Object.keys(view ?? {}).sort()).toEqual([...SERVER_VIEW_KEYS].sort());
  });
});

describe('listServerViews (D-19)', () => {
  it('returns [] when there are no servers', async () => {
    fixture = await startServiceFixture();

    const { listServerViews } = await loadReadServers();
    const views = await listServerViews(fixture.deps);

    expect(views).toEqual([]);
  });

  it('returns every server ordered by name ascending', async () => {
    fixture = await startServiceFixture();
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const nameC = `zzz-${suffix}-c`;
    const nameA = `aaa-${suffix}-a`;
    const nameB = `mmm-${suffix}-b`;
    await registerFixtureServer(fixture, nameC);
    await registerFixtureServer(fixture, nameA);
    await registerFixtureServer(fixture, nameB);

    const { listServerViews } = await loadReadServers();
    const views = await listServerViews(fixture.deps);

    const namesForThisRun = views.map((v) => v.name).filter((n) => n.includes(suffix));
    expect(namesForThisRun).toEqual([nameA, nameB, nameC]);
  });

  it('projects every item through toServerView with no credential-shaped field', async () => {
    fixture = await startServiceFixture();
    await registerFixtureServer(fixture, uniqueName('list'));

    const { listServerViews } = await loadReadServers();
    const views = await listServerViews(fixture.deps);

    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(Object.keys(view).sort()).toEqual([...SERVER_VIEW_KEYS].sort());
    }
  });
});

describe('ServerServices facade exposes reads (D-01)', () => {
  it('has nine members including getServer and listServers', async () => {
    fixture = await startServiceFixture();
    const { createServerServices } = await loadServerServices();

    const services = createServerServices(fixture.deps);

    expect(Object.keys(services).sort()).toEqual(
      [
        'connectAndDiscover',
        'deleteServer',
        'editServer',
        'failInFlightConnection',
        'getServer',
        'listConnectingServerIds',
        'listServers',
        'registerServer',
        'trustFingerprint',
      ].sort(),
    );
  });

  it('getServer through the factory matches a direct getServerView call', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture, uniqueName('facade'));
    const { createServerServices } = await loadServerServices();
    const { getServerView } = await loadReadServers();
    const services = createServerServices(fixture.deps);

    const viaFactory = await services.getServer(server.id);
    const viaDirectCall = await getServerView(fixture.deps, server.id);

    expect(viaFactory).toEqual(viaDirectCall);
  });
});
