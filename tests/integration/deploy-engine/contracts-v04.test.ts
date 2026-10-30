// v0.4 empirical contracts (21-01, ADR 0011). Permanent: every assertion is what was measured
// against the real sshd + dockerd fixture on Ubuntu 22.04 and 24.04 and fails if a new Traefik,
// Docker, OpenSSL or Ubuntu changes it. Raw ssh2 as deployer, never the adapter and never a mock.
//   - PROXY (A1, H2, H4): digest-pinned Traefik v3 with the file provider only, on host 80/443,
//     API on host 127.0.0.1; dynamic files written temp + rename; -prev swap; broken files;
//     non-cacheable redirect.
//   - ACME (A2): HTTP-01 against Pebble (the only CA a fixture may name, H3), short validity,
//     observed renewal, retry after a DNS fix.
//   - CERT (A3): openssl s_client probe reduced to one line (issuer + notAfter).
//   - ENV (A4): docker create --env-file semantics and exposure.
//   - BOUNDED (H1): every remote command is `env -i ... timeout ... | head -c <cap>`.
// Remote scripts are constant strings; variable parts travel as single-quoted arguments.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@noodara/ssh/testing';
import type { ClientChannel } from '@noodara/ssh/testing';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import {
  PEBBLE_ACME_DIRECTORY_URL,
  TRAEFIK_IMAGE,
  assertAllowlistedImage,
  startPebble,
  type StartedPebble,
} from '../helpers/pebble.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const STACK_TIMEOUT_MS = 900_000;
const SSH_COMMAND_TIMEOUT_MS = 330_000;
const SERVER_PORT = 8080;
const PROXY_DIR = '/opt/noodara-proxy';
const PROXY_CONTAINER = 'noodara-proxy';
const API_PORT = 9180;
const RESOLVER = 'noodara';
const CERT_VALIDITY_SECONDS = 300;
const OUTPUT_CAP = 65_536;
const DEFAULT_CERT_ISSUER = 'CN=TRAEFIK DEFAULT CERT';

// --- Raw ssh2 plumbing ------------------------------------------------------------------------

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly ms: number;
}

function connect(stack: DeployEngineStack): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => {
      resolve(client);
    });
    client.once('error', reject);
    client.connect({
      host: stack.ssh.host,
      port: stack.ssh.port,
      username: stack.ssh.user,
      privateKey: stack.ssh.privateKey,
      readyTimeout: 20_000,
    });
  });
}

function run(client: Client, command: string): Promise<RunResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    client.exec(command, (err: Error | undefined, channel: ClientChannel) => {
      if (err !== undefined) {
        reject(err);
        return;
      }
      let stdout = '';
      let exitCode: number | null = null;
      const timer = setTimeout(() => {
        channel.destroy();
        reject(new Error(`ssh exec timed out after ${String(SSH_COMMAND_TIMEOUT_MS)}ms`));
      }, SSH_COMMAND_TIMEOUT_MS);
      timer.unref();
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      channel.on('exit', (code: number | null) => {
        exitCode = code;
      });
      channel.on('close', () => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, ms: Date.now() - startedAt });
      });
      channel.end();
    });
  });
}

/** POSIX single-quote for the remote shell. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function argv(...parts: readonly string[]): string {
  return parts.map(q).join(' ');
}

/** Bash source with `@{` standing for `${` (keeps TS template syntax out of the scripts). */
function bash(strings: TemplateStringsArray, ...values: readonly string[]): string {
  return strings.raw
    .reduce((acc, part, index) => acc + part + (values[index] ?? ''), '')
    .replaceAll('@{', '${');
}

/**
 * Shared shell functions. hit/redir use curl, which the fixture installs (stock Ubuntu does not);
 * they are test-side measurements only. The certificate probe (`cert`) is the one ADR 0011
 * hands to 22-xx: openssl s_client to 127.0.0.1:443 with the domain as SNI, reduced to one line.
 */
const PRELUDE = bash`NOODARA_DYN=${PROXY_DIR}/dynamic
now_ms() { date +%s%3N; }
hit() {
  local r body
  r=$(curl -s --max-time 2 -H "Host: $1" -w '|%{http_code}' "http://127.0.0.1@{2:-/health}" 2>/dev/null)
  body=@{r%|*}; body=@{body%%$'\n'*}
  printf '%s %s\n' "@{r##*|}" "@{body:0:40}"
}
redir() {
  local how=()
  case $1 in HEAD) how=(--head) ;; POST) how=(--data '') ;; esac
  curl -s -o /dev/null --max-time 2 "@{how[@]}" -H "Host: $2" -w '%{http_code} %{redirect_url}\n' http://127.0.0.1/health 2>/dev/null
}
run_target() {
  docker run --detach --pull never --name "$1" --network "$2" --restart unless-stopped \
    --label noodara.managed=true --label "noodara.service_id=$3" --env "BODY_CANARY=$4" -- "$5" node -e "$6" >/dev/null
}
wait_for() {
  local limit=$1 want=$2 t0 r; shift 2; t0=$(now_ms)
  while :; do
    r=$("$@")
    case $r in $want) echo "$(( $(now_ms) - t0 ))"; return 0 ;; esac
    if [ $(( $(now_ms) - t0 )) -ge "$limit" ]; then echo "timeout:$r"; return 0; fi
    sleep 0.05
  done
}
write_dyn() {
  local tmp; tmp=$(mktemp "$NOODARA_DYN/.noodara-XXXXXX") || return 1
  printf '%s' "$2" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$NOODARA_DYN/$1"
}
api_routers() {
  curl -s --max-time 3 http://127.0.0.1:${String(API_PORT)}/api/http/routers 2>/dev/null | grep -o '"name":"[^"]*"' | sed 's/"name":"\(.*\)"/\1/' | sort -u
}
cert() {
  local out pem issuer end
  out=$(openssl s_client -connect 127.0.0.1:443 -servername "$1" </dev/null 2>&1)
  pem=$(printf '%s\n' "$out" | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p')
  if [ -z "$pem" ]; then
    case $out in *"Connection refused"*|*"connect:errno"*) echo "NOODARA_CERT down" ;; *) echo "NOODARA_CERT unavailable" ;; esac
    return 0
  fi
  issuer=$(printf '%s\n' "$pem" | openssl x509 -noout -nameopt RFC2253 -issuer)
  end=$(printf '%s\n' "$pem" | openssl x509 -noout -enddate)
  echo "NOODARA_CERT tls notAfter=$(date -u -d "@{end#notAfter=}" +%s) issuer=@{issuer#issuer=}"
}
renewed() {
  local c n; c=$(cert "$1"); n=@{c#*notAfter=}; n=@{n%% *}
  if [ "$n" -gt "$2" ] 2>/dev/null; then echo "renewed $c"; else echo "same $c"; fi
}`;

/**
 * H1: the only way this file reaches the host. Empty environment (no session variable, proxy or
 * secret reaches the script), a hard wall-clock cap (124 on timeout) and an output cap (141 when
 * hit). `docker` inherits the same empty environment.
 */
function bounded(
  script: string,
  timeoutSeconds: number,
  args: readonly string[] = [],
  cap = OUTPUT_CAP,
): string {
  return argv(
    'env',
    '-i',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME=/home/deployer',
    'LC_ALL=C',
    'timeout',
    '-k',
    '1',
    String(timeoutSeconds),
    'bash',
    '--noprofile',
    '--norc',
    '-c',
    `set -o pipefail\n{\n${PRELUDE}\n${script}\n} 2>&1 | head -c ${String(cap)}`,
    'noodara-contract',
    ...args,
  );
}

/** `M key=value` lines of a script's output. */
function marks(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('M ')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(2, eq)] = line.slice(eq + 1);
  }
  return out;
}

function prefixed(stdout: string, prefix: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function ms(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`expected a measured delay, got '${String(value)}'`);
  }
  return Number(value);
}

function measure(tag: string, ubuntu: string, data: Record<string, unknown>): void {
  const line = `[V04-${tag}] ${JSON.stringify({ ubuntu, ...data })}`;
  console.log(line);
  const file = process.env['NOODARA_MEASUREMENTS_FILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${line}\n`);
}

// --- Configuration shapes ADR 0011 fixes --------------------------------------------------------

const STATIC_CONFIG = `# Managed by Noodara (ADR 0011). Static: a change needs a proxy restart.
global:
  checkNewVersion: false
  sendAnonymousUsage: false
log:
  level: INFO
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
  traefik:
    address: ":${String(API_PORT)}"
api:
  insecure: true
  dashboard: false
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
certificatesResolvers:
  ${RESOLVER}:
    acme:
      storage: /etc/traefik/acme/acme.json
      caServer: ${PEBBLE_ACME_DIRECTORY_URL}
      certificatesDuration: 1
      httpChallenge:
        entryPoint: web
`;

interface Route {
  readonly domainId: string;
  readonly host: string;
  readonly redirect: boolean;
  readonly tls: 'default' | 'acme';
}

/** One file per service: `<serviceId>.yml`; names are derived from ids only. */
function dynamicConfig(serviceId: string, upstream: string, routes: readonly Route[]): string {
  const service = `noodara-${serviceId}`;
  const lines = ['# Managed by Noodara (ADR 0011). Do not edit.', 'http:', '  routers:'];
  for (const route of routes) {
    const base = `noodara-${serviceId}-${route.domainId}`;
    lines.push(
      `    ${base}-web:`,
      '      entryPoints: [web]',
      `      rule: "Host(\`${route.host}\`)"`,
      `      service: ${service}`,
    );
    if (route.redirect) lines.push(`      middlewares: [${base}-redirect]`);
    lines.push(
      `    ${base}-websecure:`,
      '      entryPoints: [websecure]',
      `      rule: "Host(\`${route.host}\`)"`,
      `      service: ${service}`,
      route.tls === 'acme' ? `      tls: { certResolver: ${RESOLVER} }` : '      tls: {}',
    );
  }
  const redirects = routes.filter((route) => route.redirect);
  if (redirects.length > 0) {
    lines.push('  middlewares:');
    for (const route of redirects) {
      lines.push(
        `    noodara-${serviceId}-${route.domainId}-redirect:`,
        '      redirectScheme: { scheme: https, permanent: false }',
      );
    }
  }
  lines.push(
    '  services:',
    `    ${service}:`,
    '      loadBalancer:',
    '        servers:',
    `          - url: ${upstream}`,
    '',
  );
  return lines.join('\n');
}

const TARGET_SERVER_JS = `
const http = require('http');
const canary = process.env.BODY_CANARY || '';
process.on('SIGTERM', () => process.exit(0));
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok ' + canary + '\\n');
}).listen(${String(SERVER_PORT)}, '0.0.0.0');
`;

/** Prints `open` or the error code when a service container dials the proxy's API port. */
const DIAL_FROM_SERVICE_JS = `const s = require('net').connect(${String(API_PORT)}, process.argv[1]);
s.setTimeout(2000);
s.on('connect', () => { console.log('open'); s.destroy(); });
s.on('error', (e) => console.log(e.code));
s.on('timeout', () => { console.log('timeout'); s.destroy(); });`;

// --- Contracts ---------------------------------------------------------------------------------

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('ADR 0011 contracts on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let pebble: StartedPebble | undefined;
  let client: Client | undefined;
  let nodeImage = '';
  let hostIp = '';
  const serviceId = randomUUID();
  const container = `noodara-${serviceId}`;
  const network = `noodara-net-${serviceId}`;
  const upstream = `http://${container}:${String(SERVER_PORT)}`;
  const label = (): string => randomUUID().slice(0, 8);
  const hostA = `a${label()}.contracts.noodara.test`;
  const hostRetry = `r${label()}.contracts.noodara.test`;
  const hostOther = `o${label()}.contracts.noodara.test`;
  const domainA = randomUUID();
  const serviceFile = `${serviceId}.yml`;

  const sh = async (
    script: string,
    timeoutSeconds: number,
    args: readonly string[] = [],
    cap?: number,
  ): Promise<RunResult> => {
    if (client === undefined) throw new Error('client not connected');
    return run(client, bounded(script, timeoutSeconds, args, cap));
  };

  const must = async (
    script: string,
    timeoutSeconds: number,
    args: readonly string[] = [],
  ): Promise<string> => {
    const result = await sh(script, timeoutSeconds, args);
    if (result.exitCode !== 0) {
      throw new Error(
        `exit ${String(result.exitCode)}: ${script.slice(0, 80)}: ${result.stdout.slice(-600)}`,
      );
    }
    return result.stdout;
  };

  const routeA = (overrides: Partial<Route> = {}): Route => ({
    domainId: domainA,
    host: hostA,
    redirect: false,
    tls: 'default',
    ...overrides,
  });

  beforeAll(async () => {
    stack = await startDeployEngineStack({ ubuntu });
    pebble = await startPebble({
      networkName: stack.networkName,
      validitySeconds: CERT_VALIDITY_SECONDS,
    });
    client = await connect(stack);
    const node = stack.baseImages.find((ref) => ref.startsWith('node:'));
    if (node === undefined) throw new Error('no node base image preloaded');
    nodeImage = node;
    hostIp = (
      await must(String.raw`ip -4 -o addr show dev eth0 | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p'`, 10)
    ).trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostIp)) throw new Error(`no host IP: ${hostIp}`);

    const pullStarted = Date.now();
    await must('docker pull --quiet "$1" >/dev/null', 300, [assertAllowlistedImage(TRAEFIK_IMAGE)]);
    const pullMs = Date.now() - pullStarted;

    const layout = await must(
      bash`sudo -n install -d -o "$(id -u)" -g "$(id -g)" -m 0755 ${PROXY_DIR}
install -d -m 0755 ${PROXY_DIR}/dynamic ${PROXY_DIR}/ca
install -d -m 0700 ${PROXY_DIR}/acme
printf '%s' "$1" > ${PROXY_DIR}/ca/pebble-root.pem
printf '%s' "$2" > ${PROXY_DIR}/traefik.yml
chmod 0644 ${PROXY_DIR}/ca/pebble-root.pem ${PROXY_DIR}/traefik.yml
stat -c 'L %a %U %n' ${PROXY_DIR} ${PROXY_DIR}/*`,
      20,
      [pebble.listenerRootPem, STATIC_CONFIG],
    );

    await must(
      'docker network create --label noodara.managed=true -- "$2" >/dev/null && run_target "$1" "$2" "$3" v1 "$4" "$5"',
      60,
      [container, network, serviceId, nodeImage, TARGET_SERVER_JS],
    );

    const startedAt = Date.now();
    const proxy = await must(
      bash`docker run --detach --pull never --name ${PROXY_CONTAINER} --restart unless-stopped \
  --label noodara.proxy=true \
  --publish 80:80 --publish 443:443 --publish 127.0.0.1:${String(API_PORT)}:${String(API_PORT)} \
  --mount type=bind,src=${PROXY_DIR}/traefik.yml,dst=/etc/traefik/traefik.yml,readonly \
  --mount type=bind,src=${PROXY_DIR}/dynamic,dst=/etc/traefik/dynamic,readonly \
  --mount type=bind,src=${PROXY_DIR}/acme,dst=/etc/traefik/acme \
  --mount type=bind,src=${PROXY_DIR}/ca,dst=/etc/traefik/ca,readonly \
  --env LEGO_CA_CERTIFICATES=/etc/traefik/ca/pebble-root.pem \
  --add-host "pebble:$2" -- "$1" >/dev/null
docker network connect -- "$3" ${PROXY_CONTAINER}
echo "M api_ready_ms=$(wait_for 30000 '200' curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${String(API_PORT)}/api/version)"`,
      60,
      [TRAEFIK_IMAGE, pebble.ip, network],
    );
    measure('PROXY', ubuntu, {
      case: 'setup',
      traefikPullMs: pullMs,
      proxyStartMs: Date.now() - startedAt,
      apiReadyMs: marks(proxy)['api_ready_ms'],
      layout: prefixed(layout, 'L '),
    });
    ms(marks(proxy)['api_ready_ms']);
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    client?.end();
    await pebble?.stop();
    await stack?.stop();
    await assertNoStrayTestContainers();
  }, STACK_TIMEOUT_MS);

  // --- A1: file provider, listeners, loopback API ------------------------------------------------

  it('PROXY / ADR 0011 / A1: a temp + rename dynamic file routes Host to noodara-<serviceId> by Docker DNS; 80/443 public, API only on 127.0.0.1', async () => {
    const out = await must(
      bash`write_dyn "$1" "$2"
echo "M loaded_ms=$(wait_for 30000 '200 ok v1' hit "$3")"
echo "M unknown_host=$(hit "$5")"
for t in "$4:80" "$4:443" "127.0.0.1:${String(API_PORT)}" "$4:${String(API_PORT)}"; do
  if ( exec 3<>"/dev/tcp/@{t%:*}/@{t##*:}" ) 2>/dev/null; then echo "M tcp_$t=open"; else echo "M tcp_$t=refused"; fi
done
api_routers | sed 's/^/R /'
ls -A "$NOODARA_DYN" | sed 's/^/F /'
pip=$(docker inspect --format "{{(index .NetworkSettings.Networks \"$7\").IPAddress}}" ${PROXY_CONTAINER})
echo "M from_service=$(docker exec "$6" node -e "$8" "$pip")"`,
      60,
      [
        serviceFile,
        dynamicConfig(serviceId, upstream, [routeA()]),
        hostA,
        hostIp,
        hostOther,
        container,
        network,
        DIAL_FROM_SERVICE_JS,
      ],
    );
    const m = marks(out);
    const routers = prefixed(out, 'R ');
    measure('PROXY', ubuntu, {
      case: 'first load',
      loadedMs: m['loaded_ms'],
      unknownHost: m['unknown_host'],
      tcp: Object.fromEntries(Object.entries(m).filter(([key]) => key.startsWith('tcp_'))),
      apiFromServiceNetwork: m['from_service'],
      routers,
    });
    expect(ms(m['loaded_ms'])).toBeLessThan(30_000);
    expect(m['unknown_host']).toMatch(/^404 /);
    expect(m[`tcp_${hostIp}:80`]).toBe('open');
    expect(m[`tcp_${hostIp}:443`]).toBe('open');
    expect(m[`tcp_127.0.0.1:${String(API_PORT)}`]).toBe('open');
    expect(m[`tcp_${hostIp}:${String(API_PORT)}`]).toBe('refused');
    expect(routers).toContain(`noodara-${serviceId}-${domainA}-web@file`);
    expect(routers).toContain(`noodara-${serviceId}-${domainA}-websecure@file`);
    // Only the renamed file is left: the temp name never lingers.
    expect(prefixed(out, 'F ')).toEqual([serviceFile]);
  });

  it('PROXY / ADR 0011 / A1: routing survives the ADR 0010 stop -> rename -prev -> start swap (window measured)', async () => {
    const out = await must(
      bash`log=$(mktemp)
( while :; do printf '%s %s\n' "$(now_ms)" "$(hit "$1")" >> "$log"; sleep 0.05; done ) &
poller=$!
sleep 1
echo "M t_stop=$(now_ms)"; docker stop --time 10 -- "$2" >/dev/null
echo "M t_rename=$(now_ms)"; docker rename "$2" "$2-prev"
echo "M t_run=$(now_ms)"
run_target "$2" "$3" "$6" v2 "$4" "$5"
echo "M t_started=$(now_ms)"
echo "M first_v2=$(wait_for 20000 '200 ok v2' hit "$1")"
sleep 1
kill "$poller"; wait "$poller" 2>/dev/null
sed 's/^/P /' "$log"; rm -f "$log"
docker rm --force -- "$2-prev" >/dev/null`,
      90,
      [hostA, container, network, nodeImage, TARGET_SERVER_JS, serviceId],
    );
    const m = marks(out);
    const samples = prefixed(out, 'P ').map((line) => {
      const [t, ...rest] = line.split(' ');
      return { t: Number(t), r: rest.join(' ') };
    });
    const tStop = ms(m['t_stop']);
    const firstV2 = samples.find((s) => s.r === '200 ok v2');
    const lastV1 = [...samples].reverse().find((s) => s.r === '200 ok v1');
    if (firstV2 === undefined || lastV1 === undefined) throw new Error(`no swap seen: ${out}`);
    const during = samples.filter((s) => s.t > lastV1.t && s.t < firstV2.t).map((s) => s.r);
    measure('PROXY', ubuntu, {
      case: '-prev swap',
      stopMs: ms(m['t_rename']) - tStop,
      renameMs: ms(m['t_run']) - ms(m['t_rename']),
      runMs: ms(m['t_started']) - ms(m['t_run']),
      lastV1AfterStopMs: lastV1.t - tStop,
      firstV2AfterStopMs: firstV2.t - tStop,
      windowMs: firstV2.t - lastV1.t,
      answersDuringWindow: [...new Set(during.map((r) => r.split(' ')[0]))],
      samples: samples.length,
    });
    expect(m['first_v2']).toMatch(/^\d+$/);
    // Once the new container answers, every later request reaches it (no stale DNS or keep-alive).
    expect(samples.filter((s) => s.t >= firstV2.t).every((s) => s.r === '200 ok v2')).toBe(true);
    expect(firstV2.t - lastV1.t).toBeLessThan(10_000);
    // The window answers 502 (no upstream) and nothing else: no 404, so the router never dropped.
    for (const r of during) expect(r).toMatch(/^(502|000) /);
  });

  // --- H2: invalid and partially written dynamic files ----------------------------------------

  it('PROXY / ADR 0011 / H2: a broken dynamic file keeps the last good routers; a partial file is applied; the next good write recovers', async () => {
    const good = dynamicConfig(serviceId, upstream, [routeA()]);
    const goodLines = good.split('\n');
    const truncated = goodLines.slice(0, goodLines.indexOf('  services:')).join('\n');
    const other = dynamicConfig(`other-${serviceId}`, upstream, [
      { domainId: 'o', host: hostOther, redirect: false, tls: 'default' },
    ]);
    const out = await must(
      bash`printf 'http:\n  routers: [\n' > "$NOODARA_DYN/$1"
sleep 4
echo "M invalid_route=$(hit "$3")"
echo "M invalid_routers=$(api_routers | grep -c "$7" || true)"
write_dyn other.yml "$4"
echo "M other_while_invalid=$(wait_for 6000 '200 ok v2' hit "$5")"
printf '%s' "$6" > "$NOODARA_DYN/$1"
sleep 4
echo "M truncated_route=$(hit "$3")"
echo "M truncated_other=$(hit "$5")"
echo "M truncated_routers=$(api_routers | grep -c "$7" || true)"
write_dyn "$1" "$2"
echo "M recovered_ms=$(wait_for 30000 '200 ok v2' hit "$3")"
echo "M other_after_recovery=$(wait_for 10000 '200 ok v2' hit "$5")"
rm -f "$NOODARA_DYN/other.yml"
echo "M other_removed_ms=$(wait_for 10000 '404 *' hit "$5")"`,
      120,
      [serviceFile, good, hostA, other, hostOther, truncated, serviceId],
    );
    const m = marks(out);
    measure('PROXY', ubuntu, { case: 'broken dynamic file', ...m });
    // Syntax error: the whole directory load fails, Traefik keeps the last good configuration...
    expect(m['invalid_route']).toBe('200 ok v2');
    expect(m['invalid_routers']).not.toBe('0');
    // ...and ignores every other file until the directory parses again.
    expect(m['other_while_invalid']).toMatch(/^timeout:404 /);
    // A parseable but truncated file IS applied: its routers lose their service and stop routing.
    expect(m['truncated_route']).toMatch(/^404 /);
    expect(m['truncated_other']).toBe('200 ok v2');
    expect(ms(m['recovered_ms'])).toBeLessThan(30_000);
    expect(m['other_after_recovery']).toMatch(/^\d+$/);
    expect(m['other_removed_ms']).toMatch(/^\d+$/);
  });

  // --- H4: non-cacheable redirect ---------------------------------------------------------------

  it('PROXY / ADR 0011 / H4: redirectScheme permanent=false answers 302 (never 301/308) and removing it serves HTTP again', async () => {
    const out = await must(
      bash`write_dyn "$1" "$2"
echo "M redirect_ms=$(wait_for 30000 '302 *' redir GET "$4")"
for m in GET HEAD POST; do echo "M $m=$(redir "$m" "$4")"; done
write_dyn "$1" "$3"
echo "M plain_again_ms=$(wait_for 30000 '200 ok v2' hit "$4")"
echo "M plain_again=$(redir GET "$4")"`,
      90,
      [
        serviceFile,
        dynamicConfig(serviceId, upstream, [routeA({ redirect: true })]),
        dynamicConfig(serviceId, upstream, [routeA()]),
        hostA,
      ],
    );
    const m = marks(out);
    measure('PROXY', ubuntu, { case: 'redirect', ...m });
    expect(ms(m['redirect_ms'])).toBeLessThan(30_000);
    expect(m['GET']).toBe(`302 https://${hostA}/health`);
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect(m[method]).toMatch(/^30[27] https:\/\//);
      expect(m[method]).not.toMatch(/^(301|308) /);
    }
    expect(ms(m['plain_again_ms'])).toBeLessThan(30_000);
    expect(m['plain_again']).toMatch(/^200 /);
  });

  // --- A3: certificate-status probe -------------------------------------------------------------

  it('CERT / ADR 0011 / A3: openssl is present because ca-certificates (installed by install.sh) depends on it', async () => {
    const out = await must(
      bash`echo "M path=$(command -v openssl || echo none)"
echo "M version=$(openssl version)"
echo "M priority=$(dpkg-query -W -f='@{Priority}' openssl)"
echo "M ca_depends=$(dpkg-query -W -f='@{Depends}' ca-certificates)"`,
      10,
    );
    const m = marks(out);
    measure('CERT', ubuntu, { case: 'openssl presence', ...m });
    expect(m['path']).toMatch(/^\/usr\/bin\/openssl$/);
    expect(m['version']).toMatch(/^OpenSSL 3\./);
    expect(m['ca_depends']).toMatch(/\bopenssl\b/);
  });

  it('CERT / ADR 0011 / A3: before issuance the probe sees the Traefik default certificate, as for any unknown SNI', async () => {
    const out = await must('echo "M a=$(cert "$1")"; echo "M unknown=$(cert "$2")"', 20, [
      hostA,
      hostOther,
    ]);
    const m = marks(out);
    measure('CERT', ubuntu, { case: 'default certificate', ...m });
    expect(m['a']).toMatch(new RegExp(`^NOODARA_CERT tls notAfter=\\d+ issuer=${DEFAULT_CERT_ISSUER}$`));
    expect(m['unknown']).toMatch(new RegExp(`issuer=${DEFAULT_CERT_ISSUER}$`));
  });

  // --- A2: ACME issuance and renewal ------------------------------------------------------------

  it('ACME / ADR 0011 / A2: HTTP-01 against Pebble issues a certificate once DNS points at the host; acme.json stays root-only', async () => {
    if (pebble === undefined) throw new Error('pebble not started');
    await pebble.setARecord(hostA, hostIp);
    const out = await must(
      bash`write_dyn "$1" "$2"
echo "M issued_ms=$(wait_for 150000 'NOODARA_CERT tls *issuer=*Pebble*' cert "$3")"
echo "M cert=$(cert "$3")"
echo "M https=$(curl -sk --max-time 3 --resolve "$3:443:127.0.0.1" "https://$3/health" | head -c 40)"
echo "M acme_json=$(sudo -n stat -c '%a %U' ${PROXY_DIR}/acme/acme.json)"
if cat ${PROXY_DIR}/acme/acme.json >/dev/null 2>&1; then echo "M deployer_reads=yes"; else echo "M deployer_reads=no"; fi`,
      200,
      [serviceFile, dynamicConfig(serviceId, upstream, [routeA({ tls: 'acme' })]), hostA],
    );
    const m = marks(out);
    measure('ACME', ubuntu, { case: 'issuance', ...m });
    expect(ms(m['issued_ms'])).toBeLessThan(150_000);
    expect(m['cert']).toMatch(/^NOODARA_CERT tls notAfter=\d+ issuer=CN=Pebble Intermediate CA /);
    expect(m['https']).toMatch(/^ok v[12]$/);
    expect(m['acme_json']).toBe('600 root');
    expect(m['deployer_reads']).toBe('no');
  }, 240_000);

  it('ACME / ADR 0011 / A2: a short validity is renewed by Traefik within a bounded time', async () => {
    const before = await must('cert "$1"', 20, [hostA]);
    const notAfter = /notAfter=(\d+)/.exec(before)?.[1];
    if (notAfter === undefined) throw new Error(`no certificate: ${before}`);
    const out = await must(
      bash`echo "M renewed_ms=$(wait_for 270000 'renewed *' renewed "$1" "$2")"
echo "M cert=$(cert "$1")"`,
      300,
      [hostA, notAfter],
    );
    const m = marks(out);
    const after = /notAfter=(\d+)/.exec(m['cert'] ?? '')?.[1];
    measure('ACME', ubuntu, {
      case: 'renewal',
      validitySeconds: CERT_VALIDITY_SECONDS,
      renewedMs: m['renewed_ms'],
      secondsLeftAtRenewal: Number(notAfter) - Math.floor(Date.now() / 1000),
      notAfterBefore: Number(notAfter),
      notAfterAfter: Number(after),
    });
    expect(ms(m['renewed_ms'])).toBeLessThan(270_000);
    expect(Number(after)).toBeGreaterThan(Number(notAfter));
  }, 330_000);

  it('ACME / ADR 0011 / A2: a failed HTTP-01 (no DNS answer) leaves the default certificate; after the DNS fix a new router triggers issuance', async () => {
    if (pebble === undefined) throw new Error('pebble not started');
    const retryService = `retry-${serviceId}`;
    const route: Route = { domainId: 'r', host: hostRetry, redirect: false, tls: 'acme' };
    const file = dynamicConfig(retryService, upstream, [route]);
    const failed = await must(
      bash`write_dyn retry.yml "$1"
sleep 15
echo "M without_dns=$(cert "$2")"`,
      40,
      [file, hostRetry],
    );
    await pebble.setARecord(hostRetry, hostIp);
    const out = await must(
      bash`echo "M spontaneous=$(wait_for 30000 'NOODARA_CERT tls *issuer=*Pebble*' cert "$2")"
write_dyn retry.yml "$1"
echo "M same_content_rewrite=$(wait_for 10000 'NOODARA_CERT tls *issuer=*Pebble*' cert "$2")"
rm -f "$NOODARA_DYN/retry.yml"
sleep 3
write_dyn retry.yml "$1"
echo "M readd_ms=$(wait_for 150000 'NOODARA_CERT tls *issuer=*Pebble*' cert "$2")"
rm -f "$NOODARA_DYN/retry.yml"`,
      240,
      [file, hostRetry],
    );
    const m = { ...marks(failed), ...marks(out) };
    measure('ACME', ubuntu, { case: 'retry after DNS fix', ...m });
    expect(m['without_dns']).toMatch(new RegExp(`issuer=${DEFAULT_CERT_ISSUER}$`));
    expect(ms(m['readd_ms'])).toBeLessThan(150_000);
  }, 330_000);

  it('CERT / ADR 0011 / A3: proxy down is told apart; a restart serves the stored certificate without a new order', async () => {
    const out = await must(
      bash`docker stop --time 10 ${PROXY_CONTAINER} >/dev/null
echo "M down=$(cert "$1")"
docker start ${PROXY_CONTAINER} >/dev/null
echo "M back_ms=$(wait_for 30000 'NOODARA_CERT tls *issuer=*Pebble*' cert "$1")"
echo "M back=$(cert "$1")"`,
      60,
      [hostA],
    );
    const m = marks(out);
    measure('CERT', ubuntu, { case: 'proxy down and restart', ...m });
    expect(m['down']).toBe('NOODARA_CERT down');
    expect(ms(m['back_ms'])).toBeLessThan(30_000);
    expect(m['back']).toMatch(/issuer=CN=Pebble Intermediate CA /);
  });

  // --- A4: docker create --env-file -------------------------------------------------------------

  it('ENV / ADR 0011 / A4: --env-file values are literal; the file is removable right after create; the value shows only in .Config.Env', async () => {
    const canary = `NOODARA_ENV_CANARY_${randomUUID().replace(/-/g, '')}`;
    const deployment = randomUUID();
    const name = `noodara-envfile-${deployment}`;
    const lines = [
      'QUOTED="a b"',
      "SINGLE='x'",
      'BACKSLASH=a\\nb',
      '   LEADING=lead',
      'SPACEVAL=  v ',
      'EQ=a=b=c',
      '# COMMENTED=1',
      'HASH=a #b',
      'EMPTY=',
      `CANARY=${canary}`,
    ];
    const out = await must(
      bash`dir="$HOME/.noodara/deploy/$1/secrets"
(umask 077 && mkdir -p "$dir" && printf '%s\n' "@{@:5}" > "$dir/env")
echo "M mode=$(stat -c '%a' "$dir/env") $(stat -c '%a' "$dir")"
docker create --pull never --name "$2" --env-file "$dir/env" --label noodara.managed=true -- "$3" node -e 'setInterval(() => {}, 1000)' >/dev/null
rm -f -- "$dir/env"; echo "M removed=$?"
docker start -- "$2" >/dev/null; echo "M started=$?"
echo "M env=$(docker inspect --format '{{json .Config.Env}}' -- "$2")"
echo "M exec_canary=$(docker exec "$2" printenv CANARY)"
{
  docker ps --all --no-trunc --size=false --filter label=noodara.managed=true --format '{{json .}}'
  docker ps --all --no-trunc
  docker inspect --format '{{json .State}}' -- "$2"
  docker inspect --format '{{json .NetworkSettings.Networks}}' -- "$2"
  docker image inspect --format '{{.Id}}' -- "$3"
  docker image ls --no-trunc --format '{{json .}}'
  docker image history --no-trunc -- "$3"
} > "$HOME/.noodara/deploy/$1/listing" 2>&1
if grep -q -- "$4" "$HOME/.noodara/deploy/$1/listing"; then echo "M listing_leak=yes"; else echo "M listing_leak=no"; fi
docker rm --force -- "$2" >/dev/null
rm -rf -- "$HOME/.noodara/deploy/$1"`,
      60,
      [deployment, name, nodeImage, canary, ...lines],
    );
    const m = marks(out);
    const env = JSON.parse(m['env'] ?? '[]') as string[];
    measure('ENV', ubuntu, {
      case: 'literal values',
      mode: m['mode'],
      env: env.filter((entry) => !entry.startsWith('CANARY=') && !entry.startsWith('PATH=')),
      listingLeak: m['listing_leak'],
    });
    expect(m['mode']).toBe('600 700');
    expect(m['removed']).toBe('0');
    expect(m['started']).toBe('0');
    expect(env).toEqual(
      expect.arrayContaining([
        'QUOTED="a b"',
        "SINGLE='x'",
        'BACKSLASH=a\\nb',
        'LEADING=lead',
        'SPACEVAL=  v ',
        'EQ=a=b=c',
        'HASH=a #b',
        'EMPTY=',
        `CANARY=${canary}`,
      ]),
    );
    expect(env.some((entry) => entry.includes('COMMENTED'))).toBe(false);
    // Recorded exposure: .Config.Env (and the process env) hold the value...
    expect(m['exec_canary']).toBe(canary);
    // ...but no docker ps / Noodara --format template / image listing or history does.
    expect(m['listing_leak']).toBe('no');
  });

  it('ENV / ADR 0011 / A4: multi-line values cannot be expressed; a bare name inherits the CLI environment; lines stop at 64 KiB', async () => {
    const out = await must(
      bash`dir=$(mktemp -d)
try() { docker create --pull never --env-file "$dir/f" -- "$1" true 2>&1 >"$dir/id" | head -c 200 | tr '\n' ' '; echo " rc=@{PIPESTATUS[0]}"; }
ins() { docker inspect --format '{{json .Config.Env}}' "$(cat "$dir/id")"; docker rm "$(cat "$dir/id")" >/dev/null; }
printf 'ML=first\nsecond line\n' > "$dir/f"; echo "M space_line=$(try "$1")"
printf 'ML=first\nPATH\n' > "$dir/f"; echo "M bare_name=$(try "$1")"; echo "M bare_name_env=$(ins)"
for n in 65535 65536; do
  { printf 'BIG='; head -c $((n - 4)) /dev/zero | tr '\0' x; printf '\n'; } > "$dir/f"
  r=$(try "$1"); echo "M line_$n=$r"
  case $r in *rc=0*) docker rm "$(cat "$dir/id")" >/dev/null ;; esac
done
rm -rf -- "$dir"`,
      60,
      [nodeImage],
    );
    const m = marks(out);
    measure('ENV', ubuntu, { case: 'limits', ...m });
    expect(m['space_line']).toMatch(/variable 'second line' contains whitespaces/);
    expect(m['space_line']).not.toMatch(/rc=0$/);
    // A line without '=' is looked up in the CLI's own environment: PATH leaks in from `env -i`.
    expect(m['bare_name_env']).toContain('"PATH=/usr/sbin:/usr/bin:/sbin:/bin"');
    expect(m['line_65535']).toMatch(/rc=0$/);
    expect(m['line_65536']).toMatch(/token too long/);
  });

  // --- H1: bounded execution, image allowlist ----------------------------------------------------

  it('BOUNDED / ADR 0011 / H1: env -i leaves no session variable, timeout caps time (124), head caps output (141); only allowlisted images were pulled', async () => {
    const env = await must('env | cut -d= -f1 | sort | tr "\\n" " "', 10);
    const capped = await sh('yes NOODARA | head -c 200000', 10, [], 1024);
    const slow = await sh('sleep 30', 2);
    const images = await must(
      `docker image ls --format '{{.Repository}}:{{.Tag}}' | sort -u`,
      20,
    );
    const pulled = images.trim().split('\n');
    measure('BOUNDED', ubuntu, {
      env: env.trim(),
      capped: { exitCode: capped.exitCode, bytes: capped.stdout.length },
      slow: { exitCode: slow.exitCode, ms: slow.ms },
      images: pulled,
    });
    const keys = env.trim().split(' ');
    expect(keys).toEqual(expect.arrayContaining(['HOME', 'LC_ALL', 'PATH']));
    // Only what env -i set plus bash's own bookkeeping: no SSH_*, USER, LANG, proxy or secret.
    for (const key of keys) expect(['HOME', 'LC_ALL', 'PATH', 'PWD', 'SHLVL', '_']).toContain(key);
    expect(capped.exitCode).toBe(141);
    expect(capped.stdout.length).toBe(1024);
    expect(slow.exitCode).toBe(124);
    expect(slow.ms).toBeLessThan(10_000);
    const allowedRepos = new Set([
      'traefik',
      ...(stack?.baseImages ?? []).map((ref) => ref.split('@')[0]?.split(':')[0] ?? ''),
    ]);
    for (const image of pulled.filter((entry) => !entry.startsWith('<none>'))) {
      expect(image.endsWith(':latest')).toBe(false);
      const repo = image.slice(0, image.lastIndexOf(':'));
      const fromTestRegistry = stack !== undefined && repo.startsWith(`${stack.registry.host}/`);
      expect(fromTestRegistry || allowedRepos.has(repo), image).toBe(true);
    }
  });
});
