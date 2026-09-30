# Deployment command fixtures

Real output from the deploy-engine fixture host
(`tests/integration/images/sshd-dockerd-ubuntu-{22.04,24.04}`, nested dockerd
with install.sh's Docker packages), run as deployer over SSH. Never hand-edit:
re-capture with

```sh
NOODARA_CAPTURE_FIXTURES=1 NOODARA_TEST_UBUNTU=all pnpm exec vitest run \
  --config vitest.integration.config.ts tests/integration/deploy-engine/contracts-g3-g4.test.ts -t G4
```

Captured 2026-09-30 (UTC), macOS arm64 host (so `Platform.architecture` is
`arm64`; x86_64 CI would give `amd64`). Docker client/server 29.8.1, API 1.56,
on both versions. UUIDs, IDs, timestamps and relative times are from that run.

## docker_ps.ndjson (11-07, G4)

Chosen template, verbatim:

```sh
docker ps --all --no-trunc --size=false --filter label=noodara.managed=true --format '{{json .}}'
```

Three containers, all labelled `noodara.managed=true`, `noodara.service_id`,
`noodara.deployment_id`, `noodara.test=true`: one running (`sleep 3600`,
`-p 18080:3000`, own network `noodara-net-<uuid>`), one exited with code 3,
one created and never started. Newest first. One JSON object per line, file
ends with `\n`.

Key set, identical on 22.04 and 24.04:

```text
Command CreatedAt HealthStatus ID Image Labels LocalVolumes Mounts Names
Networks Platform Ports RunningFor Size State Status
```

Shapes the parser (11-10) must accept:

- `Platform` is an object (`{"architecture","os","variant"}`); every other field is a string.
- `Labels` is one comma-joined `k=v` string; `Ports` is a comma-joined string with
  `->` JSON-escaped as `>`, empty for non-running containers.
- `Command` keeps its surrounding double quotes.
- `Status`: `Up Less than a second`, `Exited (3) Less than a second ago`, `Created`.
- `Networks` reads `bridge` for the exited and created containers (default network).

`--size=false` is required. Without any size flag, `{{json .}}` still makes
the CLI compute sizes, because the template references `.Size`; the value is
then e.g. `4.1kB (virtual 173MB)`, the same as with `--size`. With
`--size=false` it is `0B`. With 50,000 files in one container's writable layer
the median remote wall time was 95-130 ms without the flag or with `--size`,
and 25-37 ms with `--size=false` (5 runs each, two runs per version, see
11-07-SUMMARY.md).

## docker_inspect_state_{running,exited}.json (11-07, G4)

```sh
docker inspect --type container --format '{{json .State}}' -- <name>
```

For the running and the exited (code 3) container above. Key set, identical on
both versions and both states: `Dead Error ExitCode FinishedAt OOMKilled Paused
Pid Restarting Running StartedAt Status`. A running container has
`FinishedAt: "0001-01-01T00:00:00Z"`. No `Health` key when the image has no
healthcheck.
