import { describe, expect, it } from "vitest";
import {
  PROXY_LAYOUT,
  PROXY_PUBLISHED_PORTS,
  proxyDynamicPathFor,
  validateResourceId,
  type ResourceId,
} from "@noodara/domain";
import { renderRemoteCommand, type RemoteCommand } from "./remote-command.js";
import {
  PROXY_CERT_STATUS_MAX_BYTES,
  PROXY_SCRIPTS,
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
  proxyRemoveFiles,
  proxyRestoreDynamic,
  proxyRouterStatus,
  proxyWriteDynamic,
  proxyWriteStatic,
} from "./proxy.js";

const IMAGE =
  "traefik:v3.7.14@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c";
const SERVICE = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const serviceId = (validateResourceId(SERVICE) as { value: ResourceId }).value;
const dynamicPath = (proxyDynamicPathFor(SERVICE) as { value: string }).value;
const digest = proxyFileDigest("http: {}\n");

function wrapped(cmd: RemoteCommand): { seconds: number; script: string; cap: number; args: string[] } {
  const argv = [...cmd.argv];
  expect(argv.slice(0, 5)).toEqual(["env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C", "timeout"]);
  expect(argv.slice(5, 7)).toEqual(["-k", "1"]);
  expect(argv.slice(8, 12)).toEqual(["bash", "--noprofile", "--norc", "-c"]);
  const script = argv[12] ?? "";
  const cap = /\} 2>&1 \| head -c (\d+)$/.exec(script);
  expect(cap).not.toBeNull();
  expect(argv[13]).toBe("noodara-proxy");
  return { seconds: Number(argv[7]), script, cap: Number(cap?.[1]), args: argv.slice(14) };
}

describe("proxy templates: bounded wrapper (A4)", () => {
  const all: [string, RemoteCommand][] = [
    ["prepare_dirs", proxyPrepareDirs()],
    ["write_static", proxyWriteStatic({ target: "traefik", digest })],
    ["write_dynamic", proxyWriteDynamic({ path: dynamicPath, digest })],
    ["restore_dynamic", proxyRestoreDynamic(dynamicPath)],
    ["remove_dynamic", proxyRemoveDynamic(dynamicPath)],
    ["remove_files", proxyRemoveFiles()],
    ["status", proxyRouterStatus("noodara-x-web")],
    ["ports_in_use", proxyPortsInUse()],
    ["cert_status", proxyCertStatus("app.example.com")],
  ];
  it.each(all)("%s runs under env -i, timeout and head -c", (_, cmd) => {
    const w = wrapped(cmd);
    expect(w.seconds).toBeGreaterThan(0);
    expect(w.seconds).toBeLessThanOrEqual(120);
    expect(w.cap).toBeGreaterThan(0);
    expect(w.script.startsWith("set -o pipefail\n{\n")).toBe(true);
  });
  it.each([
    ["create", proxyCreate({ image: IMAGE, publishedPorts: PROXY_PUBLISHED_PORTS })],
    ["connect", proxyNetworkConnect(serviceId)],
    ["disconnect", proxyNetworkDisconnect(serviceId)],
  ] as const)("docker %s runs under timeout -k 1", (_, cmd) => {
    expect(cmd.argv.slice(0, 3)).toEqual(["timeout", "-k", "1"]);
    expect(cmd.argv[4]).toBe("docker");
  });
  it("scripts are constants: no caller value is ever inside the script text", () => {
    const cmd = proxyCertStatus("evil.example.com");
    expect(wrapped(cmd).script).not.toContain("evil");
    expect(wrapped(cmd).args).toEqual(["evil.example.com"]);
    expect(Object.isFrozen(PROXY_SCRIPTS)).toBe(true);
  });
});

describe("proxy.prepare_dirs (A1)", () => {
  it("creates 0700 dirs and tightens files to 0600", () => {
    const cmd = proxyPrepareDirs();
    expect(cmd.name).toBe("proxy.prepare_dirs");
    const { script, args } = wrapped(cmd);
    expect(args).toEqual([]);
    expect(script).toContain("-m 0700");
    expect(script).toContain("chmod 0600");
    expect(script).toContain(PROXY_LAYOUT.root);
    expect(script).not.toMatch(/07[5-7][5-7]|0644/);
  });
});

describe("proxy.remove_files (22-02 A3, A4, H2)", () => {
  it("removes the whole proxy root, sudo -n only as fallback, no caller argument", () => {
    const cmd = proxyRemoveFiles();
    expect(cmd.name).toBe("proxy.remove_files");
    expect(cmd.stdin).toBe("none");
    const { script, args } = wrapped(cmd);
    expect(args).toEqual([]);
    expect(script).toContain(`root=${PROXY_LAYOUT.root}`);
    expect(script).toContain('rm -rf -- "$root"');
    expect(script).toContain('sudo -n rm -rf -- "$root"');
    expect(script.indexOf('rm -rf -- "$root"')).toBeLessThan(script.indexOf("sudo -n"));
    expect(script).toContain("NOODARA_PROXY_PURGE ok");
  });
  it("is idempotent when nothing is there and refuses a symlinked root", () => {
    const { script } = wrapped(proxyRemoveFiles());
    expect(script).toMatch(/if \[ ! -e "\$root" \] && \[ ! -L "\$root" \]; then echo "NOODARA_PROXY_PURGE ok"; exit 0; fi/);
    expect(script).toContain('if [ -L "$root" ]; then echo "NOODARA_PROXY_PURGE refused"; exit 3; fi');
  });
});

describe("proxy.write_static / write_dynamic (A1, H1)", () => {
  it("digest is byte length plus sha256", () => {
    expect(proxyFileDigest("abc")).toEqual({
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect(proxyFileDigest("é").bytes).toBe(2);
  });
  it("write_static reads stdin and targets only traefik.yml or the CA root", () => {
    const cmd = proxyWriteStatic({ target: "traefik", digest });
    expect(cmd.name).toBe("proxy.write_static");
    expect(cmd.stdin).toBe("secret");
    expect(wrapped(cmd).args).toEqual([PROXY_LAYOUT.staticConfigFile, String(digest.bytes), digest.sha256]);
    expect(wrapped(proxyWriteStatic({ target: "ca_root", digest })).args[0]).toBe(
      `${PROXY_LAYOUT.caDir}/ca-root.pem`,
    );
    expect(() => proxyWriteStatic({ target: "other" as "traefik", digest })).toThrow(RangeError);
  });
  it("write_dynamic writes a temp file, verifies size and sha256, keeps .prev 0600 and renames", () => {
    const cmd = proxyWriteDynamic({ path: dynamicPath, digest });
    expect(cmd.name).toBe("proxy.write_dynamic");
    expect(cmd.stdin).toBe("secret");
    const { script, args } = wrapped(cmd);
    expect(args).toEqual([dynamicPath, String(digest.bytes), digest.sha256]);
    expect(script).toContain("umask 077");
    expect(script).toContain('mktemp "$dir/.noodara-XXXXXX"');
    expect(script).toContain("sha256sum");
    expect(script).toContain("NOODARA_PROXY_WRITE incomplete");
    expect(script).toContain('"$target.prev"');
    expect(script).toContain('mv -f -- "$tmp" "$target"');
    expect(script).toMatch(/trap .*EXIT/);
  });
  it("accepts the noodara-api router file", () => {
    expect(wrapped(proxyWriteDynamic({ path: PROXY_LAYOUT.apiRouterFile, digest })).args[0]).toBe(
      PROXY_LAYOUT.apiRouterFile,
    );
  });
  it.each([
    "/opt/noodara-proxy/traefik.yml",
    "/opt/noodara-proxy/dynamic/../traefik.yml",
    "/opt/noodara-proxy/dynamic/x.yml",
    "/etc/passwd",
    `/opt/noodara-proxy/dynamic/${SERVICE}.yml; rm -rf /`,
    `/opt/noodara-proxy/dynamic/${SERVICE}.yml\n`,
    `/opt/noodara-proxy/dynamic/$(id).yml`,
    `dynamic/${SERVICE}.yml`,
  ])("A2: rejects dynamic path %j", (path) => {
    expect(() => proxyWriteDynamic({ path, digest })).toThrow(RangeError);
    expect(() => proxyRestoreDynamic(path)).toThrow(RangeError);
    expect(() => proxyRemoveDynamic(path)).toThrow(RangeError);
  });
  it.each([
    { bytes: -1, sha256: digest.sha256 },
    { bytes: 1.5, sha256: digest.sha256 },
    { bytes: 2_000_000, sha256: digest.sha256 },
    { bytes: 3, sha256: "nothex" },
  ])("rejects a malformed digest %j", (bad) => {
    expect(() => proxyWriteDynamic({ path: dynamicPath, digest: bad })).toThrow(RangeError);
  });
  it("restore keeps .prev; remove never touches the api router file", () => {
    expect(proxyRestoreDynamic(dynamicPath).name).toBe("proxy.restore_dynamic");
    expect(wrapped(proxyRestoreDynamic(dynamicPath)).script).toContain('cp -- "$target.prev"');
    expect(proxyRemoveDynamic(dynamicPath).name).toBe("proxy.remove_dynamic");
    expect(() => proxyRemoveDynamic(PROXY_LAYOUT.apiRouterFile)).toThrow(RangeError);
  });
});

describe("proxy.create (A1, A2, H3)", () => {
  const argv = (): string[] => [...proxyCreate({ image: IMAGE, publishedPorts: PROXY_PUBLISHED_PORTS }).argv];
  const pair = (a: string[], flag: string): string[] =>
    a.flatMap((v, i) => (v === flag ? [a[i + 1] ?? ""] : []));

  it("renders the pinned, labelled, restartable proxy container", () => {
    const a = argv();
    expect(proxyCreate({ image: IMAGE, publishedPorts: PROXY_PUBLISHED_PORTS }).name).toBe("proxy.create");
    expect(a.slice(4, 6)).toEqual(["docker", "create"]);
    expect(pair(a, "--name")).toEqual(["noodara-traefik"]);
    expect(pair(a, "--pull")).toEqual(["never"]);
    expect(pair(a, "--restart")).toEqual(["unless-stopped"]);
    expect(pair(a, "--label")).toEqual(["noodara.managed=true", "noodara.proxy=true"]);
    expect(pair(a, "--publish")).toEqual(["80:80", "443:443", "127.0.0.1:9180:9180"]);
    expect(pair(a, "--mount")).toEqual([
      "type=bind,src=/opt/noodara-proxy/traefik.yml,dst=/etc/traefik/traefik.yml,readonly",
      "type=bind,src=/opt/noodara-proxy/dynamic,dst=/etc/traefik/dynamic,readonly",
      "type=bind,src=/opt/noodara-proxy/acme,dst=/etc/traefik/acme",
    ]);
    expect(a.slice(-2)).toEqual(["--", IMAGE]);
    expect(a.join(" ")).not.toMatch(/docker\.sock|--privileged|--network host|--env /);
  });
  it("mounts the CA root and sets LEGO_CA_CERTIFICATES only on the test seam", () => {
    const a = [
      ...proxyCreate({
        image: IMAGE,
        publishedPorts: PROXY_PUBLISHED_PORTS,
        caRoot: true,
        extraHosts: [{ name: "pebble", ip: "172.18.0.5" }],
      }).argv,
    ];
    expect(pair(a, "--mount")).toContain("type=bind,src=/opt/noodara-proxy/ca,dst=/etc/traefik/ca,readonly");
    expect(pair(a, "--env")).toEqual(["LEGO_CA_CERTIFICATES=/etc/traefik/ca/ca-root.pem"]);
    expect(pair(a, "--add-host")).toEqual(["pebble:172.18.0.5"]);
  });
  it.each([
    "traefik:v3.7.14",
    "traefik:latest@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c",
    "traefik@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c",
    "nginx:1.27@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c",
    "evil/traefik-not:v3@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c",
    `${IMAGE};id`,
    "--privileged",
  ])("A2: rejects image %j", (image) => {
    expect(() => proxyCreate({ image, publishedPorts: PROXY_PUBLISHED_PORTS })).toThrow(RangeError);
  });
  it.each([
    [["80:80", "443:443", "0.0.0.0:9180:9180"]],
    [["80:80", "443:443", "9180:9180"]],
    [["80:80", "443:443"]],
    [["80:80", "443:443", "127.0.0.1:9180:9180", "8080:8080"]],
  ])("A2: rejects published ports %j (api only on 127.0.0.1)", (ports) => {
    expect(() => proxyCreate({ image: IMAGE, publishedPorts: ports })).toThrow(RangeError);
  });
  it.each([
    { name: "pebble;id", ip: "172.18.0.5" },
    { name: "pebble", ip: "127.0.0.1" },
    { name: "pebble", ip: "1.2.3.4 --privileged" },
    { name: "-x", ip: "172.18.0.5" },
  ])("rejects extra host %j", (host) => {
    expect(() =>
      proxyCreate({ image: IMAGE, publishedPorts: PROXY_PUBLISHED_PORTS, extraHosts: [host] }),
    ).toThrow(RangeError);
  });
});

describe("docker.network_connect / network_disconnect for the proxy", () => {
  it("connects and disconnects noodara-traefik to the service network, never --force", () => {
    const c = proxyNetworkConnect(serviceId);
    expect(c.name).toBe("docker.network_connect");
    expect(c.argv.slice(4)).toEqual(["docker", "network", "connect", "--", `noodara-net-${SERVICE}`, "noodara-traefik"]);
    const d = proxyNetworkDisconnect(serviceId);
    expect(d.name).toBe("docker.network_disconnect");
    expect(d.argv.slice(4)).toEqual(["docker", "network", "disconnect", "--", `noodara-net-${SERVICE}`, "noodara-traefik"]);
    expect(() => proxyNetworkDisconnect("x;id" as ResourceId)).toThrow();
  });
});

describe("proxy.status (A1)", () => {
  it("asks the loopback API for <router>@file over /dev/tcp with a capped read", () => {
    const cmd = proxyRouterStatus("noodara-a-b-web");
    expect(cmd.name).toBe("proxy.status");
    const { script, args, cap } = wrapped(cmd);
    expect(args).toEqual(["noodara-a-b-web"]);
    expect(script).toContain("/dev/tcp/127.0.0.1/9180");
    expect(script).toContain("/api/http/routers/%s@file");
    expect(cap).toBeLessThanOrEqual(16_384);
  });
  it.each(["", "Noodara", "a/b", "a@file", "a b", "a;id", "-a", "x".repeat(300)])(
    "A2: rejects router name %j",
    (name) => {
      expect(() => proxyRouterStatus(name)).toThrow(RangeError);
    },
  );
  const http = (status: string, body: string): string =>
    `HTTP/1.0 ${status}\r\nContent-Type: application/json\r\n\r\n${body}`;
  it("parses present, missing, down and error", () => {
    expect(
      parseProxyRouterStatus(
        http("200 OK", JSON.stringify({ status: "enabled", rule: "Host(`a.example.com`)", service: "noodara-x", name: "r@file" })),
      ),
    ).toEqual({ kind: "present", status: "enabled", rule: "Host(`a.example.com`)", service: "noodara-x" });
    expect(parseProxyRouterStatus(http("404 Not Found", "404 page not found\n"))).toEqual({ kind: "missing" });
    expect(parseProxyRouterStatus("NOODARA_PROXY_API down\n")).toEqual({ kind: "down" });
    expect(parseProxyRouterStatus(http("500 Internal Server Error", ""))).toEqual({ kind: "error" });
    expect(parseProxyRouterStatus(http("200 OK", "{not json"))).toEqual({ kind: "error" });
    expect(parseProxyRouterStatus("")).toEqual({ kind: "error" });
    expect(parseProxyRouterStatus(http("200 OK", JSON.stringify({ status: 1 })))).toEqual({ kind: "error" });
  });
});

// H4: real `ss -Hltnp sport = :80 or sport = :443` and `docker port noodara-traefik` shapes.
const SS_2204_PROXY = [
  'S LISTEN 0      4096         0.0.0.0:80        0.0.0.0:*    users:(("docker-proxy",pid=2310,fd=4))',
  'S LISTEN 0      4096         0.0.0.0:443       0.0.0.0:*    users:(("docker-proxy",pid=2331,fd=4))',
  'S LISTEN 0      4096            [::]:80           [::]:*    users:(("docker-proxy",pid=2317,fd=4))',
  'S LISTEN 0      4096            [::]:443          [::]:*    users:(("docker-proxy",pid=2338,fd=4))',
].join("\n");
const SS_2404_FOREIGN = [
  'S LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=812,fd=6),("nginx",pid=811,fd=6))',
  'S LISTEN 0      511             [::]:80           [::]:*    users:(("nginx",pid=812,fd=7),("nginx",pid=811,fd=7))',
].join("\n");
const SS_NO_PROCESS = "S LISTEN 0      4096         0.0.0.0:443        0.0.0.0:*";
const DOCKER_PORT = [
  "P 80/tcp -> 0.0.0.0:80",
  "P 80/tcp -> [::]:80",
  "P 443/tcp -> 0.0.0.0:443",
  "P 443/tcp -> [::]:443",
  "P 9180/tcp -> 127.0.0.1:9180",
].join("\n");

describe("proxy.ports_in_use (A1, H4)", () => {
  it("lists listeners on 80/443 and the proxy's own published ports", () => {
    const cmd = proxyPortsInUse();
    expect(cmd.name).toBe("proxy.ports_in_use");
    const { script, args } = wrapped(cmd);
    expect(args).toEqual([]);
    expect(script).toContain("ss -Hltnp");
    expect(script).toContain("docker port -- noodara-traefik");
  });
  it("22.04: docker-proxy listeners of a RUNNING noodara-traefik are ours, never reported", () => {
    expect(parsePortsInUse(`${SS_2204_PROXY}\n${DOCKER_PORT}\nNOODARA_PORTS done\n`)).toEqual({
      kind: "ok",
      foreign: [],
    });
  });
  it("24.04: nginx on :80 is foreign with its process name", () => {
    expect(parsePortsInUse(`${SS_2404_FOREIGN}\nNOODARA_PORTS done\n`)).toEqual({
      kind: "ok",
      foreign: [{ port: 80, process: "nginx" }],
    });
  });
  it("a foreign process stays foreign even when the proxy publishes that port", () => {
    expect(parsePortsInUse(`${SS_2404_FOREIGN}\n${DOCKER_PORT}\nNOODARA_PORTS done\n`)).toEqual({
      kind: "ok",
      foreign: [{ port: 80, process: "nginx" }],
    });
  });
  it("docker-proxy of another container (proxy not publishing) is foreign", () => {
    expect(parsePortsInUse(`${SS_2204_PROXY}\nNOODARA_PORTS done\n`)).toEqual({
      kind: "ok",
      foreign: [
        { port: 80, process: "docker-proxy" },
        { port: 443, process: "docker-proxy" },
      ],
    });
  });
  it("a listener without visible process is ours only when the proxy publishes it", () => {
    expect(parsePortsInUse(`${SS_NO_PROCESS}\n${DOCKER_PORT}\nNOODARA_PORTS done\n`)).toEqual({
      kind: "ok",
      foreign: [],
    });
    expect(parsePortsInUse(`${SS_NO_PROCESS}\nNOODARA_PORTS done\n`)).toEqual({
      kind: "ok",
      foreign: [{ port: 443, process: null }],
    });
  });
  it("tolerates lines without a State column and ignores other ports", () => {
    const out = 'S 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("x",pid=1,fd=3))\nS 0 4096 *:443 *:* users:(("caddy",pid=9,fd=3))\nNOODARA_PORTS done\n';
    expect(parsePortsInUse(out)).toEqual({ kind: "ok", foreign: [{ port: 443, process: "caddy" }] });
  });
  it("is unknown without ss or without the completion line", () => {
    expect(parsePortsInUse("NOODARA_PORTS no_ss\nNOODARA_PORTS done\n")).toEqual({ kind: "unknown" });
    expect(parsePortsInUse(SS_2404_FOREIGN)).toEqual({ kind: "unknown" });
  });
});

describe("tls.cert_status (A1, H2, H5)", () => {
  it("runs openssl s_client against 127.0.0.1:443 with SNI and stdin closed, capped at 512 bytes", () => {
    const cmd = proxyCertStatus("app.example.com");
    expect(cmd.name).toBe("tls.cert_status");
    const { script, args, cap } = wrapped(cmd);
    expect(args).toEqual(["app.example.com"]);
    expect(cap).toBe(PROXY_CERT_STATUS_MAX_BYTES);
    expect(PROXY_CERT_STATUS_MAX_BYTES).toBeLessThanOrEqual(512);
    expect(script).toContain('openssl s_client -connect 127.0.0.1:443 -servername "$1" </dev/null');
    expect(script).toContain("command -v openssl");
    expect(script).toContain("-nameopt RFC2253 -issuer");
    expect(script).toContain("-enddate");
    expect(script.match(/-connect/g)).toHaveLength(1);
  });
  it.each(["", "a b.example.com", "a.example.com;id", "-servername", "localhost", "1.2.3.4", "$(id).example.com"])(
    "A2: rejects hostname %j",
    (host) => {
      expect(() => proxyCertStatus(host)).toThrow(RangeError);
    },
  );
  it("parses an issued certificate with an epoch notAfter", () => {
    const status = parseTlsCertStatus(
      "NOODARA_CERT tls notAfter=1798761600 issuer=CN=Pebble Intermediate CA 1a2b3c\n",
    );
    expect(status).toEqual({
      kind: "tls",
      notAfter: new Date(1798761600 * 1000),
      issuer: "CN=Pebble Intermediate CA 1a2b3c",
      isDefault: false,
    });
    expect(certProbeFromTlsStatus(status)).toEqual({ kind: "issued", notAfter: new Date(1798761600 * 1000) });
  });
  it("H5: parses openssl's notAfter format (GMT, double-space day)", () => {
    const status = parseTlsCertStatus("NOODARA_CERT tls notAfter=Jan  5 10:04:03 2027 GMT issuer=CN=R11,O=Let's Encrypt,C=US");
    expect(status).toEqual({
      kind: "tls",
      notAfter: new Date(Date.UTC(2027, 0, 5, 10, 4, 3)),
      issuer: "CN=R11,O=Let's Encrypt,C=US",
      isDefault: false,
    });
    expect(parseTlsCertStatus("NOODARA_CERT tls notAfter=Dec 25 23:59:59 2026 GMT issuer=CN=X")).toMatchObject({
      notAfter: new Date(Date.UTC(2026, 11, 25, 23, 59, 59)),
    });
  });
  it("recognises the Traefik default certificate", () => {
    const status = parseTlsCertStatus("NOODARA_CERT tls notAfter=1798761600 issuer=CN=TRAEFIK DEFAULT CERT");
    expect(status).toMatchObject({ kind: "tls", isDefault: true });
    expect(certProbeFromTlsStatus(status)).toEqual({ kind: "default" });
  });
  it("down, unavailable and no_openssl map to a down probe", () => {
    for (const out of ["NOODARA_CERT down", "NOODARA_CERT unavailable", "NOODARA_CERT no_openssl"]) {
      const status = parseTlsCertStatus(out);
      expect(status.kind).toBe(out.split(" ")[1]);
      expect(certProbeFromTlsStatus(status)).toEqual({ kind: "down" });
    }
  });
  it.each([
    "",
    "garbage",
    "NOODARA_CERT tls notAfter=yesterday issuer=CN=X",
    "NOODARA_CERT tls notAfter=Foo  5 10:04:03 2027 GMT issuer=CN=X",
    "NOODARA_CERT tls notAfter=Feb 31 10:04:03 2027 GMT issuer=CN=X",
    "NOODARA_CERT tls notAfter=1798761600",
    "NOODARA_CERT tls notAfter=1798761600 issuer=",
    `NOODARA_CERT tls notAfter=1798761600 issuer=CN=X\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----`,
    "NOODARA_CERT tls notAfter=1798761600 issuer=CN=-----BEGIN PRIVATE KEY-----",
    `NOODARA_CERT tls notAfter=1798761600 issuer=CN=${"x".repeat(600)}`,
  ])("H2/H5: unparseable or unsafe output %j is unavailable, never a throw", (out) => {
    const status = parseTlsCertStatus(out);
    expect(status).toEqual({ kind: "unavailable" });
    expect(certProbeFromTlsStatus(status)).toEqual({ kind: "down" });
  });
  it("H2: the script never prints the PEM or s_client output", () => {
    const { script } = wrapped(proxyCertStatus("app.example.com"));
    const echoes = script.split("\n").filter((l) => /\b(echo|printf)\b/.test(l) && !l.includes("printf '%s\\n' \"$"));
    for (const line of echoes) {
      expect(line).not.toMatch(/"\$(out|pem)"/);
    }
  });
});

describe("rendered commands", () => {
  it("round-trip through renderRemoteCommand as single-quoted tokens", () => {
    const rendered = renderRemoteCommand(proxyCertStatus("app.example.com"));
    expect(rendered.startsWith("'env' '-i'")).toBe(true);
    expect(rendered.endsWith("'noodara-proxy' 'app.example.com'")).toBe(true);
  });
});
