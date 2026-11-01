// 24-04: the ACME side of the domains/secrets E2E. A worker-scoped `acme` fixture (on top of
// `deployHost`) starts Pebble + challtestsrv on the deploy host's network and wires the three
// seams the stack (fixtures/stack.ts) already points at:
// - the worker trusts Pebble's listener root from <runDir>/pebble-listener-root.pem;
// - Traefik, on the nested dockerd's default bridge, resolves `pebble` through challtestsrv,
//   appended as a nameserver to the deploy host's resolv.conf (Docker drops the loopback one);
// - the API's DNS check asks challtestsrv through <runDir>/dns-server (fixtures/dns-seam.mjs).
// An SSH tunnel forwards the deploy host's 443/80 to the runner for real HTTPS requests.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { startPebble, PEBBLE_HOSTNAME, type StartedPebble } from '../../integration/helpers/pebble.js';
import { RUN_LABEL_KEY, currentRun, test as base, type DeployHost } from './deploy-host.js';
import { ACME_ROOT_FILE_NAME, DNS_SERVER_FILE_NAME } from './stack.js';

const execFileAsync = promisify(execFile);

const CERT_VALIDITY_SECONDS = 7 * 24 * 3600;
const TUNNEL_READY_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

export interface HttpAnswer {
  readonly status: number;
  readonly location: string | null;
  readonly body: string;
}

export interface Acme {
  readonly pebble: StartedPebble;
  /** The deploy host's address on the stack network (Pebble's VA validates HTTP-01 there). */
  readonly deployHostIp: string;
  /** The server answers: 127.0.0.1 (the API's view of the server) and the deploy host IP (Pebble's). */
  pointAtServer(hostname: string): Promise<void>;
  pointAt(hostname: string, ip: string): Promise<void>;
  /** Root of the certificates Pebble issues (fresh per Pebble run). */
  issuanceRoot(): Promise<string>;
  /** GET https://<hostname><path> through the tunnel: SNI and Host are `hostname`, CA is `ca`. */
  httpsGet(hostname: string, urlPath: string, ca: string): Promise<HttpAnswer>;
  /** GET http://<hostname><path> through the tunnel (Host header only), redirects not followed. */
  httpGet(hostname: string, urlPath: string): Promise<HttpAnswer>;
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

interface Tunnel {
  readonly httpsPort: number;
  readonly httpPort: number;
  close(): Promise<void>;
}

async function openTunnel(host: DeployHost): Promise<Tunnel> {
  const httpsPort = await freeLocalPort();
  const httpPort = await freeLocalPort();
  const child: ChildProcess = spawn(
    'ssh',
    [
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'LogLevel=ERROR',
      '-i', host.ssh.privateKeyPath,
      '-p', String(host.ssh.port),
      '-L', `127.0.0.1:${String(httpsPort)}:127.0.0.1:443`,
      '-L', `127.0.0.1:${String(httpPort)}:127.0.0.1:80`,
      `${host.ssh.user}@127.0.0.1`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => { resolve(); }));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const deadline = Date.now() + TUNNEL_READY_MS;
  while (!(await canConnect(httpsPort)) || !(await canConnect(httpPort))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await close();
      throw new Error(`acme: SSH tunnel did not come up: ${stderr.trim().slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { httpsPort, httpPort, close };
}

function request(
  module: typeof http | typeof https,
  options: https.RequestOptions,
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = module.request({ ...options, method: 'GET', agent: false, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        const location = res.headers.location;
        resolve({ status: res.statusCode ?? 0, location: typeof location === 'string' ? location : null, body });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`request timed out after ${String(REQUEST_TIMEOUT_MS)}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function rootExec(host: DeployHost, script: string, ...args: string[]): Promise<string> {
  const result = await host.exec(['sh', '-c', script, 'sh', ...args]);
  if (result.exitCode !== 0) throw new Error(`acme: deploy host exec exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Fails unless every given host-side container id is gone. */
export async function assertHostContainersGone(ids: readonly string[]): Promise<void> {
  const survivors: string[] = [];
  for (const id of ids) {
    const { stdout } = await execFileAsync('docker', ['ps', '-aq', '--no-trunc', '--filter', `id=${id}`], { timeout: 30_000 });
    if (stdout.trim() !== '') survivors.push(id.slice(0, 12));
  }
  if (survivors.length > 0) throw new Error(`acme: Pebble/challtestsrv containers survived teardown: ${survivors.join(', ')}`);
}

export async function startAcme(host: DeployHost): Promise<{ acme: Acme; stop: () => Promise<void> }> {
  const { runId, runDir } = currentRun();
  const rootFile = path.join(runDir, ACME_ROOT_FILE_NAME);
  const dnsFile = path.join(runDir, DNS_SERVER_FILE_NAME);
  const pebble = await startPebble({
    networkName: host.networkName,
    validitySeconds: CERT_VALIDITY_SECONDS,
    labels: { [RUN_LABEL_KEY]: runId },
    exposeDns: true,
  });
  let tunnel: Tunnel | undefined;
  const stop = async (): Promise<void> => {
    await tunnel?.close();
    rmSync(dnsFile, { force: true });
    rmSync(rootFile, { force: true });
    await pebble.stop();
    await assertHostContainersGone(pebble.containerIds);
  };
  try {
    if (pebble.dnsServer === null) throw new Error('acme: challtestsrv DNS is not exposed');
    writeFileSync(rootFile, pebble.listenerRootPem, { mode: 0o600 });
    writeFileSync(dnsFile, pebble.dnsServer, { mode: 0o600 });
    await pebble.setARecord(PEBBLE_HOSTNAME, pebble.ip);
    if (!IPV4.test(pebble.challtestsrvIp)) throw new Error(`acme: no challtestsrv IP: ${pebble.challtestsrvIp}`);
    await rootExec(host, 'printf "nameserver %s\\n" "$1" >> /etc/resolv.conf', pebble.challtestsrvIp);
    const deployHostIp = (
      await rootExec(host, String.raw`ip -4 -o addr show dev eth0 | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p'`)
    ).trim();
    if (!IPV4.test(deployHostIp)) throw new Error(`acme: no deploy host IP: ${deployHostIp}`);
    const opened = await openTunnel(host);
    tunnel = opened;

    const acme: Acme = {
      pebble,
      deployHostIp,
      pointAtServer: (hostname) => pebble.setARecord(hostname, ['127.0.0.1', deployHostIp]),
      pointAt: (hostname, ip) => pebble.setARecord(hostname, ip),
      async issuanceRoot() {
        const out = await rootExec(host, 'curl -sk --max-time 5 "https://$1:15000/roots/0"', pebble.ip);
        const pem = PEM_CERT.exec(out)?.[0];
        if (pem === undefined) throw new Error('acme: Pebble returned no issuance root');
        return `${pem}\n`;
      },
      httpsGet: (hostname, urlPath, ca) =>
        request(https, {
          host: '127.0.0.1',
          port: opened.httpsPort,
          path: urlPath,
          servername: hostname,
          ca,
          headers: { host: hostname },
        }),
      httpGet: (hostname, urlPath) =>
        request(http, { host: '127.0.0.1', port: opened.httpPort, path: urlPath, headers: { host: hostname } }),
    };
    return { acme, stop };
  } catch (err) {
    await stop().catch(() => undefined);
    throw err;
  }
}

/** `acme` is started once per worker, after (and torn down before) `deployHost`. */
export const test = base.extend<object, { acme: Acme }>({
  acme: [
    async ({ deployHost }, use) => {
      const { acme, stop } = await startAcme(deployHost);
      try {
        await use(acme);
      } finally {
        await stop();
      }
    },
    { scope: 'worker', timeout: 5 * 60_000 },
  ],
});

export { expect } from './deploy-host.js';
