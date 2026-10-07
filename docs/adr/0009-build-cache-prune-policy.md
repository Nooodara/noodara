# ADR 0009: Build cache prune policy (D12)

## Status

Accepted — 2026-10-07

## Context

Every build leaves BuildKit cache on the server. Without a policy the cache grows until the disk
fills, which breaks every service on the host. A prune is host-wide: BuildKit cache is shared by
all builds on the server, not scoped to one service.

## Decision

- After a deployment ends `SUCCESS`, the worker runs `docker builder prune --force --filter until=168h`
  (template `docker.builder_prune`, no parameters, no `--all`). Only cache unused for 7 days goes;
  images, containers and recent cache are untouched.
- At most once per server per 24 h: the worker takes the Redis key `noodara:build-cache-prune:<serverId>`
  with `SET NX EX 86400` before the prune, so concurrent deployments on one server run one prune.
- Not while another deployment on that server is `BUILDING`: the prune is skipped without taking the key
  and a later deployment retries.
- The prune has a hard timeout (120 s). Redis failure skips the prune. A failed or timed-out prune
  deletes the key so the next deployment retries instead of waiting 24 h.
- The outcome never changes the deployment: failures are logged by error class only, and the prune
  output (which can list cache ids) is not logged, persisted or sent to the build log.

## Disable

`NOODARA_BUILD_CACHE_PRUNE=off` (default `on`; any other value fails boot with
`NOODARA_CONFIG_ERROR NOODARA_BUILD_CACHE_PRUNE`). With `off` no prune command is issued and no
Redis key is touched. Servers that share Docker with other workloads whose build cache matters
should set it to `off`.

## Consequences

- A build right after a prune may rebuild layers older than 7 days.
- Proof: unit tests in `build-cache-prune.test.ts`; `runtime-pipeline` (14-10 A3) shows one prune
  for two consecutive deployments and the running container and its image intact.
