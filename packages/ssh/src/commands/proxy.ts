// Reverse proxy and certificate templates (ADR 0011, 22-01). Scripts are constants; caller values
// travel only as validated positional arguments. Every script runs bounded (ADR 0011 H1):
// `env -i PATH=... LC_ALL=C timeout -k 1 <s> bash --noprofile --norc -c '{ ... } 2>&1 | head -c <cap>'`.
// Docker-only templates run as `timeout -k 1 <s> docker ...`.
import { createHash } from "node:crypto";
import {
  PROXY_API_PORT,
  PROXY_CONTAINER_NAME,
  PROXY_CONTAINER_PATHS,
  PROXY_LAYOUT,
  PROXY_PUBLISHED_PORTS,
  networkNameFor,
  validateHostname,
  validateImageRef,
  type CertProbe,
  type ResourceId,
} from "@noodara/domain";
import { validateContainerIp } from "./docker-deploy.js";
import { createRemoteCommand, type RemoteCommand } from "./remote-command.js";

const SCRIPT_PATH = "PATH=/usr/sbin:/usr/bin:/sbin:/bin";
const SCRIPT_ARGV0 = "noodara-proxy";
const STEP_TIMEOUT_SECONDS = 30;
const PROBE_TIMEOUT_SECONDS = 15;
const CREATE_TIMEOUT_SECONDS = 60;
const OUTPUT_MAX_BYTES = 4096;
/** Router JSON from Traefik's API (one router is well under 4 KiB). */
export const PROXY_STATUS_MAX_BYTES = 16_384;
/** H2: the probe's whole output. */
export const PROXY_CERT_STATUS_MAX_BYTES = 512;
/** Config files are small; anything larger is a bug, not a config. */
export const PROXY_FILE_MAX_BYTES = 1_048_576;
const MAX_ISSUER_LENGTH = 256;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DYNAMIC_PATH = new RegExp(`^/opt/noodara-proxy/dynamic/(${UUID}|noodara-api)\\.yml$`);
const SERVICE_DYNAMIC_PATH = new RegExp(`^/opt/noodara-proxy/dynamic/${UUID}\\.yml$`);
const ROUTER_NAME = /^[a-z0-9][a-z0-9-]{0,200}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TRAEFIK_IMAGE =
  /^(?:[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*traefik:([A-Za-z0-9_][A-Za-z0-9._-]{0,127})@sha256:[0-9a-f]{64}$/;
const EXTRA_HOST_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const CA_ROOT_FILE = "ca-root.pem";

const ROOT = PROXY_LAYOUT.root;
const API = `/dev/tcp/127.0.0.1/${String(PROXY_API_PORT)}`;

/** Shared head of the two stdin writers: temp file in the target's dir, verified, 0600. */
const WRITE_TEMP = [
  "target=$1",
  "dir=${target%/*}",
  "umask 077",
  "tmp=",
  "prev=",
  "trap 'rm -f -- ${tmp:+\"$tmp\"} ${prev:+\"$prev\"}' EXIT",
  "trap 'exit 5' HUP INT TERM PIPE",
  'tmp=$(mktemp "$dir/.noodara-XXXXXX") || exit 3',
  'cat > "$tmp" || exit 4',
  'size=$(stat -c %s -- "$tmp") || exit 3',
  'sum=$(sha256sum -- "$tmp") || exit 3',
  "sum=${sum%% *}",
  'if [ "$size" != "$2" ] || [ "$sum" != "$3" ]; then echo "NOODARA_PROXY_WRITE incomplete"; exit 4; fi',
  'chmod 0600 -- "$tmp" || exit 3',
];

export const PROXY_SCRIPTS = Object.freeze({
  /** 0700 dirs (root created once through sudo -n), 0600 for our files. */
  prepareDirs: [
    `root=${ROOT}`,
    'if [ ! -d "$root" ] || [ ! -O "$root" ]; then',
    '  sudo -n install -d -o "$(id -u)" -g "$(id -g)" -m 0700 -- "$root" || { echo "NOODARA_PROXY_DIRS sudo_failed"; exit 3; }',
    "fi",
    'chmod 0700 -- "$root" || exit 3',
    'install -d -m 0700 -- "$root/dynamic" "$root/ca" "$root/acme" || exit 3',
    'chmod 0700 -- "$root/dynamic" "$root/ca" "$root/acme" || exit 3',
    `for f in "$root/traefik.yml" "$root/ca/${CA_ROOT_FILE}" "$root"/dynamic/*.yml "$root"/dynamic/*.prev; do`,
    '  if [ -f "$f" ] && [ -O "$f" ]; then chmod 0600 -- "$f" || exit 3; fi',
    "done",
    'echo "NOODARA_PROXY_DIRS ready"',
  ].join("\n"),
  /** $1 target, $2 bytes, $3 sha256; content on stdin. */
  writeStatic: [
    ...WRITE_TEMP,
    'mv -f -- "$tmp" "$target" || exit 3',
    'echo "NOODARA_PROXY_WRITE ok"',
  ].join("\n"),
  /** H1: old or new, never partial; the replaced file is kept as `<target>.prev` (0600). */
  writeDynamic: [
    ...WRITE_TEMP,
    'if [ -f "$target" ]; then',
    '  prev=$(mktemp "$dir/.noodara-XXXXXX") || exit 3',
    '  { cp -- "$target" "$prev" && chmod 0600 -- "$prev" && mv -f -- "$prev" "$target.prev"; } || exit 3',
    "else",
    '  rm -f -- "$target.prev" || exit 3',
    "fi",
    'mv -f -- "$tmp" "$target" || exit 3',
    'echo "NOODARA_PROXY_WRITE ok"',
  ].join("\n"),
  /** Puts `.prev` back (kept, so a retry is idempotent); no `.prev` removes the file. */
  restoreDynamic: [
    "target=$1",
    "dir=${target%/*}",
    "umask 077",
    "tmp=",
    "trap 'rm -f -- ${tmp:+\"$tmp\"}' EXIT",
    "trap 'exit 5' HUP INT TERM PIPE",
    'if [ -f "$target.prev" ]; then',
    '  tmp=$(mktemp "$dir/.noodara-XXXXXX") || exit 3',
    '  { cp -- "$target.prev" "$tmp" && chmod 0600 -- "$tmp" && mv -f -- "$tmp" "$target"; } || exit 3',
    '  echo "NOODARA_PROXY_RESTORE restored"',
    "else",
    '  rm -f -- "$target" || exit 3',
    '  echo "NOODARA_PROXY_RESTORE removed"',
    "fi",
  ].join("\n"),
  /** Whole proxy root (static, dynamic, CA, acme.json with cert keys); sudo -n for root-owned files. */
  removeFiles: [
    `root=${ROOT}`,
    'if [ -L "$root" ]; then echo "NOODARA_PROXY_PURGE refused"; exit 3; fi',
    'if [ ! -e "$root" ] && [ ! -L "$root" ]; then echo "NOODARA_PROXY_PURGE ok"; exit 0; fi',
    'rm -rf -- "$root" 2>/dev/null || sudo -n rm -rf -- "$root" 2>/dev/null || { echo "NOODARA_PROXY_PURGE failed"; exit 3; }',
    'echo "NOODARA_PROXY_PURGE ok"',
  ].join("\n"),
  removeDynamic: ['rm -f -- "$1" "$1.prev" || exit 3', 'echo "NOODARA_PROXY_REMOVE ok"'].join("\n"),
  /** 22-05 H2: the backend port of a service file (one line; never the file itself). */
  readDynamic: [
    '[ -f "$1" ] || { echo "NOODARA_PROXY_READ absent"; exit 0; }',
    `port=$(head -c ${String(PROXY_FILE_MAX_BYTES)} -- "$1" | sed -n 's/.*"url":"http:\\/\\/noodara-[0-9a-f-]\\{36\\}:\\([0-9]\\{1,5\\}\\)".*/\\1/p' | head -n 1) || port=`,
    '[ -n "$port" ] || { echo "NOODARA_PROXY_READ unknown"; exit 0; }',
    'echo "NOODARA_PROXY_READ port=$port"',
  ].join("\n"),
  /** $1 router name (without `@file`). Raw HTTP/1.0 response, capped. */
  routerStatus: [
    `{ exec 3<>${API}; } 2>/dev/null || { echo "NOODARA_PROXY_API down"; exit 0; }`,
    "printf 'GET /api/http/routers/%s@file HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\nUser-Agent: noodara-proxy/1\\r\\nConnection: close\\r\\n\\r\\n' \"$1\" >&3 2>/dev/null || { echo \"NOODARA_PROXY_API starting\"; exit 0; }",
    // 22-07 A7: the socket opened but nothing answered: docker-proxy accepts while Traefik is
    // still starting, then resets. That is "starting" (keep polling), never "down" or a failure.
    `resp=$(head -c ${String(PROXY_STATUS_MAX_BYTES - 64)} <&3 2>/dev/null) || resp=`,
    '[ -n "$resp" ] || { echo "NOODARA_PROXY_API starting"; exit 0; }',
    "printf '%s\\n' \"$resp\"",
  ].join("\n"),
  /** `S <ss line>` per listener on 80/443, `P <docker port line>` per proxy binding. */
  portsInUse: [
    "if command -v ss >/dev/null 2>&1; then",
    "  out=$(sudo -n ss -Hltnp sport = :80 or sport = :443 2>/dev/null) || out=$(ss -Hltnp sport = :80 or sport = :443 2>/dev/null) || out=",
    "  if [ -n \"$out\" ]; then printf '%s\\n' \"$out\" | sed 's/^/S /'; fi",
    "else",
    '  echo "NOODARA_PORTS no_ss"',
    "fi",
    `docker port -- ${PROXY_CONTAINER_NAME} 2>/dev/null | sed 's/^/P /'`,
    'echo "NOODARA_PORTS done"',
  ].join("\n"),
  /** H2/H5: one line, issuer and notAfter only; stdin closed; loopback only. $1 = SNI. */
  certStatus: [
    'command -v openssl >/dev/null 2>&1 || { echo "NOODARA_CERT no_openssl"; exit 0; }',
    'out=$(openssl s_client -connect 127.0.0.1:443 -servername "$1" </dev/null 2>&1)',
    "pem=$(printf '%s\\n' \"$out\" | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/{p;/-----END CERTIFICATE-----/q;}')",
    'if [ -z "$pem" ]; then',
    "  case $out in",
    '    *"Connection refused"*|*"connect:errno"*) echo "NOODARA_CERT down" ;;',
    '    *) echo "NOODARA_CERT unavailable" ;;',
    "  esac",
    "  exit 0",
    "fi",
    "issuer=$(printf '%s\\n' \"$pem\" | openssl x509 -noout -nameopt RFC2253 -issuer 2>/dev/null) || { echo \"NOODARA_CERT unavailable\"; exit 0; }",
    "end=$(printf '%s\\n' \"$pem\" | openssl x509 -noout -enddate 2>/dev/null) || { echo \"NOODARA_CERT unavailable\"; exit 0; }",
    "issuer=${issuer#issuer=}",
    "end=${end#notAfter=}",
    'epoch=$(date -u -d "$end" +%s 2>/dev/null) || epoch=$end',
    `printf 'NOODARA_CERT tls notAfter=%s issuer=%s\\n' "$epoch" "\${issuer:0:${String(MAX_ISSUER_LENGTH)}}"`,
  ].join("\n"),
});

function script(
  name: RemoteCommand["name"],
  body: string,
  options: {
    readonly seconds?: number;
    readonly cap?: number;
    readonly args?: readonly string[];
    readonly stdin?: boolean;
  } = {},
): RemoteCommand {
  const cap = options.cap ?? OUTPUT_MAX_BYTES;
  return createRemoteCommand({
    name,
    argv: [
      "env",
      "-i",
      SCRIPT_PATH,
      "LC_ALL=C",
      "timeout",
      "-k",
      "1",
      String(options.seconds ?? STEP_TIMEOUT_SECONDS),
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      `set -o pipefail\n{\n${body}\n} 2>&1 | head -c ${String(cap)}`,
      SCRIPT_ARGV0,
      ...(options.args ?? []),
    ],
    stdin: options.stdin === true ? "secret" : "none",
    supervisable: false,
  });
}

function docker(name: RemoteCommand["name"], seconds: number, argv: readonly string[]): RemoteCommand {
  return createRemoteCommand({
    name,
    argv: ["timeout", "-k", "1", String(seconds), "docker", ...argv],
    stdin: "none",
    supervisable: false,
  });
}

export interface ProxyFileDigest {
  readonly bytes: number;
  readonly sha256: string;
}

/** What the host checks before the rename (H1): an interrupted write never replaces a file. */
export function proxyFileDigest(content: string): ProxyFileDigest {
  const buffer = Buffer.from(content, "utf8");
  return { bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function digestArgs(digest: ProxyFileDigest): [string, string] {
  if (
    !Number.isInteger(digest.bytes) ||
    digest.bytes < 0 ||
    digest.bytes > PROXY_FILE_MAX_BYTES ||
    typeof digest.sha256 !== "string" ||
    !SHA256.test(digest.sha256)
  ) {
    throw new RangeError("proxy write needs a valid size and sha256 digest");
  }
  return [String(digest.bytes), digest.sha256];
}

function dynamicPath(path: string, pattern: RegExp = DYNAMIC_PATH): string {
  if (typeof path !== "string" || !pattern.test(path)) {
    throw new RangeError("proxy dynamic path must be /opt/noodara-proxy/dynamic/<serviceId>.yml");
  }
  return path;
}

export function proxyPrepareDirs(): RemoteCommand {
  return script("proxy.prepare_dirs", PROXY_SCRIPTS.prepareDirs);
}

/** Removes everything under /opt/noodara-proxy; succeeds when it is already gone. */
export function proxyRemoveFiles(): RemoteCommand {
  return script("proxy.remove_files", PROXY_SCRIPTS.removeFiles);
}

export type ProxyStaticTarget = "traefik" | "ca_root";

const STATIC_TARGETS: Readonly<Record<ProxyStaticTarget, string>> = Object.freeze({
  traefik: PROXY_LAYOUT.staticConfigFile,
  ca_root: `${PROXY_LAYOUT.caDir}/${CA_ROOT_FILE}`,
});

/** The content goes to stdin; `ca_root` is the ACME test seam only. */
export function proxyWriteStatic(input: {
  readonly target: ProxyStaticTarget;
  readonly digest: ProxyFileDigest;
}): RemoteCommand {
  if (!Object.hasOwn(STATIC_TARGETS, input.target)) {
    throw new RangeError("proxy static target must be traefik or ca_root");
  }
  return script("proxy.write_static", PROXY_SCRIPTS.writeStatic, {
    args: [STATIC_TARGETS[input.target], ...digestArgs(input.digest)],
    stdin: true,
  });
}

/** `path`: proxyDynamicPathFor(serviceId) or PROXY_LAYOUT.apiRouterFile. */
export function proxyWriteDynamic(input: {
  readonly path: string;
  readonly digest: ProxyFileDigest;
}): RemoteCommand {
  return script("proxy.write_dynamic", PROXY_SCRIPTS.writeDynamic, {
    args: [dynamicPath(input.path), ...digestArgs(input.digest)],
    stdin: true,
  });
}

export function proxyRestoreDynamic(path: string): RemoteCommand {
  return script("proxy.restore_dynamic", PROXY_SCRIPTS.restoreDynamic, { args: [dynamicPath(path)] });
}

/** Service files only: the API router file is never removed. */
export function proxyRemoveDynamic(path: string): RemoteCommand {
  return script("proxy.remove_dynamic", PROXY_SCRIPTS.removeDynamic, {
    args: [dynamicPath(path, SERVICE_DYNAMIC_PATH)],
  });
}

/**
 * 22-05 H2: the port the live file routes to. Read-only; 22-07 A7: its own allowlisted name, so
 * every allowlisted name maps to exactly one script body. Service files only.
 */
export function proxyReadDynamic(path: string): RemoteCommand {
  return script("proxy.read_dynamic", PROXY_SCRIPTS.readDynamic, {
    seconds: PROBE_TIMEOUT_SECONDS,
    cap: 128,
    args: [dynamicPath(path, SERVICE_DYNAMIC_PATH)],
  });
}

export type ProxyDynamicPort =
  | { readonly kind: "port"; readonly port: number }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

export function parseProxyDynamicPort(stdout: string): ProxyDynamicPort {
  const line = stdout.trim();
  if (line === "NOODARA_PROXY_READ absent") return { kind: "absent" };
  const match = /^NOODARA_PROXY_READ port=(\d{1,5})$/.exec(line);
  const port = match === null ? NaN : Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { kind: "port", port } : { kind: "unknown" };
}

export interface ProxyExtraHost {
  readonly name: string;
  readonly ip: string;
}

function samePorts(ports: readonly string[]): boolean {
  return (
    Array.isArray(ports) &&
    ports.length === PROXY_PUBLISHED_PORTS.length &&
    ports.every((port, index) => port === PROXY_PUBLISHED_PORTS[index])
  );
}

/**
 * `docker create` of noodara-traefik (the caller pulls first, then starts it). `caRoot` and
 * `extraHosts` are the ACME test seam (Pebble). H3: `--restart unless-stopped`.
 */
export function proxyCreate(input: {
  readonly image: string;
  readonly publishedPorts: readonly string[];
  readonly caRoot?: boolean;
  readonly extraHosts?: readonly ProxyExtraHost[];
}): RemoteCommand {
  const tag = TRAEFIK_IMAGE.exec(typeof input.image === "string" ? input.image : "");
  if (tag === null || tag[1] === "latest" || !validateImageRef(input.image).ok) {
    throw new RangeError("proxy image must be a tagged, digest-pinned traefik image");
  }
  if (!samePorts(input.publishedPorts)) {
    throw new RangeError("proxy ports must be 80, 443 and the API on 127.0.0.1 only");
  }
  const hosts = (input.extraHosts ?? []).flatMap((host) => {
    const ip = validateContainerIp(host.ip);
    if (typeof host.name !== "string" || host.name.length > 253 || !EXTRA_HOST_NAME.test(host.name) || !ip.ok) {
      throw new RangeError("proxy extra host needs a plain hostname and a unicast IPv4 address");
    }
    return ["--add-host", `${host.name}:${ip.value}`];
  });
  const bind = (src: string, dst: string, readonly: boolean): string[] => [
    "--mount",
    `type=bind,src=${src},dst=${dst}${readonly ? ",readonly" : ""}`,
  ];
  const caArgs =
    input.caRoot === true
      ? [
          ...bind(PROXY_LAYOUT.caDir, PROXY_CONTAINER_PATHS.caDir, true),
          "--env",
          `LEGO_CA_CERTIFICATES=${PROXY_CONTAINER_PATHS.caDir}/${CA_ROOT_FILE}`,
        ]
      : [];
  return docker("proxy.create", CREATE_TIMEOUT_SECONDS, [
    "create",
    "--name",
    PROXY_CONTAINER_NAME,
    "--pull",
    "never",
    "--restart",
    "unless-stopped",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=3",
    "--label",
    "noodara.managed=true",
    "--label",
    "noodara.proxy=true",
    ...PROXY_PUBLISHED_PORTS.flatMap((port) => ["--publish", port]),
    ...bind(PROXY_LAYOUT.staticConfigFile, PROXY_CONTAINER_PATHS.staticConfigFile, true),
    ...bind(PROXY_LAYOUT.dynamicDir, PROXY_CONTAINER_PATHS.dynamicDir, true),
    ...bind(PROXY_LAYOUT.acmeDir, PROXY_CONTAINER_PATHS.acmeDir, false),
    ...caArgs,
    ...hosts,
    "--",
    input.image,
  ]);
}

function proxyNetwork(serviceId: ResourceId): string {
  const network = networkNameFor(serviceId);
  if (!network.ok) throw new RangeError("proxy network needs a valid service id");
  return network.value;
}

/** The proxy joins `noodara-net-<serviceId>` to reach the service by name. */
export function proxyNetworkConnect(serviceId: ResourceId): RemoteCommand {
  return docker("docker.network_connect", STEP_TIMEOUT_SECONDS, [
    "network",
    "connect",
    "--",
    proxyNetwork(serviceId),
    PROXY_CONTAINER_NAME,
  ]);
}

/** Never `--force`. */
export function proxyNetworkDisconnect(serviceId: ResourceId): RemoteCommand {
  return docker("docker.network_disconnect", STEP_TIMEOUT_SECONDS, [
    "network",
    "disconnect",
    "--",
    proxyNetwork(serviceId),
    PROXY_CONTAINER_NAME,
  ]);
}

export function proxyRouterStatus(router: string): RemoteCommand {
  if (typeof router !== "string" || !ROUTER_NAME.test(router)) {
    throw new RangeError("proxy router name must be lowercase letters, digits and dashes");
  }
  return script("proxy.status", PROXY_SCRIPTS.routerStatus, {
    seconds: PROBE_TIMEOUT_SECONDS,
    cap: PROXY_STATUS_MAX_BYTES,
    args: [router],
  });
}

export type ProxyRouterStatus =
  | { readonly kind: "present"; readonly status: string; readonly rule: string; readonly service: string }
  | { readonly kind: "missing" }
  | { readonly kind: "starting" }
  | { readonly kind: "down" }
  | { readonly kind: "error" };

/** `down`: nothing listens on the API port; `starting`: it accepts but has not answered yet. */
export function parseProxyRouterStatus(stdout: string): ProxyRouterStatus {
  const marker = stdout.trim();
  if (marker === "NOODARA_PROXY_API down") return { kind: "down" };
  if (marker === "NOODARA_PROXY_API starting") return { kind: "starting" };
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(stdout);
  if (status === null) return { kind: "error" };
  if (status[1] === "404") return { kind: "missing" };
  if (status[1] !== "200") return { kind: "error" };
  const split = stdout.indexOf("\r\n\r\n");
  if (split < 0) return { kind: "error" };
  try {
    const body: unknown = JSON.parse(stdout.slice(split + 4));
    if (typeof body !== "object" || body === null) return { kind: "error" };
    const record = body as Record<string, unknown>;
    const { status: state, rule, service } = record;
    if (typeof state !== "string" || typeof rule !== "string" || typeof service !== "string") {
      return { kind: "error" };
    }
    return { kind: "present", status: state, rule, service };
  } catch {
    return { kind: "error" };
  }
}

export function proxyPortsInUse(): RemoteCommand {
  return script("proxy.ports_in_use", PROXY_SCRIPTS.portsInUse, { seconds: PROBE_TIMEOUT_SECONDS });
}

export interface ForeignListener {
  readonly port: 80 | 443;
  /** The first process name ss shows; null when it is not visible (no privileges). */
  readonly process: string | null;
}

export type PortsInUse =
  | { readonly kind: "ok"; readonly foreign: readonly ForeignListener[] }
  | { readonly kind: "unknown" };

/**
 * H4: a listener is the proxy's own when noodara-traefik publishes that host port and the socket
 * belongs to docker-proxy (or no process is visible). Anything else on 80/443 is foreign.
 */
export function parsePortsInUse(stdout: string): PortsInUse {
  const lines = stdout.split("\n");
  if (!lines.includes("NOODARA_PORTS done") || lines.includes("NOODARA_PORTS no_ss")) {
    return { kind: "unknown" };
  }
  const published = new Set<number>();
  for (const line of lines) {
    if (!line.startsWith("P ")) continue;
    const port = /:(\d+)$/.exec(line.trim());
    if (port !== null) published.add(Number(port[1]));
  }
  const foreign = new Map<80 | 443, ForeignListener>();
  for (const line of lines) {
    if (!line.startsWith("S ")) continue;
    const local = line
      .slice(2)
      .trim()
      .split(/\s+/)
      .map((token) => /:(\d+)$/.exec(token))
      .find((match) => match !== null);
    const port = Number(local?.[1]);
    if (port !== 80 && port !== 443) continue;
    const processes = [...line.matchAll(/\("([^"]*)",pid=\d+/g)].map((match) => match[1] ?? "");
    const ours =
      published.has(port) && processes.every((name) => name === "docker-proxy");
    if (!ours && !foreign.has(port)) foreign.set(port, { port, process: processes[0] ?? null });
  }
  return { kind: "ok", foreign: [...foreign.values()].sort((a, b) => a.port - b.port) };
}

export function proxyCertStatus(hostname: string): RemoteCommand {
  const host = validateHostname(hostname);
  if (!host.ok) throw new RangeError("tls.cert_status needs a valid hostname");
  return script("tls.cert_status", PROXY_SCRIPTS.certStatus, {
    seconds: PROBE_TIMEOUT_SECONDS,
    cap: PROXY_CERT_STATUS_MAX_BYTES,
    args: [host.value],
  });
}

export type TlsCertStatus =
  | { readonly kind: "tls"; readonly notAfter: Date; readonly issuer: string; readonly isDefault: boolean }
  | { readonly kind: "down" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "no_openssl" };

export const TRAEFIK_DEFAULT_CERT_ISSUER = "CN=TRAEFIK DEFAULT CERT";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OPENSSL_DATE = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) GMT$/;

function parseNotAfter(text: string): Date | null {
  if (/^\d{1,12}$/.test(text)) return new Date(Number(text) * 1000);
  const match = OPENSSL_DATE.exec(text);
  if (match === null) return null;
  const month = MONTHS.indexOf(match[1] ?? "");
  const [day, hour, minute, second, year] = match.slice(2).map(Number) as [number, number, number, number, number];
  if (month < 0 || hour > 23 || minute > 59 || second > 60) return null;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  return date.getUTCDate() === day && date.getUTCMonth() === month ? date : null;
}

/** Never throws: anything unexpected (or key/cert material) is `unavailable`. */
export function parseTlsCertStatus(stdout: string): TlsCertStatus {
  const unavailable: TlsCertStatus = { kind: "unavailable" };
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") > PROXY_CERT_STATUS_MAX_BYTES ||
    stdout.includes("-----BEGIN") ||
    stdout.includes("PRIVATE KEY")
  ) {
    return unavailable;
  }
  const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (line.includes("\n") || line.includes("\r")) return unavailable;
  if (line === "NOODARA_CERT down") return { kind: "down" };
  if (line === "NOODARA_CERT no_openssl") return { kind: "no_openssl" };
  const match = /^NOODARA_CERT tls notAfter=(.+?) issuer=(.+)$/.exec(line);
  if (match === null) return unavailable;
  const notAfter = parseNotAfter(match[1] ?? "");
  const issuer = match[2] ?? "";
  if (notAfter === null || !Number.isFinite(notAfter.getTime()) || issuer.length > MAX_ISSUER_LENGTH) {
    return unavailable;
  }
  return { kind: "tls", notAfter, issuer, isDefault: issuer === TRAEFIK_DEFAULT_CERT_ISSUER };
}

export function certProbeFromTlsStatus(status: TlsCertStatus): CertProbe {
  if (status.kind !== "tls") return { kind: "down" };
  if (status.isDefault) return { kind: "default" };
  return { kind: "issued", notAfter: status.notAfter };
}
