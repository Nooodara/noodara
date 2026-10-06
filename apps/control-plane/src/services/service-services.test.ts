import { describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import type { ServerEvent, ServerEventPublisher } from '../events/server-event-publisher.js';
import type { services as servicesTable } from '../db/schema/services.js';
import {
  createServiceServices,
  editableFieldsFromRow,
  panelPortsFromEnv,
  recordServiceOperation,
  serviceColumnsFromSource,
} from './service-services.js';

const ACTOR = { type: 'user', id: 'user-1' } as const;
const PROJECT_ID = '0190a5d2-0000-7000-8000-000000000001';
const ENVIRONMENT_ID = '0190a5d2-0000-7000-8000-000000000002';
const SERVER_ID = '0190a5d2-0000-7000-8000-000000000003';
const SERVICE_ID = '0190a5d2-0000-7000-8000-000000000004';

/** Any property access is a failure: proves validation answers before the database is touched. */
const untouchableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`database touched: ${String(property)}`);
    },
  },
) as Database;

function recordingPublisher(): ServerEventPublisher & { events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  return {
    events,
    publish(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}

function servicesWithoutDb(): { services: ReturnType<typeof createServiceServices>; events: ServerEvent[] } {
  const publisher = recordingPublisher();
  const services = createServiceServices({
    db: untouchableDb,
    now: () => new Date('2026-10-04T00:00:00Z'),
    events: publisher,
    panelPorts: [{ port: 3000, label: 'Noodara panel' }],
  });
  return { services, events: publisher.events };
}

const VALID_CREATE = {
  name: 'api',
  serverId: SERVER_ID,
  source: { kind: 'image', imageRef: 'ghcr.io/acme/api:1.0' },
  internalPort: 8080,
};

describe('panelPortsFromEnv', () => {
  it('takes the API port and the public URL port, deduplicated', () => {
    expect(panelPortsFromEnv({ apiPort: 3000, publicUrl: 'http://localhost:3000' })).toEqual([
      { port: 3000, label: 'Noodara panel' },
    ]);
    expect(panelPortsFromEnv({ apiPort: 3000, publicUrl: 'https://panel.example.com:8443/' })).toEqual([
      { port: 3000, label: 'Noodara panel' },
      { port: 8443, label: 'Noodara panel' },
    ]);
  });

  it('falls back to the scheme default port when the public URL has none', () => {
    expect(panelPortsFromEnv({ apiPort: 4000, publicUrl: 'https://panel.example.com' }).map((p) => p.port)).toEqual([
      4000, 443,
    ]);
    expect(panelPortsFromEnv({ apiPort: 4000, publicUrl: 'http://panel.example.com' }).map((p) => p.port)).toEqual([
      4000, 80,
    ]);
  });

  it('ignores an unparsable public URL instead of throwing', () => {
    expect(panelPortsFromEnv({ apiPort: 3000, publicUrl: 'not a url' })).toEqual([
      { port: 3000, label: 'Noodara panel' },
    ]);
  });
});

describe('source <-> row columns', () => {
  it('maps a git source to its columns and back', () => {
    const columns = serviceColumnsFromSource({
      kind: 'git',
      repositoryUrl: 'https://github.com/acme/api.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      target: null,
    } as never);
    expect(columns).toEqual({
      sourceType: 'git',
      repositoryUrl: 'https://github.com/acme/api.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      buildTarget: null,
      imageRef: null,
    });
    const editable = editableFieldsFromRow({ name: 'api', internalPort: 80, publishedPort: null, ...columns });
    expect(editable.source).toEqual({
      kind: 'git',
      repositoryUrl: 'https://github.com/acme/api.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      target: null,
    });
  });

  it('maps an image source to its columns and back, clearing every git column', () => {
    const columns = serviceColumnsFromSource({ kind: 'image', imageRef: 'nginx:1.27' } as never);
    expect(columns).toEqual({
      sourceType: 'image',
      repositoryUrl: null,
      branch: null,
      buildContext: null,
      dockerfilePath: null,
      buildTarget: null,
      imageRef: 'nginx:1.27',
    });
    expect(editableFieldsFromRow({ name: 'web', internalPort: 80, publishedPort: 8080, ...columns })).toEqual({
      name: 'web',
      source: { kind: 'image', imageRef: 'nginx:1.27' },
      internalPort: 80,
      publishedPort: 8080,
    });
  });
});

describe('createService: validation before the database (H1)', () => {
  it.each([
    ['an unknown field', { ...VALID_CREATE, buildArgs: { TOKEN: 'x' } }, 'SERVICE_INPUT_UNSUPPORTED_FIELD'],
    ['an env field', { ...VALID_CREATE, env: { A: 'b' } }, 'SERVICE_INPUT_UNSUPPORTED_FIELD'],
    ['a bad name', { ...VALID_CREATE, name: 'Not A Slug' }, 'SERVICE_NAME_INVALID'],
    [
      'a file:// repository',
      { ...VALID_CREATE, source: { kind: 'git', repositoryUrl: 'file:///etc/passwd', branch: 'main' } },
      'REPOSITORY_URL_UNSUPPORTED_SCHEME',
    ],
    [
      'a build context escaping the repository',
      {
        ...VALID_CREATE,
        source: { kind: 'git', repositoryUrl: 'https://github.com/a/b.git', branch: 'main', buildContext: '../..' },
      },
      'BUILD_CONTEXT_PATH_INVALID',
    ],
    ['a reserved published port', { ...VALID_CREATE, publishedPort: 22 }, 'PUBLISHED_PORT_RESERVED'],
    ['an out-of-range internal port', { ...VALID_CREATE, internalPort: 70000 }, 'INTERNAL_PORT_INVALID'],
  ])('rejects %s as SERVICE_INPUT_INVALID with the domain reason', async (_label, fields, reason) => {
    const { services, events } = servicesWithoutDb();
    const result = await services.createService({
      actor: ACTOR,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      fields,
    });
    expect(result).toMatchObject({ ok: false, code: 'SERVICE_INPUT_INVALID', reason });
    expect(events).toEqual([]);
  });

  it('never echoes a credential embedded in a repository URL', async () => {
    const { services } = servicesWithoutDb();
    const result = await services.createService({
      actor: ACTOR,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      fields: {
        ...VALID_CREATE,
        source: { kind: 'git', repositoryUrl: 'https://user:CANARY-SECRET@github.com/a/b.git', branch: 'main' },
      },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('CANARY-SECRET');
  });
});

describe('updateService: validation before the database (H1)', () => {
  it.each([
    ['an empty edit', {}, 'SERVICE_INPUT_EMPTY_EDIT'],
    ['a server move', { serverId: SERVER_ID }, 'SERVICE_INPUT_UNSUPPORTED_FIELD'],
    ['a build-arg field', { buildArgs: {} }, 'SERVICE_INPUT_UNSUPPORTED_FIELD'],
    ['an invalid published port', { publishedPort: 0 }, 'PUBLISHED_PORT_INVALID'],
  ])('rejects %s as SERVICE_INPUT_INVALID with the domain reason', async (_label, fields, reason) => {
    const { services, events } = servicesWithoutDb();
    const result = await services.updateService({
      actor: ACTOR,
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      fields,
    });
    expect(result).toMatchObject({ ok: false, code: 'SERVICE_INPUT_INVALID', reason });
    expect(events).toEqual([]);
  });
});

describe('recordServiceOperation: updatedAt (13-02 A1, H1)', () => {
  const STORED = new Date('2026-10-05T10:00:00.000Z');
  type Row = typeof servicesTable.$inferSelect;
  const stored: Row = {
    id: SERVICE_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serverId: SERVER_ID,
    name: 'api',
    sourceType: 'image',
    repositoryUrl: null,
    branch: null,
    buildContext: null,
    dockerfilePath: null,
    buildTarget: null,
    imageRef: 'nginx:1.27',
    internalPort: 80,
    publishedPort: null,
    repositoryCredentialId: null,
    registryCredentialId: null,
    status: 'RUNNING',
    createdAt: STORED,
    updatedAt: STORED,
  };

  /** A thenable query-builder fake over one service row; records every UPDATE's `set`. */
  function fakeDb() {
    let row: Row = { ...stored };
    const sets: Record<string, unknown>[] = [];
    const chain = (resolve: () => unknown[]): unknown => {
      const proxy: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') return (ok: (value: unknown) => void) => {
              ok(resolve());
            };
            return (...args: unknown[]) => {
              if (prop === 'set') {
                const set = args[0] as Record<string, unknown>;
                sets.push(set);
                row = { ...row, ...set };
              }
              return proxy;
            };
          },
        },
      );
      return proxy;
    };
    const handle = {
      select: () => chain(() => [row]),
      selectDistinctOn: () => chain(() => [{ serviceId: SERVICE_ID, status: 'SUCCESS' }]),
      update: () => chain(() => [row]),
      insert: () => chain(() => [{ id: 'activity-1' }]),
      transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(handle),
    };
    return { db: handle as unknown as Database, sets };
  }

  const record = (db: Database, now: Date) =>
    recordServiceOperation(db, () => now, {
      serviceId: SERVICE_ID,
      serverId: SERVER_ID,
      operation: 'stop',
      actor: ACTOR,
      result: { ok: true, operation: 'stop', previousState: 'running', container: { kind: 'stopped', exitCode: 0 }, durationMs: 5 },
    });

  it('writes updatedAt with the status cache and returns it on the view', async () => {
    const fake = fakeDb();
    const now = new Date('2026-10-05T10:05:00.000Z');
    const view = await record(fake.db, now);
    expect(fake.sets).toEqual([{ status: 'STOPPED', updatedAt: now }]);
    expect(view?.updatedAt).toBe(now.toISOString());
  });

  it('two writes in the same millisecond (or a clock behind the row) still move updatedAt forward', async () => {
    const fake = fakeDb();
    const first = await record(fake.db, STORED);
    const second = await record(fake.db, new Date(STORED.getTime() - 1_000));
    expect(first?.updatedAt).toBe('2026-10-05T10:00:00.001Z');
    expect(second?.updatedAt).toBe('2026-10-05T10:00:00.002Z');
  });
});
