# ADR 0011: Domains, TLS and env contracts (Traefik file provider, ACME, certificate probe, `--env-file`)

## Status

Accepted — 2026-10-30

## Context

v0.4 puts a reverse proxy with automatic HTTPS in front of services, and injects env vars and
secrets at runtime. The user decisions of 2026-10-30 (`.planning/DECISIONS.md`) already fixed one
Traefik per server, the file provider, built-in ACME with HTTP-01, a host-side certificate probe
and `docker create --env-file`. This ADR records the measured behaviour those decisions rest on
and fixes the shapes phases 21–25 implement.

Each measurement is a permanent contract test in
`tests/integration/deploy-engine/contracts-v04.test.ts` (gate `it-contracts-v04`, 13 tests per
version, green on 22.04 and 24.04). Titles start with `PROXY`, `ACME`, `CERT`, `ENV` or
`BOUNDED / ADR 0011`. Raw numbers come from `NOODARA_MEASUREMENTS_FILE=<file>`. H1 and H3 are
also unit tests in `tests/unit/integration-helpers/acme-fixtures.test.ts`.

Environment: ADR 0008 fixture (`sshd-dockerd-ubuntu-{22.04,24.04}`, Docker 29.8.1), macOS arm64
Docker Desktop, 2026-10-30. Images (digest-pinned, the only ones a fixture may pull):
`traefik:v3.7.14`, `ghcr.io/letsencrypt/pebble:2.10.1`, `pebble-challtestsrv:2.10.1`.

## Proxy layout and static config

### Decision

- Container `noodara-traefik`, label `noodara.proxy=true`, `--restart unless-stopped`,
  `--pull never` after an explicit `docker pull` of the digest-pinned image
  (`NOODARA_PROXY_IMAGE`). Ports: `80:80`, `443:443`, `127.0.0.1:9180:9180`. No `docker.sock`.
- `/opt/noodara-proxy/` (created once with `sudo -n install -d`, then owned by the deploy user):

  | Path | Mode | Owner | Mount |
  |---|---|---|---|
  | `/opt/noodara-proxy` | 0700 | deployer | — |
  | `traefik.yml` | 0600 | deployer | `/etc/traefik/traefik.yml` ro |
  | `dynamic/` (`*.yml`, `*.yml.prev` 0600) | 0700 | deployer | `/etc/traefik/dynamic` ro |
  | `ca/` (test seam only, `ca-root.pem` 0600) | 0700 | deployer | `/etc/traefik/ca` ro |
  | `acme/` | 0700 | deployer | `/etc/traefik/acme` rw |
  | `acme/acme.json` | 0600 | root (Traefik) | — |

  Measured: Traefik creates `acme.json` as root 0600; the deploy user cannot read it. Traefik runs
  as root in its container, so 0700/0600 (22-01, `proxy.prepare_dirs`) still lets it read the rest.
- Static config (a change needs a proxy restart):

  ```yaml
  global: { checkNewVersion: false, sendAnonymousUsage: false }
  log: { level: WARN }
  entryPoints: { web: { address: ":80" }, websecure: { address: ":443" }, traefik: { address: ":9180" } }
  api: { insecure: false, dashboard: false }     # API only through the noodara-api router below
  providers:
    file: { directory: /etc/traefik/dynamic, watch: true }   # no docker provider
  certificatesResolvers:
    noodara:
      acme:
        email: <admin email | per-server override>
        storage: /etc/traefik/acme/acme.json
        caServer: <NOODARA_ACME_CA_URL>          # default Let's Encrypt production
        httpChallenge: { entryPoint: web }
  ```

  `dynamic/noodara-api.yml`, written with the static config, exposes the read-only API on the
  `traefik` entrypoint (published on 127.0.0.1:9180 only):

  ```yaml
  http:
    routers:
      noodara-api: { entryPoints: [traefik], rule: "PathPrefix(`/api`)", service: api@internal }
  ```

  Both files are rendered as canonical JSON (valid YAML) by `packages/domain/src/proxy/static-config.ts`;
  `tests/integration/proxy/proxy-templates.test.ts` loads them in a real Traefik (22-01).
  `certificatesDuration` stays at Traefik's default (2160 h) in production; tests set it to 1.
  With `NOODARA_ACME_CA_ROOT_FILE` set, the root goes to `ca/` and the container gets
  `LEGO_CA_CERTIFICATES=/etc/traefik/ca/<file>` (measured: this is how Traefik trusts Pebble).
- The proxy is connected to every routed `noodara-net-<serviceId>` (`docker network connect`).

### Measured

| | 22.04 | 24.04 |
|---|---|---|
| Traefik pull | 7.7 s | 8.6 s |
| `docker run` to API ready | 0.24 s + 62 ms | 0.3 s + 70 ms |
| Host IP :80 / :443 | open / open | open / open |
| 127.0.0.1:9180 / host IP :9180 | open / refused | open / refused |
| Proxy IP :9180 from a service container | open | open |

The API is reachable from containers on the networks the proxy joins. It is read-only (Traefik's
API has no write endpoints, dashboard off) and shows router rules and upstream names of services
on the same server, all of which belong to the same single tenant. Accepted for v0.4 and listed
under Consequences.

## Dynamic config (A1)

### Decision

- One file per service, `dynamic/<serviceId>.yml`, a pure function of the service's domain rows.
  Every name derives from ids only (never from hostnames or user text):

  ```yaml
  # Managed by Noodara (ADR 0011). Do not edit.
  http:
    routers:
      noodara-<serviceId>-<domainId>-web:
        entryPoints: [web]
        rule: "Host(`<hostname>`)"
        service: noodara-<serviceId>
        middlewares: [noodara-<serviceId>-<domainId>-redirect]   # only when https_redirect
      noodara-<serviceId>-<domainId>-websecure:
        entryPoints: [websecure]
        rule: "Host(`<hostname>`)"
        service: noodara-<serviceId>
        tls: { certResolver: noodara }
    middlewares:
      noodara-<serviceId>-<domainId>-redirect:
        redirectScheme: { scheme: https, permanent: false }
    services:
      noodara-<serviceId>:
        loadBalancer:
          servers:
            - url: http://noodara-<serviceId>:<internalPort>
  ```

- Write = `mktemp dynamic/.noodara-XXXXXX` (same filesystem, no `.yml` suffix so the provider
  ignores it), content on stdin, size + sha256 checked, `chmod 0600`, the replaced file kept as
  `<serviceId>.yml.prev` (0600), `mv -f` onto `<serviceId>.yml`. Never write in place; an
  interrupted write never renames (22-01 `proxy.write_dynamic`, `proxy.restore_dynamic`).
- Removing a service's routes = removing its file; then `docker network disconnect`.
- The API lists routers as `<name>@file`; that suffix is part of the verify contract.

### Measured

- A temp + rename write is routed after **~2.0 s** (2031 ms on 22.04, ~2.0 s on 24.04): Traefik's
  default `providers.providersThrottleDuration` of 2 s. Unknown hosts get `404`.
- Upstream by Docker DNS name follows the ADR 0010 swap (stop, rename to `-prev`, start the new
  `noodara-<serviceId>`): no config change is needed.

  | Swap (ms) | stop | rename | run | window | answers in window |
  |---|---|---|---|---|---|
  | 22.04 | 110 | 12 | 92 | 63 | none sampled |
  | 24.04 | 91 | 15 | 147 | 282 | 502 only |

  During the window Traefik answers `502`; this is the documented stop-then-start downtime.

## Invalid or partial dynamic files (H2)

### Measured (both versions)

| Case | Effect |
|---|---|
| Syntax error in one file | The **whole directory** is rejected: last good routers stay and serve (`200`), and new valid files elsewhere are **not** picked up while it is broken |
| Truncated but parseable file | Applied as written: the router loses its service and answers `404` |
| Next good write | Recovered in ~2.1 s (2078 ms on 22.04); pending files from other services load with it |

### Decision

- 22-01 (apply/restore): only temp + rename writes; the rendered YAML is validated in the control
  plane before upload. On a failed verify, restore re-renders the previous rows and writes them
  the same way (no backup files left in `dynamic/`, which would load).
- 22-03 (verify): a write is not trusted. After the write, poll the API (`/api/http/routers`,
  127.0.0.1:9180) until the expected `@file` routers are present and the removed ones absent,
  for at most 10 s (throttle 2 s + margin). A timeout means "not applied" (for example another
  file is broken) and the apply fails without touching the service container.

## Redirect (H4)

### Decision

`redirectScheme` with `permanent: false`, per domain, rendered whenever `https_redirect` is on,
independent of certificate status. Never `301`/`308`, so turning the switch off works in browsers
that cached the redirect.

### Measured (both versions)

`GET` → `302`, `HEAD` → `307`, `POST` → `307`, all to `https://<host>/…`. After the middleware
is removed, plain HTTP to the same host answers `200` again in ~2.0 s.

## ACME (A2)

### Measured

| | 22.04 | 24.04 |
|---|---|---|
| HTTP-01 issuance after the A record exists | 7.1 s | 2.4 s |
| Renewal of a 300 s certificate (`certificatesDuration: 1`) | 26 s | 57 s |
| Proxy restart to stored certificate served | 0.2 s, no new order | 0.2 s, no new order |

- A failed HTTP-01 (no DNS answer) is **not retried**: not on its own (30 s observed), and not on
  a same-content rewrite (Traefik skips identical config). Removing the router and adding it
  back issues in ~2.6–3 s.
- Production renewal (not measurable in tests): Traefik renews 2160 h certificates 30 days before
  `notAfter` (Traefik docs).

### Decision

- Retry after a DNS fix (dns-check `RESOLVES`, or a PATCH) = write the file without the domain's
  routers, verify, then write it back. A plain rewrite is not a retry.
- Tests and fixtures name only the Pebble directory (`https://pebble:14000/dir`); H3 enforces it.

## Certificate probe and status (A3)

### Decision

- Probe on the host over SSH, no curl (ADR 0010):
  `openssl s_client -connect 127.0.0.1:443 -servername <hostname> </dev/null`, reduced on the host
  with `openssl x509 -issuer -enddate` to one line:
  `NOODARA_CERT tls notAfter=<epoch | openssl date when date -d fails> issuer=<RFC2253>` | `NOODARA_CERT down` |
  `NOODARA_CERT unavailable`. 22-04 adds a `command -v openssl` guard (`NOODARA_CERT no_openssl`).
  The default certificate is recognised by `issuer=CN=TRAEFIK DEFAULT CERT`.
- The control plane never reads `acme.json`.
- States and transitions (`packages/domain`, 21-02):

  | From | Probe / event | To |
  |---|---|---|
  | NONE | domain added | PENDING |
  | PENDING | issued certificate | ISSUED |
  | PENDING | default cert, within `NOODARA_CERT_ISSUE_TIMEOUT_MS` (10 min) | PENDING |
  | PENDING | beyond the timeout | FAILED (`CERT_DNS_MISMATCH` if dns ≠ RESOLVES, else `CERT_ISSUANCE_FAILED`) |
  | any | `down` | unchanged status, cause `CERT_PROXY_UNAVAILABLE` (FAILED when PENDING times out) |
  | ISSUED | `notAfter` within 30 days | RENEWING |
  | RENEWING | later `notAfter` | ISSUED |
  | ISSUED, RENEWING | `notAfter` past | EXPIRED |
  | FAILED | dns-check RESOLVES or PATCH (retry above) | PENDING |

- Timings: regular cycle `NOODARA_CERT_CHECK_INTERVAL_MS` (10 min); after a domain change, checks
  at 15 s, 30 s and 60 s (issuance measured at 2–8 s, plus the 2 s throttle).
- dns-check outcomes: `RESOLVES` (an A/AAAA answer equals a server IP), `MISMATCH` (answers, none
  match), `UNRESOLVED` (NXDOMAIN or no address), `UNAVAILABLE` (resolver error or 3 s timeout).
  Advisory only: a domain can be added before DNS points at the server.

### Measured

| | 22.04 | 24.04 |
|---|---|---|
| openssl | `/usr/bin/openssl`, 3.0.2 | `/usr/bin/openssl`, 3.0.13 |
| Priority | optional | optional |
| Why present | `ca-certificates` Depends `openssl` | same |

`ca-certificates` is the first step of Docker's apt install, so every server that runs Docker this
way has openssl. Before issuance, the target SNI and an unknown SNI both show the default
certificate; after issuance the issuer is the Pebble intermediate; a stopped proxy gives `down`.

## `--env-file` semantics (A4)

### Measured (both versions)

| Input line | Container env |
|---|---|
| `QUOTED="a b"`, `SINGLE='x'` | quotes kept literally |
| `BACKSLASH=a\nb` | backslash and `n` kept (no escape processing) |
| `   LEADING=lead` | leading spaces of the line trimmed |
| `SPACEVAL=  v ` | value spaces kept |
| `EQ=a=b=c` | split at the first `=` |
| `HASH=a #b` | kept; only lines starting with `#` are comments |
| `EMPTY=` | empty value |
| `ML=first` then `second line` (a multi-line value) | `docker create` fails, rc 125 (`contains whitespaces`) |
| `PATH` (bare name, no `=`) | inherits the value from the docker CLI's own environment |
| line of 65,535 bytes / 65,536 bytes | ok / `bufio.Scanner: token too long`, rc 125 |

- The file (0600, dir 0700) can be removed right after `docker create`; the container starts.
- The value appears in `docker inspect` `.Config.Env` and the process environment; it does not
  appear in `docker ps`, Noodara's `--format` templates, `docker image ls` or `docker history`.

### Decision

- Always write `NAME=value`, never a bare name; one line per variable, no quoting.
- Values are single-line (`ENV_VALUE_MULTILINE`, hint: base64): a newline in a value would make
  the rest a new line, which errors, inherits the CLI env (bare word) or silently defines another
  variable (`NAME=…`). A line, name and `=` included,
  is at most 65,535 bytes; 21-03 sets the value cap below that.
- Write `<workspace>/secrets/env` 0600, run `docker create`, remove the file.
- `.Config.Env` exposure on the user's own server is accepted (decision of 2026-10-30); Noodara's
  formats never select `.Config.Env`.

## Bounded execution (H1)

Every remote command runs as
`env -i PATH=… HOME=… LC_ALL=C timeout -k 1 <s> bash --noprofile --norc -c '{ … } 2>&1 | head -c <cap>'`.
Measured: the environment holds only `HOME LC_ALL PATH PWD SHLVL _`; a slow command ends with
124 after 2.0 s; an output above the cap ends with 141 at exactly the cap. No probe sends service
env or secrets. Only the allowlisted images are pulled; a unit test rejects `:latest`, unpinned
and unknown references and any `docker run`/`create` without `--pull never`.

## Rejected alternatives

- **Docker provider + labels**: needs `docker.sock` inside Traefik (root on the host), and labels
  are fixed at create time, so every domain change recreates the service container.
- **Caddy**: good automatic HTTPS, but the roadmap fixes Traefik; switching would redo every
  measurement here for no v0.4 criterion.
- **Control-plane-side ACME**: private keys would travel over SSH and live in the database; the
  control plane would need port 80 on each server; renewals would stop when the panel is down.
- **Reading `acme.json`**: it holds account and certificate private keys, is root 0600, and would
  need sudo; the TLS handshake gives issuer and `notAfter` without any key.
- **curl-based probes**: curl is not on stock Ubuntu (ADR 0010), and parsing `curl -v`
  certificate output is fragile; openssl is present through `ca-certificates`.
- **`permanent: true` redirect**: 301/308 get cached and the per-domain switch could not be undone.

## Consequences

- Stop-then-start stays: Traefik answers `502` for 60–300 ms per deploy.
- One broken dynamic file freezes routing changes for the whole server until fixed; verify (22-03)
  and drift re-apply (22-04) catch it, and temp + rename plus pre-upload validation prevent it.
- Failed issuance needs the remove/re-add retry; a plain rewrite does nothing.
- The read-only Traefik API is visible to service containers on the same server (single tenant).
- Resolved env values are readable with `docker inspect` by anyone with Docker access on the
  server.
