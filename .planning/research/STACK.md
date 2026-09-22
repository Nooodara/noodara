# Stack Research — v0.2 Projects & Services

**Domain:** self-hostable PaaS control plane — remote Docker/Git execution over SSH, log streaming, public docs/landing site, UI motion
**Researched:** 2026-09-22
**Confidence:** HIGH (Docker/Git-over-SSH transport, docs site, Motion) / MEDIUM (private-repo credential handling — corroborated by multiple sources, no single authoritative spec)

Scope note: this file only covers *new* stack needs for v0.2 (Projects → Environments → Services, Docker/Git execution on the remote server, build/runtime log streaming, docs + landing site, `packages/ui` motion). Everything already shipped in v0.1 (Fastify 5, Drizzle, BullMQ, ssh2, Better Auth, Next.js 16, Tailwind v4, Radix, Vitest/Playwright/Testcontainers) is unchanged and not re-justified here.

## Recommended Stack

### Core additions

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| *(none — reuse `@noodara/ssh`)* | ssh2 `1.17.0` (already pinned) | Docker + Git execution on the remote server | v0.2's own roadmap says Noodara "opera vía SSH desde el control plane" for v0.1, and v0.2 does not introduce an agent. Every Docker/Git operation in §7.2/§7.3 (`pull`, `build`, `create`, `start`, `stop`, `restart`, `remove`, `inspect`, `logs`, `clone`, `checkout`) is a single, well-known CLI command. Running these as new entries in the existing `@noodara/ssh` command allowlist (`packages/ssh/src/commands`) keeps every remote call inside the already-audited, already-tested pipe: one TOFU-verified connection per server, one mutex, one redaction pass, one timeout wrapper (`execWithTimeout`). No new runtime dependency is needed to satisfy §7.1–§7.3. |
| `fumadocs-core` + `fumadocs-ui` | `16.15.13` | Public docs site (`Read` surface) | Next.js-native docs framework. Verified via npm: peer deps are `next: 16.x.x`, `react: ^19.2.0`, `react-dom: ^19.2.0` — an exact match to this repo's pinned `next@16.3.5`/`react@19.3.0`. It is a Next.js app, not a second framework, so it fits directly into the existing pnpm+Turborepo pipeline (one more `apps/*` workspace, same lint/typecheck/build scripts, same `packages/ui` design tokens via Tailwind v4 — ships its own `@fumadocs/tailwind` plugin). Built-in full-text search (Orama), MDX, versioned nav — no Algolia key, no separate search service. |
| `motion` (import from `motion/react`) | `13.4.1` | Gesture-driven springs in the UI redesign (`docs/ui-build-prompt.md`) | Confirmed via Context7 (`/websites/motion_dev`) this is the current, canonical package — "Framer Motion" was renamed to "Motion"; `motion` and `framer-motion` are published in lockstep at the same version, but `motion` is the name to install going forward. Peer deps `react: ^18.0.0 \|\| ^19.0.0` match `react@19.3.0`. Full physics-based spring engine (not CSS-transition polyfill), which is what "gesture-driven springs" in the brief actually needs (drag, layout animations, spring physics) — CSS transitions/`@keyframes` alone cannot do interruptible spring gestures. |

### Supporting libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `motion/react-client` (subpath of `motion`, no extra install) | `13.4.1` | Server-Component-friendly Motion import for Next.js App Router | Use in any file that stays a Server Component wrapper — importing `* as motion from 'motion/react-client'` avoids hand-adding `"use client"` to every leaf and keeps the client JS bundle scoped to the animated component itself, not its parent tree. |
| `LazyMotion` + `m` + `domAnimation` (from `motion/react`, no extra install) | `13.4.1` | Bundle-size control | The full `motion` component ships pre-bundled with every feature (~34 KB gzip). `LazyMotion`+`m`+`domAnimation` cuts the initial payload to ~4–6 KB and loads gesture/drag features on demand. Given the design brief's "calm interface" principle (most of the dashboard is static data, not animation), wrap only the animated subtree, not the whole app, in `LazyMotion`. Only reach for `domMax` (adds drag + layout-group) where a screen genuinely needs it — it is heavier than `domAnimation`. |

### Development / test tooling

| Tool | Purpose | Notes |
|------|---------|-------|
| Extend existing DinD Testcontainers pattern (`tests/integration/images/installer-dind-*`, `tests/integration/helpers/installer-dind.ts`) | Real Docker daemon reachable over real sshd, for §7.5 integration tests (`build Dockerfile`, `pull image`, `create/start/stop/restart/remove/inspect container`, `collect logs`) | No new package. v0.1 already built two separate building blocks — sshd Testcontainers fixtures (`tests/integration/images/sshd-ubuntu-2{2,4}.04`) and a Docker-in-Docker Testcontainers fixture for the installer. v0.2 needs a **combined image**: sshd + a real `dockerd` in the same container, reachable only through the same allowlisted SSH exec path the production code uses (no daemon TCP port exposed) — this is a new Dockerfile, not a new dependency. |
| A bare git repo inside the same or a sibling Testcontainers fixture (`git init --bare` + `git` CLI, seeded at build time) | Real Git-over-SSH server for §7.5 (`clone repository`, `checkout branch`) and private-repo/deploy-key scenarios | No new package — reuses the project's existing pattern of "real key material generated per test run via `ssh-keygen`, never committed" (phase 2) to authorize a throwaway deploy key against the bare repo's `authorized_keys`. |
| `testcontainers` / `@testcontainers/postgresql` / `@testcontainers/redis` | already pinned `12.1.0` | No version change needed; v0.2's new Postgres tables (Project/Environment/Service/Deployment) and Redis-streamed logs use the same fixtures already wired into `vitest.integration.config.ts`. |
| `fixtures/node-api`, `fixtures/static-app`, `fixtures/failing-build` | Official deploy fixtures (§7.6) | Keep them dependency-free: `node-api` as a plain `node:22-slim` + built-in `http` module exposing `GET /health` (no Express — matches the project's zero-unnecessary-dependency, provenance-gated ethos); `static-app` as static HTML served by `nginx:alpine` or `node:22-slim` + `http-server`-equivalent one-liner; `failing-build` as a Dockerfile with a deliberately broken `RUN` step. None of these need adding a dependency to the monorepo's own `package.json` — they are standalone fixture repos with their own minimal `package.json`/`Dockerfile`. |

## Installation

```bash
# Docs site (new workspace app)
pnpm --filter @noodara/docs add fumadocs-core@16.15.13 fumadocs-ui@16.15.13
pnpm --filter @noodara/docs add -D fumadocs-mdx@15.4.3

# Motion (add to apps/web, or to packages/ui if animated primitives live there)
pnpm --filter @noodara/web add motion@13.4.1
# or: pnpm --filter @noodara/ui add motion@13.4.1

# No new runtime dependency for Docker/Git-over-SSH — extend packages/ssh's
# existing command allowlist (packages/ssh/src/commands) instead of installing
# dockerode / docker-modem / simple-git / nodegit / isomorphic-git.
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|--------------------------|
| Docker CLI over the existing `@noodara/ssh` exec allowlist | `dockerode` (+ `docker-modem`'s `protocol: 'ssh'`, which does depend on `ssh2 ^1.15.0` under the hood) talking to the remote Docker **Engine API** | Only if/when Noodara grows an on-host **Agent** (already flagged in `docs/roadmap-v0.1-v0.5.md` and `PROJECT.md` as "research will decide the version") that owns a local Unix-socket connection to `dockerd` — at that point a typed API client is worth it. Over SSH specifically it is the wrong trade today: `docker-modem` opens its **own**, independent `ssh2` connection per server (its own host-key handling, its own auth, its own lack of the project's TOFU verifier/mutex/timeout/redaction wrapper), doubling the SSH surface per server instead of reusing the one connection `@noodara/ssh` already manages. It also swaps the project's frozen, no-interpolation **command allowlist** security model (SEC-04) for an open Engine API surface — a materially larger attack surface for a milestone whose acceptance criteria only need 9 named operations. |
| Docker CLI over the existing `@noodara/ssh` exec allowlist | Docker Engine API over a manual SSH port-forward tunnel (`ssh -L` / `client.forwardOut`) to `docker.sock`, then a generic HTTP client | Same objection as above, plus: it requires shipping build context (repo + Dockerfile) as a tarball from the control plane to the remote daemon over the tunnel. Because Git operations already clone the repo directly onto the remote host (§7.3, over the same SSH session), `docker build` can run against a directory that's already local to the target machine — no tarball streaming, no extra wire cost, no extra library (`tar-fs`) needed. |
| `git` CLI on the remote host, invoked via the existing SSH exec allowlist | `simple-git` / `isomorphic-git` / `nodegit` run *locally* on the control plane, cloning into a local workdir that is then pushed/synced to the server | Rejected outright for this architecture: cloning locally on the control plane and then transferring the checkout to the remote server means owning a second transfer mechanism (rsync/tar-over-SSH) on top of the one that already exists for commands, doubles disk usage on the control plane, and contradicts the explicit constraint "Noodara opera vía SSH desde el control plane" / "must never run builds locally." `nodegit` additionally ships native bindings that are a known source of install/build breakage and would need its own provenance review. |
| Fumadocs (Next.js-native) | Astro + Starlight | Only if the docs site needs to be fully decoupled from the product's React/Tailwind toolchain (e.g., a separate team owns it with no Next.js experience) or needs Astro's content-collections for a much larger non-docs content site. For Noodara it would add a second bundler/dev-server, a second CI lint/typecheck pipeline, and a second design-system port (Starlight's own theming would need to be re-skinned to the Apple-inspired token set that `packages/ui` already owns) purely to gain a docs framework that Fumadocs already provides inside the existing toolchain. |
| Fumadocs (Next.js-native) | VitePress | Never for this repo — VitePress is Vue-based. Adopting it would mean maintaining a second component framework and a second design-system implementation alongside React/Next/Tailwind for no functional gain; Fumadocs covers the same "great docs DX with MDX + search" need without leaving the stack. |
| Fumadocs (Next.js-native) | Plain Next.js static export with hand-rolled MDX | Only for a docs site with a handful of static pages and no need for search, versioned nav, or a TOC/sidebar generator — below that bar, hand-rolling costs more engineering time than adopting Fumadocs, which is already peer-compatible with the exact Next/React versions pinned in this repo. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|--------------|
| `dockerode` / `docker-modem` (`protocol: 'ssh'`) for v0.2 | Opens a second, independently-authenticated `ssh2` connection per server outside `@noodara/ssh`'s TOFU verifier, per-target mutex, and redaction/timeout wrapper; replaces the project's frozen command-allowlist security model with an open Engine API surface. Also pulls in `@grpc/grpc-js`, `protobufjs`, `tar-fs` — a materially larger dependency surface than the 9 CLI operations §7.2 actually needs. | Extend `packages/ssh`'s allowlist with new `docker …` command templates, executed through the existing `execWithTimeout`. Revisit dockerode only if/when a local on-host Agent with a Unix-socket connection is built. |
| `simple-git`, `isomorphic-git`, `nodegit` | Git operations happen *on the remote server*, not on the control plane — installing a local Git library implies cloning locally and then having to transfer the checkout to the target host, which is a second transfer mechanism the architecture doesn't have and doesn't need. `nodegit` additionally carries native-binding build risk. | `git` CLI invoked on the remote host via the existing SSH exec allowlist — same trust boundary as Docker operations. |
| Embedding a Git token or deploy-key passphrase directly in a repository URL or as a CLI flag (`https://<token>@github.com/...`, `ssh -i <path>` where `<path>` itself encodes the secret, or any secret passed as a bare argv token) | Command strings executed by `@noodara/ssh` are logged (redacted) and can appear in the remote host's own process list (`ps aux`) for the life of the exec; argv-embedded secrets defeat both. This is exactly the class of leak `noodara-security`'s canary tests (`security:scan-leaks`) already exist to catch. | For SSH-based repos: write the decrypted deploy key to a mode-600 file **on the remote host** for the duration of the single clone/fetch, referenced via `GIT_SSH_COMMAND='ssh -i <path> -o StrictHostKeyChecking=accept-new'` (an env var, not argv), then delete it immediately after the command completes — mirrors how credentials are already decrypted only in-memory and never written to the control plane's disk. For HTTPS/token repos: a `GIT_ASKPASS` helper script that reads the token from an environment variable scoped to that one exec call, never interpolated into the URL or the command string. |
| A raw, unbounded `docker logs -f` / `docker build` exec reusing `execWithTimeout` as-is | `execWithTimeout` (SEC-05) buffers all output in memory and only resolves on channel `close`, with a hard 64 KB (`MAX_OUTPUT_BYTES`) cap and a single fixed timeout — it was built for short, bounded discovery commands, not a follow-mode log stream or a multi-minute build. Reusing it unmodified would either truncate build/runtime logs at 64 KB or block the exec pipe waiting for a stream that may never close. | A new streaming exec primitive (still inside `packages/ssh`, still allowlist-only) that emits chunks as they arrive instead of buffering, publishes each chunk to the *existing* Redis pub/sub channel pattern (same mechanism already proven for `server.updated`/`server.discovery_progress` SSE events, same 1 MiB per-connection backpressure-eviction precedent from the phase-5 gap closure), and enforces an explicit maximum stream duration / total retained bytes per CLAUDE.md §2.3's "explicit timeouts on every remote operation." This is new code, not a new dependency — `ioredis` (already pinned) is sufficient. |
| A new pub/sub or message-broker library (NATS, MQTT, socket.io, etc.) for streaming build/runtime logs to the UI | Redis pub/sub → SSE is already built, tested, and load-bearing for `server.*` events (Phase 4/5). Adding a second real-time transport for logs would mean two live-update mechanisms in one app for no functional gain. | Reuse the existing Redis pub/sub → SSE channel with new, explicitly allowlisted event types (e.g. `deployment.build_log`, `service.runtime_log`), same connection cap and backpressure eviction already in production. |
| Object storage (S3-compatible bucket, MinIO, etc.) for build/runtime logs at this milestone | §7.8's acceptance criteria only require build logs and "runtime logs básicos" to be available — no roadmap requirement yet for long-term log retention, rotation policies, or multi-GB volumes. | Store a size-capped log tail (e.g. a bounded text column, following the same 64 KB-order-of-magnitude discipline already established for exec output) per `Deployment`/`Service` row in the existing Postgres/Drizzle schema. Revisit object storage only if a later milestone needs full, unbounded log retention. |
| Astro, Starlight, VitePress, Nextra for the docs/landing site | Each introduces a second framework or a second component model into a repo that is otherwise 100% Next.js/React/Tailwind v4/Radix, duplicating CI plumbing (lint/typecheck/build) and requiring the Apple-inspired design system to be re-implemented in a second theming system. | Fumadocs (`fumadocs-core`/`fumadocs-ui` `16.15.13`) as a Next.js app inside the same Turborepo/pnpm workspace, reusing `packages/ui` and the existing Tailwind v4 config. |
| Wrapping the entire app tree in `motion`'s full-featured `<motion.*>` components, or wrapping the whole app in one global `LazyMotion` with `domMax` | The unqualified `motion` component ships pre-bundled with every feature (~34 KB gzip) regardless of what's actually used; `domMax` additionally bundles drag/layout-group support most screens won't touch. Given the brief's own "calm interface" principle, most of the dashboard is static — animating it by default works against both bundle size and the design philosophy. | Import `motion/react-client` (or manually mark client components) and scope `LazyMotion`+`m`+`domAnimation` to the specific animated subtree (the "authored moments" the brief calls out: discovery, TOFU, elevation/vibrancy transitions) — not the app shell. |

## Stack Patterns by Variant

**If a Service source type is `git`:**
- Clone/fetch/checkout run on the remote host via the SSH exec allowlist, using the server's already-established connection (no new connection per Git op).
- Private repos: deploy key stored through the same encrypted-credential envelope (`AES-256-GCM`, `SecretValue`) already used for server SSH credentials; decrypted only in-memory on the control plane, written to a mode-600 file on the *remote* host for one command, then deleted.

**If a Service source type is `dockerfile`:**
- Build runs on the remote host, against the directory Git already cloned there — no build-context tarball ever crosses the control-plane → server wire.

**If a Service source type is `image`:**
- Only `docker pull` + `docker create`/`docker start` are needed — no Git operation, no build step, no build-log stream (only the runtime-log stream applies).

**If a log stream never closes (`docker logs -f`) or runs long (a slow build):**
- Enforce an explicit maximum duration per CLAUDE.md §2.3, independent from `execWithTimeout`'s existing fixed-budget model built for short discovery commands.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|------------------|-------|
| `fumadocs-core@16.15.13` / `fumadocs-ui@16.15.13` | `next@16.3.5`, `react@19.3.0`, `react-dom@19.3.0` | Verified via npm peer-dependency ranges (`next: 16.x.x`, `react: ^19.2.0`) — exact match to what's already pinned in this repo; no version bump to Next/React needed. |
| `fumadocs-mdx@15.4.3` | `next: ^15.3.0 \|\| ^16.0.0`, `fumadocs-core: ^16.15.3` | Compatible with the repo's pinned `fumadocs-core@16.15.13`. |
| `motion@13.4.1` | `react: ^18.0.0 \|\| ^19.0.0`, `react-dom` same range | Matches `react@19.3.0`/`react-dom@19.3.0`; also compatible with Next.js 16 App Router when used behind `"use client"` or `motion/react-client`. |
| `ssh2@1.17.0` (already pinned in `@noodara/ssh`) | Not reused by `dockerode`/`docker-modem` in this recommendation | `docker-modem@5.0.7` itself depends on `ssh2@^1.15.0` — version-compatible if ever adopted later, but deliberately **not** wired into this milestone (see "What NOT to Use"). |

## Sources

- Context7 `/apocas/dockerode` — verified `buildImage`/`followProgress`/`logs({follow:true})`/remote-host connection shapes; confirmed no native SSH transport in dockerode itself (HIGH confidence — official README via Context7).
- npm registry (`npm view`) — live version/peerDependency data for `docker-modem@5.0.7` (`ssh2: ^1.15.0` dependency), `dockerode@5.0.1`, `fumadocs-core@16.15.13`, `fumadocs-ui@16.15.13`, `fumadocs-mdx@15.4.3`, `motion@13.4.1`, `astro@7.3.3`, `@astrojs/starlight@0.42.3`, `vitepress@1.6.4` (HIGH confidence — registry is authoritative for current published versions).
- Context7 `/websites/motion_dev` — verified `motion/react` App Router usage (`"use client"` and `motion/react-client`), `LazyMotion`+`domAnimation` bundle-size guidance (HIGH confidence — official docs via Context7).
- WebSearch, GitHub `apocas/docker-modem` issues #80/#135 — corroborated `protocol: 'ssh'` support and its `ssh2` dependency floor (MEDIUM confidence — community/maintainer discussion, cross-checked against the package's own `package.json`).
- WebSearch, GitHub deploy-key guides (multiple independent sources) — `GIT_SSH_COMMAND`/`IdentityFile`/`GIT_ASKPASS` patterns for keeping credentials out of argv (MEDIUM confidence — consistent across multiple independent write-ups, no single canonical spec; this repo's own `noodara-security` skill and existing `SEC-04`/`SEC-05` precedent were used to adapt the pattern to this codebase's trust boundary).
- Repo evidence (`packages/ssh/src/exec-with-timeout.ts`, `tests/integration/images/{sshd,installer-dind}-*`, `tests/integration/helpers/installer-dind.ts`, `MILESTONES.md` phase 2/4/5 entries) — read directly to ground every "reuse existing X" claim in code that already exists and is already tested (HIGH confidence — primary source, this repository).

---
*Stack research for: Noodara v0.2 Projects & Services*
*Researched: 2026-09-22*
