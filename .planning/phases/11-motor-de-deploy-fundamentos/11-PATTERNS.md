# Phase 11: Motor de deploy — fundamentos - Pattern Map

**Mapped:** 2026-09-29
**Files analyzed:** ~30 new/modified files (domain, ssh, git/docker packages, schema, fixtures, test infra, ADR, CI)
**Analogs found:** 24 / 30

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/domain/src/deployment/deployment-state.ts` | model (state machine) | event-driven | `packages/domain/src/server/server-state.ts` | exact |
| `packages/domain/src/deployment/deployment-state.test.ts` | test | event-driven | `packages/domain/src/server/server-state.test.ts` | exact |
| `packages/domain/src/service/derive-service-status.ts` | utility (pure fn) | transform | `packages/domain/src/discovery/merge-facts.ts` (`classifySnapshotOutcome`) | role-match |
| `packages/domain/src/validators/git.ts` | utility (validator) | transform | `packages/domain/src/validators/network.ts` (`validateHost`) | exact |
| `packages/domain/src/validators/docker-naming.ts` | utility (validator) | transform | `packages/domain/src/validators/identity.ts` (`validateServerName`) | exact |
| `packages/domain/src/validators/git.test.ts`, `docker-naming.test.ts` | test | transform | identity/network validator tests (same dir) | exact |
| `packages/domain/src/discovery/buildkit.ts` | utility (parser) | transform | `packages/domain/src/discovery/docker-version.ts` | exact |
| `packages/domain/src/discovery/types.ts` (extend) | config/types | transform | same file, `DISCOVERY_CHECK_IDS`/`DiscoveryFacts` | exact |
| `packages/domain/src/discovery/merge-facts.ts` (extend `FACTS_KEYS`) | utility | transform | same file | exact |
| `packages/ssh/src/commands/git.ts` | service (command template) | request-response | `packages/ssh/src/commands/docker.ts` | exact |
| `packages/ssh/src/commands/fs.ts` | service (command template) | request-response | `packages/ssh/src/commands/docker.ts` | exact |
| `packages/ssh/src/commands/docker.ts` (additions: build/pull/create/start/stop/restart/remove/inspect/logs/ps) | service (command template) | request-response | same file (existing `DOCKER_COMMANDS`) | exact |
| `packages/ssh/src/commands/kill.ts` | service (remote primitive) | request-response | `packages/ssh/src/commands/docker.ts` + `allowlist.ts` | role-match |
| `packages/ssh/src/commands/allowlist.ts` (grows) / `allowlist.test.ts` (exactness guard update) | config / test | request-response | same files | exact |
| `packages/ssh/src/exec-streaming.ts` | service (streaming exec) | streaming | `packages/ssh/src/exec-with-timeout.ts` | exact |
| `packages/ssh/src/git-error-classifier.ts` | service (error table) | transform | `packages/ssh/src/error-classifier.ts` | exact |
| `packages/ssh/src/docker-error-classifier.ts` | service (error table) | transform | `packages/ssh/src/error-classifier.ts` | exact |
| `packages/ssh/src/testing/generate-deploy-keys.ts` | utility (test helper) | file-I/O | `packages/ssh/src/testing/generate-keys.ts` | role-match (do not extend, Pitfall 4) |
| `packages/git/` (new package: `package.json`, `tsconfig.json`, `src/index.ts`) | service package | request-response | `packages/ssh/package.json` + `tsconfig.json` | exact |
| `packages/docker/` (new package) | service package | request-response | `packages/ssh/package.json` + `tsconfig.json` | exact |
| `apps/control-plane/src/db/schema/projects.ts` | model (Drizzle schema) | CRUD | `apps/control-plane/src/db/schema/servers.ts` | role-match |
| `apps/control-plane/src/db/schema/environments.ts` | model (Drizzle schema, composite FK parent) | CRUD | `servers.ts` + Drizzle composite-FK doc pattern (in RESEARCH) | role-match |
| `apps/control-plane/src/db/schema/services.ts` | model (Drizzle schema, composite FK child + 2 credential FKs) | CRUD | `servers.ts` (credential_id FK pattern) | role-match |
| `apps/control-plane/src/db/schema/deployments.ts` | model (Drizzle schema, append-only + partial unique idx) | CRUD | `servers.ts` (enum-from-domain-constant pattern) | role-match |
| `apps/control-plane/src/db/schema/deployment-log-chunks.ts` | model (Drizzle schema) | CRUD | `servers.ts` (simplest table shape) | partial-match (no direct analog for log-chunk shape) |
| `apps/control-plane/src/db/schema/credentials.ts` (extend enum + `public_key` column) | model (Drizzle schema) | CRUD | same file | exact |
| `apps/control-plane/src/db/migrations/0005_*.sql` + `meta/` | migration | batch | `0004_phase9_user_preferences.sql` + `meta/` | exact |
| `tests/integration/deploy-engine/contracts.test.ts` | test (contract/spike) | event-driven | `tests/integration/ssh/contracts.test.ts` | exact |
| `tests/integration/images/sshd-dockerd-ubuntu-{22.04,24.04}/Dockerfile` | config (test image) | file-I/O | `tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile` + `sshd-ubuntu-22.04/Dockerfile` | exact (merge of two) |
| `tests/integration/helpers/deploy-engine.ts` (or similar fixture helper) | utility (test helper) | file-I/O | `tests/integration/helpers/ssh.ts` + `installer-dind.ts` | exact |
| `fixtures/node-api`, `fixtures/static-app`, `fixtures/failing-build` | config (fixture) | file-I/O | none in-repo (new concept) | no-analog |
| `docs/adr/0008-deploy-engine-empirical-contracts.md` | docs | — | `docs/adr/0004-ssh-adapter-empirical-contracts.md` | exact |
| `.github/workflows/ci.yml`, `nightly.yml` (matrix extension) | config (CI) | batch | same files, existing `integration` job | exact |

## Pattern Assignments

### `packages/domain/src/deployment/deployment-state.ts` (model, event-driven)

**Analog:** `packages/domain/src/server/server-state.ts` (126 lines) — copy verbatim structure, adapt values.

**Core pattern** (whole file is the template; key excerpt, lines 6-39):
```typescript
export const SERVER_STATUSES = [
  'PENDING', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'UNREACHABLE', 'ERROR',
] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

const TRANSITIONS: Readonly<Record<ServerStatus, readonly ServerStatus[]>> = Object.freeze({
  PENDING: ['CONNECTING'],
  CONNECTING: ['CONNECTED', 'UNREACHABLE', 'ERROR'],
  // ...
} satisfies Record<ServerStatus, readonly ServerStatus[]>);
```
For `DeploymentStatus`, RESEARCH.md already gives the adapted 7-state, no-cycle version (append-only, no reason-gated edges needed since Deployment has no `TransitionReason` concept unless the planner decides otherwise):
```typescript
export const DEPLOYMENT_STATUSES = [
  'QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING', 'SUCCESS', 'FAILED', 'CANCELLED',
] as const;
```
Copy `InvalidTransitionError` (lines 56-66), `canTransition` (82-85), and `transition()` (111-126) verbatim, dropping `TransitionReason`/`REASON_REQUIRED`/`MissingTransitionReasonError`/`canTrustFingerprint` entirely — Deployment has no reason-gated edges (confirmed by RESEARCH.md Pattern: State machine).

**Error handling pattern:** `InvalidTransitionError extends Error` with `from`/`to` fields (lines 56-66) — copy exactly, rename nothing but the class if desired.

---

### `packages/domain/src/deployment/deployment-state.test.ts` (test, event-driven)

**Analog:** `packages/domain/src/server/server-state.test.ts`

**Test structure pattern** (lines 1-60): hand-written `ALLOWED_EDGES` list independent of the implementation, mechanically generate the full N² cross-product from the frozen tuple (`SERVER_STATUSES.flatMap(...)`), then assert every pair either matches an allowed edge or throws `InvalidTransitionError`. For Deployment (7 states, no cycles, no reason gates) this becomes a 49-pair cross-product with a much shorter `ALLOWED_EDGES` list and no `REASON_FOR_EDGE`/`ALL_REASONS` section. Keep `≥95% branch` coverage requirement (CLAUDE.md §3.1).

---

### `packages/domain/src/service/derive-service-status.ts` (utility, transform)

**Analog:** `packages/domain/src/discovery/merge-facts.ts`'s `classifySnapshotOutcome` (lines 44-74) — pure classification function pattern, not a state machine: takes a list of inputs, filters "relevant" ones, returns one of a small closed union. `deriveServiceStatus` should follow the same shape: pure, no I/O, takes the latest deployment(s) and returns a status, never throws.

```typescript
// Source: packages/domain/src/discovery/merge-facts.ts lines 56-74, structural pattern to copy
export function classifySnapshotOutcome(
  checks: readonly { status: DiscoveryCheckStatus }[],
): SnapshotOutcome {
  const relevant = checks.filter((check) => isRelevant(check.status));
  if (relevant.length === 0) return 'failed';
  const passCount = relevant.filter((check) => check.status === 'pass').length;
  if (passCount === relevant.length) return 'ok';
  if (passCount === 0) return 'failed';
  return 'partial';
}
```
D-05 note from CONTEXT.md: `UNKNOWN !== STOPPED`, must be a distinct value in the returned union — mirror `DockerVersionResult`'s 4-way discriminated union style (`packages/domain/src/discovery/docker-version.ts` lines 18-22) rather than a boolean or nullable.

---

### `packages/domain/src/validators/git.ts` / `docker-naming.ts` (utility validators, transform)

**Analog:** `packages/domain/src/validators/network.ts` (`validateHost`, lines 54-115) and `packages/domain/src/validators/identity.ts` (`validateServerName`, lines 33-41).

**Imports / shared type pattern** (identity.ts lines 1-5):
```typescript
import { type ValidationResult, fail, ok } from './network.js';
```
Every new validator (`validateRepositoryUrl`, `validateGitRef`, `validateImageRef`, `validateContainerName`, `validateDeployWorkspacePath`) must return this same `ValidationResult<T>` shape — never throw, never return a bare boolean.

**Core validation pattern** (network.ts lines 60-115, `validateHost`): branch explicitly on each shape (never one catch-all regex), check the most dangerous input class first:
```typescript
const SHELL_METACHARACTER_PATTERN = /[;|&$`()<>]/;
// ...
export function validateHost(input: string): ValidationResult<string> {
  if (SHELL_METACHARACTER_PATTERN.test(input)) {
    return fail('HOST_CONTAINS_METACHARACTER', 'Host must not contain a shell metacharacter (;|&$`()<>)');
  }
  if (input.length === 0) return fail('HOST_EMPTY', 'Host must not be empty');
  if (/\s/.test(input)) return fail('HOST_CONTAINS_WHITESPACE', 'Host must not contain whitespace');
  // ... branch further, return ok(normalized) at the end
}
```
Apply this exact "shell metacharacters checked first, named `fail` code per rejection reason" discipline to `validateRepositoryUrl` (D-05: reject `http://`/`git://`/`file://`, embedded creds, query/fragment, `..`, newlines, spaces), `validateGitRef` (D-08: character class + boundary checks), `validateImageRef` (D-07: mandatory tag/digest). Branded types: wrap the `ok()` value in a nominal type the same way — no branded-type example exists yet in this repo for a string (identity.ts returns plain strings); the planner should introduce something like `type RepositoryUrl = string & { readonly __brand: 'RepositoryUrl' }` as new infrastructure, since D-05..D-09 explicitly ask for branded types where `identity.ts`/`network.ts` currently return plain validated strings.

**Test pattern:** one `describe` block per validator, one `it` per rejection code plus one for the success path — mirror `network.ts`'s and `identity.ts`'s existing (unread but implied by ) sibling `.test.ts` files' per-code coverage.

---

### `packages/domain/src/discovery/buildkit.ts` (utility parser, transform)

**Analog:** `packages/domain/src/discovery/docker-version.ts` (full file, 99 lines) — "detect, don't infer" pattern.

**Core pattern** (lines 18-22, 37-74):
```typescript
export type DockerVersionResult =
  | { readonly kind: 'not_installed' }
  | { readonly kind: 'daemon_unreachable'; readonly clientVersion: string }
  | { readonly kind: 'installed'; readonly clientVersion: string; readonly serverVersion: string }
  | { readonly kind: 'unparseable'; readonly reason: string };

export function parseDockerVersion(input: CommandOutput): DockerVersionResult {
  const stdout = input.stdout.trim();
  if (input.exitCode === COMMAND_NOT_FOUND_EXIT_CODE && stdout.length === 0) {
    return { kind: 'not_installed' };
  }
  if (stdout.length === 0) return { kind: 'unparseable', reason: 'Command produced no output' };
  let parsed: unknown;
  try { parsed = JSON.parse(stdout) as unknown; } catch { return { kind: 'unparseable', reason: 'Output was not valid JSON' }; }
  // ... narrow further, never throw
}
```
`BuildKitStatus` (already sketched in RESEARCH.md) follows the identical shape:
```typescript
export type BuildKitStatus =
  | { readonly kind: 'active' }
  | { readonly kind: 'plugin_missing' }
  | { readonly kind: 'unparseable'; readonly reason: string };
```
Same `CommandOutput` interface (docker-version.ts lines 12-16) should be imported/reused, not redefined. Constant `COMMAND_NOT_FOUND_EXIT_CODE = 127` (line 10) — reuse for absent-binary detection.

**Integration point:** `packages/domain/src/discovery/types.ts` — `DISCOVERY_CHECK_IDS` (lines 20-32) must gain one new id (e.g. `'docker_buildkit'`), and `DiscoveryFacts` (lines 53-66) gains the corresponding nullable field. `merge-facts.ts`'s `FACTS_KEYS` (lines 10-23) must add the same key or the new fact silently never merges (D-07's "null means not observed" rule, lines 25-29 of `merge-facts.ts`).

---

### `packages/ssh/src/commands/git.ts`, `fs.ts`, `docker.ts` additions (service, request-response)

**Analog:** `packages/ssh/src/commands/docker.ts` (existing, 7 lines) + `allowlist.ts` (40 lines).

**Full existing pattern to extend** (docker.ts, all 7 lines):
```typescript
// Docker/compose version templates (D-12). Structured output only — `--format` JSON and
// `--short`, never free-text parsing (RESEARCH Pitfall 6).
export const DOCKER_COMMANDS = {
  'docker.version': "docker version --format '{{json .}}'",
  'docker.compose_version': 'docker compose version --short',
} as const;
```
New frozen-string templates (e.g. `docker.ps`, `docker.pull`, `docker.stop`) that take **no argument** follow this exact frozen-object style. Templates that take a validated argument (build, run, git clone) must instead be **functions**, per RESEARCH.md's explicit new pattern:
```typescript
// Source: RESEARCH.md "Pattern: allowlist con plantillas parametrizadas"
import { escapeShellArg } from './allowlist.js';
import type { RepositoryUrl, GitRef, DeployWorkspacePath } from '@noodara/domain/validators';

export function gitClone(url: RepositoryUrl, ref: GitRef, targetDir: DeployWorkspacePath): string {
  return `git clone --depth 1 --branch ${escapeShellArg(ref)} -- ${escapeShellArg(url)} ${escapeShellArg(targetDir)}`;
}
```
Rule: branded type in → `escapeShellArg` wraps every interpolated value → `--` before positional args (mirrors `git.ts`'s own example). Never accept a raw `string`.

**Allowlist wiring** (`allowlist.ts` lines 1-18):
```typescript
import { ACCESS_COMMANDS } from './access.js';
import { DISCOVERY_COMMANDS } from './discovery.js';
import { DOCKER_COMMANDS } from './docker.js';

export const COMMAND_TEMPLATES = {
  ...DISCOVERY_COMMANDS,
  ...DOCKER_COMMANDS,
  ...ACCESS_COMMANDS,
} as const;
export type CommandName = keyof typeof COMMAND_TEMPLATES;
```
New `GIT_COMMANDS`/`FS_COMMANDS` objects (or function-exporting modules for parameterized ones) get spread in alongside the existing three.

**Test exactness guard pattern** (`allowlist.test.ts` lines 11-36): a hand-written `EXPECTED_COMMAND_NAMES` array asserted equal to `COMMAND_NAMES` in order and length, plus "no `${`", "no backtick", "no `$(`" source-text scans over every template (lines 40-66). This test **must be updated in the same plan** that adds each new template — RESEARCH.md and CONTEXT.md both call this out explicitly (D-02-adjacent discipline). Also update the `CommandName <-> DiscoveryCheckId correspondence` test (lines 96-101) only for discovery-related additions (BuildKit).

---

### `packages/ssh/src/commands/kill.ts` (service, request-response — G2 remote-kill primitive)

**Analog:** composition of `packages/ssh/src/commands/docker.ts` (template style) + D-04's fallback design already fixed in CONTEXT.md/RESEARCH.md. No existing single-file analog for "compose two shell primitives with a fallback" — write as a function returning the `setsid`+pidfile+`kill -- -pgid` command string, plus a second function for `docker kill <container>`, both following the same branded-type-in/escaped-out discipline as `git.ts`.

---

### `packages/ssh/src/exec-streaming.ts` (service, streaming)

**Analog:** `packages/ssh/src/exec-with-timeout.ts` (full file, 206 lines) — sibling module, not a rewrite.

**Structural shape pattern** (lines 21-27, 29-38):
```typescript
export interface ExecChannel {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'close', listener: (code: number | null, signal?: string) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void };
  destroy(): void;
}
export interface ExecWithTimeoutInput {
  readonly client: { exec(command: string, callback: (err: Error | undefined, channel: ExecChannel) => void): void };
  readonly commandName: CommandName;
  readonly timeoutMs: number;
  readonly redactor: Redactor;
}
```
`exec-streaming.ts` needs the same structural-typing discipline (never the concrete `ssh2` type) but must add: (1) stdin write support (`channel.write(secret)` + `channel.end()`, per G1's candidate 1), (2) an `AbortSignal` input for cancellation, (3) chunk-by-chunk callback/stream output instead of buffering to a single `ExecResult` at `close`.

**Bounded-accumulation pattern** (lines 40-102, `StreamAccumulator`/`appendChunk`/`trimIncompleteUtf8Tail`): reuse verbatim if streaming still needs a bounded byte cap per chunk; `MAX_OUTPUT_BYTES = 65_536` (line 11) is the existing constant — decide in the plan whether streaming reuses the same cap per line/chunk or a different reasoned default (CONTEXT.md leaves this to Claude's discretion, measured at verification).

**Settlement/timeout pattern** (lines 112-144, the `settle()` guard + `timedOut` flag): copy this exact single-flag settlement discipline to avoid the same double-resolve class of bug in the new streaming variant.

**Redaction on the way out** (lines 194-201): every stdout/stderr chunk passes through `redactor.redact(...)` before reaching the caller — non-negotiable per `packages/domain/src/security/redactor.ts` and CLAUDE.md §2.3.

---

### `packages/ssh/src/git-error-classifier.ts` / `docker-error-classifier.ts` (service, error table)

**Analog:** `packages/ssh/src/error-classifier.ts` (full file, 214 lines) — frozen, ordered rule table that never throws.

**Core pattern** (lines 22-32, 82-177):
```typescript
interface ClassificationRule {
  readonly name: string;
  readonly code: ServerErrorCode;
  readonly matches: (error: unknown, context: ClassifyContext) => boolean;
  readonly message: (error: unknown, context: ClassifyContext) => string;
}

export const ERROR_CLASSIFICATION_RULES: readonly ClassificationRule[] = Object.freeze([
  { name: 'auth-failed', code: 'AUTH_FAILED', matches: (error) => isClientAuthentication(error), message: () => '...' },
  // ... ordered, structured fields checked before message-string matches
  { name: 'unclassified-fallback', code: 'CONNECTION_LOST', matches: () => true, message: (error) => `...` },
]);
```
**Safe field access pattern** (lines 39-47, `safeStringField`): read every candidate field behind try/catch, since a hostile/malformed error object's getter can itself throw.

**Never-throws wrapper pattern** (lines 187-214, `classifySshError`): outer try/catch around the whole classification loop, plus inner try/catch around each rule's `matches`/`message` call individually, plus a `SAFE_FALLBACK_MESSAGE` constant returned when everything else fails. Copy this three-layer defense verbatim for `classifyGitError`/`classifyDockerError`, redacting every produced message with the same `Redactor` (line 205: `context.redactor.redact(message)`).

**Terminal fallback discipline:** the last rule always has `matches: () => true` and is a visible, named entry — never an implicit `else` (lines 162-176). DEP-08's `UNSUPPORTED_REPOSITORY_FEATURE` code (LFS/submodules, D-09) should be one named rule in `classifyGitError`'s table, not a special-cased branch outside it.

---

### `packages/git/`, `packages/docker/` (new packages)

**Analog:** `packages/ssh/package.json` + `packages/ssh/tsconfig.json` (both read in full above).

**package.json pattern:**
```json
{
  "name": "@noodara/git",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "turbo": { "tags": ["ssh-adapter"] },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint --config ../config/eslint.config.js .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --root ../.. --project packages"
  },
  "dependencies": { "@noodara/domain": "workspace:*", "@noodara/ssh": "workspace:*" },
  "devDependencies": { "@noodara/config": "workspace:*", "@types/node": "^22.12.0", "vitest": "5.0.0" }
}
```
`packages/docker` mirrors this with its own name. Both carry the `"ssh-adapter"` turbo tag (D-26) — `turbo.json` line 86 already has an `"ssh-adapter"` boundary group whose `allow` list (line 83, 93) needs `@noodara/git`/`@noodara/docker` added if they're meant to depend on/be depended-on across the same boundary group; verify exact `turbo.json` boundary block before editing (only lines 83-93 were grepped, read the full block in the plan).

**tsconfig.json pattern** (verbatim, only path differs):
```json
{
  "extends": "@noodara/config/tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

---

### `apps/control-plane/src/db/schema/{projects,environments,services,deployments,deployment-log-chunks}.ts` + `credentials.ts` extension

**Analog:** `apps/control-plane/src/db/schema/servers.ts` (76 lines) + `credentials.ts` (18 lines).

**Enum-from-domain-constant pattern** (servers.ts lines 16-19):
```typescript
import { SERVER_ERROR_CODES, SERVER_STATUSES } from '@noodara/domain/server';
export const serverStatusEnum = pgEnum('server_status', [...SERVER_STATUSES]);
export const serverErrorCodeEnum = pgEnum('server_error_code', [...SERVER_ERROR_CODES]);
```
`deployments.ts` must derive `deploymentStatusEnum` from `DEPLOYMENT_STATUSES` the same way — the DB enum and the TS union can never drift (same comment as servers.ts line 16-17).

**Credential FK + cascade-delete-in-transaction pattern** (servers.ts lines 33-35):
```typescript
credentialId: uuid('credential_id').notNull().references(() => credentials.id),
```
For `services.ts`, per D-17 (nullable, `ON DELETE RESTRICT`, two FKs):
```typescript
// Source: RESEARCH.md Code Examples, "Enum ampliado y FKs nullable"
repositoryCredentialId: uuid('repository_credential_id').references(() => credentials.id, { onDelete: 'restrict' }),
registryCredentialId: uuid('registry_credential_id').references(() => credentials.id, { onDelete: 'restrict' }),
```

**Credentials enum extension** (credentials.ts line 7, D-16):
```typescript
export const credentialTypeEnum = pgEnum('credential_type', ['ssh_private_key', 'ssh_password']);
// becomes:
export const credentialTypeEnum = pgEnum('credential_type', [
  'ssh_private_key', 'ssh_password', 'git_deploy_key', 'git_https_token', 'registry_password',
]);
```
Add `publicKey: text('public_key')` (D-18, nullable, plaintext) alongside the existing `encryptedValue`/`keyVersion` columns (credentials.ts lines 9-18) — same envelope, same `keyVersion` rotation column, no new crypto mechanism (Don't-Hand-Roll table).

**Unique-index-on-lowercase pattern** (servers.ts lines 67-74) — reuse for `projects`/`environments`/`services` name uniqueness scoped to parent, if the planner decides case-insensitive names apply here too:
```typescript
uniqueIndex('servers_name_lower_unique_idx').on(sql`lower(${table.name})`),
```

**Composite FK / partial-unique-index patterns**: not present in `servers.ts` (single-level ownership) — use RESEARCH.md's Drizzle-doc-sourced examples verbatim (already concrete code in RESEARCH.md "FK compuesta para ownership jerárquico" and "Índice parcial único para concurrencia" sections) since no existing schema file in this repo has a multi-level FK yet.

---

### `apps/control-plane/src/db/migrations/0005_*.sql`

**Analog:** `0004_phase9_user_preferences.sql` + its `meta/` snapshot — read the actual file content and drizzle-kit-generated `meta/_journal.json` entry before writing 0005 (not read in this pass; low risk, purely mechanical `drizzle-kit generate` output). Pitfall 3 (`ALTER TYPE ... ADD VALUE` in the same transaction as its use) applies directly — confirm drizzle-kit's per-file transaction behavior (Open Question 1 in RESEARCH.md) before finalizing.

---

### `tests/integration/deploy-engine/contracts.test.ts` (test, event-driven — G1-G4 permanent spikes)

**Analog:** `tests/integration/ssh/contracts.test.ts` (full file, 631 lines).

**Structural pattern to copy:**
- Raw `ssh2.Client`/`@noodara/ssh/testing` only, never a mock (header comment lines 1-8; `attemptConnect` helper lines 58-94).
- `describe.each(UBUNTU_VERSIONS)('Task N: ... (Ubuntu %s)', (ubuntu) => { ... })` for every spike that must run on both 22.04 and 24.04 (lines 263, 533).
- `afterEach` always calls `assertNoStrayTestContainers()` (lines 102-108, 266-270, imported from `../helpers/ssh.js`).
- One `describe` block per spike/task, one `it` per measured behavior with a long, evidence-citing title naming the exact ADR/open-question it resolves (e.g. line 110's title). Titles double as living documentation — keep this style for G1-G4.
- `ExecCapture`/`runAs` helper pattern (lines 252-261) for driving `container.exec(['sh', '-c', command], { user })` directly against the fixture when testing raw shell behavior (not through the SSH adapter).

**Evidence-gathering pattern** (lines 30-56, `describeError`/`ObservedError`): capture every field an error might carry, verbatim, never re-derived — reuse this shape for G1/G2 spike error observation.

---

### `tests/integration/images/sshd-dockerd-ubuntu-{22.04,24.04}/Dockerfile`

**Analog:** merge of `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` (sshd + optional docker CLI/slow-df) and `tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile` (real dockerd via Docker's apt repo, privileged nested daemon).

**Shared-context-via-COPY pattern** (both Dockerfiles' header comments + `COPY sshd-common/...`/`COPY installer-dind-common/...` lines): build context is `tests/integration/images/`, so the new sshd+dockerd image can `COPY sshd-common/setup-users.sh ...` and `COPY installer-dind-common/entrypoint.sh ...` (or a merged custom entrypoint) without duplicating scripts — same convention both existing families already use.

**ARG-gated optional layer pattern** (sshd Dockerfile lines with `ARG WITH_DOCKER_CLI=false` / installer-dind's `ARG WITH_DOCKER=true`): a single `RUN if [ "$ARG" = "true" ]; then ... fi` per optional feature, keeping the default image's layers shared/cached across variants.

**Docker apt-repo install pattern** (installer-dind Dockerfile, full apt-key + repo + install block) — this is the exact sequence to reuse for actually installing `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin` (per `install.sh` lines 518-519, cited in RESEARCH.md) inside the new combined image, since G3 must measure the real Docker that `install.sh` provisions.

**Bare Git repo + deploy keys (D-12):** no existing Dockerfile analog serves git-over-ssh; add a `git init --bare` step and an `authorized_keys` file populated at container start (mirroring `sshd-common/entrypoint.sh`'s pattern of generating `ed25519_locked` at start time, not build time, per `startSshd`'s per-run `SSH_TEST_KEY_PASSPHRASE` injection in `tests/integration/helpers/ssh.ts` lines 60-78) using the new `generate-deploy-keys.ts` helper.

---

### `tests/integration/helpers/deploy-engine.ts` (or similarly named new helper)

**Analog:** `tests/integration/helpers/ssh.ts` (full file, 232 lines).

**Fixture-lifecycle pattern** (lines 60-119, `startSshd`): `GenericContainer.fromDockerfile(IMAGES_CONTEXT, ...).withBuildArgs(...)`, `.withName(...)`, `.withLabels({ 'noodara.test': 'true' })` (mandatory, D-14), `.withEnvironment({...per-run secrets...})`, `.withWaitStrategy(Wait.forLogMessage(...))` — never a fixed sleep. Idempotent `stop()` guarded by a `stopped` flag (lines 104-109).

**Path resolution pattern** (lines 19-23): resolve the Dockerfile context from `import.meta.url`, never `process.cwd()`.

**Registry+htpasswd fixture (D-10):** no direct analog exists for a `registry:2` Testcontainers fixture; follow the same `GenericContainer(...).withLabels({'noodara.test': 'true'}).withWaitStrategy(...)` shape as `startBlackholeListener` (ssh.ts lines 180-196) for a plain (non-Dockerfile) image, since `registry:2` is pulled, not built.

**Reused exact helper:** `assertNoStrayTestContainers()` (ssh.ts lines 226-231) — import directly, do not reimplement, for the new deploy-engine test suite's `afterEach`.

---

## Shared Patterns

### Validation-before-shell (SVC-08, D-05..D-09)
**Source:** `packages/domain/src/validators/network.ts` lines 42, 60-115; `packages/ssh/src/commands/allowlist.ts` lines 30-40 (`escapeShellArg`).
**Apply to:** every new validator (`git.ts`, `docker-naming.ts`) and every new command template (`git.ts`, `fs.ts`, `docker.ts` additions, `kill.ts`) in `packages/ssh/src/commands/`.
```typescript
const SHELL_METACHARACTER_PATTERN = /[;|&$`()<>]/;
export function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
```
Chain is always: raw input → domain validator (`ValidationResult<T>`) → branded type → `escapeShellArg` → closed allowlist template → `exec-streaming.ts`.

### Never-throws error classification
**Source:** `packages/ssh/src/error-classifier.ts` lines 39-47 (`safeStringField`), 187-214 (`classifySshError`).
**Apply to:** `git-error-classifier.ts`, `docker-error-classifier.ts`. Ordered frozen rule table, structured fields before message-string matching, terminal fallback as a visible named rule, triple try/catch (outer, per-rule matches, per-rule message), every message redacted before return.

### Redaction on every remote-output path
**Source:** `packages/ssh/src/exec-with-timeout.ts` lines 194-201 (`redactor.redact(stdoutFinal.text)`); `packages/domain/src/security/redactor.ts` (not re-read this pass, already established per CONTEXT.md "Reusable Assets").
**Apply to:** `exec-streaming.ts` (every chunk, not just the final buffer), `git-error-classifier.ts`/`docker-error-classifier.ts` (every produced message).

### Pure discriminated-union parsers ("detect, don't infer")
**Source:** `packages/domain/src/discovery/docker-version.ts` lines 18-22, 37-74.
**Apply to:** `packages/domain/src/discovery/buildkit.ts` (`BuildKitStatus`), any `docker ps` NDJSON parser (G4) — never a boolean, never collapse "unparseable" into "absent".

### Frozen enum/state-machine with mechanically-generated exhaustive test
**Source:** `packages/domain/src/server/server-state.ts` (whole file); `packages/domain/src/server/server-state.test.ts` lines 16-60 (cross-product generation from the frozen tuple).
**Apply to:** `deployment-state.ts` + its test.

### Drizzle enum sourced from a domain constant, never duplicated
**Source:** `apps/control-plane/src/db/schema/servers.ts` lines 16-19.
**Apply to:** `deployments.ts` (`deploymentStatusEnum` from `DEPLOYMENT_STATUSES`), `credentials.ts` (`credentialTypeEnum` extension).

### Testcontainers fixture discipline
**Source:** `tests/integration/helpers/ssh.ts` lines 60-119, 226-231.
**Apply to:** every new fixture helper this phase adds (sshd+dockerd combined image, registry+htpasswd, bare git repo) — `noodara.test=true` label mandatory, real wait strategy never a sleep, idempotent `stop()`, `assertNoStrayTestContainers()` reused verbatim in every `afterEach`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `fixtures/node-api`, `fixtures/static-app`, `fixtures/failing-build` | config (fixture) | file-I/O | No `fixtures/` directory exists yet in this repo (v0.2 introduces it per roadmap §3.1) — these are genuinely new; follow repo conventions for `.dockerignore` (none to copy from) and pnpm workspace inclusion/exclusion (check root `pnpm-workspace.yaml` to decide whether `fixtures/*` needs an entry or an explicit exclusion so they aren't treated as workspace packages). |
| `apps/control-plane/src/db/schema/deployment-log-chunks.ts` | model | CRUD | No existing "append-only log chunk" table shape in the schema directory; use RESEARCH.md's general schema conventions (uuid PK via `uuidv7()`, `timestamp({ withTimezone: true })`) but there is no structural analog for chunked log storage — planner designs from D22 (SSE surface types only, this phase) and D-15..D-18 timeout/jobId decisions in ROADMAP.md. |
| `packages/domain/src/discovery/fixtures/*.json` (docker ps captures for G4) | test fixture (data) | file-I/O | ADR 0004 documents this pattern in prose (per RESEARCH.md) but the actual `docker version` fixture files were not located/read in this pass — planner should check for existing captured-JSON fixtures under `packages/domain/src/discovery/` before inventing a new directory convention. |

## Metadata

**Analog search scope:** `packages/domain/src/{server,validators,discovery}`, `packages/ssh/src/{,commands,testing}`, `apps/control-plane/src/db/schema`, `apps/control-plane/src/db/migrations`, `tests/integration/{ssh,helpers,images}`, root `turbo.json`, `docs/adr/`.
**Files scanned:** 24 read in full or targeted excerpt, plus directory listings of `tests/integration/images/*`, `apps/control-plane/src/db/migrations/`.
**Pattern extraction date:** 2026-09-29
