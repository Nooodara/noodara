# Feature Research

**Domain:** Self-hosted PaaS — Projects → Environments → Services, Git/Dockerfile/image deploy, build & runtime logs, container state (v0.2 scope)
**Researched:** 2026-09-22
**Confidence:** MEDIUM-HIGH (competitor behavior verified against official docs and GitHub issues; a few gaps where docs were thin are flagged LOW)

## Feature Landscape

### Table Stakes (Users Expect These)

Features a Coolify/Dokploy switcher assumes exist. Missing these = product feels incomplete for the v0.2 promise ("create a project, environment, service, deploy it, see it running").

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Project → Environment → Service hierarchy | Coolify and Dokploy both group services under a project/application concept; roadmap §7 fixes this shape | LOW | Pure CRUD + ownership constraint (service never crosses project). Domain-model work, not infra work. |
| Service from Git repo (branch select, build context) | Baseline of every competitor researched (Coolify, Dokploy, Railway, Render) | MEDIUM | Needs Git clone + checkout + private-repo credential (SSH deploy key is the common pattern — see Sourced Behavior below). |
| Service from Dockerfile | Roadmap §7.1 explicit requirement; Dokploy models this as one of five "build types" | MEDIUM | Needs build context path + optional Dockerfile path, matching Dokploy's `build-type: dockerfile` fields (context default `.`). [Source](https://docs.dokploy.com/docs/core/applications/build-type) |
| Service from Docker image | All six competitors support pulling a pre-built image directly | LOW | Simplest path: no build step, straight to `docker pull` + `docker create` + `docker start`. |
| Manual deploy trigger + deploy history list | Coolify's Deployments tab and Railway's deployments view both show past + current operations in one list | LOW-MEDIUM | Roadmap doesn't require webhooks in v0.2 (that's v0.3) — button-triggered deploy is enough. |
| Build logs, streamed, timestamped | Universal across Coolify, Dokploy, Railway, Render — all stream build output live and keep it after completion | MEDIUM | Coolify: "watch the logs in real time... timestamped logs show exactly what's happening at each step." [Source](https://coolify.io/docs/applications/deployments/overview) |
| Runtime/container logs, separate from build logs | Railway explicitly separates them ("during build the build logs will be shown, during deploy the deploy logs will be shown") | MEDIUM | v0.2 only needs "runtime logs básicos" per roadmap §7.2 — no filter/search yet (that refinement is v0.5 per roadmap §10.2). |
| Failed build surfaces an actionable error, doesn't replace the running version | Render: "if the build fails, Render cancels the deploy, and your original service instance continues running without interruption." Coolify: "failed source builds preserve the running application rather than replacing it." | MEDIUM-HIGH | This is a roadmap §7.8 acceptance criterion ("Failed build produce error accionable") — matches industry norm, not a Noodara invention. |
| Redeploy | Railway: "a successful, failed, or crashed deployment can be re-deployed... exact same code and build/deploy configuration." Coolify's redeploy re-runs the same flow. | LOW-MEDIUM | For v0.2 (no deployment engine yet), redeploy = re-run current build from the same source ref, not "replay a specific past deployment image" (that nuance is v0.3, once Deployment entities carry immutable image refs). |
| Cancel a running/queued build | Render auto-cancels on health-check failure; Railway has explicit "Abort deployment"; Dokploy has a cancel button but **only for queued builds, not in-progress ones** — a documented limitation, see Pitfalls below | MEDIUM-HIGH | Cancelling an **in-progress** build (mid-`docker build`) is harder than cancelling a queued one. Noodara should not repeat Dokploy's gap — the roadmap explicitly lists "Cancelación segura" and "no quedan recursos temporales después de cancelar" as v0.2 acceptance criteria. |
| Stop / restart / remove container | Roadmap §7.2 lists these as explicit Docker operations; every competitor exposes them | LOW | Direct Docker API calls once the container id is known; state transitions must be validated in `packages/domain` per project conventions. |
| Real container state shown in UI, not just "last known" | Roadmap §7.8: "Estado real del container coincide con UI/API" | MEDIUM-HIGH | This is where competitors visibly struggle — see Pitfalls. Needs either polling `docker inspect` on a schedule or Docker events subscription, not a value cached only at deploy time. |
| Editable admin profile (name, email, password) | Coolify: Profile > General lets the user change name/email/password; on password change it signs out all other sessions and revokes API tokens | LOW-MEDIUM | Straightforward CRUD on the existing single-admin `User` entity from v0.1; the "sign out everywhere + revoke tokens on password change" behavior is a good security pattern to copy. [Source](https://github.com/coollabsio/coolify/issues/1129), general Coolify docs findings |
| Appearance/theme settings (light/dark/auto + persistent override) | ThemeToggle already exists in Noodara's `packages/ui`; Coolify has theme/appearance settings in Profile | LOW | v0.1 already has a toggle — v0.2 needs to add "auto" + persistence + density + reduced-motion override, which is additive, not new architecture. |
| Public docs site with install command, concepts, first-deploy guide | Universal pattern: Coolify docs and Dokploy docs both lead with "Get Started" → install → first deployment, then reference sections per resource type | LOW-MEDIUM (content work, not engineering) | See "Docs Site Content Requirements" below for the exact shape both competitors converge on. |
| Landing page | Both Coolify and Dokploy have a persuasive public site distinct from the docs and from the app itself | LOW-MEDIUM | Content/design work; no backend dependency beyond what v0.1's brand kit already produces. |

### Differentiators (Competitive Advantage)

Not required for v0.2 acceptance, but where Noodara can visibly stand out from Coolify/Dokploy without expanding scope.

| Feature | Value Proposition | Complexity | Notes |
|---------|--------------------|------------|-------|
| Deterministic, testable state reconciliation for container status (no silent "stuck Running forever") | This is Dokploy's most-reported class of bug (issues #4461, #2670, #4271, #508, #2106 — deployments/containers stuck showing "Running" with no way to recover except restarting the whole app or touching the DB/Redis by hand) | MEDIUM (mostly a testing discipline, not new tech) | Directly serves Noodara's "cero recursos huérfanos" / TDD principles. A visible differentiator: Noodara should never require the user to `docker restart` the control plane itself to unstick a deploy. |
| Cancel that actually works mid-build, not just for queued items | Dokploy issue #2757 is literally a feature request for "ability to cancel running deployments" — filed because it didn't work; issue #390 "stop deploy is not effective" | MEDIUM-HIGH | Requires killing the underlying `docker build`/BuildKit process and cleaning any half-built image/container, which is exactly what roadmap §7.8 tests for ("no quedan recursos temporales después de cancelar"). |
| Actionable, classified build failures (not raw stdout dump) | Render's approach is "search the log explorer for the word `error`" — i.e., the user still has to read raw logs. Noodara's design doctrine (`ui-build-prompt.md` §9.17) already bans raw server text and mandates a closed vocabulary of error codes with copy per code | MEDIUM | v0.1 already proved this pattern for SSH error codes (`AUTH_FAILED`, `CONNECT_TIMEOUT`, etc.). Extending the same discipline to build/deploy failures (e.g. `GIT_CLONE_FAILED`, `DOCKERFILE_NOT_FOUND`, `BUILD_FAILED`, `PORT_ALREADY_IN_USE`) is a natural, low-risk differentiator that reuses an existing pattern rather than inventing one. |
| Calm, narrated deploy progress (steps with pass/fail + duration), same authored-moment treatment as v0.1's discovery narration | `ui-build-prompt.md` §8.4 explicitly calls the discovery narration "lo que Coolify y Dokploy no tienen" — the same treatment applied to a deploy timeline (queued → cloning → building → starting → running) is a direct extension of an already-validated pattern | MEDIUM | Reuses the SSE + step-by-step UI pattern already built for discovery in v0.1; low net-new architecture. |
| Fixture-driven, repeatable deploy testing (`node-api`, `static-app`, `failing-build`) as first-class product quality signal | No competitor documents this level of deploy-path test rigor publicly; it's Noodara's TDD culture applied to the deploy engine itself | LOW (already mandated by roadmap §7.6) | Not user-facing, but it is what prevents Noodara from shipping the exact bug classes found in Dokploy's issue tracker. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that look good at this stage but would violate the roadmap's version ordering or Noodara's stated principles.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| Git webhooks / auto-deploy on push | Every competitor has it; feels like an obvious "modern PaaS" checkbox | Explicitly deferred to v0.3 by roadmap §8.4 (needs signature verification, duplicate-delivery handling, retries — real complexity that belongs with the deployment state machine, not the basic deploy mechanism) | Manual "Deploy" button in v0.2; webhook-triggered deploy lands in v0.3 once the deterministic state machine exists to receive it safely |
| Healthchecks gating "success" | Roadmap's own E2E example in §7.7 ends with "service becomes HEALTHY", which could tempt building HTTP/TCP healthchecks now | Roadmap §8.5 defines healthchecks (HTTP/TCP/container state, with path/port/timeout/interval/retries) as v0.3 scope — building them now duplicates work once the deployment state machine formalizes HEALTHCHECK as a state | v0.2's "HEALTHY" is intentionally coarse: container is `running` and (if applicable) the fixture's `/health` responds once, checked as an E2E assertion, not a first-class recurring healthcheck feature |
| Rollback to a previous deployment | Natural adjacent feature once deploy history exists (Railway, Render, Fly.io, Kamal all have it) | Roadmap §8.6 defines rollback as a v0.3 feature tied to the Deployment entity's `previous_deployment` field and the state machine's `ROLLING_BACK`/`ROLLED_BACK` states — v0.2 doesn't have that entity shape yet | v0.2 gives "redeploy" (re-run current source ref) as the only recovery action; true rollback (pick an older immutable build) waits for v0.3 |
| Environment variables / secrets UI on services | Feels incomplete to deploy an app with no way to configure it — real user pain | Roadmap explicitly assigns this to v0.4 (§9.5–9.7); v0.2's Service entity intentionally has no env var storage yet, per project instructions in the milestone brief | Document the dependency clearly in requirements: "Service" record has no env vars field in v0.2; apps that need runtime config must bake it into the Docker image or Dockerfile for now, and this limitation should be stated in the docs site's first-deploy guide |
| Domain/HTTPS exposure for the deployed service | Users will immediately ask "how do I visit my app" | v0.4 scope (Traefik, TLS, domain routing) — building any of it now creates a networking dependency the current architecture doesn't have | v0.2's "service becomes HEALTHY" is verified via container state + internal port reachability from the control plane (e.g., an internal health probe against the mapped port), not via a public URL |
| One-click "template marketplace" (Coolify's 300+ service templates, Dokploy's template system) | Both major competitors lead marketing with this; looks like fast user value | Massive scope expansion unrelated to any v0.2 acceptance criterion; invites maintaining dozens of third-party Compose templates | Not in scope for any version through v0.5 per roadmap — Noodara's three services types (Git/Dockerfile/image) are the whole v0.2 surface |
| Multi-service Docker Compose stacks as a first-class "Service" | Dokploy treats Compose as its own resource type; feels like a natural v0.2 extension since Docker Compose is already a discovered capability from v0.1 | Roadmap §7 defines one Service = one deployable unit (repo/Dockerfile/image), not a Compose stack; Compose-as-Service adds N-container networking and naming-collision complexity not covered by v0.2's acceptance criteria | Keep "Service" singular-container for v0.2; Compose-stack-as-Service is a candidate for research in a later milestone, not now |
| Log search/filter across build+runtime logs | Feels essential once you have logs | Roadmap §10.2 explicitly scopes "filter, basic search, timestamps, source identification" to v0.5, and even then says "no intentar reemplazar Datadog/Loki/ELK" | v0.2 gives tail + follow of raw ordered log lines only; search/filter is deferred |
| Auto-retry failed builds | Seems resilient; several users file feature requests for it against competitors | Silent retries hide root cause and can multiply orphaned resources (build cache, half-pulled images) if not idempotent — exactly the failure mode the roadmap's "no orphan resources" criteria guard against, and idempotency isn't guaranteed until v0.3's deployment engine | Surface the failure with an actionable error and a manual "Redeploy" button; no automatic retry until the v0.3 state machine can guarantee idempotency |

## Feature Dependencies

```
Project (CRUD)
    └──requires──> none (leaf entity, needs ownership scoping only)

Environment (CRUD)
    └──requires──> Project

Service (create from Git/Dockerfile/image)
    └──requires──> Environment, Server (must be CONNECTED, Docker present — v0.1 discovery facts)
    └──requires──> Git credential storage (private repos) ──requires──> v0.1's encryption/secret-storage pattern (AES-256-GCM at-rest, same as SSH credentials)

Deploy trigger (manual button)
    └──requires──> Service (source type + repo/image + branch + build context + internal port all recorded)
    └──requires──> Docker operations (pull/build/create/start) on the target Server via SSH (reuses v0.1's `packages/ssh` adapter — no new transport)

Build logs (streamed)
    └──requires──> Deploy trigger
    └──enhances──> Cancel (a visible in-progress build is what makes "cancel this" meaningful in the UI)

Runtime logs
    └──requires──> Container successfully created (i.e., build succeeded or image pulled)
    └──conflicts with──> nothing; independent of build logs stream

Real container state in UI
    └──requires──> Docker "inspect container" operation (roadmap §7.2)
    └──requires──> a reconciliation mechanism (poll or Docker events) distinct from "state as of last deploy" — this is the exact gap that causes Dokploy's "stuck Running" bug class

Redeploy
    └──requires──> Deploy trigger (re-runs same flow)
    └──enhances──> Failed build recovery (redeploy after fixing repo/Dockerfile)

Cancel (queued)
    └──requires──> a deploy queue/lock (only one deploy in flight per service — matches Render's "only one deploy can run at a time per service" policy)

Cancel (in-progress)
    └──requires──> ability to kill the underlying docker build/exec process and clean partial artifacts ──requires──> explicit process/resource tracking per deployment attempt (this is harder than "cancel queued" and is where Dokploy visibly fails — treat as its own tested path, not an afterthought)

Environment variables / secrets on Service
    └──DEFERRED TO v0.4── (Service entity in v0.2 has no env var storage; do not build placeholder UI for it — ui-build-prompt.md §2.3/§9.19 forbid "coming soon" affordances)

Domain/HTTPS
    └──DEFERRED TO v0.4── (no dependency created by v0.2's Service shape; internal port is enough for v0.2's "service becomes HEALTHY" check)

Webhooks / auto-deploy, Healthchecks, Rollback
    └──DEFERRED TO v0.3── (require the Deployment entity + state machine that v0.2 does not build; v0.2's "deploy" is a single synchronous/queued operation, not a multi-state machine)

Admin profile edit (name/email/password)
    └──requires──> v0.1's existing single-admin User + Better Auth session management (no new auth architecture)

Appearance settings (theme auto/light/dark, reduced motion, density)
    └──requires──> v0.1's existing ThemeToggle component and design tokens (additive: persistence + "auto" option + new preference dimensions)

Docs site + Landing page
    └──requires──> Brand kit (logo, wordmark, favicon) — first item in the v0.2 target feature order per PROJECT.md
    └──enhances──> nothing functional; pure content/marketing surface, independently shippable from the app changes
```

### Dependency Notes

- **Service requires Server discovery facts from v0.1:** a Service cannot be created against a server that is not `CONNECTED` with Docker present — this reuses v0.1's state machine rather than inventing a new precondition check.
- **Git credential storage requires v0.1's encryption pattern:** private-repo access (SSH deploy key, per Coolify's and Dokploy's convergent pattern) must go through the same AES-256-GCM-at-rest, never-returned-to-browser discipline already built for SSH server credentials — this is a security requirement, not just a nice-to-have consistency choice.
- **Cancel (in-progress) is a materially different problem from Cancel (queued):** Dokploy's own issue tracker shows queued-cancel shipped but in-progress-cancel did not (#2757, #390). Treat these as two distinct, separately-tested behaviors in requirements, not one checkbox.
- **Real container state reconciliation is not free with "inspect container":** a single `docker inspect` call at deploy time gives a snapshot, not ongoing truth. The roadmap's acceptance criterion "Estado real del container coincide con UI/API" implies either periodic polling or subscribing to Docker events — this should be called out explicitly to the requirements/roadmap phase as a design decision point, not left implicit.
- **Env vars/secrets and domains are hard dependencies for v0.4, not v0.2:** the Service entity recorded in v0.2 (per roadmap §7.1: name, project, environment, server, source type, repository/image, branch, internal port, status, timestamps) has no field for env vars or domain. Any v0.2 UI that implies "you can configure this later here" without the field existing yet risks becoming a placeholder, which `ui-build-prompt.md` explicitly forbids. Requirements should state today's Service shape does not include env vars and flag it as a known, deliberate gap the first-deploy docs guide must call out (e.g., "bake config into the image for now").
- **Webhooks, healthchecks, and rollback depend on the Deployment entity + state machine, which is v0.3 work:** v0.2's "deploy" should be modeled as a simpler, still-fully-tested operation (queued → building → running/failed) without inventing the full v0.3 state machine early — this matches the roadmap's explicit warning against building "nada de v0.2+ salvo que desbloquee un criterio de aceptación de v0.1" applied forward (don't build v0.3 shapes early either).

## MVP Definition

### Launch With (v0.2)

Minimum to satisfy roadmap §7.8's acceptance criteria and the milestone goal in `PROJECT.md`.

- [ ] Project CRUD (create, edit, archive/delete, list) — table stakes, foundation for everything else
- [ ] Environment CRUD under a Project, with production/staging/development/custom as suggested (not enforced) names — roadmap explicitly says "no deben estar limitados exclusivamente a esos nombres"
- [ ] Service creation from Git repo (with branch, build context, internal port) — table stakes
- [ ] Service creation from Dockerfile (with build context, Dockerfile path) — table stakes
- [ ] Service creation from Docker image — table stakes
- [ ] Docker operations: pull, build, create, start, stop, restart, remove, inspect — roadmap §7.2, all required for acceptance
- [ ] Git operations: clone, checkout branch, validate repo URL, private-repo credential, commit SHA capture — roadmap §7.3
- [ ] Manual deploy trigger with build logs streamed live — table stakes
- [ ] Runtime logs (basic tail) — table stakes, explicit acceptance criterion
- [ ] Redeploy (re-run current build) — table stakes
- [ ] Cancel — both queued and in-progress, with guaranteed cleanup of partial resources — explicit acceptance criterion, and the exact area where competitors are weakest
- [ ] Real container state reconciliation shown accurately in UI/API — explicit acceptance criterion, needs a deliberate design decision (poll vs. events)
- [ ] Failed build surfaces a classified, actionable error (closed vocabulary, no raw server text) — extends v0.1's error-code pattern, explicit acceptance criterion
- [ ] Fixtures: `node-api`, `static-app`, `failing-build` — roadmap §7.6, needed to make the above testable and repeatable
- [ ] Editable admin profile (name, email, password) — explicit milestone target feature
- [ ] Appearance settings (theme auto/light/dark with persistent override, reduced motion, density) — explicit milestone target feature
- [ ] Public docs site with install command, concepts, first-deploy guide — explicit milestone target feature
- [ ] Public landing page — explicit milestone target feature
- [ ] Brand identity applied across app, README, docs — explicit milestone target feature, and listed first in PROJECT.md's target feature order

### Add After Validation (v0.3)

Trigger: once v0.2's basic deploy mechanism is proven reliable (20 consecutive deploys, no orphaned resources).

- [ ] Git webhooks (push-triggered deploy) — needs the deterministic state machine to be safe against duplicate delivery
- [ ] Healthchecks (HTTP/TCP/container state) as a recurring, configurable feature — v0.2's coarse "container running" check is enough until then
- [ ] Rollback to a previous deployment — needs immutable Deployment history with image references
- [ ] Deployment history with full state machine (QUEUED → PREPARING → BUILDING → DEPLOYING → HEALTHCHECK → SUCCESS/FAILED/ROLLED_BACK/CANCELLED)

### Future Consideration (v0.4+)

- [ ] Environment variables and secrets per service — deferred by roadmap to v0.4, needs the Secret entity and reference-resolution model
- [ ] Domain attachment and HTTPS — deferred to v0.4, needs Traefik integration
- [ ] Template marketplace / one-click service catalog — not on the roadmap through v0.5 at all; explicitly out of scope per "Fuera de alcance" in CLAUDE.md (no generic CI/CD, no scope creep)
- [ ] Multi-container Compose-as-Service — no roadmap version currently claims this; candidate for post-v0.5 review only if user demand appears

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|----------------------|----------|
| Project/Environment/Service CRUD | HIGH | LOW | P1 |
| Deploy from Git/Dockerfile/image | HIGH | MEDIUM | P1 |
| Docker + Git operations (roadmap §7.2/§7.3) | HIGH | MEDIUM | P1 |
| Build logs streamed | HIGH | MEDIUM | P1 |
| Runtime logs (basic) | HIGH | MEDIUM | P1 |
| Real container state reconciliation | HIGH | MEDIUM-HIGH | P1 |
| Cancel (queued and in-progress) | HIGH | MEDIUM-HIGH | P1 |
| Redeploy | HIGH | LOW-MEDIUM | P1 |
| Classified/actionable failed-build errors | HIGH | MEDIUM | P1 |
| Fixtures (`node-api`, `static-app`, `failing-build`) | MEDIUM (enables testing, not user-facing) | LOW | P1 |
| Admin profile edit | MEDIUM | LOW | P1 |
| Appearance settings | MEDIUM | LOW | P1 |
| Docs site (install, concepts, first deploy) | HIGH (onboarding/trust) | LOW-MEDIUM (content) | P1 |
| Landing page | MEDIUM (marketing/trust) | LOW-MEDIUM (content) | P1 |
| Brand identity | MEDIUM | LOW-MEDIUM | P1 |
| Log search/filter | MEDIUM | MEDIUM | P3 (v0.5 per roadmap) |
| Webhooks | HIGH | MEDIUM-HIGH | P2 (v0.3) |
| Healthchecks (recurring) | HIGH | MEDIUM | P2 (v0.3) |
| Rollback | HIGH | MEDIUM-HIGH | P2 (v0.3) |
| Env vars/secrets on service | HIGH | MEDIUM-HIGH | P2 (v0.4) |
| Domains/HTTPS | HIGH | HIGH | P2 (v0.4) |
| Template marketplace | LOW (for this audience/stage) | HIGH | P3 (not roadmapped) |

## Competitor Feature Analysis

| Feature | Coolify | Dokploy | Railway | Render | Fly.io | Kamal | Our Approach |
|---------|---------|---------|---------|--------|--------|-------|--------------|
| Source types | Git (GitHub/GitLab/Bitbucket/Gitea), Dockerfile, Compose, image [Source](https://coolify.io/docs/applications/deployments/overview) | Git (Github/Git/Docker + Nixpacks/Railpack/Buildpacks/Dockerfile/Static) [Source](https://docs.dokploy.com/docs/core/applications/build-type) | Source code (Railpack/Dockerfile) or Docker image [Source](https://docs.railway.com/deployments/reference) | Git repo or image | `fly.toml` + Dockerfile/buildpack, or `--image` | Docker image via `deploy.yml`, no build service | Git repo, Dockerfile, image — matches roadmap §7.1 exactly, no buildpacks/Nixpacks in v0.2 |
| Private repo auth | SSH deploy key (read-only, single-repo scope) or GitHub App [Source](https://coolify.io/docs/applications/ci-cd/github/deploy-key) | SSH key added to Git provider + SSH URL required [Source](https://docs.dokploy.com/docs/core/providers) | GitHub App integration | GitHub/GitLab OAuth app | GitHub Actions token pattern | N/A (deploys pre-built images, no Git) | SSH deploy-key pattern (reuses v0.1's SSH credential storage/encryption); GitHub as first explicit integration per roadmap §7.3, generic Git via SSH URL when reasonable |
| Deploy trigger | Manual, webhook (auto on push via GitHub App), API | Manual, webhook | Manual (CLI/dashboard), auto on push, API | Manual, auto on push | CLI (`fly deploy`) | CLI (`kamal deploy`) | Manual only in v0.2; webhook is v0.3 |
| Build/runtime log separation | Both shown, "examine both because a build can succeed while the process crashes at startup" | Deployment record shows build progress; separate container logs for runtime | Explicit: build logs during build, deploy logs during deploy | Deploy log explorer, separate from live app logs | `fly logs` for runtime, deploy output during `fly deploy` | `kamal app logs` for runtime, deploy output during `kamal deploy` | Same separation: build logs tied to a deploy attempt, runtime logs tied to the running container, independent lifetimes |
| Cancel | Cancel button (queued/in-progress) | **Cancel only works for queued deployments; in-progress cancel documented as broken/requested** (issues #2757, #390) [Source](https://github.com/Dokploy/dokploy/issues/2757) | "Abort deployment" from menu, works in-progress | Auto-cancel on health-check failure, keeps old instance running | N/A (blue/green orchestrated by platform) | N/A | Must handle both queued and in-progress cancel correctly and test it — this is Noodara's clearest opportunity to beat a documented competitor gap |
| Failed build behavior | Preserves running app, doesn't replace it | Same pattern; failed deploy record kept | Deployment marked Failed, previous stays live | "original service instance continues running without interruption" | Old machine stays up until new one healthy | Rolling restart keeps old containers until new ones healthy | Same pattern: never replace a healthy running service with a failed build; roadmap acceptance criterion |
| Redeploy semantics | Re-run same deployment flow | Re-trigger deploy from stored config | New deployment, identical code+config | Re-trigger | `fly deploy` again | `kamal deploy` again | v0.2: re-run current source ref (no immutable deployment history yet, that's v0.3) |
| Rollback | Via deployment history (not detailed in docs excerpt) | Not surfaced in researched docs | Explicit rollback action, restores image + variables | Documented zero-downtime rollback article | `fly releases --image` + redeploy older image | `kamal rollback VERSION` | Deferred to v0.3 per roadmap §8.6 — do not build in v0.2 |
| Container state / health surfaced | Runtime settings incl. health checks (docs don't detail drift-handling) | Monitoring graphs "only updated if you are viewing the current page" (implies polling while open, not push) | Deployment statuses incl. Crashed, auto-restart up to 10x | Health-check-gated deploy promotion | Machine checks, `fly status` | Docker healthcheck + rolling restart | Needs explicit reconciliation design (poll interval or Docker events), not "only while page is open" — flag as design decision |
| Admin/profile settings | Profile > General: name/email/password, signs out all sessions + revokes API tokens on password change | Whitelabel (Enterprise) for branding; ProfileForm component for account | Account settings via dashboard | Account settings via dashboard | N/A (CLI-first, fly.io account is separate SaaS) | N/A (no UI at all) | Reuse v0.1's Better Auth session model; copy the "sign out everywhere + revoke tokens on password change" security pattern |
| Docs site shape | Get Started (self-hosted/cloud choice) → first deploy guides → per-framework guides → Services/Databases reference → Developer Tools (API/CLI) | Core (essential guides) → Services (deploy mechanics) → Remote Servers → Troubleshooting → Guides → Examples | Guides + reference docs, CLI-documented per command | Deploys/Troubleshooting/Logging as distinct doc trees, "Your First Deploy" as a named page | Deep CLI reference (`flyctl`), Rails/language-specific guides | Single docs site (kamal-deploy.org) + community wiki (kamal.wiki) for logs/how-tos | Converge on: Get Started (install command) → Concepts (Project/Environment/Service, Server) → First Deploy walkthrough → Reference (per source type, per Docker/Git operation) → Troubleshooting (error-code table) |

## Sourced Behavior — Detail for Requirements

This section expands on specific, requirements-relevant behaviors referenced in the tables above.

**What a Service records (cross-competitor convergence, confirms roadmap §7.1):**
Coolify and Dokploy both converge on the same minimal shape: source type, repository/image reference, branch (Git only), build method/context (Dockerfile path + build context for Dockerfile type; publish directory for static builds), and a port. Roadmap §7.1's field list (`name, project, environment, server, source type, repository/image, branch, internal port, status, created_at, updated_at`) matches this convergence closely — no missing field was found in competitor docs that roadmap §7.1 lacks for v0.2's scope. **Confidence: HIGH** (directly sourced from Dokploy's build-type docs and Coolify's deployment overview).

**Env vars are explicitly out of the Service record in v0.2 (dependency to flag to requirements):**
Roadmap §7.1 does not list env vars in the Service fields, and roadmap §9.5 assigns "Variables por service" to v0.4. This means v0.2's first-deploy docs guide and the Service-creation UI must not imply env var configuration is available — apps needing runtime config must bake it into the image/Dockerfile for the v0.2 milestone. **Confidence: HIGH** (directly stated in roadmap, cross-checked against `ui-build-prompt.md` §2.3's explicit list of what does not exist yet and its "no placeholders" rule).

**Deploy trigger → steps → logs → duration → final state, expected shape:**
Every competitor researched shows: (1) a deployment/build record created on trigger, (2) live streamed output during build, (3) a terminal state (success/failed/cancelled), (4) the record persists in a list for later inspection. None of the six competitors show a step-by-step "narrated" build (numbered named steps with pass/fail, like Noodara's discovery flow) — this is confirmed as a real differentiation opportunity, not just aspirational framing. **Confidence: MEDIUM** (docs describe the log stream and final states clearly; the absence of a narrated-steps UI is inferred from the absence of any mention across all six docs sets, not an explicit competitor statement that they lack it).

**Cancel semantics, queued vs. in-progress — the highest-signal pitfall found:**
Dokploy's own GitHub issues (#2757 "ability to cancel running deployments" filed as a feature request, and #390 "stop deploy is not effective") show that a "Cancel" button in the UI does not necessarily terminate an in-progress `docker build`. Roadmap §7.8 requires "no quedan recursos temporales después de cancelar" — this must be tested against an in-progress build specifically, not just a queued one, or Noodara risks shipping the same visible gap. **Confidence: HIGH** (directly sourced from Dokploy's public issue tracker, filed by real users against the exact behavior Noodara needs to implement correctly).

**Real container state reconciliation — the second-highest-signal pitfall:**
Multiple Dokploy issues (#4461, #2670, #4271, #508, #2106) describe deployments/containers stuck showing "Running" indefinitely with no automatic correction — in the worst case, the only documented workaround was restarting the entire Dokploy application via `docker restart`, or manually editing Postgres/Redis state. This is a state-reconciliation failure: the UI's cached "Running" status was never re-verified against the actual Docker daemon state, or the queue's lock was never released. Roadmap §7.8's "Estado real del container coincide con UI/API" is exactly the guarantee that these issues violate. **Confidence: HIGH** (five independent GitHub issues against one competitor, consistent symptom pattern).

**Disk-space and orphaned-resource pitfalls, general Docker + Coolify-specific:**
Coolify issues document Docker cleanup getting stuck in an "endless" state and BuildKit/containerd snapshots filling disk without being reclaimed, sometimes because the daemon's build cache retention isn't bounded. Roadmap §7.8 explicitly requires "20 create/delete cycles no dejan containers ni networks huérfanos" and "no quedan recursos temporales después de cancelar" — these acceptance criteria exist precisely because this class of bug is common in the ecosystem. **Confidence: MEDIUM-HIGH** (sourced from Coolify's own GitHub issues #5611, #7270, and a community discussion #3192 on "no space left on device"; general pattern, not deeply investigated root cause).

## Docs Site Content Requirements (v0.2 scope)

Both Coolify's and Dokploy's public docs converge on the same top-level shape, which should inform Noodara's v0.2 docs site:

1. **Get Started / install** — a single copy-pasteable install command as the very first thing shown (Coolify frames this as "choose your path: self-hosted vs cloud"; Dokploy leads with "Core: essential guides for deploying and managing applications"). Noodara already has this from v0.1: `curl -fsSL .../install.sh | sh`.
2. **Concepts** — neither competitor has a dedicated "concepts" page as prominently as Noodara should; Dokploy's structure implies concepts through its "Core" section rather than naming them explicitly. Noodara should make Project → Environment → Service → Server explicit and diagram it, since this hierarchy is new in v0.2 and not something a Coolify/Dokploy switcher will recognize by name (Coolify uses "Applications" more flatly; Dokploy uses "Applications" + "Compose" as project-adjacent but less strictly nested).
3. **First deploy guide** — both competitors have a named "first deployment" walkthrough (Coolify: "Deploying Your First Application"; Render: "Your First Render Deploy"). Noodara's equivalent should walk: connect a server (already done in v0.1) → create project → create environment → create service (pick one of Git/Dockerfile/image) → deploy → watch build logs → see runtime logs → see container state → (explicitly note: no env vars yet, no domain yet — those come in v0.4).
4. **Reference per source type / per operation** — Dokploy's "Services" section and Coolify's "Applications" + framework-specific pages are the reference-depth tier; Noodara's v0.2 equivalent is one reference page per source type (Git/Dockerfile/image) plus a reference for each Docker/Git operation exposed (deploy, redeploy, stop, restart, remove, cancel).
5. **Troubleshooting / error codes** — Dokploy has a dedicated Troubleshooting section. Noodara should mirror this with a page mapping each closed-vocabulary error code (the deploy/build equivalent of v0.1's `AUTH_FAILED`, `HOST_KEY_CHANGED`, etc.) to what it means and what to do.

**Confidence: MEDIUM** (structural convergence is directly observed from both docs sites' navigation; the specific recommendation to add an explicit "Concepts" page is an inference, not something either competitor does prominently — flagged as a genuine content-strategy choice for Noodara, not a copied pattern).

## Landing Page Content Requirements (v0.2 scope)

Not deeply competitor-sourced (landing-page copy strategy is not a "documentation" claim that needs the same sourcing rigor), but structurally, both Coolify's and Dokploy's marketing sites lead with: install command visible near the top, a short "what it replaces" framing (self-hosted alternative to Heroku/Vercel), and a link straight into docs. Noodara's landing page should do the same, plus lead with the differentiator framing already established in `PROJECT.md` and `ui-build-prompt.md`: "Your infrastructure, understood" / "Complex infrastructure. Calm interface." — i.e., don't just copy Coolify/Dokploy's "deploy anything Docker can run" framing; lead with the understanding angle even though the AI/graph features themselves don't ship until v0.5. **Confidence: LOW-MEDIUM** (general marketing-site convention observed, not a documented "best practice" source; this is closer to a product-copy recommendation than a researched fact).

## Sources

- [Coolify — Deployments Overview](https://coolify.io/docs/applications/deployments/overview)
- [Coolify — GitHub Deploy Key](https://coolify.io/docs/applications/ci-cd/github/deploy-key)
- [Coolify GitHub issue #1129 — Password admin](https://github.com/coollabsio/coolify/issues/1129)
- [Coolify GitHub issue #6414 — PR deployment stuck in progress](https://github.com/coollabsio/coolify/issues/6414)
- [Coolify GitHub issue #5611 — Endless Docker cleanup](https://github.com/coollabsio/coolify/issues/5611)
- [Coolify GitHub issue #7270 — Disk filled by containerd snapshots](https://github.com/coollabsio/coolify/issues/7270)
- [Coolify GitHub discussion #3192 — No space left on device](https://github.com/coollabsio/coolify/discussions/3192)
- [Coolify docs homepage](https://coolify.io/docs)
- [Dokploy — Applications](https://docs.dokploy.com/docs/core/applications)
- [Dokploy — Build Type](https://docs.dokploy.com/docs/core/applications/build-type)
- [Dokploy — Providers](https://docs.dokploy.com/docs/core/providers)
- [Dokploy docs homepage](https://docs.dokploy.com)
- [Dokploy GitHub issue #4461 — Deployment stuck in "running" forever after OOM](https://github.com/Dokploy/dokploy/issues/4461)
- [Dokploy GitHub issue #2670 — Deployments marked "running" when they never ended](https://github.com/Dokploy/dokploy/issues/2670)
- [Dokploy GitHub issue #4271 — Deployment stuck in "Running" with no logs/containers](https://github.com/Dokploy/dokploy/issues/4271)
- [Dokploy GitHub issue #2106 — Program deployment always stuck at running](https://github.com/Dokploy/dokploy/issues/2106)
- [Dokploy GitHub issue #508 — Deployments get stuck](https://github.com/Dokploy/dokploy/issues/508)
- [Dokploy GitHub issue #2757 — Ability to cancel running deployments](https://github.com/Dokploy/dokploy/issues/2757)
- [Dokploy GitHub issue #390 — Stop deploy is not effective](https://github.com/Dokploy/dokploy/issues/390)
- [Railway — Deployments Reference](https://docs.railway.com/deployments/reference)
- [Railway — Deployment Actions](https://docs.railway.com/deployments/deployment-actions)
- [Render — Troubleshooting Your Deploy](https://render.com/docs/troubleshooting-deploys)
- [Render — Deploying on Render](https://render.com/docs/deploys)
- [Fly.io — Rollback Guide](https://fly.io/docs/blueprints/rollback-guide/)
- [Fly.io — fly releases](https://fly.io/docs/flyctl/releases/)
- [Kamal — kamal rollback](https://kamal-deploy.org/docs/commands/rollback/)
- [Kamal Wiki — How to access Rails app logs on Kamal](https://kamal.wiki/how-to-view-rails-app-logs-on-kamal/)
- Internal: `/Users/xch4rt/work/myself/noodara/code/docs/roadmap-v0.1-v0.5.md` §7 (v0.2 scope, source of truth)
- Internal: `/Users/xch4rt/work/myself/noodara/code/docs/ui-build-prompt.md` §2, §8 (product context, product-signature moments, "no placeholders" rule)
- Internal: `/Users/xch4rt/work/myself/noodara/code/.planning/PROJECT.md` (milestone goal, target feature order, validated v0.1 scope)

---
*Feature research for: self-hosted PaaS, v0.2 Projects & Services scope*
*Researched: 2026-09-22*
