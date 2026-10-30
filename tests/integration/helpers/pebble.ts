// ACME test CA (21-01, ADR 0011): Pebble + pebble-challtestsrv on the deploy-engine stack's
// network. Pebble's VA resolves every name through challtestsrv, whose A records the test sets
// (no default answer), and validates HTTP-01 on port 80 of whatever the test pointed the name at.
// Test runs never reach a real CA: PEBBLE_ACME_DIRECTORY_URL is the only ACME URL a fixture may
// configure (tests/unit/integration-helpers/acme-fixtures.test.ts, H3), and every image a v0.4
// contract may start or pull is digest-pinned in PROXY_FIXTURE_IMAGES (H1).
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/** Traefik v3.7.14 (2026-10-08), multi-arch index digest. Pulled by the nested dockerd. */
export const TRAEFIK_IMAGE =
  'traefik:v3.7.14@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c';
/** Pebble 2.10.1, multi-arch index digest. */
export const PEBBLE_IMAGE =
  'ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199';
/** pebble-challtestsrv 2.10.1, multi-arch index digest. */
export const CHALLTESTSRV_IMAGE =
  'ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1@sha256:12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b';

/** H1: the only images the v0.4 proxy/ACME fixtures may pull. */
export const PROXY_FIXTURE_IMAGES: readonly string[] = [
  TRAEFIK_IMAGE,
  PEBBLE_IMAGE,
  CHALLTESTSRV_IMAGE,
];

/** Pebble's TLS certificate (test/certs/localhost) names `localhost`, `pebble` and 127.0.0.1. */
export const PEBBLE_HOSTNAME = 'pebble';
export const PEBBLE_ACME_PORT = 14000;
/** H3: the only ACME directory URL any integration or E2E fixture may configure. */
export const PEBBLE_ACME_DIRECTORY_URL = 'https://pebble:14000/dir';
export const CHALLTESTSRV_ALIAS = 'challtestsrv.noodara-test.internal';

const DIGEST_PINNED = /^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$/;
const STARTUP_TIMEOUT_MS = 180_000;
const EXEC_TIMEOUT_MS = 30_000;
const MANAGEMENT_TIMEOUT_MS = 10_000;
const MANAGEMENT_PORT = 8055;

/** Throws unless `ref` is a tagged, digest-pinned, non-`latest` entry of the allowlist. */
export function assertAllowlistedImage(ref: string): string {
  if (!DIGEST_PINNED.test(ref)) {
    throw new Error(`proxy fixtures: image '${ref}' is not tag@sha256-pinned`);
  }
  const tag = ref.slice(ref.lastIndexOf(':', ref.indexOf('@')) + 1, ref.indexOf('@'));
  if (tag === 'latest') throw new Error(`proxy fixtures: image '${ref}' uses :latest`);
  if (!PROXY_FIXTURE_IMAGES.includes(ref)) {
    throw new Error(`proxy fixtures: image '${ref}' is not in PROXY_FIXTURE_IMAGES`);
  }
  return ref;
}

export interface StartPebbleOptions {
  /** The deploy-engine stack's network: Pebble's VA reaches the deploy host on it. */
  readonly networkName: string;
  /** Validity of every issued certificate, in seconds (Pebble profile `validityPeriod`). */
  readonly validitySeconds: number;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface StartedPebble {
  readonly directoryUrl: string;
  /** Pebble's address on `networkName`; clients pin `pebble` to it (its cert names `pebble`). */
  readonly ip: string;
  /** Root of Pebble's own HTTPS listener (minica), for LEGO_CA_CERTIFICATES. Public test data. */
  readonly listenerRootPem: string;
  readonly validitySeconds: number;
  /** Points `host` at `ip` for Pebble's VA (A record only; AAAA stays empty). */
  setARecord(host: string, ip: string): Promise<void>;
  clearARecord(host: string): Promise<void>;
  /** Idempotent. */
  stop(): Promise<void>;
}

function pebbleConfig(validitySeconds: number): string {
  return JSON.stringify({
    pebble: {
      listenAddress: `0.0.0.0:${String(PEBBLE_ACME_PORT)}`,
      managementListenAddress: '0.0.0.0:15000',
      certificate: 'test/certs/localhost/cert.pem',
      privateKey: 'test/certs/localhost/key.pem',
      // HTTP-01 is validated on the real port 80 of the name's A record (the deploy host).
      httpPort: 80,
      tlsPort: 443,
      ocspResponderURL: '',
      externalAccountBindingRequired: false,
      domainBlocklist: ['blocked-domain.example'],
      retryAfter: { authz: 1, order: 1 },
      keyAlgorithm: 'ecdsa',
      profiles: {
        default: { description: 'noodara contract tests', validityPeriod: validitySeconds },
      },
    },
  });
}

async function management(base: string, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`pebble: challtestsrv ${path} answered ${String(response.status)}`);
  }
}

function fqdn(host: string): string {
  return host.endsWith('.') ? host : `${host}.`;
}

export async function startPebble(options: StartPebbleOptions): Promise<StartedPebble> {
  const labels = { ...(options.labels ?? {}), 'noodara.test': 'true' };
  if (!Number.isInteger(options.validitySeconds) || options.validitySeconds < 60) {
    throw new Error('pebble: validitySeconds must be an integer >= 60');
  }
  const started: StartedTestContainer[] = [];
  const stopAll = async (): Promise<void> => {
    for (const container of started.splice(0).reverse()) await container.stop();
  };
  try {
    // No default answers: a name resolves only after the test sets its A record.
    const challtestsrv = await new GenericContainer(assertAllowlistedImage(CHALLTESTSRV_IMAGE))
      .withLabels(labels)
      .withNetworkMode(options.networkName)
      .withNetworkAliases(CHALLTESTSRV_ALIAS)
      .withCommand([
        '-defaultIPv4',
        '',
        '-defaultIPv6',
        '',
        '-http01',
        '',
        '-https01',
        '',
        '-tlsalpn01',
        '',
        '-doh',
        '',
      ])
      .withExposedPorts(MANAGEMENT_PORT)
      .withWaitStrategy(Wait.forLogMessage('Starting challenge servers'))
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start();
    started.push(challtestsrv);
    const managementBase = `http://${challtestsrv.getHost()}:${String(
      challtestsrv.getMappedPort(MANAGEMENT_PORT),
    )}`;

    const pebble = await new GenericContainer(assertAllowlistedImage(PEBBLE_IMAGE))
      .withLabels(labels)
      .withNetworkMode(options.networkName)
      .withNetworkAliases(PEBBLE_HOSTNAME)
      .withEnvironment({
        PEBBLE_VA_NOSLEEP: '1',
        PEBBLE_WFE_NONCEREJECT: '0',
        PEBBLE_AUTHZREUSE: '0',
      })
      .withCopyContentToContainer([
        {
          content: pebbleConfig(options.validitySeconds),
          target: '/test/config/noodara-pebble.json',
          mode: 0o644,
        },
      ])
      .withCommand([
        '-config',
        '/test/config/noodara-pebble.json',
        '-dnsserver',
        `${CHALLTESTSRV_ALIAS}:8053`,
      ])
      .withWaitStrategy(Wait.forLogMessage(/ACME directory available/))
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start();
    started.push(pebble);

    // The image is distroless (no shell); the archive API reads the shipped minica root.
    const archive = await Promise.race([
      pebble.copyArchiveFromContainer('/test/certs/pebble.minica.pem'),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('pebble: reading the minica root timed out'));
        }, EXEC_TIMEOUT_MS).unref();
      }),
    ]);
    const chunks: Buffer[] = [];
    for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array));
    const tarText = Buffer.concat(chunks).toString('latin1');
    const begin = tarText.indexOf('-----BEGIN CERTIFICATE-----');
    const endMarker = '-----END CERTIFICATE-----';
    const end = tarText.indexOf(endMarker, begin);
    if (begin < 0 || end < 0) throw new Error('pebble: minica root not found in the image');
    const listenerRootPem = `${tarText.slice(begin, end + endMarker.length)}\n`;

    let stopped = false;
    return {
      directoryUrl: PEBBLE_ACME_DIRECTORY_URL,
      ip: pebble.getIpAddress(options.networkName),
      listenerRootPem,
      validitySeconds: options.validitySeconds,
      setARecord: (host, ip) =>
        management(managementBase, '/add-a', { host: fqdn(host), addresses: [ip] }),
      clearARecord: (host) => management(managementBase, '/clear-a', { host: fqdn(host) }),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await stopAll();
      },
    };
  } catch (error) {
    await stopAll().catch(() => undefined);
    throw error;
  }
}
