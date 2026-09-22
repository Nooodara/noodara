# Feature Research

**Domain:** Self-hosted PaaS control plane (Coolify / Dokploy category) — v0.1 Foundation scope: install, admin auth, connect a server over SSH, discover it, server detail, activity log.
**Researched:** 2026-09-10
**Confidence:** MEDIUM-HIGH (Coolify and Dokploy claims sourced from official docs; CapRover/Portainer used only for contrast, LOW confidence on those two)

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist in this category. Missing these makes Noodara feel unfinished next to Coolify/Dokploy — the exact products it's positioned against.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| One-command install on a clean VPS | Both Coolify (`curl \| bash` wrapping `install.sh`) and Dokploy (`curl -sSL https://dokploy.com/install.sh \| sudo sh`) install everything (Docker, DB, reverse proxy, panel) in a single command with no manual steps. This is the entry bar for the category. | HIGH | Roadmap already commits to this. Script must be idempotent-ish and print the URL + next step at the end (Coolify does this). |
| First-run admin bootstrap that races-to-claim | Coolify explicitly warns: whoever visits the registration screen first becomes the root/admin user — a known footgun if the panel is exposed before the owner claims it. Dokploy's first dashboard visit is also an account-creation screen. | MEDIUM | Noodara should close this gap rather than copy the flaw: e.g. one-time setup token printed by the installer, or bind first-run registration to localhost/private IP until claimed. This is a security differentiator disguised as a table-stakes flow — flag for PITFALLS. |
| Optional pre-seeding of admin credentials via install-time env vars | Coolify supports `ROOT_USERNAME`/`ROOT_USER_EMAIL`/`ROOT_USER_PASSWORD` env vars passed to the install script to skip the race-to-register step entirely (useful for scripted/IaC installs). | LOW | Cheap to add once install script + first-run flow exist; removes the "someone else grabs admin" risk outright. |
| Session-based auth with logout | Standard for a single-tenant admin panel. Roadmap already scopes "autenticación local" + "session management." | LOW | Nothing differentiating here; get it boring and correct (secure cookies, session expiry, logout invalidation). |
| Add server form: host/IP, SSH port, SSH user, credential | Both Coolify and Dokploy show a form with these exact fields. Coolify defaults port 22 and user `root`; Dokploy's fields are name, IP, username (typically root), SSH key, port. This shape is the category standard. | LOW | Roadmap already specifies this exactly (host, SSH port, SSH user configurable, credential). |
| SSH key as the primary/recommended credential type | Coolify requires the key to have **no passphrase** (interactive prompts break automation) and recommends `ed25519`. Dokploy generates keys in-app (RSA 2048-bit or Ed25519 256-bit) via a dedicated SSH Keys settings page, associates a key to a server at creation time, and — notably — **never lets you read the private key again after creation** (write-once). | MEDIUM | Roadmap allows "clave o password." Password-based SSH auth is what Coolify/Dokploy both quietly deprioritize in favor of keys; treat password auth as a fallback/compat path, not the primary flow. |
| "Test connection" / "Validate server" action, separate from saving the record | Coolify has an explicit **"Validate Server & Install Docker Engine"** button on the server's General page — it is a distinct step from just adding the row, and it performs live verification. Dokploy's validation ("Server Validation") runs a battery of checks and renders each as a pass/fail row with an icon and a description string (e.g. "Installed: 28.5.0"). | MEDIUM | Maps directly to roadmap's "prueba de conectividad" + connection state machine (PENDING → CONNECTING → CONNECTED/UNREACHABLE/ERROR). Users expect to *trigger* this, not just see status appear passively. |
| Live connection/reachability status per server | Both tools show a persistent status indicator (Coolify: green "Proxy Running"/reachable state; Dokploy: validation row states, terminal access as an implicit liveness check). Users check this before troubleshooting deploys. | LOW-MEDIUM | Roadmap's 6-state machine (PENDING/CONNECTING/CONNECTED/DISCONNECTED/UNREACHABLE/ERROR) is already more granular than either competitor's binary-ish status — this is fine and arguably better, but the UI must make the distinction between DISCONNECTED (was connected, now isn't) and UNREACHABLE (never connected / network failure) legible at a glance. |
| Automatic environment discovery after connecting | Coolify's validation step doesn't just check reachability — it detects and reports on Docker installation and installs it if missing. Dokploy's validation table checks Docker, Swarm mode, dokploy-network, sudo access, docker group membership, and build tooling (Nixpacks/Buildpacks/Railpack), each with a version string where applicable. | MEDIUM-HIGH | Roadmap's discovery set (hostname, distro, OS version, arch, CPU, RAM, disk, uptime, Docker + version) is a superset of Coolify's and roughly parallel to Dokploy's infra checks. This is squarely table stakes — a self-hosted PaaS that can't tell you what it's talking to isn't trustworthy. |
| Per-check pass/fail detail during discovery, not just a spinner | Dokploy's `StatusRow` pattern (label + boolean icon + dynamic description) is the concrete UX precedent: show what was checked and why it passed/failed, not a black-box "connecting...". | LOW-MEDIUM | Directly informs the connect-server E2E flow and the "Complex infrastructure. Calm interface." design principle — progressive disclosure of what's happening during discovery builds trust. |
| Server detail view with live-ish system facts | Both products show a server's OS/resource facts on its detail page; Coolify goes further with historical CPU/RAM/disk charts (via its "Sentinel" agent). | LOW (for the static facts) / HIGH (for historical charts) | Roadmap's v0.1 detail fields (hostname, status, OS, CPU, RAM, disk, uptime, Docker, last seen) are the **static snapshot** version of what Coolify eventually offers with Sentinel. Correctly scoped as table stakes for a snapshot, not a time series — time series is v0.5 (Observability) territory, not v0.1. |
| Non-root / sudo user support (even if root is the default) | Coolify has a documented (if "experimental") non-root flow requiring passwordless `sudo` via `/etc/sudoers.d/<user>` with `NOPASSWD: ALL`. Dokploy's validation explicitly checks "Sudo Access" and "Docker Group" membership as first-class checks, implying non-root is a fully supported path, not an afterthought. | MEDIUM | Roadmap doesn't explicitly call out sudo vs root, but "Usuario SSH configurable" implies it. Recommend v0.1 supports both but is explicit in the UI/docs that root is the fastest path and non-root requires pre-existing passwordless sudo + docker group membership (mirrors both competitors). |
| Edit / delete server, with credential cleanup on delete | Roadmap already specifies this and both competitors support editing server metadata (name, IP, SSH key) post-creation. | LOW | Deleting a server must scrub its stored credential — roadmap already calls this out under Security; keep it as a hard acceptance criterion, not just a nice-to-have. |
| Activity/audit log of server operations and auth events | Not heavily documented publicly for Coolify/Dokploy (their audit trails are thinner than enterprise tools), but it's still an expected feature for anyone who has used a hosting control panel, and the roadmap fixes it for v0.1. | LOW-MEDIUM | Low external validation of "how Coolify does it exactly" — treat as MEDIUM confidence, informed more by general admin-panel conventions than by competitor docs. Keep scope tight for v0.1: server CRUD, connect/discover attempts, auth login/logout — not a general-purpose event bus yet. |
| Global/instance settings screen | Both products have an instance-level settings area (Dokploy: `/dashboard/settings/*`). Roadmap fixes "Configuración global del control plane." | LOW | v0.1 scope should stay minimal: this is a container for future settings, not a feature in itself yet. |

### Differentiators (Competitive Advantage)

Features that set Noodara apart at the v0.1 stage — before the AI/graph differentiator ships in v0.5, but that lay groundwork for it or beat competitors on trust/clarity.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Explicit, granular connection state machine (6 states) surfaced in UI, not just "online/offline" | Coolify and Dokploy both effectively expose a binary-ish reachability signal (reachable/not, or a validation checklist state) rather than a first-class state machine with distinct PENDING/CONNECTING/CONNECTED/DISCONNECTED/UNREACHABLE/ERROR semantics. Making this visible and correctly labeled builds the "understands infrastructure, doesn't just ping it" positioning from day one. | MEDIUM | This is core-domain logic already required by the roadmap (state transitions unit-tested). The differentiator is *exposing* it well in the UI, distinguishing "never connected" from "was connected and dropped" from "auth/permission error" — competitors blur these. |
| Transparent, step-by-step discovery narrative in the UI | Rather than a generic spinner, show what's being checked (SSH reachable → auth OK → OS detected → Docker detected → metrics captured) similar in spirit to Dokploy's `StatusRow` list but framed as "Noodara is learning about your server" — reinforces the "understood, not just managed" brand promise even before AI exists. | MEDIUM | Zero new backend work beyond what discovery already computes; this is a UX/copy differentiator layered on table-stakes discovery. High leverage, low cost. |
| Host fingerprint / TOFU strategy that is visible and explained to the user | Neither Coolify nor Dokploy's public docs surface host-key verification handling to the end user in the add-server flow (it's an SSH implementation detail users hit as an error, per Coolify's "host key verification failed" troubleshooting content). Making TOFU (trust-on-first-connect, pin fingerprint, warn/hard-fail on change) an explicit, visible part of the connect flow is a security-forward differentiator consistent with the "safe by construction" positioning in PROJECT.md. | MEDIUM-HIGH | Roadmap already fixes "estrategia de host fingerprint (TOFU) definida" as a v0.1 requirement — this elevates it from an invisible backend detail (as it is for competitors) to a trust-building UI moment (e.g., show fingerprint on first connect, flag on change, never silently disable checking). |
| Closing the "first user to register becomes admin" race condition | Coolify's own docs flag this as a real risk to warn users about. Fixing it (setup token, IP-restricted first-run, or forced CLI-driven admin creation) turns a known competitor weakness into a Noodara trust signal, aligned with "no fugas de credenciales, sin estados falsos" core value. | LOW-MEDIUM | Cheap relative to value: e.g., print a one-time setup URL/token to the install log, require it on first `/setup`, expire it after use. |
| Security-first credential handling made visible, not just internal | Roadmap requires credentials never in API responses/logs/errors/telemetry. Surfacing this as a visible product behavior (e.g., server detail never shows the raw key/password even to the admin, explicit "credential stored encrypted, never displayed" messaging) turns a backend guarantee into a perceptible trust feature — similar to how Dokploy makes "you can never read the private key again" a stated, visible policy rather than a silent implementation detail. | LOW | Mostly a copy/UX task layered on already-required backend behavior (redacted fields, explicit empty/masked state instead of blank space that looks like a bug). |

### Anti-Features (Commonly Requested, Often Problematic — Explicitly Out for v0.1)

| Feature | Why Requested | Why Problematic for v0.1 | Alternative |
|---------|---------------|--------------------------|-------------|
| Historical resource-usage charts / continuous metrics (Coolify's Sentinel-style time series) | Users comparing Noodara to Coolify will ask "where are my CPU/RAM graphs over time?" | Requires a persistent metrics pipeline, sampling agent, storage, and charting — explicitly v0.5 (Observability) in the roadmap. Building it now duplicates work once the Infrastructure Graph and metrics model exist. | v0.1 shows a **point-in-time snapshot** on server detail (current CPU/RAM/disk/uptime) refreshed on-demand or on a coarse poll; defer time series to v0.5. |
| Installing a persistent agent/daemon on the managed server | Coolify's Sentinel and other tools use a lightweight agent for faster/richer telemetry; users may expect Noodara to need "an agent" like some competitors evolve toward. | Roadmap explicitly scopes v0.1 to operate via SSH from the control plane with no agent, to reduce security surface and complexity while the connect/discover trust story is being proven. Agent is an open question for later versions, not a v0.1 decision. | SSH-based discovery/exec only; revisit agent architecture after v0.1 is validated (already noted as "Pending" in PROJECT.md decisions). |
| Multi-server clustering / node pools (CapRover-style "Join Cluster") | Power users ask for horizontal scaling / Swarm-style clustering early, since CapRover ships this. | Out of scope by roadmap — v0.1 is single-server register/connect/discover only; no orchestration, no cross-server scheduling. Clustering assumes projects/services exist, which don't ship until v0.2+. | Support registering multiple independent servers (already in scope), but no relationship/orchestration between them in v0.1. |
| Build servers / dedicated build infrastructure (Dokploy's "Build Server" server type) | Dokploy differentiates deploy vs. build servers; users familiar with Dokploy may expect a server "role" selector. | There's no deployment engine yet in v0.1 (that's v0.3), so a "build server" role is meaningless before builds exist. | Model `Server` generically now; introduce a role/purpose concept only when the deployment engine (v0.3) needs to distinguish build vs. runtime targets. |
| Password-based SSH as the primary/recommended auth path | Some users have only a root password and no key pair, and will want the path of least resistance. | Both Coolify and Dokploy converge on SSH keys as the real path (Coolify requires passphrase-less keys for automation; Dokploy generates and stores keys in-app, never re-exposing the private key). Leading with passwords undercuts the "secure and consistent" core value and complicates the credential-encryption story with two very different secret shapes. | Support password as a documented fallback (roadmap allows "clave o password"), but make key-based auth the default recommendation in UI copy and onboarding, mirroring the ecosystem norm. |
| Multi-user / roles / teams on the add-server or activity-log flows | Natural extension once an admin panel exists; users used to team tools ask for it immediately. | Roadmap fixes single local admin for v0.1 explicitly (Out of Scope). Building any role model now adds authorization surface with zero users to validate it against. | Single admin session; activity log records "system"/the one admin as actor; defer RBAC entirely. |
| General-purpose log aggregation / search UI for the activity log | Once an activity log exists, it's tempting to add filters, full-text search, export, retention policies, etc. | Roadmap's v0.1 activity log exists to prove "operaciones relevantes sobre servidores y sesión" are recorded — not to be a log platform. v0.5 explicitly says "no intentar reemplazar Datadog/Loki/ELK," and that principle applies even more strongly to a v0.1 audit trail. | Simple reverse-chronological list of typed events (server added/edited/deleted/connected/failed, login/logout) with no search/export in v0.1; revisit richer log UX once deployments (v0.2/v0.3) generate far more log volume. |
| Auto-detecting/pre-filling server credentials from cloud provider APIs (DigitalOcean/Hetzner/AWS integrations) | Reduces friction of copy-pasting IP/key manually; some competitors' ecosystems have marketplace/cloud-init integrations. | No such integration exists in Coolify/Dokploy's core add-server flow per current docs (it's manual IP/user/key entry in both); adding provider APIs now is unscoped complexity with no roadmap mandate before v0.5. | Manual entry only, matching both reference products; revisit if a specific milestone after v0.5 targets provider integrations. |

## Feature Dependencies

```
One-command install
    └──requires──> Control plane app boot + PostgreSQL + migrations (already sequenced first)

First-run admin bootstrap
    └──requires──> One-command install (script must print/seed setup path)
    └──enhances──> Session-based auth (nothing to log into until an admin exists)

Add server (host/port/user/credential form)
    └──requires──> Session-based auth (must be logged in to reach Servers screen)
    └──requires──> Credential encryption at-rest (roadmap security requirement)

Test connection / Validate server
    └──requires──> Add server (must have a stored server record + credential)
    └──requires──> Host fingerprint / TOFU strategy (first successful connect is exactly when TOFU pinning happens)
    └──produces──> Connection state machine transitions (PENDING → CONNECTING → CONNECTED/UNREACHABLE/ERROR)

Discovery (hostname, OS, CPU, RAM, disk, uptime, Docker)
    └──requires──> Test connection succeeding (CONNECTED state) — cannot discover an unreachable server
    └──enhances──> Server Detail view (discovery output is exactly what detail displays)

Server Detail view
    └──requires──> Discovery (all displayed fields originate there)
    └──requires──> Connection state machine (status field on detail)

Activity log (server ops + session events)
    └──requires──> Add/Edit/Delete server, Test connection, Login/Logout (all are the events being logged)
    └──conflicts_with──> General-purpose log search/export (explicitly deferred, see anti-features)

Non-root/sudo server support
    └──enhances──> Add server (alternate credential path alongside root)
    └──requires──> Discovery/validation checks for sudo access + docker group membership (mirrors Dokploy's validation rows)

Delete server → credential purge
    └──requires──> Credential encryption at-rest (must know what to purge and confirm it's gone)

Historical metrics / time series (anti-feature for v0.1)
    └──requires──> Discovery + Server Detail snapshot (v0.1) as its foundation — deferred to v0.5 Observability, not a v0.1 dependency to satisfy now
```

### Dependency Notes

- **Test connection requires TOFU strategy:** the very first successful SSH handshake is the moment a host fingerprint must be captured/pinned. If TOFU design isn't settled before "Add server" ships, the connect flow either silently trusts unknown hosts (security regression vs. the stated core value) or breaks on first use. This is why PITFALLS-adjacent research should treat TOFU as a blocking design decision, not a follow-up.
- **Discovery requires CONNECTED state:** discovery cannot run against PENDING/UNREACHABLE/ERROR servers; the state machine is a hard gate, not cosmetic. Server Detail should render a clear "not yet discovered" empty state distinct from "discovery failed."
- **Activity log conflicts with log-platform ambitions:** keep the v0.1 log a fixed, typed event list. Adding filters/search now competes for the same UI real estate and design effort as v0.5's explicit non-goal ("no reemplazar Datadog/Loki/ELK"), so the same restraint should apply one milestone earlier.
- **Non-root support depends on discovery-time checks:** to safely support sudo users (mirroring Dokploy's validation rows), discovery/validation must check `sudo -n` capability and docker group membership as part of the same pass that detects OS/Docker — don't bolt this on later as a separate check.

## MVP Definition

### Launch With (v0.1 — already fixed by roadmap, restated for clarity)

- [x] One-command install on Ubuntu 22.04/24.04 — table stakes, matches category bar
- [x] Local admin auth + session management — table stakes, required before anything else works
- [x] Add/edit/delete server (host, SSH port, SSH user, key or password credential, encrypted at rest) — table stakes
- [x] Test connection with explicit state machine (PENDING/CONNECTING/CONNECTED/DISCONNECTED/UNREACHABLE/ERROR) — table stakes + differentiator in how it's surfaced
- [x] Discovery (hostname, distro, OS version, arch, CPU, RAM, disk, uptime, Docker + version) — table stakes
- [x] Server detail view (hostname, status, OS, CPU, RAM, disk, uptime, Docker, last seen) — table stakes
- [x] Activity log (server ops + session events) — table stakes, kept minimal
- [x] Global settings screen (container only) — table stakes, minimal
- [x] Host fingerprint / TOFU strategy — differentiator, security-critical
- [x] Non-root/sudo server support alongside root — table stakes per ecosystem norm

### Add After Validation (recommended additions, not currently in roadmap — flag for requirements review)

- [ ] First-run admin bootstrap hardening (setup token / IP restriction on registration) — closes a documented Coolify weakness; cheap, should arguably be pulled into v0.1 rather than deferred, given it's low complexity and directly serves the "no fugas de credenciales" core value. Recommend flagging this to the user for v0.1 inclusion rather than treating it as v0.2+.
- [ ] Install-time env var pre-seeding of admin credentials (Coolify's `ROOT_USERNAME`/etc. pattern) — trivial once first-run flow exists, useful for scripted installs and future CI/E2E test setup.
- [ ] Per-check discovery progress UI (Dokploy `StatusRow` pattern) — pure UX layer over already-planned discovery logic.

### Future Consideration (v0.2+, already correctly deferred by roadmap)

- [ ] Historical metrics / time-series charts — v0.5 Observability
- [ ] Agent-based telemetry — open question, not before v0.1 is validated
- [ ] Multi-server clustering/orchestration — never explicitly planned; assess only after v0.5
- [ ] Build-server vs. deploy-server role distinction — relevant once v0.3 deployment engine exists
- [ ] Cloud provider integrations for server provisioning — no current milestone targets this

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| One-command install | HIGH | HIGH | P1 |
| Local admin auth + sessions | HIGH | MEDIUM | P1 |
| Add/edit/delete server + encrypted credentials | HIGH | MEDIUM | P1 |
| Connection test + state machine | HIGH | MEDIUM-HIGH | P1 |
| Discovery | HIGH | MEDIUM-HIGH | P1 |
| Server detail view | HIGH | LOW-MEDIUM | P1 |
| Activity log (minimal) | MEDIUM | LOW | P1 |
| TOFU / host fingerprint strategy | HIGH (trust/security) | MEDIUM | P1 |
| Non-root/sudo support | MEDIUM | MEDIUM | P1 (matches ecosystem norm) |
| First-run bootstrap hardening | MEDIUM-HIGH (risk reduction) | LOW | P1/P2 — recommend elevating to P1 given low cost |
| Discovery progress narrative UI | MEDIUM (brand/trust) | LOW | P2 |
| Install-time credential pre-seeding | LOW-MEDIUM | LOW | P2 |
| Historical metrics/time series | HIGH (eventually) | HIGH | P3 (v0.5) |
| Clustering/orchestration | LOW at this stage | HIGH | P3 (unscheduled) |

**Priority key:**
- P1: Must have for v0.1 launch (per roadmap or strongly recommended addition)
- P2: Should have, low-cost enhancement layered on P1 work
- P3: Explicitly deferred to later milestones per roadmap

## Competitor Feature Analysis

| Feature | Coolify | Dokploy | Noodara v0.1 Approach |
|---------|---------|---------|------------------------|
| Install | Single script (`install.sh` via curl\|bash); supports env-var pre-seeded admin credentials; prints instance URL at the end | Single script (`curl -sSL https://dokploy.com/install.sh \| sudo sh`); installs Docker, initializes Swarm, deploys Postgres/Redis/panel/Traefik in one pass; ~2-5 min | One-command install on Ubuntu 22.04/24.04 (roadmap-fixed); recommend adding pre-seed env vars and a setup-token safeguard the competitors lack |
| First admin | First visitor to register = admin (documented risk) | First dashboard visit prompts admin account creation (same pattern/risk) | Fix the race condition explicitly: setup token or localhost-restricted first-run, as a differentiator |
| Add server fields | Host, SSH port (default 22), SSH user (default root), private key selection | Name, IP, username (typically root), SSH key, port | Same field set (host, SSH port, SSH user, credential), matching roadmap and category norm |
| SSH key handling | Recommends ed25519; key must have **no passphrase**; add pubkey to target's `authorized_keys` manually or via wizard | Generates RSA (2048-bit) or Ed25519 (256-bit) keys in-app; private key **cannot be read again after creation** (write-once secret) | Support key or password (roadmap allows both); default/recommend key-based; encrypt at rest; never expose stored private key/password in API responses — matches Dokploy's write-once posture in spirit |
| Root vs. sudo user | Root is default; non-root is "experimental," requires passwordless `sudo` (`NOPASSWD: ALL`) and docker group membership pre-configured before adding the server | Validation explicitly checks "Sudo Access" and "Docker Group" as pass/fail rows, implying first-class non-root support | Support both from day one (roadmap: "Usuario SSH configurable"); discovery/validation should check sudo capability + docker group membership as part of the same pass, not bolt it on |
| Validation / connect action | Explicit **"Validate Server & Install Docker Engine"** button; distinct step from saving the record; installs Docker if missing | Explicit "Setup Server" action (Deployments tab) that runs a one-time install script; separate "Server Validation" panel shows per-check pass/fail rows (Docker, Swarm, dokploy-network, Sudo Access, Docker Group, Nixpacks/Buildpacks/Railpack) with version strings | Explicit "Test connection" / "Connect" action tied to the state machine (PENDING→CONNECTING→CONNECTED/UNREACHABLE/ERROR); do NOT auto-install Docker in v0.1 (roadmap only requires *detecting* Docker, not installing it) — this is a scope difference worth flagging to the user |
| Status indicator | Green "Proxy Running" / reachable state on server page | Per-check pass/fail icons; terminal access as implicit liveness probe | Explicit 6-state machine surfaced with distinct copy per state (PENDING/CONNECTING/CONNECTED/DISCONNECTED/UNREACHABLE/ERROR) — more granular than either competitor |
| Discovery/detection | Docker install + version, reachability; deeper resource metrics only via optional Sentinel agent (later, ongoing time series) | Docker version, Swarm mode, network, sudo/docker-group, build tool versions | hostname, distro, OS version, arch, CPU, RAM, disk, uptime, Docker + version — snapshot only, no agent, no time series (roadmap-fixed) |
| Server detail page | Status + resource charts (via Sentinel) once configured | Server dropdown + terminal + Docker/Swarm overview | Static snapshot: hostname, status, OS, CPU, RAM, disk, uptime, Docker, last seen (roadmap-fixed); time series deferred to v0.5 |
| Host fingerprint handling | Not surfaced to the user in docs; failures show up as raw SSH "host key verification failed" errors | Not documented as a distinct user-facing step | Make TOFU explicit and visible in the connect flow — differentiator vs. both |
| Clustering / multi-node | Multi-server supported as independent connected servers (no clustering primitive in core docs found) | Multi-server supported (Deploy vs. Build server roles); no peer clustering primitive found | Independent servers only in v0.1, no relationships between them (matches both; CapRover-style clustering explicitly out of scope) |
| Activity/audit log | Not prominently documented publicly | Not prominently documented publicly | Roadmap-fixed minimal event log (server ops + session); low external validation, treat as own design informed by general admin-panel conventions |

## Sources

- [Installation | Coolify Docs](https://coolify.io/docs/get-started/installation) — install script, root-user pre-seeding via env vars, onboarding flow (WebSearch, verified against official domain — MEDIUM-HIGH)
- [OpenSSH | Coolify Docs](https://coolify.io/docs/knowledge-base/server/openssh) — SSH key requirements (no passphrase, ed25519 recommendation), PermitRootLogin guidance, "Validate Server & Install Docker Engine" flow, status indicator (WebFetch of official docs — HIGH)
- [Non-root User | Coolify Docs](https://next.coolify.io/docs/core/infrastructure/servers/non-root-user) — passwordless sudo setup, `useradd`, `/etc/sudoers.d`, docker group, data directory ownership (WebFetch of official docs — HIGH)
- [Metrics | Coolify Docs](https://next.coolify.io/docs/core/observability/monitoring/metrics) and [Sentinel and Metrics | Coolify Docs](https://coolify.io/docs/knowledge-base/server/sentinel) — Sentinel agent, sampling intervals, historical charts via ApexCharts (WebSearch summary of official docs — MEDIUM)
- [Introduction | Dokploy Remote Servers](https://docs.dokploy.com/docs/core/remote-servers) — Deploy vs. Build server types, remote server management features (WebFetch of official docs — HIGH)
- [Deploy Server | Dokploy](https://docs.dokploy.com/docs/core/remote-servers/instructions) — required fields (name, IP, username, SSH key, port), Setup Server one-time install script, Enter Terminal connectivity test (WebFetch of official docs — HIGH)
- [SSH Keys | Dokploy](https://docs.dokploy.com/docs/core/ssh-keys) — RSA 2048-bit vs Ed25519 256-bit key generation, write-once private key storage (WebFetch of official docs — HIGH)
- [Server Validation | Dokploy/dokploy DeepWiki](https://deepwiki.com/Dokploy/dokploy/10.2-server-validation) — full validation checklist by server type (Docker, RClone, Nixpacks, Buildpacks, Railpack, Swarm, dokploy-network, /etc/dokploy, Sudo Access, Docker Group), `StatusRow` UI pattern (WebFetch of community-maintained source-derived docs — MEDIUM, cross-checked against official Dokploy docs structure)
- [Installation | Dokploy](https://docs.dokploy.com/docs/core/installation) — install script behavior, first-user admin creation on first dashboard visit (WebSearch summary of official docs — MEDIUM-HIGH)
- [CLI Commands | CapRover](https://caprover.com/docs/cli-commands.html) and [App Scaling & Cluster | CapRover](https://caprover.com/docs/app-scaling-and-cluster) — cluster join flow requiring root SSH key, used only as contrast for the "no clustering in v0.1" anti-feature (WebSearch — LOW, used for contrast only, not as a v0.1 model)
- .planning/PROJECT.md — Noodara core value, v0.1 requirements, constraints, out-of-scope list (project source of truth)
- docs/roadmap-v0.1-v0.5.md, section 6 — authoritative v0.1 functional scope, security requirements, acceptance criteria (project source of truth)

---
*Feature research for: Self-hosted PaaS control plane — v0.1 Foundation (install, auth, connect server, discovery, server detail, activity log)*
*Researched: 2026-09-10*
