# Installing Noodara

This document is the complete reference for installing, logging into, upgrading, rolling back
and diagnosing a Noodara panel on a single VPS. It describes exactly what `install.sh` does today
— every command, every default and every exit code below is read directly from the script, not
from a plan written in advance.

## Requirements

- Ubuntu 22.04 LTS or 24.04 LTS, `amd64` or `arm64`. No other operating system or architecture is
  supported; the installer refuses to continue on anything else.
- Root access, or `sudo`.
- 2 GB RAM recommended. 1 GB is the hard minimum — below it the installer refuses to continue.
  Between 1 GB and 2 GB it prints a warning and continues.
- 5 GB free disk on the filesystem the install directory lives on (or its nearest existing parent,
  on a fresh host).
- A free host port for the panel. The default is `3000`; override it with `NOODARA_PORT`.

Every one of these checks runs **before** the installer writes or installs anything. If any check
fails, the installer stops immediately with a message naming exactly what failed and how to fix
it, and the system is left exactly as it was.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sh
```

`nooodara` is filled in with the real GitHub organization or user once the
repository is published. Run this as root, or with `sudo sh` if you are not root.

To set any of the variables in "Supported variables" below for this command, put the assignment
on the `sh` side of the pipe, never before `curl`: a `VAR=value` prefix in front of `curl` applies
only to `curl` itself, not to the `sh` process reading its piped output, so the installer would
never see it. As root: `curl -fsSL <url> | NOODARA_PORT=8080 sh`. With `sudo`, every variable must
also go after `sudo` — plain `sudo sh` on its own already drops the caller's environment the same
way a `VAR=value` placed before `curl` does: `curl -fsSL <url> | sudo NOODARA_PORT=8080 sh`.

## Install without piping to a shell

Piping a remote script straight into a root shell is a trust decision, and you do not have to make
it blindly. Download the script, read it, then run it:

```sh
curl -fsSL -o install.sh https://raw.githubusercontent.com/nooodara/noodara/main/install.sh
less install.sh
sh install.sh
```

This is the same guidance Docker's own `get.docker.com` installer gives, and it is the recommended
path for anyone who will not run a remote script as root sight-unseen. The script is strict POSIX
`sh`: every function is self-contained, and the only thing that ever runs at the top level is a
single guarded call at the very bottom of the file — a connection dropped mid-download can only
ever leave a partial set of function definitions behind, never a half-finished install.

## What gets installed

The installer brings up six Docker Compose services under `/opt/noodara`:

| Service | What it runs |
|---|---|
| `postgres` | The database, in a named volume |
| `redis` | The queue and cache, in a named volume |
| `migrate` | A one-shot that applies database migrations, then exits |
| `api` | The control-plane HTTP API |
| `worker` | The background job worker |
| `web` | The panel UI, proxying `/api/*` to `api` |

Only `web` publishes a port on the host — the one you set with `NOODARA_PORT` (default `3000`).
`postgres` and `redis` are not reachable from outside the host at all; `api` is reached only
through `web`'s own proxy.

Everything lives under `/opt/noodara`:

- `docker-compose.yml` — the topology above, mode `644`, replaced on every run so an upgrade picks
  up any topology change.
- `.env` — every secret and setting, mode `600`, owned by root. This file is generated once, on a
  fresh install, and never regenerated afterward.
- `install.log` — a plain, timestamped record of which steps ran. It never contains a secret or
  the setup token, only step names and the names (never the values) of variables that were
  generated or preserved.

Data lives in two named Docker volumes, not bind mounts, so it survives a `docker compose down`
and an upgrade without any extra configuration.

`api`/`migrate`/`worker` all run the same published image,
`ghcr.io/<owner>/noodara-control-plane:<version>`, differing only by which command they run inside
it; `web` runs `ghcr.io/<owner>/noodara-web:<version>`. Both images are published for `linux/amd64`
and `linux/arm64` as a single multi-arch manifest, and `<version>` is always an explicit release
tag — the installer never pulls the unversioned tag, so a restart can never silently change which
release is running.

## First login

Once the stack reports healthy, the installer prints the panel URL and, if no admin account exists
yet, a one-time setup token:

```
Noodara is running.
Panel: http://203.0.113.7:3000
One-time setup token: <token>
Open the panel and enter this token to create the admin account.
```

Open the panel URL and enter the token to create the first admin account. The token is printed
only once, the first time an admin does not yet exist — a later run against the same installation
will not reprint it once an admin has been created.

To skip the token step entirely, set both `NOODARA_ADMIN_EMAIL` and `NOODARA_ADMIN_PASSWORD`
before running the installer. Both are required together — setting only one makes the installer
print a warning naming both variables and fall back to the normal token flow, using neither value.

Before anything is written, the installer itself checks `NOODARA_ADMIN_PASSWORD` for: no embedded
newline or carriage return, no literal single quote (`'`, which cannot be written safely into the
generated `.env` file), at least 12 characters, and that it does not equal the admin email address
or the part of it before the `@`. A password failing any of these is rejected immediately, before
`.env` is touched.

The control plane enforces the rest of its password policy — most importantly, rejecting a
common or easily guessed password — only later, inside the `api` container, once
`docker compose up` has already started it. A password that fails that check does not fail
immediately: the installer waits out its full health-check budget (5 minutes by default) before
exiting with code 53, with the real reason (for example "Password is too common") in the `api`
service's own log tail:

```sh
docker compose -f /opt/noodara/docker-compose.yml logs api
```

Once the admin account exists, you may remove both variables from `/opt/noodara/.env` — they are
only ever read at install time.

## Plain HTTP warning

**The default install serves the panel over plain, unencrypted HTTP.** When the resolved panel URL
starts with `http://`, the installer writes `NOODARA_COOKIE_INSECURE=true` into `.env`, which
disables the session cookie's `Secure` attribute so you can still log in over an unencrypted
connection. This also means the session cookie — and the one-time setup token, the first time you
use it — travel in the clear. Anyone able to observe traffic between your browser and the server
can read them.

HTTPS and automatic certificates arrive in a later release. Until then, if you want TLS today:

1. Put a reverse proxy (for example Caddy or nginx) in front of the panel, terminating TLS there
   and forwarding to `127.0.0.1:<NOODARA_PORT>`.
2. Edit `/opt/noodara/.env`: set `NOODARA_PUBLIC_URL` to the `https://` origin the proxy serves,
   and remove the `NOODARA_COOKIE_INSECURE` line entirely — it is only ever meant to exist for an
   `http://` origin.
3. Apply the edit — re-running the installer does **not** do this (see "Supported variables"
   above); run Compose directly instead:

   ```sh
   docker compose -f /opt/noodara/docker-compose.yml up -d
   ```

4. Confirm it took: `docker compose -f /opt/noodara/docker-compose.yml exec api env | grep
   NOODARA_PUBLIC_URL` should show the new `https://` origin, and logging in through the proxy's
   `https://` URL should set a session cookie with the `Secure` attribute (visible in the
   browser's own cookie inspector).

## Firewall

If `ufw` is active, the installer detects it and prints an advisory — it never modifies a firewall
rule itself. The advisory says, verbatim:

> ufw is active on this server. Docker publishes container ports by inserting its own iptables rules, which typically bypass ufw's rules entirely for published ports -- a port Docker publishes may be reachable from the internet even if ufw shows it as denied.

This is the precise, load-bearing fact: **do not rely on `ufw` to protect the panel's published
port.** A port Docker has published is commonly reachable from the internet regardless of what
`ufw status` reports. If you want `ufw` to actually govern Docker's published ports, you need
additional `DOCKER-USER` iptables-chain configuration beyond `ufw allow`/`ufw deny` — that
configuration is outside the scope of this installer.

To allow the panel port through `ufw` anyway (for example, if you have already configured the
`DOCKER-USER` chain):

```sh
sudo ufw allow <port>/tcp
```

And, separately:

> Remember your cloud provider's own firewall/security-group rules also apply -- ufw only governs this host.

Your cloud provider's own firewall or security group is a real, independent boundary — check it
too.

## Supported variables

These are the only variables an operator is expected to set. Every other environment variable
`install.sh` reads is either a fixed default or an internal test seam and is not documented here.

| Variable | Default | Effect |
|---|---|---|
| `NOODARA_VERSION` | Latest published release | Pins the exact release tag to install. Must match `[A-Za-z0-9_][A-Za-z0-9_.-]*` (1–128 characters) and must never be `latest`. A leading `v` (e.g. `v0.1.0`) is accepted and stripped automatically. |
| `NOODARA_PORT` | `3000` | The host port the panel is published on. Must be a number between 1 and 65535. |
| `NOODARA_PUBLIC_URL` | Auto-detected public IP, then local IP, over `http://` | The public origin the panel is reachable at. Must start with `http://` or `https://` followed by a host, and must not contain whitespace, a single quote, a double quote, a backslash, a dollar sign, a backtick or an embedded newline/carriage return. |
| `NOODARA_ADMIN_EMAIL` | unset | Pre-seeds the admin account's email. Must be set together with `NOODARA_ADMIN_PASSWORD`, or not at all. |
| `NOODARA_ADMIN_PASSWORD` | unset | Pre-seeds the admin account's password. At least 12 characters, no single quote, must not equal the admin email or the part of it before the `@`. The control plane also rejects a common password, checked later at boot (see "First login"). Must be set together with `NOODARA_ADMIN_EMAIL`, or not at all. |
| `NOODARA_SKIP_RESOURCE_CHECK` | unset | Set to `1` to skip the RAM/disk checks entirely — a deliberate override for a host you already know is fine. |

None of these variables — or any value derived from them — may contain an embedded newline or
carriage return; the installer rejects any such value outright, naming the variable but never
echoing the rejected value, before writing anything to disk.

After install, you may edit a small number of keys directly in `/opt/noodara/.env`:

- `NOODARA_PORT` — change the published panel port. The new port must be free on the host.
- `NOODARA_PUBLIC_URL` — change the panel's public origin.
- `NOODARA_COOKIE_INSECURE` — remove this line once a TLS proxy is genuinely in front (see "Plain
  HTTP warning" above).

**Re-running the installer does not apply an `.env` edit.** On the same version, with the stack
already healthy, a re-run is a true no-op (see "Upgrade" below): it never runs `docker compose up`,
so nothing you changed in `.env` is picked up. To apply an edit, run Compose directly, from the
install directory:

```sh
docker compose -f /opt/noodara/docker-compose.yml up -d
```

Compose reads the current `.env` and recreates only the services whose resolved configuration
changed — `web` for `NOODARA_PORT`, `api`/`worker` for `NOODARA_PUBLIC_URL` or
`NOODARA_COOKIE_INSECURE` — leaving the rest untouched.

**`.env` always wins over a re-run's environment.** If you pass `NOODARA_PORT` or
`NOODARA_PUBLIC_URL` as an environment variable to a re-run and it disagrees with what `.env`
already has recorded, the installer prints a single warning naming both values and keeps the one
already in `.env`; it never overwrites your edit. To change either value, edit `/opt/noodara/.env`
directly and apply it with the `docker compose ... up -d` command above.

## Upgrade

Upgrading is re-running the exact same install command, optionally pinning a specific release with
`NOODARA_VERSION`:

```sh
curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sh
```

What actually happens depends on what the installer finds:

- **Same version, stack already healthy** — a true no-op. Nothing is written: no backup, no image
  pull, no `docker compose up`. Only a single, immediate health check runs, and the summary is
  printed again.
- **Same version, stack stopped or unhealthy** — a repair. The installer prints "The stack is not
  healthy; starting it.", then pulls images and brings the stack back up. `.env` is not touched —
  there is nothing to change when the version has not moved.
- **Different version** — a genuine upgrade. The installer backs up `.env` to a timestamped copy
  (see below), records the version you are moving from, updates `.env`'s version line, pulls the
  new images and brings the stack up on the new version.

Every one of these paths preserves your existing secrets and data. Nothing here ever regenerates a
secret, deletes a volume, or touches a value already present in `.env` — an upgrade only ever adds
a variable a newer release genuinely requires, and only when it is not already there.

Before any upgrade write, the installer copies the current `.env` to
`/opt/noodara/.env.bak-<timestamp>`, mode `600`. **This backup file contains the same secrets as
`.env` itself** — treat it with the same care.

## Rollback

There is no automatic rollback in this release. If an upgrade's health check fails, the installer
exits with a non-zero status, shows the log tail of the service that failed to become healthy, and
tells you the exact command to go back. As root:

```sh
curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | NOODARA_VERSION=<previous-version> sh
```

Or with `sudo` (the variable must go after `sudo`, same as in "Install" above):

```sh
curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sudo NOODARA_VERSION=<previous-version> sh
```

The previous version is the one the installer names in that message — it is also recorded in
`/opt/noodara/.env` for later reference. A failed upgrade never rolls back on its own, and it never
touches your data volumes or your existing `.env` beyond what the upgrade attempt itself already
wrote (the one `.env.bak-<timestamp>` backup described above).

## Troubleshooting

Every failure the installer can produce has its own exit code and its own actionable message.
This is the complete table, taken directly from the script:

| Exit code | Reason | What to do |
|---|---|---|
| 10 | Not running as root | Re-run the installer with `sudo`. |
| 11 | A required command is missing | Install the named command (`curl`, `openssl`, `ss`, `ip`, `awk` or `grep`) and re-run. |
| 12 | Unsupported operating system | Noodara requires Ubuntu 22.04 or 24.04. |
| 13 | Unsupported architecture | Noodara requires `amd64` or `arm64`. |
| 14 | Insufficient RAM | Free up memory, add RAM, or set `NOODARA_SKIP_RESOURCE_CHECK=1` to override deliberately. |
| 15 | Insufficient free disk | Free up disk space, or set `NOODARA_SKIP_RESOURCE_CHECK=1` to override deliberately. |
| 16 | The panel port is already in use | Set `NOODARA_PORT=<other>` and re-run. |
| 17 | Docker was installed via snap | Remove it (`sudo snap remove docker`) and re-run — Noodara does not support a snap-installed Docker. |
| 20 | Docker Engine installation failed | Read the `apt` output printed above the error and fix the underlying issue, or install Docker manually. |
| 21 | The Compose plugin is still missing after installation | Install `docker-compose-plugin` manually and re-run. |
| 22 | Docker is installed but its daemon is not responding | Start it (`sudo systemctl start docker`) and re-run. Nothing is touched — the installer never removes or reinstalls an existing Docker. |
| 30 | Writing `.env` (or a value in it) failed | The message names the exact variable or file operation that failed; fix it and re-run. |
| 40 | Could not resolve which version to install | Set `NOODARA_VERSION=<tag>` explicitly and re-run. |
| 41 | Could not resolve a public URL | Set `NOODARA_PUBLIC_URL=<url>` explicitly and re-run. |
| 50 | Pulling images failed | Check network connectivity and the resolved image tags, then re-run. |
| 51 | `docker compose up` failed | Read Compose's own error and the service state printed above. Data and secrets are untouched. |
| 52 | Database migrations failed | Read the `migrate` service's log tail printed above. Data and secrets are untouched. |
| 53 | A service did not become healthy in time | Read the named service's log tail printed above. Data and secrets are untouched; see "Rollback" above if this happened during an upgrade. |

**Reading logs:**

```sh
docker compose -f /opt/noodara/docker-compose.yml logs <service>
```

**Checking health:**

```sh
docker compose -f /opt/noodara/docker-compose.yml ps
docker compose -f /opt/noodara/docker-compose.yml exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && echo healthy
curl -I http://127.0.0.1:<port>/login
```

The `ps` HEALTH column reflects each service's own Compose `healthcheck:`. The middle command
re-runs the `api` container's own healthcheck by hand, from inside the container against its
`/health` route directly (the same call `docker-compose.yml`'s `api` healthcheck itself makes) —
only `web` publishes a port on the host, and `web` only proxies `/api/*` to `api` (see "What gets
installed" above), so `/health` is never reachable from outside the container. The last command
confirms the panel itself is answering on the port you published.

**Running the operator CLI inside the running `api` container:**

```sh
docker compose -f /opt/noodara/docker-compose.yml exec api node dist/cli/index.js admin reset
docker compose -f /opt/noodara/docker-compose.yml exec api node dist/cli/index.js secrets rotate
```

`admin reset` issues a one-time recovery token for the existing admin account. `secrets rotate`
re-encrypts every stored credential under a newly rotated master key.

## Backups

This release has no managed, automatic backups. Two things are worth backing up yourself before
you rely on this installation:

- **`/opt/noodara/.env`.** Its `NOODARA_MASTER_KEY` value is unrecoverable if lost — every stored
  SSH credential becomes permanently undecryptable without it. Back this file up somewhere safe,
  outside the VPS itself.
- **The two named Docker volumes** (`noodara_postgres_data` and `noodara_redis_data`), especially
  before an upgrade. A `pg_dump` of the `postgres` volume, taken and stored off the host, is the
  simplest option today.

`install.log` never contains a secret — it is safe to share for diagnosis. `.env.bak-*` files do
contain secrets, exactly like `.env` itself, and should be handled and stored the same way.
