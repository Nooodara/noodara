import { describe, expect, it } from 'vitest';
import type { ObservedContainer } from './docker-ps.js';
import {
  parsePublishedHostPorts,
  preflightPublishedPort,
  type PortPreflightInput,
} from './port-preflight.js';

const SERVICE_ID = 'c6f053d9-77ca-4ea6-86df-105f47c7d9fb';
const OTHER_SERVICE_ID = '0b5e6c1d-2f3a-4b5c-8d9e-0f1a2b3c4d5e';

function container(overrides: Partial<ObservedContainer>): ObservedContainer {
  return {
    id: '4fb0b52c06b9',
    name: 'some-container',
    image: 'nginx:1.27',
    state: 'running',
    exitCode: null,
    labels: {},
    ports: '',
    ...overrides,
  };
}

function input(overrides: Partial<PortPreflightInput>): PortPreflightInput {
  return {
    serviceId: SERVICE_ID,
    publishedPort: 18080,
    otherServices: [],
    panelPorts: [],
    containers: [],
    ...overrides,
  };
}

describe('parsePublishedHostPorts', () => {
  it('reads the IPv4 and IPv6 bindings of a real docker ps capture', () => {
    expect(parsePublishedHostPorts('0.0.0.0:18080->3000/tcp, [::]:18080->3000/tcp')).toEqual([
      { hostPort: 18080, protocol: 'tcp' },
      { hostPort: 18080, protocol: 'tcp' },
    ]);
  });

  it('reads legacy IPv6, host-ip and udp bindings', () => {
    expect(
      parsePublishedHostPorts(':::8080->80/tcp, 127.0.0.1:5432->5432/tcp, 0.0.0.0:53->53/udp'),
    ).toEqual([
      { hostPort: 8080, protocol: 'tcp' },
      { hostPort: 5432, protocol: 'tcp' },
      { hostPort: 53, protocol: 'udp' },
    ]);
  });

  it('expands a published host range', () => {
    expect(parsePublishedHostPorts('0.0.0.0:8000-8002->8000-8002/tcp')).toEqual([
      { hostPort: 8000, protocol: 'tcp' },
      { hostPort: 8001, protocol: 'tcp' },
      { hostPort: 8002, protocol: 'tcp' },
    ]);
  });

  it('ignores exposed-but-unpublished ports, empty strings and garbage', () => {
    expect(parsePublishedHostPorts('')).toEqual([]);
    expect(parsePublishedHostPorts('3000/tcp, 80/tcp')).toEqual([]);
    expect(parsePublishedHostPorts('nonsense, 0.0.0.0:99999->80/tcp, 0.0.0.0:9-3->80/tcp')).toEqual(
      [],
    );
  });
});

describe('preflightPublishedPort', () => {
  it('passes when the service publishes no port', () => {
    const result = preflightPublishedPort(
      input({ publishedPort: null, panelPorts: [{ port: 22, label: 'ssh' }] }),
    );

    expect(result).toEqual({ ok: true });
  });

  it('passes when nothing else owns the port', () => {
    const result = preflightPublishedPort(
      input({
        otherServices: [{ serviceId: OTHER_SERVICE_ID, publishedPort: 18081 }],
        panelPorts: [
          { port: 22, label: 'ssh' },
          { port: 3000, label: 'panel' },
        ],
        containers: [container({ ports: '0.0.0.0:18081->80/tcp' })],
      }),
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects a panel port with PORT_IN_USE naming the panel owner', () => {
    const result = preflightPublishedPort(
      input({ publishedPort: 3000, panelPorts: [{ port: 3000, label: 'control-plane' }] }),
    );

    expect(result).toEqual({
      ok: false,
      code: 'PORT_IN_USE',
      port: 3000,
      owner: { kind: 'panel', label: 'control-plane' },
    });
  });

  it('rejects the port another service on the server already publishes, even when stopped', () => {
    const result = preflightPublishedPort(
      input({ otherServices: [{ serviceId: OTHER_SERVICE_ID, publishedPort: 18080 }] }),
    );

    expect(result).toEqual({
      ok: false,
      code: 'PORT_IN_USE',
      port: 18080,
      owner: { kind: 'service', serviceId: OTHER_SERVICE_ID },
    });
  });

  it('ignores its own row in the service list', () => {
    const result = preflightPublishedPort(
      input({ otherServices: [{ serviceId: SERVICE_ID, publishedPort: 18080 }] }),
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects a port bound by a container in the docker ps snapshot', () => {
    const result = preflightPublishedPort(
      input({
        containers: [
          container({
            name: `noodara-${OTHER_SERVICE_ID}`,
            labels: { 'noodara.service_id': OTHER_SERVICE_ID },
            ports: '0.0.0.0:18080->3000/tcp, [::]:18080->3000/tcp',
          }),
        ],
      }),
    );

    expect(result).toEqual({
      ok: false,
      code: 'PORT_IN_USE',
      port: 18080,
      owner: {
        kind: 'container',
        containerName: `noodara-${OTHER_SERVICE_ID}`,
        serviceId: OTHER_SERVICE_ID,
      },
    });
  });

  it('names a container Noodara does not manage with a null service id', () => {
    const result = preflightPublishedPort(
      input({ containers: [container({ name: 'postgres', ports: '127.0.0.1:18080->5432/tcp' })] }),
    );

    expect(result).toMatchObject({
      ok: false,
      owner: { kind: 'container', containerName: 'postgres', serviceId: null },
    });
  });

  it('catches a port inside a published range', () => {
    const result = preflightPublishedPort(
      input({
        containers: [container({ name: 'range', ports: '0.0.0.0:18070-18090->18070-18090/tcp' })],
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'PORT_IN_USE',
      owner: { containerName: 'range' },
    });
  });

  it('does not count a udp binding against a tcp publish', () => {
    const result = preflightPublishedPort(
      input({ containers: [container({ ports: '0.0.0.0:18080->53/udp' })] }),
    );

    expect(result).toEqual({ ok: true });
  });

  it('skips the service own container, which the deploy replaces on the same port', () => {
    const own = [
      container({ name: `noodara-${SERVICE_ID}`, ports: '0.0.0.0:18080->3000/tcp' }),
      container({
        name: 'renamed',
        labels: { 'noodara.service_id': SERVICE_ID },
        ports: '0.0.0.0:18080->3000/tcp',
      }),
    ];

    expect(preflightPublishedPort(input({ containers: own }))).toEqual({ ok: true });
  });

  it('reports the panel before services and services before containers', () => {
    const all = input({
      publishedPort: 8080,
      panelPorts: [{ port: 8080, label: 'panel' }],
      otherServices: [{ serviceId: OTHER_SERVICE_ID, publishedPort: 8080 }],
      containers: [container({ ports: '0.0.0.0:8080->80/tcp' })],
    });

    expect(preflightPublishedPort(all)).toMatchObject({ owner: { kind: 'panel' } });
    expect(preflightPublishedPort({ ...all, panelPorts: [] })).toMatchObject({
      owner: { kind: 'service' },
    });
    expect(preflightPublishedPort({ ...all, panelPorts: [], otherServices: [] })).toMatchObject({
      owner: { kind: 'container' },
    });
  });
});
