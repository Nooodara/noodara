// Registries for the deploy-engine fixture (11-03-PLAN.md Task 2).
//   startAuthRegistry    D-10: registry:2 with htpasswd, the only registry the login/pull tests use.
//   startBaseImageMirror G7: unauthenticated pull-through cache configured as the nested dockerd's
//                        registry-mirrors, so digest-pinned docker.io bases resolve without anonymous
//                        Docker Hub pulls. Content-addressed: a digest ref cannot be substituted.
import { randomBytes, randomUUID } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/** registry:2 resolved with `docker buildx imagetools inspect registry:2` on 2026-09-29. */
export const REGISTRY_IMAGE =
  'registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';

export const REGISTRY_ALIAS = 'registry.noodara-test.internal';
export const MIRROR_ALIAS = 'mirror.noodara-test.internal';
export const REGISTRY_PORT = 5000;

/** Preferred upstream (no Docker Hub rate limit) and the documented G7 fallback. */
export const MIRROR_UPSTREAM = 'https://mirror.gcr.io';
export const MIRROR_FALLBACK_UPSTREAM = 'https://registry-1.docker.io';

const REGISTRY_STARTUP_TIMEOUT_MS = 120_000;
/** Pull of REGISTRY_IMAGE + startup. withStartupTimeout does not cover the pull, this does. */
export const REGISTRY_START_DEADLINE_MS = 240_000;
/** Where the host daemon pulls REGISTRY_IMAGE from. */
const REGISTRY_IMAGE_SOURCE = 'docker.io';
const UPSTREAM_PROBE_TIMEOUT_MS = 10_000;

export interface RegistryCredentials {
  readonly username: string;
  readonly password: string;
}

export interface StartedRegistry {
  readonly container: StartedTestContainer;
  /** host:port as seen from containers on the same network. */
  readonly host: string;
}

export interface StartedMirror extends StartedRegistry {
  readonly upstream: string;
}

/** Fresh random credentials per run; never a committed literal. */
export function generateRegistryCredentials(): RegistryCredentials {
  return {
    username: `noodara-${randomBytes(4).toString('hex')}`,
    password: randomBytes(24).toString('base64url'),
  };
}

function registryContainer(network: string, alias: string): GenericContainer {
  return new GenericContainer(REGISTRY_IMAGE)
    .withName(`noodara-${alias.split('.')[0] ?? 'registry'}-${randomUUID()}`)
    .withLabels({ 'noodara.test': 'true' })
    .withNetworkMode(network)
    .withNetworkAliases(alias)
    .withWaitStrategy(Wait.forLogMessage(/listening on/))
    .withStartupTimeout(REGISTRY_STARTUP_TIMEOUT_MS);
}

/** `htpasswdEntry` is one bcrypt `user:hash` line (see deploy-engine.ts, generated with htpasswd -B). */
export async function startAuthRegistry(
  network: string,
  htpasswdEntry: string,
): Promise<StartedRegistry> {
  const registry = registryContainer(network, REGISTRY_ALIAS)
    .withEnvironment({
      REGISTRY_AUTH: 'htpasswd',
      REGISTRY_AUTH_HTPASSWD_REALM: 'noodara-test',
      REGISTRY_AUTH_HTPASSWD_PATH: '/auth/htpasswd',
    })
    .withCopyContentToContainer([
      { content: `${htpasswdEntry.trim()}\n`, target: '/auth/htpasswd', mode: 0o644 },
    ]);
  const container = await startWithin(
    () => registry.start(),
    REGISTRY_START_DEADLINE_MS,
    REGISTRY_IMAGE_SOURCE,
  );
  return { container, host: `${REGISTRY_ALIAS}:${String(REGISTRY_PORT)}` };
}

/**
 * Bounds `start()` (image pull + startup). On timeout it rejects naming the image and the registry
 * it is pulled from; a container that still comes up afterwards is stopped, not leaked.
 */
export function startWithin<T extends { stop(): Promise<unknown> }>(
  start: () => Promise<T>,
  timeoutMs: number,
  sourceRegistry: string,
): Promise<T> {
  const image = REGISTRY_IMAGE.split('@')[0] ?? REGISTRY_IMAGE;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = start();
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(
          `registry helper: starting ${image} (pulled from ${sourceRegistry}) timed out after ` +
            `${String(timeoutMs)}ms; is ${sourceRegistry} reachable from the Docker host?`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  started.then(
    async (container) => {
      if (timedOut) await container.stop().catch(() => undefined);
    },
    () => undefined,
  );
  return Promise.race([started, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

/** True when the upstream answers the registry API root at all (401 counts: it is alive). */
async function upstreamReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/v2/`, {
      signal: AbortSignal.timeout(UPSTREAM_PROBE_TIMEOUT_MS),
    });
    return response.status === 200 || response.status === 401;
  } catch {
    return false;
  }
}

/** Probes the preferred upstream, then the G7 fallback; throws fast when neither answers. */
export async function selectMirrorUpstream(
  probe: (url: string) => Promise<boolean> = upstreamReachable,
): Promise<string> {
  if (await probe(MIRROR_UPSTREAM)) return MIRROR_UPSTREAM;
  if (await probe(MIRROR_FALLBACK_UPSTREAM)) {
    console.warn(
      `deploy-engine: ${MIRROR_UPSTREAM} unreachable, base-image mirror falls back to ${MIRROR_FALLBACK_UPSTREAM} (G7)`,
    );
    return MIRROR_FALLBACK_UPSTREAM;
  }
  throw new Error(
    `deploy-engine: base-image upstreams unreachable: ${MIRROR_UPSTREAM} and ${MIRROR_FALLBACK_UPSTREAM} ` +
      `(no answer on /v2/ within ${String(UPSTREAM_PROBE_TIMEOUT_MS)}ms each)`,
  );
}

export async function startBaseImageMirror(network: string): Promise<StartedMirror> {
  const upstream = await selectMirrorUpstream();
  const mirror = registryContainer(network, MIRROR_ALIAS).withEnvironment({
    REGISTRY_PROXY_REMOTEURL: upstream,
  });
  const container = await startWithin(
    () => mirror.start(),
    REGISTRY_START_DEADLINE_MS,
    REGISTRY_IMAGE_SOURCE,
  );
  return { container, host: `${MIRROR_ALIAS}:${String(REGISTRY_PORT)}`, upstream };
}
