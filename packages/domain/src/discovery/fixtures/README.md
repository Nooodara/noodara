# Discovery command fixtures

Real command output captured from the project-owned sshd fixture images
(`tests/integration/images/sshd-ubuntu-22.04`, `sshd-ubuntu-24.04`), so
every parser in this phase (plan 02-05) is tested against reality instead
of hand-typed sample text (02-RESEARCH.md assumption A3;
02-04-PLAN.md Task 2).

**Never hand-edit a file in this directory.** If a command template in
`packages/ssh/src/commands` changes, re-run the capture script — it is
the only source of truth for what goes here.

- **Capture script:** `scripts/capture-discovery-fixtures.mjs` (run it
  from the repo root: `node scripts/capture-discovery-fixtures.mjs`;
  requires `packages/ssh` to already be built, i.e. `pnpm build` first).
- **Captured:** 2026-09-14, on macOS (Apple Silicon, arm64) with Docker
  Desktop, against `tests/integration/images/sshd-ubuntu-22.04` and
  `sshd-ubuntu-24.04` as they existed after plan 02-02.
- **Host-specific fields:** `arch.txt` reads `aarch64` and the Docker
  fixtures' `Client.Arch` reads `"arm64"` because the capturing host is
  Apple Silicon. GitHub `ubuntu-latest` (x86_64) will produce `x86_64`
  and `"amd64"` respectively if the script is re-run there — no parser
  in plan 02-05 may assume a fixed value for either field.

## File naming

One file per `DiscoveryCheckId` (`packages/domain/src/discovery/types.ts`)
per Ubuntu version, named `<check-id>.txt` — the check id doubles as the
filename with no translation table needed. A `.meta.json` sibling exists
wherever a command's *failure* shape (a non-zero exit code and/or stderr
text) is itself part of what a parser must handle correctly, per D-12's
"never collapse a JSON-parse failure into `docker_installed = false`"
requirement (Pitfall 2).

| File | Command | User | Exit code | Notes |
|---|---|---|---|---|
| `hostname.txt` | `hostname` | deployer | 0 | Docker's own randomly-assigned container hostname — expected to differ on every re-run, not a value to assert exactly. |
| `os_release.txt` | `cat /etc/os-release` | deployer | 0 | |
| `arch.txt` | `uname -m` | deployer | 0 | Host-architecture-dependent (see above). |
| `cpu.txt` | `nproc` | deployer | 0 | |
| `memory.txt` | `cat /proc/meminfo` | deployer | 0 | Free/available/cached counters vary run to run — genuinely variable, not a capture bug. |
| `disk.txt` | `df -P -k /` | deployer | 0 | Used/available blocks vary slightly run to run. |
| `uptime.txt` | `cat /proc/uptime` | deployer | 0 | Always differs — it is, by definition, the container's uptime. |
| `sudo.txt` | `sudo -n true` | deployer | 0 | deployer has passwordless sudo (SERV-08's "pass" fixture). |
| `sudo.restricted.txt` / `.restricted.meta.json` | `sudo -n true` | restricted | 1 | restricted has no sudoers entry (SERV-08's "fail" fixture); `.meta.json`'s `stderr` is `"sudo: a password is required\n"`. |
| `docker_group.txt` | `id -nG` | deployer | 0 | Contains `docker` (deployer is a group member). |
| `docker_group.restricted.txt` / `.restricted.meta.json` | `id -nG` | restricted | 0 | Does **not** contain `docker`. |
| `docker_version.txt` / `.meta.json` | `docker version --format '{{json .}}'` | deployer | 1 | **Captured** from the `dockerCli: true` image variant (CLI installed, no daemon running). `stdout` is valid JSON with a populated `Client` key and `"Server":null`; `.meta.json`'s `stderr` is Docker's own "failed to connect to the docker API..." message. This is the "installed, daemon unreachable" shape D-12's parser must treat as `docker_installed = true`. |
| `docker_compose_version.txt` / `.meta.json` | `docker compose version --short` | deployer | 0 | Also from the `dockerCli: true` image — the compose plugin reports its own version without needing a daemon. |
| `docker_version.not_installed.txt` / `.not_installed.meta.json` | `docker version --format '{{json .}}'` | deployer | 127 | **Captured** from the plain image (no `docker` CLI at all). `stdout` is empty; `.meta.json`'s `stderr` is `"sh: 1: docker: not found\n"`. This is the "not installed" shape — distinguishable from the above by exit code and by stdout containing no JSON at all, never by a `JSON.parse` try/catch alone. |
| `docker_compose_version.not_installed.txt` / `.not_installed.meta.json` | `docker compose version --short` | deployer | 127 | Same shape as `docker_version.not_installed.*`. |

## Captured vs. derived

**Every file above is captured** — real stdout/stderr/exit-code bytes
from a real container, never invented. 02-04-PLAN.md's Task 2 also
requires recording that one shape is **not** capturable from this
fixture matrix: the "Docker daemon present and responding" case (a
populated, non-null `.Server` key in `docker version`'s JSON). Building a
real, working Docker-in-Docker daemon inside the sshd fixture image is
out of scope for this phase's Testcontainers setup. Any future test that
needs that branch must construct its input as a **derived** fixture —
explicitly hand-written from Docker's own documented JSON schema and
labelled as derived, never saved into this directory as if it were
captured — so a reader can never mistake a derived sample for measured
reality (docs/adr/0004-ssh-adapter-empirical-contracts.md records this
gap explicitly).
