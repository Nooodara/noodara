import { describe, expect, it } from 'vitest';
import type { EnvValue } from '../env/env-value.js';
import { buildGraph, namesInEnvValue } from './build-graph.js';
import { compareGraphKeys, type GraphSnapshot, type InfrastructureGraph } from './graph-types.js';
import { scopeGraph } from './scope-graph.js';

// 26-03 (GRF-01): buildGraph, DEPENDS_ON inference and scopeGraph. This file alone holds
// build-graph.ts and scope-graph.ts at 100% in coverage-state-machine.

/** Deterministic UUID-shaped ids: `uuid(1)` = 00000000-0000-4000-8000-000000000001. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const plain = (value: string): EnvValue => ({ kind: 'plain', value });
const ref = (name: string): EnvValue => ({ kind: 'secret_ref', name });

const IDS = {
  server1: uuid(1),
  server2: uuid(2),
  projectA: uuid(10),
  projectB: uuid(11),
  envAProd: uuid(20),
  envAStaging: uuid(21),
  envBProd: uuid(22),
  api: uuid(30),
  db: uuid(31),
  web: uuid(32),
  other: uuid(33),
  domainApi: uuid(40),
  domainWeb: uuid(41),
  domainOther: uuid(42),
} as const;

/** Two projects on two servers; project A has production (api, db) and staging (web). */
function baseSnapshot(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    servers: [
      { id: IDS.server1, name: 'edge-1' },
      { id: IDS.server2, name: 'edge-2' },
    ],
    projects: [
      { id: IDS.projectA, name: 'shop' },
      { id: IDS.projectB, name: 'blog' },
    ],
    environments: [
      { id: IDS.envAProd, projectId: IDS.projectA, name: 'production' },
      { id: IDS.envAStaging, projectId: IDS.projectA, name: 'staging' },
      { id: IDS.envBProd, projectId: IDS.projectB, name: 'production' },
    ],
    services: [
      {
        id: IDS.api,
        environmentId: IDS.envAProd,
        serverId: IDS.server1,
        name: 'api',
      },
      {
        id: IDS.db,
        environmentId: IDS.envAProd,
        serverId: IDS.server1,
        name: 'db',
      },
      {
        id: IDS.web,
        environmentId: IDS.envAStaging,
        serverId: IDS.server2,
        name: 'web',
      },
      {
        id: IDS.other,
        environmentId: IDS.envBProd,
        serverId: IDS.server2,
        name: 'blog',
      },
    ],
    domains: [
      { id: IDS.domainApi, serviceId: IDS.api, hostname: 'api.shop.test' },
      { id: IDS.domainWeb, serviceId: IDS.web, hostname: 'staging.shop.test' },
      { id: IDS.domainOther, serviceId: IDS.other, hostname: 'blog.test' },
    ],
    serviceEnv: [],
    ...overrides,
  };
}

/** Every invariant of A2; returns the broken ones so a failure names them. */
function graphInvariantViolations(graph: InfrastructureGraph): string[] {
  const violations: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (ids.size !== graph.nodes.length) violations.push('duplicate node id');
  const outgoing = (from: string, type: string): number =>
    graph.relations.filter((r) => r.from === from && r.type === type).length;
  for (const node of graph.nodes) {
    if (node.kind === 'Service') {
      if (outgoing(node.id, 'RUNS_ON') !== 1) violations.push(`${node.id} RUNS_ON != 1`);
      if (outgoing(node.id, 'BELONGS_TO') !== 1) violations.push(`${node.id} BELONGS_TO != 1`);
    }
    if (node.kind === 'Environment' && outgoing(node.id, 'BELONGS_TO') !== 1) {
      violations.push(`${node.id} BELONGS_TO != 1`);
    }
    if (
      node.kind === 'Domain' &&
      !graph.relations.some((r) => r.type === 'EXPOSED_BY' && r.to === node.id)
    ) {
      violations.push(`${node.id} orphan domain`);
    }
  }
  for (const r of graph.relations) {
    if (!ids.has(r.from) || !ids.has(r.to)) violations.push(`${r.id} dangling`);
  }
  return violations;
}

/** Seeded PRNG (mulberry32), as in observability/parsers.property.test.ts. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

function shuffledSnapshot(snapshot: GraphSnapshot, next: () => number): GraphSnapshot {
  return {
    servers: shuffled(snapshot.servers, next),
    projects: shuffled(snapshot.projects, next),
    environments: shuffled(snapshot.environments, next),
    services: shuffled(snapshot.services, next),
    domains: shuffled(snapshot.domains, next),
    serviceEnv: shuffled(snapshot.serviceEnv, next),
  };
}

const node = (graph: InfrastructureGraph, kind: string, entityId: string) =>
  graph.nodes.find((n) => n.id === `${kind}:${entityId}`);
const relationIds = (graph: InfrastructureGraph, type?: string): string[] =>
  graph.relations.filter((r) => type === undefined || r.type === type).map((r) => r.id);
const dependsOn = (graph: InfrastructureGraph) =>
  graph.relations
    .filter((r) => r.type === 'DEPENDS_ON')
    .map((r) => ({ from: r.from, to: r.to, envKeys: r.envKeys }));
const svc = (id: string): string => `service:${id}`;
const env = (serviceId: string, key: string, value: EnvValue) => ({
  serviceId,
  key,
  value,
});

describe('buildGraph nodes and relations (A1)', () => {
  const graph = buildGraph(baseSnapshot());

  it('derives one node per registered entity with kind-prefixed ids and parent refs', () => {
    expect(graph.nodes.map((n) => n.kind).sort()).toEqual([
      ...Array<string>(3).fill('Domain'),
      ...Array<string>(3).fill('Environment'),
      ...Array<string>(2).fill('Project'),
      ...Array<string>(2).fill('Server'),
      ...Array<string>(4).fill('Service'),
    ]);
    expect(node(graph, 'server', IDS.server1)).toEqual({
      id: `server:${IDS.server1}`,
      kind: 'Server',
      entityId: IDS.server1,
      label: 'edge-1',
    });
    expect(node(graph, 'environment', IDS.envAStaging)).toMatchObject({
      projectId: IDS.projectA,
      label: 'staging',
    });
    expect(node(graph, 'service', IDS.web)).toMatchObject({
      projectId: IDS.projectA,
      environmentId: IDS.envAStaging,
      serverId: IDS.server2,
      label: 'web',
    });
    expect(node(graph, 'domain', IDS.domainApi)).toMatchObject({
      label: 'api.shop.test',
      serviceId: IDS.api,
      environmentId: IDS.envAProd,
      projectId: IDS.projectA,
    });
    expect(graph.omitted).toEqual([]);
  });

  it('emits RUNS_ON, BELONGS_TO and EXPOSED_BY with the documented direction', () => {
    expect(relationIds(graph, 'RUNS_ON')).toContain(
      `RUNS_ON:service:${IDS.api}->server:${IDS.server1}`,
    );
    expect(relationIds(graph, 'BELONGS_TO')).toEqual(
      expect.arrayContaining([
        `BELONGS_TO:service:${IDS.api}->environment:${IDS.envAProd}`,
        `BELONGS_TO:environment:${IDS.envAProd}->project:${IDS.projectA}`,
      ]),
    );
    expect(relationIds(graph, 'EXPOSED_BY')).toContain(
      `EXPOSED_BY:service:${IDS.api}->domain:${IDS.domainApi}`,
    );
    expect(relationIds(graph, 'RUNS_ON')).toHaveLength(4);
    expect(relationIds(graph, 'BELONGS_TO')).toHaveLength(7);
    expect(relationIds(graph, 'EXPOSED_BY')).toHaveLength(3);
  });

  it('sorts nodes and relations by id', () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    const rels = relationIds(graph);
    expect(rels).toEqual([...rels].sort());
  });

  it('is byte-identical for the same input in any order and does not mutate it', () => {
    const snapshot = baseSnapshot({
      serviceEnv: [
        env(IDS.api, 'DATABASE_URL', plain(`postgres://app@noodara-${IDS.db}:5432/app`)),
        env(IDS.api, 'DB_HOST', plain(`noodara-${IDS.db}`)),
        env(IDS.web, 'API_URL', plain('https://api.shop.test/v1')),
      ],
      servers: [...baseSnapshot().servers, { id: IDS.server1, name: 'dup' }],
    });
    const frozen = JSON.stringify(snapshot);
    const expected = JSON.stringify(buildGraph(snapshot));
    const next = mulberry32(0x26_03);
    for (let run = 0; run < 50; run += 1) {
      expect(JSON.stringify(buildGraph(shuffledSnapshot(snapshot, next)))).toBe(expected);
    }
    expect(JSON.stringify(snapshot)).toBe(frozen);
  });

  it('builds an empty graph from an empty snapshot', () => {
    const empty = {
      servers: [],
      projects: [],
      environments: [],
      services: [],
      domains: [],
      serviceEnv: [],
    };
    expect(buildGraph(empty)).toEqual({
      nodes: [],
      relations: [],
      omitted: [],
    });
  });
});

describe('buildGraph keeps its invariants on inconsistent snapshots (A2)', () => {
  it('holds every invariant on the base fixture', () => {
    expect(graphInvariantViolations(buildGraph(baseSnapshot()))).toEqual([]);
  });

  it('omits every copy of a duplicated id, then the children that lost their parent', () => {
    const base = baseSnapshot();
    const graph = buildGraph(
      baseSnapshot({
        projects: [...base.projects, { id: IDS.projectB, name: 'blog-copy' }],
        services: [
          ...base.services,
          {
            id: IDS.db,
            environmentId: IDS.envAProd,
            serverId: IDS.server1,
            name: 'db2',
          },
        ],
      }),
    );
    expect(graph.omitted).toEqual([
      { kind: 'Project', entityId: IDS.projectB, reason: 'duplicate_id' },
      { kind: 'Environment', entityId: IDS.envBProd, reason: 'missing_parent' },
      { kind: 'Service', entityId: IDS.db, reason: 'duplicate_id' },
      { kind: 'Service', entityId: IDS.other, reason: 'missing_parent' },
      { kind: 'Domain', entityId: IDS.domainOther, reason: 'missing_parent' },
    ]);
    expect(node(graph, 'project', IDS.projectB)).toBeUndefined();
    expect(graphInvariantViolations(graph)).toEqual([]);
  });

  it('omits a service whose server is missing and a domain whose service is missing', () => {
    const base = baseSnapshot();
    const graph = buildGraph(
      baseSnapshot({
        services: [
          ...base.services,
          {
            id: uuid(90),
            environmentId: IDS.envAProd,
            serverId: uuid(91),
            name: 'ghost',
          },
        ],
        domains: [...base.domains, { id: uuid(92), serviceId: uuid(93), hostname: 'ghost.test' }],
      }),
    );
    expect(graph.omitted).toEqual([
      { kind: 'Service', entityId: uuid(90), reason: 'missing_parent' },
      { kind: 'Domain', entityId: uuid(92), reason: 'missing_parent' },
    ]);
    expect(graphInvariantViolations(graph)).toEqual([]);
  });

  it('holds every invariant for random snapshots with dangling and duplicated references', () => {
    const next = mulberry32(0x26_03_02);
    // Small id pools (4 per kind) so dangling parents and name matches happen often; ids are
    // mostly distinct, with a duplicated id now and then.
    const any = (offset: number): string => uuid(offset + Math.floor(next() * 4));
    const many = (offset: number, max: number): string[] => {
      const ids = shuffled(
        Array.from({ length: max }, (_, i) => uuid(offset + i)),
        next,
      ).slice(0, Math.floor(next() * (max + 1)));
      return ids.length > 0 && next() < 0.1 ? [...ids, ...ids.slice(0, 1)] : ids;
    };
    const seen = { services: 0, dependsOn: 0, omitted: 0 };
    for (let run = 0; run < 500; run += 1) {
      // A parent is usually one generated in this run and sometimes a dangling id from the pool.
      const parent = (ids: readonly string[], offset: number): string =>
        ids.length > 0 && next() < 0.8
          ? (ids[Math.floor(next() * ids.length)] ?? any(offset))
          : any(offset);
      const servers = many(0, 4);
      const projects = many(100, 4);
      const environments = many(200, 4);
      const services = many(300, 4);
      const snapshot: GraphSnapshot = {
        servers: servers.map((id) => ({ id, name: 's' })),
        projects: projects.map((id) => ({ id, name: 'p' })),
        environments: environments.map((id) => ({
          id,
          projectId: parent(projects.slice(0, 2), 100),
          name: 'e',
        })),
        services: services.map((id) => ({
          id,
          environmentId: parent(environments, 200),
          serverId: parent(servers, 0),
          name: 'svc',
        })),
        domains: many(400, 4).map((id, i) => ({
          id,
          serviceId: parent(services, 300),
          hostname: `h${String(i)}.test`,
        })),
        serviceEnv: Array.from({ length: Math.floor(next() * 9) }, () => parent(services, 300)).map(
          (serviceId, i) => {
            const roll = next();
            const value =
              roll < 0.2
                ? ref('x')
                : roll < 0.6
                  ? plain(`noodara-${parent(services, 300)}`)
                  : plain(`https://h${String(i % 4)}.test/`);
            return { serviceId, key: `K${String(i)}`, value };
          },
        ),
      };
      const graph = buildGraph(snapshot);
      const violations = graphInvariantViolations(graph);
      if (violations.length > 0) throw new Error(`run ${String(run)}: ${violations.join('; ')}`);
      seen.services += graph.nodes.filter((n) => n.kind === 'Service').length;
      seen.dependsOn += dependsOn(graph).length;
      seen.omitted += graph.omitted.length;
      expect(JSON.stringify(buildGraph(shuffledSnapshot(snapshot, next)))).toBe(
        JSON.stringify(graph),
      );
    }
    // The generator must reach every path: kept services, inferred edges and omissions.
    expect(seen.services).toBeGreaterThan(100);
    expect(seen.dependsOn).toBeGreaterThan(20);
    expect(seen.omitted).toBeGreaterThan(100);
  });
});

describe('DEPENDS_ON inference (A3, ADR 0012)', () => {
  const build = (serviceEnv: GraphSnapshot['serviceEnv'], overrides: Partial<GraphSnapshot> = {}) =>
    buildGraph(baseSnapshot({ ...overrides, serviceEnv }));

  it('links a service to another by its container name as the whole value', () => {
    expect(dependsOn(build([env(IDS.api, 'DB_HOST', plain(`noodara-${IDS.db}`))]))).toEqual([
      { from: svc(IDS.api), to: svc(IDS.db), envKeys: ['DB_HOST'] },
    ]);
  });

  it('links by the host part of a URL, in any case, and merges keys into one edge', () => {
    const graph = build([
      env(
        IDS.api,
        'DATABASE_URL',
        plain(`postgres://user@NOODARA-${IDS.db.toUpperCase()}:5432/app`),
      ),
      env(IDS.api, 'DB_HOST', plain(`noodara-${IDS.db}`)),
      env(IDS.web, 'API_URL', plain('https://API.shop.test/v1?x=1')),
      env(IDS.web, 'API_HOST', plain('api.shop.test')),
    ]);
    expect(dependsOn(graph)).toEqual([
      {
        from: svc(IDS.api),
        to: svc(IDS.db),
        envKeys: ['DATABASE_URL', 'DB_HOST'],
      },
      {
        from: svc(IDS.web),
        to: svc(IDS.api),
        envKeys: ['API_HOST', 'API_URL'],
      },
    ]);
    expect(graph.relations.find((r) => r.type === 'DEPENDS_ON')?.id).toBe(
      `DEPENDS_ON:${svc(IDS.api)}->${svc(IDS.db)}`,
    );
  });

  it('never reads a secret reference, even one named like a service', () => {
    const poisoned = {
      kind: 'secret_ref',
      get name(): string {
        throw new Error('secret reference was inspected');
      },
    } as unknown as EnvValue;
    expect(
      dependsOn(
        build([
          env(IDS.api, 'DB_PASSWORD', poisoned),
          env(IDS.api, 'DB', ref(`noodara-${IDS.db}`)),
        ]),
      ),
    ).toEqual([]);
  });

  it('ignores self-references, other projects, unknown names, partial matches and host:port', () => {
    expect(
      dependsOn(
        build([
          env(IDS.api, 'SELF', plain(`noodara-${IDS.api}`)),
          env(IDS.api, 'SELF_URL', plain('https://api.shop.test')),
          env(IDS.api, 'BLOG', plain(`noodara-${IDS.other}`)),
          env(IDS.other, 'SHOP', plain('https://api.shop.test')),
          env(IDS.api, 'UNKNOWN', plain('https://unknown.test')),
          env(IDS.api, 'UNKNOWN_CONTAINER', plain(`noodara-${uuid(77)}`)),
          env(IDS.api, 'MENTION', plain(`see noodara-${IDS.db} for details`)),
          env(IDS.api, 'HOST_PORT', plain(`noodara-${IDS.db}:5432`)),
          env(IDS.api, 'EMPTY_HOST', plain('file:///etc/noodara')),
          env(IDS.api, 'BAD_URL', plain('http://')),
          env(IDS.api, 'EMPTY', plain('')),
        ]),
      ),
    ).toEqual([]);
  });

  it('links across environments of the same project', () => {
    expect(dependsOn(build([env(IDS.web, 'API', plain(`noodara-${IDS.api}`))]))).toEqual([
      { from: svc(IDS.web), to: svc(IDS.api), envKeys: ['API'] },
    ]);
  });

  it('ignores env of an unregistered service and names shared by two services', () => {
    const base = baseSnapshot();
    const graph = build(
      [
        env(uuid(88), 'DB', plain(`noodara-${IDS.db}`)),
        env(IDS.web, 'SHARED', plain('shared.test')),
      ],
      {
        domains: [
          ...base.domains,
          { id: uuid(50), serviceId: IDS.api, hostname: 'shared.test' },
          { id: uuid(51), serviceId: IDS.db, hostname: 'shared.test' },
        ],
      },
    );
    expect(dependsOn(graph)).toEqual([]);
  });

  it('matches a service whose id is not a UUID by its domain only', () => {
    const base = baseSnapshot();
    const graph = build(
      [
        env(IDS.api, 'LEGACY', plain('legacy.shop.test')),
        env(IDS.api, 'C', plain('noodara-legacy')),
      ],
      {
        services: [
          ...base.services,
          {
            id: 'legacy',
            environmentId: IDS.envAProd,
            serverId: IDS.server1,
            name: 'legacy',
          },
        ],
        domains: [
          ...base.domains,
          { id: uuid(60), serviceId: 'legacy', hostname: 'legacy.shop.test' },
        ],
      },
    );
    expect(dependsOn(graph)).toEqual([
      { from: svc(IDS.api), to: svc('legacy'), envKeys: ['LEGACY'] },
    ]);
  });

  it('namesInEnvValue returns the whole value and, for a URL, its host', () => {
    expect(namesInEnvValue('Plain-Value')).toEqual(['plain-value']);
    expect(namesInEnvValue('redis://cache.test:6379')).toEqual([
      'redis://cache.test:6379',
      'cache.test',
    ]);
    expect(namesInEnvValue('http://')).toEqual(['http://']);
    expect(namesInEnvValue('file:///x')).toEqual(['file:///x']);
  });
});

describe('scopeGraph (A4)', () => {
  const graph = buildGraph(
    baseSnapshot({
      serviceEnv: [
        env(IDS.api, 'DB', plain(`noodara-${IDS.db}`)),
        env(IDS.web, 'API', plain(`noodara-${IDS.api}`)),
      ],
      servers: [...baseSnapshot().servers, { id: uuid(3), name: 'idle' }],
    }),
  );
  const entityIds = (g: InfrastructureGraph): string[] => g.nodes.map((n) => n.id);

  it('keeps an authorized project, its environments, services, domains and their servers', () => {
    const scoped = scopeGraph(graph, { projectIds: [IDS.projectA] });
    expect(entityIds(scoped).filter((id) => id.startsWith('project:'))).toEqual([
      `project:${IDS.projectA}`,
    ]);
    expect(entityIds(scoped)).toEqual(
      expect.arrayContaining([svc(IDS.api), svc(IDS.db), svc(IDS.web)]),
    );
    expect(entityIds(scoped)).toEqual(
      expect.arrayContaining([`server:${IDS.server1}`, `server:${IDS.server2}`]),
    );
    expect(entityIds(scoped)).not.toContain(`server:${uuid(3)}`);
    expect(
      entityIds(scoped).some((id) => id.includes(IDS.projectB) || id.includes(IDS.other)),
    ).toBe(false);
    expect(entityIds(scoped)).not.toContain(`domain:${IDS.domainOther}`);
    expect(graphInvariantViolations(scoped)).toEqual([]);
    expect(dependsOn(scoped)).toHaveLength(2);
  });

  it('keeps an authorized environment without its project and drops edges leaving the scope', () => {
    const scoped = scopeGraph(graph, { environmentIds: [IDS.envAStaging] });
    expect(entityIds(scoped)).toEqual([
      `domain:${IDS.domainWeb}`,
      `environment:${IDS.envAStaging}`,
      `server:${IDS.server2}`,
      svc(IDS.web),
    ]);
    const ids = new Set(entityIds(scoped));
    expect(scoped.relations.every((r) => ids.has(r.from) && ids.has(r.to))).toBe(true);
    expect(scoped.relations.map((r) => r.type).sort()).toEqual([
      'BELONGS_TO',
      'EXPOSED_BY',
      'RUNS_ON',
    ]);
    expect(dependsOn(scoped)).toEqual([]);
  });

  it('fails closed on an empty scope and never lists omissions', () => {
    expect(scopeGraph(graph, {})).toEqual({
      nodes: [],
      relations: [],
      omitted: [],
    });
    const withOmission = buildGraph(
      baseSnapshot({
        domains: [{ id: uuid(70), serviceId: uuid(71), hostname: 'x.test' }],
      }),
    );
    expect(withOmission.omitted).toHaveLength(1);
    expect(scopeGraph(withOmission, { projectIds: [IDS.projectA, IDS.projectB] }).omitted).toEqual(
      [],
    );
  });

  it('a server shared with an out-of-scope project is shown, the other project is not', () => {
    const scoped = scopeGraph(graph, { projectIds: [IDS.projectB] });
    expect(entityIds(scoped)).toEqual([
      `domain:${IDS.domainOther}`,
      `environment:${IDS.envBProd}`,
      `project:${IDS.projectB}`,
      `server:${IDS.server2}`,
      svc(IDS.other),
    ]);
    expect(JSON.stringify(scoped)).not.toContain(IDS.projectA);
    expect(JSON.stringify(scoped)).not.toContain(IDS.web);
  });
});

describe('compareGraphKeys', () => {
  it('orders by UTF-16 code units, independent of locale', () => {
    expect(['b', 'B', 'a'].sort(compareGraphKeys)).toEqual(['B', 'a', 'b']);
    expect(compareGraphKeys('a', 'a')).toBe(0);
  });
});
