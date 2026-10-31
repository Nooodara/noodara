// 22-01 proxy and certificate templates (ADR 0011) on the real sshd + dockerd fixture, Ubuntu
// 22.04 and 24.04. Every step under test is the rendered allowlisted template; raw ssh2 commands
// only set up the fixture (service container, foreign listeners) or read root-side truth.
//   A3: install, dynamic write, router in the API, Host routing, restore from .prev,
//       ports_in_use, tls.cert_status (no proxy / default / Pebble-issued).
//   H1: an interrupted large dynamic write leaves the old file; .prev is 0600.
//   H3: --restart unless-stopped; the proxy answers again after docker restart.
//   R1: renderStaticConfig + renderDynamicConfig output loaded by a real Traefik.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PROXY_API_PORT,
  PROXY_API_ROUTER_NAME,
  PROXY_CONTAINER_NAME,
  PROXY_LAYOUT,
  proxyContainerName,
  proxyDynamicPathFor,
  proxyRouterNamesFor,
  renderDynamicConfig,
  renderStaticConfig,
  validateHostname,
  type ProxyRouteDomain,
  type ResourceId,
  type ValidationResult,
} from "@noodara/domain";
import { Client } from "@noodara/ssh/testing";
import type { ClientChannel } from "@noodara/ssh/testing";
import {
  dockerStart,
  renderRemoteCommand,
  type RemoteCommand,
} from "@noodara/ssh/testing/deploy-templates";
import {
  PROXY_CERT_STATUS_MAX_BYTES,
  certProbeFromTlsStatus,
  parsePortsInUse,
  parseProxyRouterStatus,
  parseTlsCertStatus,
  proxyCertStatus,
  proxyCreate,
  proxyFileDigest,
  proxyNetworkConnect,
  proxyNetworkDisconnect,
  proxyPortsInUse,
  proxyPrepareDirs,
  proxyRemoveDynamic,
  proxyRestoreDynamic,
  proxyRouterStatus,
  proxyWriteDynamic,
  proxyWriteStatic,
  type ProxyRouterStatus,
} from "../../../packages/ssh/src/commands/proxy.js";
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from "../helpers/deploy-engine.js";
import {
  PEBBLE_ACME_DIRECTORY_URL,
  PEBBLE_HOSTNAME,
  TRAEFIK_IMAGE,
  assertAllowlistedImage,
  startPebble,
  type StartedPebble,
} from "../helpers/pebble.js";
import { assertNoStrayTestContainers } from "../helpers/ssh.js";

const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 330_000;
const SERVER_PORT = 8080;
const CERT_VALIDITY_SECONDS = 3600;
const ACME_EMAIL = "ops@noodara.dev";

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function connect(stack: DeployEngineStack): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => {
      resolve(client);
    });
    client.once("error", reject);
    client.connect({
      host: stack.ssh.host,
      port: stack.ssh.port,
      username: stack.ssh.user,
      privateKey: stack.ssh.privateKey,
      readyTimeout: 20_000,
    });
  });
}

/**
 * `feed` writes stdin; `interrupt: true` destroys the channel after feeding (no EOF from us),
 * otherwise the channel is ended so the remote `cat` sees EOF.
 */
function runLine(
  client: Client,
  commandLine: string,
  feed?: (channel: ClientChannel) => void,
  interrupt = false,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    client.exec(
      commandLine,
      (err: Error | undefined, channel: ClientChannel) => {
        if (err !== undefined) {
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        let exitCode: number | null = null;
        const timer = setTimeout(() => {
          channel.destroy();
          reject(
            new Error(
              `ssh exec timed out after ${String(SSH_COMMAND_TIMEOUT_MS)}ms`,
            ),
          );
        }, SSH_COMMAND_TIMEOUT_MS);
        timer.unref();
        channel.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        channel.on("exit", (code: number | null) => {
          exitCode = code;
        });
        channel.on("close", () => {
          clearTimeout(timer);
          resolve({ exitCode, stdout, stderr });
        });
        feed?.(channel);
        if (interrupt) {
          channel.destroy();
        } else {
          channel.end();
        }
      },
    );
  });
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function valid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.code}`);
  return result.value;
}

async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const startedAt = performance.now();
  for (;;) {
    const value = await read();
    if (done(value) || performance.now() - startedAt >= timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const TARGET_SERVER_JS = `
const http = require('http');
process.on('SIGTERM', () => process.exit(0));
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok ' + req.headers.host + '\\n');
}).listen(${String(SERVER_PORT)}, '0.0.0.0');
`;

const LISTEN_JS = `require('net').createServer(() => {}).listen(Number(process.argv[1]), '0.0.0.0');
process.on('SIGTERM', () => process.exit(0));`;

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  "22-01 proxy templates on Ubuntu %s",
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let pebble: StartedPebble | undefined;
    let client: Client | undefined;
    let nodeImage = "";
    let hostIp = "";
    const serviceId = randomUUID() as ResourceId;
    const container = `noodara-${serviceId}`;
    const network = `noodara-net-${serviceId}`;
    const dynamicPath = valid(proxyDynamicPathFor(serviceId));
    const label = (): string => randomUUID().slice(0, 8);
    const hostA = valid(validateHostname(`a${label()}.proxy.noodara.test`));
    const hostIssued = valid(
      validateHostname(`i${label()}.proxy.noodara.test`),
    );
    const hostNoRoute = valid(
      validateHostname(`n${label()}.proxy.noodara.test`),
    );
    const domainA: ProxyRouteDomain = {
      id: randomUUID(),
      hostname: hostA,
      httpsRedirect: false,
    };
    const domainIssued: ProxyRouteDomain = {
      id: randomUUID(),
      hostname: hostIssued,
      httpsRedirect: false,
    };
    const [webRouterA] = proxyRouterNamesFor(serviceId, [domainA]).filter(
      (name) => name.endsWith("-web"),
    );
    const goodDynamic = valid(
      renderDynamicConfig({ id: serviceId, internalPort: SERVER_PORT }, [
        domainA,
      ]),
    );

    const c = (): Client => {
      if (client === undefined) throw new Error("client not connected");
      return client;
    };
    const run = (command: RemoteCommand, stdin?: string): Promise<RunResult> =>
      runLine(
        c(),
        renderRemoteCommand(command),
        stdin === undefined ? undefined : (channel) => channel.write(stdin),
      );
    const mustRun = async (
      command: RemoteCommand,
      stdin?: string,
    ): Promise<string> => {
      const result = await run(command, stdin);
      expect(
        result.exitCode,
        `${command.name}: ${result.stdout}${result.stderr}`,
      ).toBe(0);
      return result.stdout;
    };
    /** Fixture setup and root-side truth only; never a template under test. */
    const shell = async (
      script: string,
      args: readonly string[] = [],
    ): Promise<string> => {
      const line = [
        "timeout",
        "60",
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        script,
        "noodara-test",
        ...args,
      ]
        .map(q)
        .join(" ");
      const result = await runLine(c(), line);
      if (result.exitCode !== 0) {
        throw new Error(
          `exit ${String(result.exitCode)}: ${script.slice(0, 80)}: ${result.stderr}`,
        );
      }
      return result.stdout;
    };
    const hit = async (host: string): Promise<string> =>
      (
        await shell(
          `r=$(curl -s --max-time 2 -H "Host: $1" -w '|%{http_code}' http://127.0.0.1/ 2>/dev/null) || true
printf '%s %s' "\${r##*|}" "\${r%|*}"`,
          [host],
        )
      ).trim();
    const routerStatus = async (name: string): Promise<ProxyRouterStatus> =>
      parseProxyRouterStatus(await mustRun(proxyRouterStatus(name)));
    const sha = async (path: string): Promise<string> =>
      (await shell('sha256sum -- "$1" | cut -d" " -f1', [path])).trim();
    const modes = async (
      paths: readonly string[],
    ): Promise<Record<string, string>> => {
      const out = await shell('stat -c "%a %n" -- "$@"', paths);
      return Object.fromEntries(
        out
          .trim()
          .split("\n")
          .map((line) => {
            const [mode = "", path = ""] = line.split(" ");
            return [path, mode];
          }),
      );
    };
    const writeDynamic = (content: string): Promise<string> =>
      mustRun(
        proxyWriteDynamic({
          path: dynamicPath,
          digest: proxyFileDigest(content),
        }),
        content,
      );

    beforeAll(async () => {
      stack = await startDeployEngineStack({ ubuntu });
      pebble = await startPebble({
        networkName: stack.networkName,
        validitySeconds: CERT_VALIDITY_SECONDS,
      });
      client = await connect(stack);
      const node = stack.baseImages.find((ref) => ref.startsWith("node:"));
      if (node === undefined) throw new Error("no node base image preloaded");
      nodeImage = node;
      hostIp = (
        await shell(
          String.raw`ip -4 -o addr show dev eth0 | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p'`,
        )
      ).trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostIp))
        throw new Error(`no host IP: ${hostIp}`);
      await shell('timeout 300 docker pull --quiet "$1" >/dev/null', [
        assertAllowlistedImage(TRAEFIK_IMAGE),
      ]);
      await shell(
        `docker network create --label noodara.managed=true -- "$2" >/dev/null
docker run --detach --pull never --name "$1" --network "$2" --restart unless-stopped \\
  --label noodara.managed=true --label "noodara.service_id=$3" -- "$4" node -e "$5" >/dev/null`,
        [container, network, serviceId, nodeImage, TARGET_SERVER_JS],
      );
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      client?.end();
      await pebble?.stop();
      await stack?.stop();
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it("A3/H5: tls.cert_status without a proxy is down, one capped line, no certificate material", async () => {
      const out = await mustRun(proxyCertStatus(hostA));
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(
        PROXY_CERT_STATUS_MAX_BYTES,
      );
      expect(out).not.toContain("BEGIN CERTIFICATE");
      expect(parseTlsCertStatus(out)).toEqual({ kind: "down" });
      expect(certProbeFromTlsStatus(parseTlsCertStatus(out))).toEqual({
        kind: "down",
      });
    });

    it("A3/H4: ports_in_use reports a foreign process and a foreign docker-proxy, and nothing once they are gone", async () => {
      await shell(
        `docker run --detach --pull never --name noodara-test-foreign-80 --network host -- "$1" node -e "$2" 80 >/dev/null
docker run --detach --pull never --name noodara-test-foreign-443 --publish 443:443 -- "$1" node -e "$2" 443 >/dev/null`,
        [nodeImage, LISTEN_JS],
      );
      const busy = await pollUntil(
        async () => mustRun(proxyPortsInUse()),
        (out) => {
          const parsed = parsePortsInUse(out);
          return parsed.kind === "ok" && parsed.foreign.length === 2;
        },
        20_000,
      );
      console.log(`[22-01-PORTS] ${JSON.stringify({ ubuntu, busy })}`);
      expect(parsePortsInUse(busy)).toEqual({
        kind: "ok",
        foreign: [
          { port: 80, process: "node" },
          { port: 443, process: "docker-proxy" },
        ],
      });

      await shell(
        "docker rm --force -- noodara-test-foreign-80 noodara-test-foreign-443 >/dev/null",
      );
      const free = await pollUntil(
        async () => mustRun(proxyPortsInUse()),
        (out) => {
          const parsed = parsePortsInUse(out);
          return parsed.kind === "ok" && parsed.foreign.length === 0;
        },
        20_000,
      );
      expect(parsePortsInUse(free)).toEqual({ kind: "ok", foreign: [] });
    });

    it("A3/R1: install with the rendered static config; 0700 dirs, 0600 files; the noodara-api router is loaded and the API is loopback-only", async () => {
      if (pebble === undefined) throw new Error("pebble not started");
      const config = valid(
        renderStaticConfig({
          email: ACME_EMAIL,
          caUrl: PEBBLE_ACME_DIRECTORY_URL,
        }),
      );
      expect(await mustRun(proxyPrepareDirs())).toContain(
        "NOODARA_PROXY_DIRS ready",
      );
      await mustRun(
        proxyWriteStatic({
          target: "traefik",
          digest: proxyFileDigest(config.traefikConfig),
        }),
        config.traefikConfig,
      );
      await mustRun(
        proxyWriteStatic({
          target: "ca_root",
          digest: proxyFileDigest(pebble.listenerRootPem),
        }),
        pebble.listenerRootPem,
      );
      await mustRun(
        proxyWriteDynamic({
          path: PROXY_LAYOUT.apiRouterFile,
          digest: proxyFileDigest(config.apiRouterConfig),
        }),
        config.apiRouterConfig,
      );
      await mustRun(
        proxyCreate({
          image: TRAEFIK_IMAGE,
          publishedPorts: config.publishedPorts,
          caRoot: true,
          extraHosts: [{ name: PEBBLE_HOSTNAME, ip: pebble.ip }],
        }),
      );
      await mustRun(dockerStart(proxyContainerName()));
      await mustRun(proxyNetworkConnect(serviceId));

      const api = await pollUntil(
        () => routerStatus(PROXY_API_ROUTER_NAME),
        (status) => status.kind === "present",
        30_000,
      );
      expect(api).toMatchObject({
        kind: "present",
        status: "enabled",
        service: "api@internal",
      });

      const dirs = [
        PROXY_LAYOUT.root,
        PROXY_LAYOUT.dynamicDir,
        PROXY_LAYOUT.caDir,
        PROXY_LAYOUT.acmeDir,
      ];
      const files = [
        PROXY_LAYOUT.staticConfigFile,
        `${PROXY_LAYOUT.caDir}/ca-root.pem`,
        PROXY_LAYOUT.apiRouterFile,
      ];
      const seen = await modes([...dirs, ...files]);
      for (const dir of dirs) expect(seen[dir], dir).toBe("700");
      for (const file of files) expect(seen[file], file).toBe("600");

      const reach = await shell(
        `for t in "127.0.0.1:${String(PROXY_API_PORT)}" "$1:${String(PROXY_API_PORT)}"; do
  if ( exec 3<>"/dev/tcp/\${t%:*}/\${t##*:}" ) 2>/dev/null; then echo "$t open"; else echo "$t refused"; fi
done
curl -s -o /dev/null --max-time 2 -w 'web_api %{http_code}\\n' http://127.0.0.1/api/version || true`,
        [hostIp],
      );
      expect(reach).toContain(`127.0.0.1:${String(PROXY_API_PORT)} open`);
      expect(reach).toContain(`${hostIp}:${String(PROXY_API_PORT)} refused`);
      expect(reach).toContain("web_api 404");

      // H4: re-install on a RUNNING proxy never sees its own listeners as foreign.
      const ours = await mustRun(proxyPortsInUse());
      console.log(`[22-01-PORTS] ${JSON.stringify({ ubuntu, ours })}`);
      expect(parsePortsInUse(ours)).toEqual({ kind: "ok", foreign: [] });
    });

    it("A3/R1: a rendered dynamic file shows its routers in the API and routes HTTP by Host", async () => {
      expect(await writeDynamic(goodDynamic)).toContain(
        "NOODARA_PROXY_WRITE ok",
      );
      const web = await pollUntil(
        () => routerStatus(webRouterA ?? ""),
        (status) => status.kind === "present" && status.status === "enabled",
        30_000,
      );
      expect(web).toMatchObject({ kind: "present", status: "enabled" });
      if (web.kind === "present")
        expect(web.service).toMatch(
          new RegExp(`^noodara-${serviceId}(@file)?$`),
        );
      for (const name of proxyRouterNamesFor(serviceId, [domainA])) {
        expect(await routerStatus(name), name).toMatchObject({
          kind: "present",
          status: "enabled",
        });
      }
      expect(
        await pollUntil(
          () => hit(hostA),
          (r) => r.startsWith("200 "),
          30_000,
        ),
      ).toBe(`200 ok ${hostA}`);
      expect(await hit(hostNoRoute)).toMatch(/^404 /);
      // First write: no previous file, so no .prev.
      expect(
        await shell('[ -e "$1.prev" ] && echo yes || echo no', [dynamicPath]),
      ).toBe("no\n");
    });

    it("A3: an invalid dynamic file is restored from .prev and the router answers again", async () => {
      const goodSha = await sha(dynamicPath);
      const truncated = JSON.stringify({
        http: {
          routers: {
            [webRouterA ?? ""]: {
              entryPoints: ["web"],
              rule: `Host(\`${hostA}\`)`,
              service: `noodara-${serviceId}`,
            },
          },
        },
      });
      await writeDynamic(truncated);
      expect(await sha(`${dynamicPath}.prev`)).toBe(goodSha);
      expect(
        (await modes([`${dynamicPath}.prev`, dynamicPath]))[
          `${dynamicPath}.prev`
        ],
      ).toBe("600");
      expect(
        await pollUntil(
          () => hit(hostA),
          (r) => r.startsWith("404 "),
          30_000,
        ),
      ).toMatch(/^404 /);

      expect(await mustRun(proxyRestoreDynamic(dynamicPath))).toContain(
        "NOODARA_PROXY_RESTORE restored",
      );
      expect(await sha(dynamicPath)).toBe(goodSha);
      expect(
        await pollUntil(
          () => hit(hostA),
          (r) => r.startsWith("200 "),
          30_000,
        ),
      ).toBe(`200 ok ${hostA}`);
      expect(await routerStatus(webRouterA ?? "")).toMatchObject({
        kind: "present",
        status: "enabled",
      });
    });

    it("H1: an interrupted large dynamic write leaves the old file and no temp file", async () => {
      const before = await sha(dynamicPath);
      const prevBefore = await sha(`${dynamicPath}.prev`);
      const large = `${goodDynamic}\n${`# ${"x".repeat(78)}\n`.repeat(8000)}`;
      const half = large.slice(0, Math.floor(large.length / 2));
      const command = renderRemoteCommand(
        proxyWriteDynamic({
          path: dynamicPath,
          digest: proxyFileDigest(large),
        }),
      );

      // EOF after half the bytes: the size/sha256 check refuses the rename.
      const eof = await runLine(c(), command, (channel) => channel.write(half));
      expect(eof.exitCode).toBe(4);
      expect(eof.stdout).toContain("NOODARA_PROXY_WRITE incomplete");

      // The connection drops mid-write: same outcome, the trap removes the temp file.
      await runLine(c(), command, (channel) => channel.write(half), true);
      const leftovers = await pollUntil(
        () =>
          shell('ls -A -- "$1" | grep -c "^\\.noodara-" || true', [
            PROXY_LAYOUT.dynamicDir,
          ]),
        (out) => out.trim() === "0",
        10_000,
      );
      expect(leftovers.trim()).toBe("0");
      expect(await sha(dynamicPath)).toBe(before);
      expect(await sha(`${dynamicPath}.prev`)).toBe(prevBefore);
      expect(
        (await modes([`${dynamicPath}.prev`]))[`${dynamicPath}.prev`],
      ).toBe("600");

      // The complete large write goes through and keeps the router.
      expect(await writeDynamic(large)).toContain("NOODARA_PROXY_WRITE ok");
      expect(await sha(`${dynamicPath}.prev`)).toBe(before);
      expect(
        await pollUntil(
          () => hit(hostA),
          (r) => r.startsWith("200 "),
          30_000,
        ),
      ).toBe(`200 ok ${hostA}`);
    });

    it("A3/H2: tls.cert_status tells the default certificate from a Pebble-issued one", async () => {
      if (pebble === undefined) throw new Error("pebble not started");
      const fallback = await mustRun(proxyCertStatus(hostNoRoute));
      expect(parseTlsCertStatus(fallback)).toMatchObject({
        kind: "tls",
        isDefault: true,
      });
      expect(certProbeFromTlsStatus(parseTlsCertStatus(fallback))).toEqual({
        kind: "default",
      });

      await pebble.setARecord(hostIssued, hostIp);
      await writeDynamic(
        valid(
          renderDynamicConfig({ id: serviceId, internalPort: SERVER_PORT }, [
            domainA,
            domainIssued,
          ]),
        ),
      );
      const issued = await pollUntil(
        () => mustRun(proxyCertStatus(hostIssued)),
        (out) => {
          const status = parseTlsCertStatus(out);
          return status.kind === "tls" && !status.isDefault;
        },
        150_000,
      );
      console.log(
        `[22-01-CERT] ${JSON.stringify({ ubuntu, fallback, issued })}`,
      );
      for (const out of [fallback, issued]) {
        expect(Buffer.byteLength(out)).toBeLessThanOrEqual(
          PROXY_CERT_STATUS_MAX_BYTES,
        );
        expect(out).not.toContain("BEGIN CERTIFICATE");
        expect(out).not.toContain("PRIVATE KEY");
      }
      const status = parseTlsCertStatus(issued);
      expect(status).toMatchObject({ kind: "tls", isDefault: false });
      if (status.kind !== "tls") throw new Error("unreachable");
      expect(status.issuer).toMatch(/^CN=Pebble Intermediate CA /);
      expect(status.notAfter.getTime()).toBeGreaterThan(Date.now());
      expect(certProbeFromTlsStatus(status)).toEqual({
        kind: "issued",
        notAfter: status.notAfter,
      });
    });

    it("H3: the proxy restarts unless-stopped and its routers answer again after docker restart", async () => {
      const policy = await shell(
        'docker inspect --format "{{.HostConfig.RestartPolicy.Name}}" -- "$1"',
        [PROXY_CONTAINER_NAME],
      );
      expect(policy.trim()).toBe("unless-stopped");
      await shell('docker restart --timeout 10 -- "$1" >/dev/null', [
        PROXY_CONTAINER_NAME,
      ]);
      const running = await shell(
        'docker inspect --format "{{.State.Running}}" -- "$1"',
        [PROXY_CONTAINER_NAME],
      );
      expect(running.trim()).toBe("true");
      expect(
        await pollUntil(
          () => hit(hostA),
          (r) => r.startsWith("200 "),
          30_000,
        ),
      ).toBe(`200 ok ${hostA}`);
      expect(
        await pollUntil(
          () => routerStatus(webRouterA ?? ""),
          (s) => s.kind === "present",
          30_000,
        ),
      ).toMatchObject({ kind: "present", status: "enabled" });
    });

    it("A1: remove_dynamic drops the routers and network_disconnect detaches the proxy", async () => {
      expect(await mustRun(proxyRemoveDynamic(dynamicPath))).toContain(
        "NOODARA_PROXY_REMOVE ok",
      );
      expect(
        await pollUntil(
          () => routerStatus(webRouterA ?? ""),
          (s) => s.kind === "missing",
          30_000,
        ),
      ).toEqual({ kind: "missing" });
      expect(await shell('ls -A -- "$1"', [PROXY_LAYOUT.dynamicDir])).toBe(
        "noodara-api.yml\n",
      );
      await mustRun(proxyNetworkDisconnect(serviceId));
      const networks = await shell(
        `docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' -- "$1"`,
        [PROXY_CONTAINER_NAME],
      );
      expect(networks).not.toContain(network);
      expect(await routerStatus(PROXY_API_ROUTER_NAME)).toMatchObject({
        kind: "present",
      });
    });
  },
);
