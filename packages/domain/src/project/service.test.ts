import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  RESERVED_PUBLISHED_PORTS,
  type ServiceCreateInput,
  type ServiceEditInput,
  type ServiceEditableFields,
  classifyServiceEdit,
  validateInternalPort,
  validatePublishedPort,
  validateServiceCreateInput,
  validateServiceEditInput,
  validateServiceName,
} from './service.js';

const SERVER_ID = '01920000-0000-7000-8000-000000000001';
const GIT_SOURCE = {
  kind: 'git',
  repositoryUrl: 'https://github.com/acme/app.git',
  branch: 'main',
} as const;
const IMAGE_SOURCE = {
  kind: 'image',
  imageRef: 'ghcr.io/acme/app:v1',
} as const;
const CREATE = {
  name: 'api',
  serverId: SERVER_ID,
  source: GIT_SOURCE,
  internalPort: 3000,
};

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

function validCreate(input: unknown): ServiceCreateInput {
  const result = validateServiceCreateInput(input);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

function validEdit(input: unknown): ServiceEditInput {
  const result = validateServiceEditInput(input);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

describe('validateServiceName', () => {
  it.each(['api', 'web-2', '0', 'x'.repeat(63)])('accepts %j', (name) => {
    expect(validateServiceName(name)).toEqual({ ok: true, value: name });
  });

  it.each(['', 'API', '-api', 'api-', 'a_b', 'a b', 'a/b', 'x'.repeat(64), 'api\n', 7, null])(
    'rejects %j with SERVICE_NAME_INVALID',
    (name) => {
      expect(codeOf(validateServiceName(name))).toBe('SERVICE_NAME_INVALID');
    },
  );
});

describe('validateInternalPort', () => {
  it.each([1, 80, 3000, 65535])('accepts %d', (port) => {
    expect(validateInternalPort(port)).toEqual({ ok: true, value: port });
  });

  it.each([0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '80', true, null, undefined])(
    'rejects %j with INTERNAL_PORT_INVALID',
    (port) => {
      expect(codeOf(validateInternalPort(port))).toBe('INTERNAL_PORT_INVALID');
    },
  );
});

describe('validatePublishedPort', () => {
  it.each([undefined, null])('maps %j to null: publishing is off by default (D10)', (port) => {
    expect(validatePublishedPort(port)).toEqual({ ok: true, value: null });
  });

  it.each([1, 80, 443, 8080, 65535])('accepts %d', (port) => {
    expect(validatePublishedPort(port)).toEqual({ ok: true, value: port });
  });

  it.each([0, -1, 65536, 80.5, Number.NaN, '8080', false, {}])(
    'rejects %j with PUBLISHED_PORT_INVALID',
    (port) => {
      expect(codeOf(validatePublishedPort(port))).toBe('PUBLISHED_PORT_INVALID');
    },
  );

  it('reserves SSH and the Docker daemon ports', () => {
    expect([...RESERVED_PUBLISHED_PORTS]).toEqual([22, 2375, 2376]);
  });

  it.each([...RESERVED_PUBLISHED_PORTS])('rejects the reserved port %d', (port) => {
    const result = validatePublishedPort(port);

    expect(codeOf(result)).toBe('PUBLISHED_PORT_RESERVED');
    expect(!result.ok && result.message).toContain(String(port));
  });
});

describe('validateServiceCreateInput', () => {
  it('validates a git service and defaults the published port to null', () => {
    expect(validateServiceCreateInput(CREATE)).toEqual({
      ok: true,
      value: {
        name: 'api',
        serverId: SERVER_ID,
        source: {
          ...GIT_SOURCE,
          buildContext: '.',
          dockerfilePath: 'Dockerfile',
          target: null,
        },
        internalPort: 3000,
        publishedPort: null,
      },
    });
  });

  it('validates an image service with a published port', () => {
    const result = validateServiceCreateInput({
      ...CREATE,
      source: IMAGE_SOURCE,
      publishedPort: 8080,
    });

    expect(result.ok && result.value.source).toEqual(IMAGE_SOURCE);
    expect(result.ok && result.value.publishedPort).toBe(8080);
  });

  it.each([null, 'api', [], [CREATE], 1])('rejects %j with SERVICE_INPUT_INVALID', (input) => {
    expect(codeOf(validateServiceCreateInput(input))).toBe('SERVICE_INPUT_INVALID');
  });

  it.each(['buildArgs', 'build_args', 'env', 'envVars', 'environment', 'secrets', 'id', 'status'])(
    'rejects the unsupported field %s by name (D13)',
    (key) => {
      const result = validateServiceCreateInput({ ...CREATE, [key]: 'x' });

      expect(codeOf(result)).toBe('SERVICE_INPUT_UNSUPPORTED_FIELD');
      expect(!result.ok && result.message).toContain(key);
    },
  );

  it.each([
    [{ ...CREATE, name: 'API' }, 'SERVICE_NAME_INVALID'],
    [{ ...CREATE, name: undefined }, 'SERVICE_NAME_INVALID'],
    [{ ...CREATE, serverId: 'srv-1' }, 'RESOURCE_ID_INVALID'],
    [{ ...CREATE, serverId: 7 }, 'RESOURCE_ID_INVALID'],
    [{ ...CREATE, source: undefined }, 'SERVICE_SOURCE_INVALID'],
    [{ ...CREATE, source: { kind: 'image', imageRef: 'node' } }, 'IMAGE_REF_TAG_REQUIRED'],
    [
      { ...CREATE, source: { ...GIT_SOURCE, buildArgs: { A: '1' } } },
      'SERVICE_SOURCE_UNSUPPORTED_FIELD',
    ],
    [{ ...CREATE, internalPort: 0 }, 'INTERNAL_PORT_INVALID'],
    [{ ...CREATE, internalPort: undefined }, 'INTERNAL_PORT_INVALID'],
    [{ ...CREATE, publishedPort: 22 }, 'PUBLISHED_PORT_RESERVED'],
    [{ ...CREATE, publishedPort: 70000 }, 'PUBLISHED_PORT_INVALID'],
  ])('passes the field validator code through (%j -> %s)', (input, code) => {
    expect(codeOf(validateServiceCreateInput(input))).toBe(code);
  });

  it('exposes no build-arg or env field (D13)', () => {
    expectTypeOf<keyof ServiceCreateInput>().toEqualTypeOf<
      'name' | 'serverId' | 'source' | 'internalPort' | 'publishedPort'
    >();
  });
});

describe('validateServiceEditInput', () => {
  it('returns only the fields present', () => {
    expect(validateServiceEditInput({ name: 'web' })).toEqual({
      ok: true,
      value: { name: 'web' },
    });
  });

  it('keeps an explicit null published port as "stop publishing"', () => {
    expect(validateServiceEditInput({ publishedPort: null })).toEqual({
      ok: true,
      value: { publishedPort: null },
    });
  });

  it('validates every editable field together', () => {
    const result = validateServiceEditInput({
      name: 'web',
      source: IMAGE_SOURCE,
      internalPort: 8080,
      publishedPort: 8081,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'web',
        source: IMAGE_SOURCE,
        internalPort: 8080,
        publishedPort: 8081,
      },
    });
  });

  it('rejects an empty edit', () => {
    expect(codeOf(validateServiceEditInput({}))).toBe('SERVICE_INPUT_EMPTY_EDIT');
  });

  it.each(['serverId', 'buildArgs', 'env', 'status'])(
    'rejects the unsupported field %s by name',
    (key) => {
      const result = validateServiceEditInput({ [key]: 'x' });

      expect(codeOf(result)).toBe('SERVICE_INPUT_UNSUPPORTED_FIELD');
      expect(!result.ok && result.message).toContain(key);
    },
  );

  it.each([
    ['x', 'SERVICE_INPUT_INVALID'],
    [{ name: '' }, 'SERVICE_NAME_INVALID'],
    [
      { source: { kind: 'git', repositoryUrl: 'file:///etc', branch: 'main' } },
      'REPOSITORY_URL_UNSUPPORTED_SCHEME',
    ],
    [{ internalPort: '80' }, 'INTERNAL_PORT_INVALID'],
    [{ publishedPort: 2375 }, 'PUBLISHED_PORT_RESERVED'],
    [{ source: null }, 'SERVICE_SOURCE_INVALID'],
  ])('rejects %j with %s', (input, code) => {
    expect(codeOf(validateServiceEditInput(input))).toBe(code);
  });
});

describe('classifyServiceEdit', () => {
  const current: ServiceEditableFields = (() => {
    const { name, source, internalPort, publishedPort } = validCreate(CREATE);
    return { name, source, internalPort, publishedPort };
  })();

  it('classifies an edit that changes nothing as none', () => {
    const edit = validEdit({
      name: 'api',
      source: {
        ...GIT_SOURCE,
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
      },
      internalPort: 3000,
      publishedPort: null,
    });

    expect(classifyServiceEdit(current, edit)).toEqual({
      kind: 'none',
      changedFields: [],
    });
  });

  it('classifies a rename as metadata only (no redeploy)', () => {
    expect(classifyServiceEdit(current, validEdit({ name: 'web' }))).toEqual({
      kind: 'metadata',
      changedFields: ['name'],
    });
  });

  it.each([
    [{ repositoryUrl: 'https://github.com/acme/other.git' }],
    [{ branch: 'release' }],
    [{ buildContext: 'apps/api' }],
    [{ dockerfilePath: 'Dockerfile.prod' }],
    [{ target: 'runtime' }],
  ])('classifies a git source change %j as redeploy', (change) => {
    const edit = validEdit({ source: { ...GIT_SOURCE, ...change } });

    expect(classifyServiceEdit(current, edit)).toEqual({
      kind: 'redeploy',
      changedFields: ['source'],
    });
  });

  it('classifies a switch from git to image as redeploy', () => {
    const edit = validEdit({ source: IMAGE_SOURCE });

    expect(classifyServiceEdit(current, edit).kind).toBe('redeploy');
  });

  it('compares image sources by reference', () => {
    const imageService: ServiceEditableFields = {
      ...current,
      source: validCreate({ ...CREATE, source: IMAGE_SOURCE }).source,
    };

    expect(classifyServiceEdit(imageService, validEdit({ source: IMAGE_SOURCE })).kind).toBe(
      'none',
    );
    expect(
      classifyServiceEdit(
        imageService,
        validEdit({
          source: { kind: 'image', imageRef: 'ghcr.io/acme/app:v2' },
        }),
      ).kind,
    ).toBe('redeploy');
    expect(classifyServiceEdit(imageService, validEdit({ source: GIT_SOURCE })).kind).toBe(
      'redeploy',
    );
  });

  it.each([
    [{ internalPort: 8080 }, ['internalPort']],
    [{ publishedPort: 8080 }, ['publishedPort']],
  ])(
    'classifies a port change %j as redeploy: ports are fixed at container creation',
    (input, fields) => {
      expect(classifyServiceEdit(current, validEdit(input))).toEqual({
        kind: 'redeploy',
        changedFields: fields,
      });
    },
  );

  it('classifies stopping publication as redeploy', () => {
    const published = {
      ...current,
      publishedPort: validCreate({ ...CREATE, publishedPort: 8080 }).publishedPort,
    };

    expect(classifyServiceEdit(published, validEdit({ publishedPort: null }))).toEqual({
      kind: 'redeploy',
      changedFields: ['publishedPort'],
    });
  });

  it('lists every changed field in a stable order and lets redeploy win over metadata', () => {
    const edit = validEdit({
      publishedPort: 9000,
      internalPort: 9001,
      source: IMAGE_SOURCE,
      name: 'web',
    });

    expect(classifyServiceEdit(current, edit)).toEqual({
      kind: 'redeploy',
      changedFields: ['name', 'source', 'internalPort', 'publishedPort'],
    });
  });
});
