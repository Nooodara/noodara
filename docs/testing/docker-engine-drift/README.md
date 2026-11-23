# Docker Engine 29.10 drift: ADR 0010 A2 `-prev` contract (task 37-01)

Evidence for the amendment of ADR 0010 A2 (2026-11-23). No hostnames, usernames or environment
dumps are recorded; container and network names carry fresh per-run UUIDs.

## Nightly runs (same deploy-engine job, `contracts-v03`)

| Run | Source | Engine in the fixture (`[G1]`/`[G2]` versions line) | Result |
|---|---|---|---|
| `43581697263` (2026-11-14) | `784ca1b6` | 29.9.3 | success |
| `44073612196` (2026-11-17) | `784ca1b6` | 29.10.0 | failure, 22.04 and 24.04, `contracts-v03.test.ts:944:40` |
| `45013137566` (2026-11-22) | `34b81ddd` (docs-only after `784ca1b6`) | 29.10.0 | failure, 22.04 and 24.04, `contracts-v03.test.ts:944:40` |

Same source, different engine, different result: the fixture installs the current `docker-ce`
from Docker's apt repository on every uncached build (as `install.sh` does for users).

## Local RED on a fresh engine (2026-11-23)

The cached local fixture images reported Engine 29.9.2, which is not valid evidence. Both
fixtures were rebuilt with the classic builder and `--no-cache` (no apt layer reused):

| Fixture | `dockerd --version` | `docker-ce` package |
|---|---|---|
| `sshd-dockerd-ubuntu-22.04` | 29.10.0, build 06db173 | `5:29.10.0-1~ubuntu.22.04~jammy` |
| `sshd-dockerd-ubuntu-24.04` | 29.10.0, build 06db173 | `5:29.10.0-1~ubuntu.24.04~noble` |

The images Testcontainers built for the run reported the same 29.10.0. The unchanged test
`PREV / ADR 0010 / A2: starting -prev while the new container holds the port fails AND detaches
-prev ...` failed on both versions at the same line as the nightlies:

```text
AssertionError: expected [ Array(1) ] to deeply equal []
- []
+ [ "noodara-net-<uuid>" ]
 ❯ tests/integration/deploy-engine/contracts-v03.test.ts:944:40   expect(await networkNames(prev)).toEqual([])
```

## Observed on 29.10.0 after the blocked `docker start <-prev>`

- `docker start` exits non-zero with the port conflict; the new container keeps answering 202.
- `-prev` stays `exited` with exactly one endpoint key, `noodara-net-<serviceId>`, whose
  `IPAddress` and `EndpointID` are empty: `attached` for both the test and `restorePrevious`
  (`networkAddress` kind `none`).
- A redundant `docker network connect <net> <-prev>` on the stopped, still-attached container
  exits 0 with no output and leaves the networks unchanged (measured twice in a row). This
  contradicts hardening criterion H3 of task 37-01, which expected a non-zero exit with an
  endpoint-already-exists message; the test records the outcome (`redundantConnect`) instead.
- The plain restore (rm new, rename `-prev` back, start, no connect) answers 201 with
  networks `[noodara-net-<serviceId>]`.

## Gate results on 29.10.0 (local, scale 1, 2026-11-23)

`agent-flow gate --task 37-01`: `test`, `typecheck`, `lint`, `boundaries`, `it-contracts-v03`
(`NOODARA_TEST_UBUNTU=all`) and `it-runtime-rollback-all` (`NOODARA_TEST_UBUNTU=all`) all
passed, at scale 1, on macOS arm64 Docker Desktop. The fixture images Testcontainers built for
the run report `Docker version 29.10.0, build 06db173` on 22.04 and on 24.04. Measure lines of
the renamed A2 test (`NOODARA_MEASUREMENTS_FILE`, container ids elided):

```text
[V03-PREV] {"ubuntu":"22.04","case":"failed start of -prev","engine":"29.10.0","branch":"attached","attachedIpEmpty":true,"blockedStart":"Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint noodara-<uuid>-prev (<id>): Bind for 0.0.0.0:18080 failed: port is already allocated","redundantConnect":"accepted","swapToFirstAnswerMs":422}
[V03-PREV] {"ubuntu":"24.04","case":"failed start of -prev","engine":"29.10.0","branch":"attached","attachedIpEmpty":true,"blockedStart":"Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint noodara-<uuid>-prev (<id>): Bind for 0.0.0.0:18080 failed: port is already allocated","redundantConnect":"accepted","swapToFirstAnswerMs":428}
```

Only the `attached` branch ran locally (29.10.0). The `detached` branch keeps the original
29.9.x assertions and is exercised only on an engine that drops the endpoint; the CI/nightly
confirmation of task 37-02 remains mandatory.

## Unit coverage of `restorePrevious` (`packages/docker/src/runtime-operations.test.ts`)

Already present before 37-01: `renames -prev back, keeps an attached network and starts it`
(attached, no connect), `re-attaches a detached container to its network while stopped, before
start` (detached, connect), `an unreadable network list stops before start` (invalid JSON,
ROLLBACK_FAILED), `a failed network connect stops before start`.

Added by 37-01: `a truncated network list is ROLLBACK_FAILED and connects and starts nothing`,
`H4: a container on another network only (bridge) is detached from its own and is connected
before start`, `H4: a failed network inspect stops before any connect or start`. The product
already handled these cases, so they passed on first run; a temporary local mutation of
`restorePrevious` (ignore truncation, treat any network as attached, treat an inspect failure as
attached) made each of them fail, and the product file was restored unchanged.
