---
phase: 11-motor-de-deploy-fundamentos
plan: 15
subsystem: deploy-engine
tags: [git, docker, ssh-adapter, security, tdd]
requires: ["11-13", "11-14"]
provides:
  - "@noodara/git: cloneRepository (prepare, credential over stdin, supervised shallow clone, head SHA, feature probe)"
  - "@noodara/docker: pull/build/network/container/inspect/ps/workspace wrappers, one template each, classified with classifyDockerError"
  - "Shared StepResult/StepLimits shape (mirrored in both packages)"
affects: [12]
tech-stack:
  added: []
  patterns: ["runStep + notCompleted: transport loss -> SERVER_UNREACHABLE, usage errors rethrown", "secrets registered with the redactor for the whole call"]
key-files:
  created:
    - packages/git/ (package.json, turbo.json, tsconfig*, src/{index,clone-repository,run-step,step-result}.ts, src/clone-repository.test.ts)
    - packages/docker/ (package.json, turbo.json, tsconfig*, src/{index,docker-operations,run-step,step-result}.ts, src/docker-operations.test.ts)
  modified:
    - turbo.json (ssh-adapter may depend on ssh-adapter)
    - vitest.shared.ts (aliases @noodara/git, @noodara/docker)
    - pnpm-lock.yaml (two workspace importers only)
decisions:
  - "pullImage runs fs.prepare_workspace first: the supervised pull writes its pidfile in runDir"
  - "logout runs after a successful login even if the pull failed or was aborted, without the caller signal"
  - "HTTPS askpass file reuses the known_hosts secret slot (no askpass entry in DEPLOY_SECRET_NAMES)"
  - "restartContainer classifies as start; removeWorkspace/removeImage as remove"
metrics:
  completed: 2026-10-01
  tasks: 2
---

# 11-15 Summary: @noodara/git and @noodara/docker

## Done

- Task 1 (709c72a RED, 298415d GREEN): `cloneRepository` with deploy key, HTTPS token or no
  credential. Secrets go only over stdin, are registered with the redactor before the first step
  and released in `finally`. LFS/submodules -> UNSUPPORTED_REPOSITORY_FEATURE; unparseable probe or
  bad SHA -> CLONE_FAILED.
- Task 2 (49181c7 RED, 88bd932 GREEN): 13 Docker wrappers. Registry password only via
  `--password-stdin` into `workspace.dockerConfigDir`; names derived from branded ids
  (`noodara-<id>`, `noodara-net-<id>`, `noodara/<service>:<deployment>`). `ensureNetwork` treats
  "already exists" as success. Type-level tests reject build args, env vars, raw strings and a
  plain-string password.
- SEC canaries: per-run `crypto.randomBytes` secrets; a hostile remote echoing the secret never
  reaches argv, results or chunks; the redactor is clean after the call.

## Verification

`agent-flow gate --task 11-15`: test, typecheck, lint, boundaries, build green (build needs
`NOODARA_API_ORIGIN` set for apps/web).

## Open

- HTTPS token clone still not measured end to end (OPEN_QUESTIONS 4).
- `docker rm`/`network rm` on a missing object is not treated as success yet; Phase 12 decides.
