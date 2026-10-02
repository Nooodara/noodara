---
phase: 11-motor-de-deploy-fundamentos
plan: 13
subsystem: ssh
tags: [ssh, allowlist, deploy-templates, security, tdd]
requires: ["11-02", "11-09"]
provides:
  - "DEPLOY_COMMAND_NAMES (27 names) and DeployCommandName, with an exactness guard"
  - "RemoteCommand brand (module-private), renderRemoteCommand, frozen SHELL_SCRIPTS"
  - "27 closed builders: git.*, fs.*, secrets.*, process.*, docker.*"
  - "tests/integration/deploy-engine/deploy-templates.test.ts: real round-trip on Ubuntu 22.04 and 24.04"
affects: [11-14, 11-15, 12]
tech-stack:
  added: []
  patterns: ["RemoteCommand only from commands/", "secrets on stdin to constant sh -c scripts", "SEC transcript canary in integration suites"]
key-files:
  created:
    - packages/ssh/src/commands/remote-command.ts
    - packages/ssh/src/commands/shell-scripts.ts
    - packages/ssh/src/commands/deploy-allowlist.ts
    - packages/ssh/src/commands/git.ts
    - packages/ssh/src/commands/workspace.ts
    - packages/ssh/src/commands/docker-deploy.ts
    - packages/ssh/src/testing/deploy-templates.ts
    - packages/ssh/src/testing/shell-round-trip.ts
    - tests/integration/deploy-engine/deploy-templates.test.ts
  modified:
    - packages/ssh/src/commands/index.ts
    - vitest.shared.ts
decisions:
  - "ADR 0008 wins over the plan text (see ADR overrides)"
  - "process.group_alive = pgrep -g on the pidfile pgid, proven with a supervised docker build"
  - "Per-run test secrets come from crypto.randomBytes; the suite asserts none reaches argv or output"
metrics:
  completed: 2026-10-01
  tasks: 3
---

# 11-13 Summary: deploy allowlist templates

## Done

- Task 1 (de82491 RED, ce77a51 GREEN): `RemoteCommand` brand, `SHELL_SCRIPTS`, the
  27-name registry and its guard (scans, POSIX round-trip, `@ts-expect-error` against forging).
- Task 2 (d73976f, 0b6e76e): git, workspace, secret and process builders.
- Task 3 (486871a, 05fabc2, 9abadd7): docker builders, forbidden-flag guard, barrel without
  `createRemoteCommand`.
- Round-trip on the real fixture (0b88160 wip, finished under agent-flow): every remote command is
  a builder's output passed through `renderRemoteCommand`. Green on Ubuntu 22.04 and 24.04.
  - G1: workspace 700, secret file 600 with the exact stdin bytes; login `--password-stdin` into
    the per-deployment `--config`, pull through it, logout leaves no auth; pull without login fails.
  - git: supervised deploy-key clone, `head_sha`, `checkout --detach`, `probe_features` 0/0 and 1/1,
    no recursion, no key path in `.git/config`.
  - A2: `process.group_alive` exits 0 during a supervised `docker build`, `kill_group` empties the
    group, `group_alive` then exits 1; missing pidfile never reports alive.
  - docker lifecycle with G4 NDJSON `ps` (`Size` = `0B`), labels, log-opts, restart policy.
- SEC: unit canaries (`workspace.test.ts`) run the secret and askpass templates in a real `/bin/sh`
  with `randomBytes` canaries; the integration suite keeps a transcript of every command line and
  output and its last test asserts no token, file canary, registry password or deploy key line in it.

## ADR overrides

ADR 0008 wins where the pre-spike plan text differs:

| Plan text | Implemented (ADR 0008) | Why |
|---|---|---|
| `kill -TERM -- "-$pgid"` | `kill -s TERM -- "-$pgid"` | dash rejects `-TERM` (exit 2, nothing killed) |
| `setsid sh -c ...` | `setsid -w sh -c ...` | plain `setsid` forks and reports exit 0 before the command ends |
| docker ps without size flag | `--all --no-trunc --size=false --filter label=noodara.managed=true --format '{{json .}}'` | `{{json .}}` computes Size unless `--size=false` |
| git exit codes distinguish failures | not used by the templates; failures classified by text | git exits 128 for every clone failure class |

Other deviations:

- `docker stop/restart` use `--timeout` instead of `--time` (Docker 29 deprecates `--time`).
- `fs.prepare_workspace` is `sh -c 'umask 077 && mkdir -p "$0/secrets" "$0/run"'`, not
  `mkdir -p -m 0700` (`-m` only applies to the last directory).

## Open items

- ADR 0008 is still `Proposed`; the plan gate asked for `Accepted`. Executed per the orchestrator
  rule "ADR wins"; acceptance stays with the user (OPEN_QUESTIONS 2).
- `DEPLOY_SECRET_NAMES` has no askpass entry; the integration test uses the `known_hosts` slot.
  Phase 12 adds it together with the HTTPS token clone (OPEN_QUESTIONS 4).
- `gitClone(https_token)` is not run end-to-end: the fixture has no HTTPS git host.
