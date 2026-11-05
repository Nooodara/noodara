// 29-01 (A1): turns a parsed fixture into the in-memory installation the eval tools read. Ids are
// deterministic UUIDs derived from the fixture id and the entity ref, so a replayed cassette
// (29-02) sees the same ids on every run. Entity refs and evidence refs used by scenarios resolve
// here; a dangling ref is an error, never a silent miss.
import { createHash } from 'node:crypto';
import {
  CRASH_LOOP_MIN_RESTARTS,
  type ContainerRuntimeObservation,
  type DeploymentStatus,
  type EnvValue,
  type Evidence,
  type LogLevel,
  type LogSource,
  type MemoryReading,
} from '@noodara/domain';
import {
  ENTITY_REF_PATTERN,
  EVIDENCE_REF_PATTERN,
  type DeploymentFixture,
  type Fixture,
  type ServerFixture,
  type ServiceFixture,
} from './schema.js';

export const MIB = 1024 * 1024;
/** Metric samples are one minute apart, ending at the fixture's `now`. */
export const SAMPLE_INTERVAL_SECONDS = 60;

export type EntityKind = 'Server' | 'Project' | 'Environment' | 'Service' | 'Deployment' | 'Domain';

export interface EntityRecord {
  readonly ref: string;
  readonly kind: EntityKind;
  readonly id: string;
  readonly label: string;
}

export interface ModelServer extends ServerFixture {
  readonly id: string;
}
export interface ModelEnvironment {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
}
export interface ModelProject {
  readonly id: string;
  readonly name: string;
}
export interface ModelDeployment extends DeploymentFixture {
  readonly id: string;
  readonly number: number;
  readonly serviceId: string;
  readonly previousDeploymentId: string | null;
}
export interface ModelLogEntry {
  readonly source: LogSource;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly stream: 'stdout' | 'stderr' | null;
  readonly text: string;
}
export interface ModelService extends Omit<ServiceFixture, 'deployments' | 'logs' | 'domains' | 'env'> {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
  readonly domains: readonly { readonly id: string; readonly hostname: string }[];
  readonly env: readonly { readonly key: string; readonly value: EnvValue }[];
  /** Oldest first. */
  readonly deployments: readonly ModelDeployment[];
  /** Oldest first. */
  readonly logs: readonly ModelLogEntry[];
}

export interface FixtureModel {
  readonly fixtureId: string;
  readonly nowMs: number;
  readonly servers: readonly ModelServer[];
  readonly projects: readonly ModelProject[];
  readonly environments: readonly ModelEnvironment[];
  readonly services: readonly ModelService[];
  /** Canary secret values; the conversation redactor registers them and a leak scan looks for them. */
  readonly secrets: readonly { readonly name: string; readonly value: string }[];
  readonly entities: ReadonlyMap<string, EntityRecord>;
  /** Resolves `<kind>:<path>` to the entity; throws on a dangling ref. */
  entity(ref: string): EntityRecord;
}

export class FixtureError extends Error {
  constructor(fixtureId: string, message: string) {
    super(`fixture ${fixtureId}: ${message}`);
    this.name = 'FixtureError';
  }
}

/** A deterministic RFC 4122 v4-shaped UUID for one fixture entity. */
export function fixtureUuid(fixtureId: string, ref: string): string {
  const hex = createHash('sha256').update(`noodara-ai-evals:${fixtureId}:${ref}`).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const SECRET_REF = /^<secret:([a-z][a-z0-9_]{0,63})>$/;

export function buildFixtureModel(fixture: Fixture): FixtureModel {
  const fail = (message: string): never => {
    throw new FixtureError(fixture.id, message);
  };
  const nowMs = Date.parse(fixture.now);
  const at = (secondsAgo: number) => new Date(nowMs - secondsAgo * 1000).toISOString();
  const entities = new Map<string, EntityRecord>();
  const add = (ref: string, kind: EntityKind, label: string): string => {
    if (entities.has(ref)) fail(`duplicate entity ${ref}`);
    const id = fixtureUuid(fixture.id, ref);
    entities.set(ref, { ref, kind, id, label });
    return id;
  };

  const secretNames = new Set<string>();
  const secretValues = new Set<string>();
  for (const secret of fixture.secrets) {
    if (secretNames.has(secret.name)) fail(`duplicate secret ${secret.name}`);
    if (secretValues.has(secret.value)) fail(`secret ${secret.name} reuses a canary value`);
    secretNames.add(secret.name);
    secretValues.add(secret.value);
  }

  const servers: ModelServer[] = fixture.servers.map((server) => {
    if (server.diskUsedMb > server.diskTotalMb) fail(`server ${server.name} uses more disk than it has`);
    if (server.memoryUsedMb.some((mb) => mb > server.ramMb)) fail(`server ${server.name} uses more memory than it has`);
    return { ...server, id: add(`server:${server.name}`, 'Server', server.name) };
  });
  const serverByName = new Map(servers.map((server) => [server.name, server]));

  const projects: ModelProject[] = [];
  const environments: ModelEnvironment[] = [];
  const services: ModelService[] = [];
  for (const project of fixture.projects) {
    const projectId = add(`project:${project.name}`, 'Project', project.name);
    projects.push({ id: projectId, name: project.name });
    for (const environment of project.environments) {
      const environmentId = add(`environment:${project.name}/${environment.name}`, 'Environment', environment.name);
      environments.push({ id: environmentId, name: environment.name, projectId });
      for (const service of environment.services) {
        const server = serverByName.get(service.server) ?? fail(`service ${service.name} runs on unknown server ${service.server}`);
        if ((service.image === undefined) === (service.repository === undefined)) {
          fail(`service ${service.name} needs exactly one of image or repository`);
        }
        const serviceId = add(`service:${service.name}`, 'Service', service.name);
        const domains = service.domains.map((hostname) => ({ id: add(`domain:${hostname}`, 'Domain', hostname), hostname }));
        const env = Object.entries(service.env).map(([key, raw]): { key: string; value: EnvValue } => {
          const ref = SECRET_REF.exec(raw);
          if (ref === null) {
            if (raw.includes('<secret:')) fail(`service ${service.name} env ${key} is a malformed secret reference`);
            if ([...secretValues].some((value) => raw.includes(value))) fail(`service ${service.name} env ${key} holds a canary as a plain value`);
            return { key, value: { kind: 'plain', value: raw } };
          }
          const name = ref[1] as string;
          if (!secretNames.has(name)) fail(`service ${service.name} env ${key} references unknown secret ${name}`);
          return { key, value: { kind: 'secret_ref', name } };
        });
        let previous: string | null = null;
        const deployments = service.deployments.map((deployment, index): ModelDeployment => {
          const number = index + 1;
          const id = add(`deployment:${service.name}#${String(number)}`, 'Deployment', `${service.name} #${String(number)}`);
          const model = { ...deployment, id, number, serviceId, previousDeploymentId: previous };
          previous = id;
          return model;
        });
        for (let i = 1; i < deployments.length; i += 1) {
          if ((deployments[i] as ModelDeployment).startedMinutesAgo > (deployments[i - 1] as ModelDeployment).startedMinutesAgo) {
            fail(`service ${service.name} deployments must be listed oldest first`);
          }
        }
        const logs = service.logs
          .map(
            (log): ModelLogEntry => ({
              source: log.source,
              timestamp: at(log.secondsAgo),
              level: log.level,
              stream: log.source === 'runtime' ? (log.stream ?? 'stdout') : null,
              text: log.text,
            }),
          )
          .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
        services.push({
          ...service,
          id: serviceId,
          projectId,
          environmentId,
          serverId: server.id,
          domains,
          env,
          deployments,
          logs,
        });
      }
    }
  }

  function entity(ref: string): EntityRecord {
    if (!ENTITY_REF_PATTERN.test(ref)) fail(`malformed entity ref ${ref}`);
    return entities.get(ref) ?? fail(`unknown entity ${ref}`);
  }

  return Object.freeze({
    fixtureId: fixture.id,
    nowMs,
    servers,
    projects,
    environments,
    services,
    secrets: fixture.secrets,
    entities,
    entity,
  });
}

// ---- views shared by the backend and the evidence ----------------------------------------------

export function serverOf(model: FixtureModel, serverId: string): ModelServer {
  const server = model.servers.find((candidate) => candidate.id === serverId);
  if (server === undefined) throw new FixtureError(model.fixtureId, `no server ${serverId}`);
  return server;
}

/** Container memory readings, oldest first, against the container limit (null: unlimited). */
export function containerMemoryReadings(service: ModelService): MemoryReading[] {
  const limitBytes = service.memoryLimitMb === null ? null : service.memoryLimitMb * MIB;
  return service.memoryUsedMb.map((mb) => ({ usedBytes: Math.round(mb * MIB), limitBytes }));
}

export function hostMemoryReadings(server: ModelServer): MemoryReading[] {
  return server.memoryUsedMb.map((mb) => ({ usedBytes: Math.round(mb * MIB), limitBytes: server.ramMb * MIB }));
}

export function rootFilesystem(server: ModelServer) {
  return {
    target: '/',
    sizeBytes: server.diskTotalMb * MIB,
    usedBytes: server.diskUsedMb * MIB,
    availBytes: (server.diskTotalMb - server.diskUsedMb) * MIB,
  };
}

const STOPPED_STATES = new Set(['created', 'exited', 'dead']);

export function containerObservation(service: ModelService): ContainerRuntimeObservation | null {
  const container = service.container;
  if (container === null) return null;
  return {
    stopped: STOPPED_STATES.has(container.state),
    restarting: container.state === 'restarting',
    restartsInWindow: container.restartsInWindow,
    crashLoop: container.restartsInWindow >= CRASH_LOOP_MIN_RESTARTS,
    outOfMemory: container.oomKilled,
    healthcheck: container.healthcheck,
    exitCode: container.state === 'running' ? null : container.exitCode,
  };
}

/** A server is reachable for diagnosis only while connected. */
export function serverReachable(server: ModelServer): boolean {
  return server.status === 'CONNECTED';
}

// ---- evidence -----------------------------------------------------------------------------------

function serviceByName(model: FixtureModel, name: string): ModelService {
  const service = model.services.find((candidate) => candidate.name === name);
  if (service === undefined) throw new FixtureError(model.fixtureId, `evidence names unknown service ${name}`);
  return service;
}

function serverByName(model: FixtureModel, name: string): ModelServer {
  const server = model.servers.find((candidate) => candidate.name === name);
  if (server === undefined) throw new FixtureError(model.fixtureId, `evidence names unknown server ${name}`);
  return server;
}

/**
 * Derives the domain Evidence a scenario lists from the fixture's state, so evidence and fixture
 * can never disagree. Each item's `ref` is `<kind>:<uuid>` of the entity it observes.
 */
export function deriveEvidence(model: FixtureModel, refs: readonly string[]): Evidence[] {
  return refs.map((raw): Evidence => {
    const match = EVIDENCE_REF_PATTERN.exec(raw);
    if (match === null) throw new FixtureError(model.fixtureId, `malformed evidence ref ${raw}`);
    const kind = match[1] as string;
    const target = match[2] as string;
    switch (kind) {
      case 'server': {
        const server = serverByName(model, target);
        return { kind: 'server', ref: `server:${server.id}`, reachable: serverReachable(server) };
      }
      case 'host_memory': {
        const server = serverByName(model, target);
        return { kind: 'host_memory', ref: `server:${server.id}`, readings: hostMemoryReadings(server) };
      }
      case 'filesystem': {
        const server = serverByName(model, target);
        return { kind: 'filesystem', ref: `server:${server.id}`, filesystem: rootFilesystem(server) };
      }
      case 'deployment': {
        const deploymentEntity = model.entity(`deployment:${target}`);
        const status = deploymentStatus(model, deploymentEntity.id);
        return { kind: 'deployment', ref: `deployment:${deploymentEntity.id}`, status };
      }
      case 'container': {
        const service = serviceByName(model, target);
        const observation = containerObservation(service);
        if (observation === null) throw new FixtureError(model.fixtureId, `evidence ${raw}: service ${target} has no observed container`);
        return { kind: 'container', ref: `service:${service.id}`, container: `noodara-${service.id}`, observation };
      }
      case 'port': {
        const service = serviceByName(model, target);
        return { kind: 'port', ref: `service:${service.id}`, port: service.publishedPort ?? service.internalPort, responding: service.portResponding };
      }
      default: {
        const service = serviceByName(model, target);
        return {
          kind: 'container_memory',
          ref: `service:${service.id}`,
          container: `noodara-${service.id}`,
          readings: containerMemoryReadings(service),
          hostTotalBytes: serverOf(model, service.serverId).ramMb * MIB,
        };
      }
    }
  });
}

function deploymentStatus(model: FixtureModel, deploymentId: string): DeploymentStatus {
  for (const service of model.services) {
    const deployment = service.deployments.find((candidate) => candidate.id === deploymentId);
    if (deployment !== undefined) return deployment.status;
  }
  throw new FixtureError(model.fixtureId, `no deployment ${deploymentId}`);
}
