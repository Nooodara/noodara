---
phase: 11-motor-de-deploy-fundamentos
plan: 02
subsystem: domain
tags: [validators, branded-types, git, docker, security, tdd]
requires: []
provides:
  - "@noodara/domain/validators: Brand, validateRepositoryUrl, validateGitBranch, validateCommitSha"
  - "@noodara/domain/validators: validateImageRef, registry/path/target/port/object-id validators, containerNameFor, networkNameFor, deploymentImageRefFor, deployWorkspaceFor, resolveRepoBuildPaths, DEPLOY_SECRET_NAMES, SUPERVISED_OPERATIONS"
  - "@noodara/domain/validators: SERVICE_SOURCE_TYPES, ServiceSource, validateServiceSource"
affects: [11-05, 11-13, 11-14, 11-15]
tech-stack:
  added: []
  patterns: ["Brand<T, B> = T & { readonly __brand: B } for every validated value", "per-shape parsing with dangerous-character checks first and one named code per rule"]
key-files:
  created:
    - packages/domain/src/validators/branded.ts
    - packages/domain/src/validators/git.ts
    - packages/domain/src/validators/git.test.ts
    - packages/domain/src/validators/docker-naming.ts
    - packages/domain/src/validators/docker-naming.test.ts
    - packages/domain/src/validators/service-source.ts
    - packages/domain/src/validators/service-source.test.ts
  modified:
    - packages/domain/src/validators/index.ts
decisions:
  - "Repository URL check order: empty, length, metacharacters, whitespace, then ? and # as REPOSITORY_URL_QUERY_OR_FRAGMENT, then shape"
  - "[ and ] count as metacharacters except as a well-formed bracketed IPv6 host"
  - "Hostnames must survive WHATWG URL host parsing unchanged; this rejects IPv4 shorthands like 127.1, 0x7f.0.0.1 and 2130706433"
  - "IPv4 literals with leading zeros and multicast/broadcast (>=224) are rejected as non-public"
  - "ssh:// URLs require a user (REPOSITORY_URL_INVALID_USER when missing)"
  - "Branch segments may not start with '.' or end with '.lock' (per segment, not only at the end)"
  - "Dockerfile path is relative to the repository root, not to the build context"
metrics:
  duration: "~12 min"
  completed: 2026-09-29
  tasks: 3
  files: 8
---

# Phase 11 Plan 02: SVC-08 validation vocabulary Summary

Branded types and validators for repository URL (D-05/D-06), branch (D-08), commit SHA, image reference (D-07), registry, build paths, ports, Docker ids, UUID-derived names and the deploy workspace. `ServiceSource` has no build-arg or env field and rejects extra keys by name (DEP-08).

## Tasks

| Task | RED | GREEN | Notes |
|------|-----|-------|-------|
| 1. Branded types, repo URL, branch, SHA | 4da78bc | 5a495f2 | 169 tests |
| 2. Docker naming, image ref, workspace | edd5791 | 45de4e3 | 138 tests |
| 3. ServiceSource + barrel | 5e1394b | bfa8d9e | 40 tests incl. expectTypeOf |

## Verification

- `pnpm exec vitest run packages/domain`: 27 files, 1036 tests passed (purity.test.ts included)
- Coverage on `packages/domain/src/validators/**`: 100% statements, branches, functions, lines
- `pnpm test`: 208 files, 3797 tests passed
- `pnpm typecheck` and `pnpm lint`: green (no export-name collisions in the root barrel)

## Deviations from Plan

### Test adjustments during GREEN (Task 1)

- `[not-ipv6]` and an unterminated `[2001:db8::1` report `REPOSITORY_URL_CONTAINS_METACHARACTER`, not `INVALID_HOST`, because a bracket is only allowed as a well-formed IPv6 host. They moved to a separate case. `[1:2:3]` covers the invalid-IPv6-host path instead.
- Fixed the "hostname too long" case (the original fixture was 247 chars, under the limit). Added `[::ffff:a00:1]` to cover IPv4-mapped IPv6.
- The implementation also had a bug: `/main` was not rejected as a boundary. Fixed in the GREEN commit.

No other deviations. No integration tests touched.

## Known Stubs

None.

## Self-Check: PASSED

- All 8 files exist; commits 4da78bc, 5a495f2, edd5791, 45de4e3, 5e1394b, bfa8d9e are in `git log`.
