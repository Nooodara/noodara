# Phase 5: UI web - Research

**Researched:** 2026-09-19
**Domain:** Next.js 16 App Router admin dashboard consuming an existing Fastify+SSE API; Playwright E2E; a from-scratch `packages/ui` design system on Radix + Tailwind v4
**Confidence:** HIGH (backend contract, security gaps, package legitimacy) / MEDIUM (Next.js 16 App Router patterns, data-fetching architecture — no Context7 fetch performed this session, reasoned from 05-UI-SPEC.md + STACK.md + direct code reading) / LOW (exact discovery-progress event/endpoint naming — explicitly still open per 05-UI-SPEC.md §11)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Heredado de fases anteriores (bloqueado, no se re-discutió)**
- Next.js 16 App Router como cliente delgado de la API Fastify (PROJECT.md, aprobado por el usuario). Nunca habla con Postgres ni Redis.
- Same-origin: Next proxya `/api/*` al API con `rewrites` en dev; sin CORS; cookies `SameSite=Lax` y `EventSource` sin configuración extra (fase 4 D-29). Las mutaciones llevan `Origin` igual a `NOODARA_PUBLIC_URL` o el API responde 403 `FORBIDDEN_ORIGIN`.
- Un único stream SSE global `GET /api/events` compartido por lista y detalle. Sin replay: al reconectar `EventSource`, la UI resincroniza con `GET /api/servers`. Un 401 en el stream o en cualquier ruta redirige a login (fase 4 D-01, D-05, D-06). `503 SSE_LIMIT_REACHED` trae `Retry-After`.
- `connect` y `discover` responden 202 y el progreso llega solo por SSE; `jobId` nunca se usa para polling (fase 4 D-08).
- Vocabulario único de errores `{ error: 'CODE', message }` y `VALIDATION_FAILED` con `issues: [{ path, message }]` (fase 4 D-16).
- Crear/editar en sheet lateral; credencial nunca precargada, muestra `••••••••` + "Replace"; borrar exige escribir el nombre y el API ya lo valida (`CONFIRMATION_MISMATCH`, fase 3 D-12).
- ed25519 recomendado en la UI (fase 2 D-01). El fingerprint se muestra exactamente como `ssh-keygen -lf` (`ssh-ed25519 SHA256:...`, fase 2 D-04/D-05).
- `CONNECTED` significa "la última operación tuvo éxito", no un socket abierto (fase 3 D-03). `UNSUPPORTED_OS` y Docker ausente son advertencias con el servidor en CONNECTED (fase 2 D-11/D-12).
- Tokens, escala tipográfica, status pills, layout y reglas Do/Don't: skill `noodara-ux-apple`. Tailwind + Radix, dark primero, light obligatorio, toggle de tema persistido, copy en inglés sentence case.

**Flujo de alta y conexión**
- **D-01:** Botón primario del sheet de alta: "Save and connect" (registra, `POST /connect`, cierra sheet, navega a detalle). Secundario discreto "Save without connecting" deja PENDING.
- **D-02:** Primer connect exitoso (TOFU): aviso neutro y descartable, una sola vez, con fingerprint + comando `ssh-keygen -lf`. El fingerprint queda permanentemente como fila en mono con fecha y botón de copiar.
- **D-03:** `HOST_KEY_CHANGED`: banner de error con ambos fingerprints apilados en mono (confiado y observado, cada uno con fecha) y el comando de verificación. "Trust new fingerprint" abre diálogo que exige escribir el nombre del servidor.
- **D-04:** Credencial en el sheet: segmentado "Private key" (default)/"Password". Textarea mono o "Choose file" (lee en el navegador, nunca multipart). Passphrase opcional. Editar: puntos + "Replace".

**Narrativa de progreso del discovery (DISC-02)**
- **D-05:** Progreso en vivo, check por check. Añade backend: (a) callback por check en `runDiscovery`, (b) nuevo tipo de evento SSE, (c) endpoint de lectura de checks del último run, (d) canary de fugas extendido. Regla dura: la UI nunca muestra progreso que no ha recibido.
- **D-06:** Seis pasos con nombre, expandibles a checks crudos. "SSH reachable"/"Authenticated" vienen del resultado de conexión (no son discovery checks). OS = `hostname`,`os_release`,`arch`; Resources = `cpu`,`memory`,`disk`,`uptime`; Docker = `docker_version`,`docker_compose_version`; Access = `sudo`,`docker_group`. Un paso pasa solo si todos sus checks pasan.
- **D-07:** El checklist vive en una sección "Discovery" del detalle: expandida y en vivo durante un run; al terminar, resumen de una línea que expande al checklist. "Re-run discovery" vive ahí. Solo el último run tiene UI en v0.1.
- **D-08:** Tres desenlaces visuales: pass (`--status-ok`), warning ámbar (`--status-warn`) para un fallo que deja el servidor utilizable, fail rojo (`--status-error`) solo para el check que terminó el run. `not_applicable`/`skipped` en gris idle.

**Lista y detalle de servidores**
- **D-09:** Lista en filas hairline de 44px: nombre, `host:port` mono, status pill, last seen relativo con tooltip ISO. Editar/borrar en menú `⋯` de fila. Sin cards.
- **D-10:** Detalle es su propia página con URL propia. Nombre como título + pill, "Connect"/"Re-run discovery" en toolbar (un solo primario), enlace de vuelta. Inspector no se usa en v0.1.
- **D-11:** Facts (DETL-01): fila de cuatro stat tiles (CPU, RAM, disco, uptime) en mono tabular. Debajo: System/Docker/Connection en pares label/valor. Todo etiquetado "as of" el último discovery.
- **D-12:** Dos estados distintos (DETL-02), una sola acción cada uno. Nunca conectado: estado vacío "Not discovered yet" + "Connect". Falló: banner de error redactado por `error_code`, con los facts del último discovery bueno debajo, atenuados y con su fecha.

**Activity log y settings**
- **D-13:** Paginación con "Load older": primeras 50 filas agrupadas bajo cabeceras de día; sin infinite scroll.
- **D-14:** Cada fila es una frase con nombre de servidor como enlace si existe, `errorCode` en mono solo en fallos, tiempo relativo con tooltip ISO. Expandir muestra pares label/valor elegidos por acción. Solo claves conocidas; nunca JSON crudo.
- **D-15:** Settings no gestiona sesiones en esta fase (queda en SET-01). Sign out disponible desde cualquier pantalla (AUTH-03).
- **D-16:** Settings: grupo Instance (versión, URL pública) + grupo Advanced colapsado (master key fingerprint, timeouts SSH, worker concurrency) en mono, cada uno con nota "fijado por variable de entorno". Todo read-only.

**Restricción de seguridad (de la auditoría de fase 4, no discutida)**
- **D-17:** `04-SECURITY.md` tiene 4 amenazas abiertas y un bypass de TOFU confirmado: `editServer` no limpia `pendingFingerprint` cuando el servidor está en `ERROR`, así que "Trust new fingerprint" puede promover un fingerprint capturado contra el host anterior. La pantalla de D-03 se apoya directamente en ese camino. **Estos arreglos deben estar hechos antes de ejecutar esta fase**; si no lo están al planificar, el plan los incluye como primera ola. El E2E o un test de integración debe cubrir "editar host en ERROR y luego trust" como regresión.

### Claude's Discretion
- Forma del evento de progreso y del endpoint de lectura (D-05): nombres, payload y ruta, dentro de: payload por allowlist explícita, dentro del scope protegido por sesión, publicación best-effort que nunca hace fallar el run, allowlist de tipos del broadcaster ampliado explícitamente, evento solo lleva `detail` ya redactado.
- Página abierta a mitad de un run: sin replay de eventos, resolver bajo la regla de D-05 (no inventar progreso).
- E2E, nightly y canary (QA-04, QA-05): Playwright contra api + worker + web reales con el contenedor sshd de fase 2; repetición nightly 20/20; 100 conexiones consecutivas en integración; job de canary en el mismo run. Reutilizar `pnpm security:scan-leaks`. El repo no tiene remote configurado y solo existe `ci.yml`; el workflow nightly se escribe y valida en local.
- Pantallas de setup, login y lockout: seguir semántica de fase 1 (404 en `/api/setup` cuando ya hay admin, lockout progresivo) sin revelar si una cuenta existe.
- Shell: sidebar lista solo Servers, Activity y Settings — sin placeholders de v0.2+ (CLAUDE.md §8).
- Stream caído: indicador sutil y resincronización al reconectar; nunca presentar datos viejos como en vivo.
- Refresco del activity log: sin nuevo tipo de evento SSE; refetch al enfocar la página o cuando llega un evento de servidor.
- Tras confiar un fingerprint nuevo (`ERROR → PENDING`): PENDING ofrece "Connect" como única acción; no auto-conectar.
- Botón Connect mientras hay un connect en curso: deshabilitado; un 409 `ALREADY_CONNECTING` se trata como estado, no error.
- Capa de datos del cliente (librería de fetching/cache, frontera server/client components), estructura de `packages/ui`, y si hay catálogo de componentes.
- Validación en el sheet: errores inline por campo desde `issues[].path`; `NAME_TAKEN`/`HOST_TAKEN` en su campo.

### Deferred Ideas (OUT OF SCOPE)
- Historial de runs de discovery (lista de snapshots anteriores) — necesita endpoint de listado, no requerido en v0.1.
- Pantalla de sesiones activas en Settings — backend existe, fuera de los diez requisitos de la fase.
- Confirmación obligatoria del fingerprint en el primer connect ("pending first trust") — rompería TOFU y "Save and connect".
- Uso del inspector (tercer panel) — v0.2+.
- Tipo de evento SSE para activity — no en esta fase.
- Configuración global editable — `GET /api/config` sigue read-only.
- Cards o layout alterno para pocos servidores — considerado y no elegido.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SERV-04 | Lista de servidores: nombre, host, status pill, last seen | `GET /api/servers` returns `ServerView[]` (27-field allowlist, see Standard Stack/Code Examples). D-09 row spec in UI-SPEC §2.3. |
| DETL-01 | Detalle: hostname, status, OS, CPU, RAM, disco, uptime, Docker, last seen, fingerprint | Same `ServerView` fields, all already present on `GET /api/servers/:id`. UI-SPEC §2.5/D-11 lays out the exact tile/group mapping. |
| DETL-02 | Distinguir "nunca descubierto" vs "discovery falló", una acción cada uno | Derivable client-side from `status`/`lastErrorCode`/`hostname===null`. `mergeDiscoveryFacts` (phase 3) guarantees old facts never get overwritten by null, which is what makes the "dimmed facts under an error banner" pattern honest. See Common Pitfalls #3. |
| ACT-02 | Activity log cronológico inverso, sin metadatos sensibles | `GET /api/activity` (cursor keyset, 10-column explicit select) already redacts at write time (SEC-02). D-14's curated per-action key rendering is a client-side allowlist on top of an already-safe payload. |
| SET-01 | Pantalla de configuración global mínima | `GET /api/config` returns version/publicUrl/masterKeyFingerprint/sshTimeouts/workerConcurrency verbatim — no new backend work. |
| UI-01 | Shell (sidebar, toolbar, contenido) dark/light, teclado | New `packages/ui` + `apps/web` work, no backend dependency. Full contract in 05-UI-SPEC.md §1. |
| UI-02 | Pantallas setup/login/lista/sheet/detalle/activity/settings con estados vacío/carga/error | Every screen's data source already exists except the discovery-progress live view (DISC-02, see below). Full contract in 05-UI-SPEC.md §2. |
| DISC-02 | Progreso del discovery check por check, pass/fail y detalle, nunca spinner genérico | **Requires new backend surface** — `runDiscovery`/`connectAndDiscover` currently only report a snapshot after the full run completes (see Architecture Patterns / Backend Addition Contract). This is the one requirement in this phase whose data does not exist yet. |
| QA-04 | E2E Playwright login→...→detail; nightly 20/20 + 100 conexiones | `tests/integration/helpers/` (sshd fixture, worker-fixture, boot-process) are reusable. `test:e2e` script is currently a placeholder that must be replaced. |
| QA-05 | Canary secrets en el mismo run, CI y nightly | `pnpm security:scan-leaks` already exists (3 suites) and must be extended to the new SSE event type, new endpoint, and the UI's own outputs (rendered HTML, console, localStorage). |
</phase_requirements>

## Summary

This phase is greenfield on the frontend (`apps/web`, `packages/ui` do not exist yet) but the backend contract it consumes is 95% complete and stable: all eight `/api/servers` routes, `/api/activity`, `/api/config`, `/api/setup`, `/api/recovery`, `/api/sessions`, and the single global `GET /api/events` SSE stream from Phase 4 already return exactly the shapes 05-UI-SPEC.md's screens are designed against. The one genuine gap is DISC-02: today `runDiscovery` (`packages/ssh/src/run-discovery.ts`) runs all eleven checks in a sequential loop and only returns a `DiscoverySnapshot` after the entire run finishes — there is no mechanism to observe a check as it completes. 05-CONTEXT.md's D-05 explicitly authorizes exactly the backend addition needed: an `onCheck` callback threaded through `runDiscovery` → `connectAndDiscover` → a new allowlisted SSE event type, plus a new read endpoint for page-load/mid-run resync. The shapes for both are fully specified in 05-UI-SPEC.md §7 and should be treated as a strong default, not re-derived from scratch, though the exact names remain open per its own §11 item 4.

The critical planning fact this research surfaces that is **not** in 05-UI-SPEC.md's own scope: `04-SECURITY.md` is `status: open` with 4 unresolved threats (T-4-02, T-4-10, T-4-32, T-4-38) and one confirmed, currently-exploitable TOFU bypass (UF-01) that this phase's own UI makes reachable for the first time — the "Trust new fingerprint" flow (D-03) drives directly through the vulnerable code path. 05-CONTEXT.md's own D-17 is explicit and non-negotiable: these fixes must land as this phase's first wave if they aren't already fixed by the time planning happens. Verified directly against the current tree: `edit-server.ts:211` still only clears `pendingFingerprint` `if (row.status === 'CONNECTED')`, never for `ERROR` — the bug is unfixed as of this research pass. This must be Wave 0/1 of the plan, not a footnote.

On the frontend stack: Next.js 16.3.5/React 19.3.0 (STACK.md pinned 16.3.4/19.3.0 — current registry has patched to 16.3.5, functionally equivalent), Tailwind v4.3.3, Radix primitives (`@radix-ui/react-dialog`, `-tooltip`, `-collapsible`, `-radio-group`, `-scroll-area`, `-visually-hidden`, `-checkbox`), `lucide-react`, and `@playwright/test`/`playwright` @1.63.0 all passed `slopcheck` `[OK]` this session and resolve to their expected canonical GitHub orgs (`vercel/next.js`, `react/react` — Meta's org was renamed/migrated to `react/react`, confirmed via a live 301 redirect from `facebook/react`, `tailwindlabs/tailwindcss`, `lucide-icons/lucide`, `microsoft/playwright`, `radix-ui/primitives`). `scripts/check-package-provenance.mjs` must be extended with all of these before install, following the exact pattern already used for `bullmq`/`ioredis` in Phase 4.

**Primary recommendation:** Treat this phase as two workstreams gated in sequence — (1) a mandatory Wave 0 that closes 04-SECURITY.md's 4 open threats plus UF-01, re-verified with a real integration test ("edit host while ERROR, then trust new fingerprint" must now fail safely), and only then (2) the greenfield `packages/ui` + `apps/web` build against the now-stable API contract, adding exactly one new SSE event type and one new read endpoint for DISC-02, never more backend surface than that.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Auth session / cookie handling | API / Backend | Frontend Server (SSR) | Better Auth issues/validates the cookie; Next.js only forwards it same-origin via rewrites and redirects on 401 — it never inspects or mints a session itself. |
| Server CRUD, connect/discover triggers | API / Backend | Browser / Client | All business rules (state machine, uniqueness, credential encoding) live in `apps/control-plane/src/services/*`; the browser only calls the 8 routes and renders the result. |
| Discovery progress narrative (DISC-02) | API / Backend (new SSE event + read endpoint) | Browser / Client (rendering/sequencing) | The check-by-check *data* must originate server-side (D-05's "never invent progress"); the UI's job is purely to render what it received, including the "next pending check" inference from a fixed, known sequence. |
| Real-time state sync (status pills, discovery) | Browser / Client | API / Backend (SSE publisher) | `EventSource` consumption, reconnect/resync logic and optimistic UI (disabling Connect) are pure client concerns; the server only publishes best-effort events, never blocks on delivery. |
| Design system tokens/components (`packages/ui`) | Browser / Client | — | Purely presentational; no I/O, matches `packages/domain`'s "pure" precedent but for UI instead of business logic. |
| Session-scoped theme/localStorage state | Browser / Client | — | `data-theme`, `noodara-theme`, first-trust-notice dismissal — all cosmetic, never security-relevant, never sent to the server. |
| Activity log rendering | Browser / Client | API / Backend (redaction, pagination) | Server already redacts at write time and exposes a safe 10-column projection; the client's curated-key rendering (D-14) is a second, defense-in-depth allowlist, not the only one. |
| E2E/nightly/canary orchestration (QA-04/05) | CI / Backend (test runner) | Browser / Client (Playwright drives a real browser) | Playwright drives the full stack (api+worker+web+sshd fixture) from outside; it is infrastructure, not app code, but its assertions span every tier. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next | 16.3.5 (16.3.4 pinned by STACK.md; registry has moved to a patch release) [ASSUMED: training-derived choice, not independently re-researched via Context7 this session] | App Router web client | Fixed by PROJECT.md/STACK.md as the thin client of the Fastify API; App Router is used purely for routing/SSR shell, no server actions talk to Postgres/Redis directly (constraint from CONTEXT.md). |
| react / react-dom | 19.3.0 | UI runtime | Ships bundled with Next.js 16; STACK.md pin, `npm view` confirms current registry version matches. |
| zod | 4.6.1 | Client-side validation (mirrors server schemas) | Already the project's one validation library (Fastify routes, `packages/domain`); reusing it client-side (not necessarily `WireCredentialSchema` verbatim, since that's a control-plane package) keeps one mental model instead of introducing a second schema library. |
| tailwindcss | 4.3.3 | Utility CSS + `@theme` token binding | v4's CSS-first `@theme` block lets `packages/ui/tokens.css`'s custom properties be referenced directly (`var(--token)`) instead of duplicating values into a JS config — this is the documented reason 05-UI-SPEC.md chose v4 over v3. [CITED: 05-UI-SPEC.md tokens section] |
| @radix-ui/react-dialog, -tooltip, -collapsible, -radio-group, -scroll-area, -visually-hidden, -checkbox | latest 1.x each (verified: 1.1.23 / 1.2.16 / 1.1.20 / current at audit time) | Unstyled accessible primitives for Sheet/Dialog/Tooltip/SegmentedControl/Disclosure/ScrollArea | Locked stack decision (CLAUDE.md §3): "Radix primitives" for `packages/ui`. Handles focus trap, `Esc`-to-close, ARIA roles for free — exactly what the skill's accessibility section requires without hand-rolling. |
| lucide-react | current (verified `[OK]` via slopcheck; version not independently pinned by CONTEXT.md/STACK.md) [ASSUMED: researcher/UI-SPEC decision, explicitly flagged in 05-UI-SPEC.md §11 item 5 for user veto] | Icon set | Stroke-only, matches skill's "una sola familia, 1.5px stroke" rule when `strokeWidth={1.5}` is set explicitly (lucide's default is 2). |
| @playwright/test / playwright | 1.63.0 | E2E runner | Fixed by roadmap (CLAUDE.md §3, STACK.md). |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| next/font (bundled with Next.js, no separate package) | — | Self-host Inter/JetBrains Mono fallback fonts | Only if SF Pro/SF Mono are unavailable (non-Apple client) — `display: 'swap'`, latin subset only, per 05-UI-SPEC.md. |
| clsx or a hand-rolled 10-line `cn()` helper | — | Conditional className composition | Only if component variant logic gets unwieldy with plain template strings — evaluate during Wave 1 before adding; this project has repeatedly declined small utility deps (see STATE.md's "concurrently deliberately not installed" precedent). |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled `fetch` + `EventSource` cache | TanStack Query / SWR | 05-UI-SPEC.md §11 item 6 explicitly defers this decision to the planner: hand-rolled avoids a new dependency (matching this project's "no new tooling unless necessary" pattern, e.g. `concurrently` declined in Phase 4), but if list/detail cache invalidation across the one global SSE stream gets unwieldy by hand, revisit with the user rather than forcing a from-scratch cache layer on the executor. |
| Next.js App Router | TanStack Start / Vite+React Router v7 | STACK.md already resolved this in favor of Next.js for v0.1 (maturity over architectural elegance); not re-open for this phase — CONTEXT.md marks it "heredado ... bloqueado". |
| Radix-styled hand-built components | shadcn/ui | 05-UI-SPEC.md explicitly rejects shadcn/ui ("no `components.json`") in favor of hand-built components directly on Radix primitives — avoids importing a registry/CLI dependency and keeps every component's source directly inside `packages/ui`. |

**Installation (indicative — exact versions re-verified at Wave 1 execution time):**
```bash
pnpm --filter web add next@16.3 react@19.3 react-dom@19.3 zod
pnpm --filter web add -D tailwindcss@4 @tailwindcss/postcss
pnpm --filter ui add @radix-ui/react-dialog @radix-ui/react-tooltip @radix-ui/react-collapsible @radix-ui/react-radio-group @radix-ui/react-scroll-area @radix-ui/react-visually-hidden @radix-ui/react-checkbox lucide-react
pnpm add -D -w @playwright/test
```

**Version verification:** ran `npm view <pkg> version` for every package above on 2026-09-19 (see Package Legitimacy Audit table for exact resolved versions and repository URLs). `next`/`react`/`react-dom` match STACK.md's pins almost exactly (next has moved one patch release forward, 16.3.4 → 16.3.5); everything else was not independently pinned in prior research and is resolved fresh here.

## Package Legitimacy Audit

`slopcheck scan --pkg npm <name> --json` was run for every net-new package this phase would install (slopcheck is installed and functional in this environment — no fallback needed). All returned `"status": "OK"`, `"flags": []`. `npm view <pkg> repository.url` was cross-checked against each package's known canonical org.

| Package | Registry | Resolved version | Source Repo | slopcheck | Disposition |
|---------|----------|-------------------|--------------|-----------|-------------|
| next | npm | 16.3.5 | github.com/vercel/next.js | OK | Approved |
| react | npm | 19.3.0 | github.com/react/react (redirect target of the renamed `facebook/react` org — confirmed live via `curl -I https://github.com/facebook/react` → 301 → `github.com/react/react`) | OK | Approved |
| react-dom | npm | 19.3.0 | github.com/react/react (monorepo, `packages/react-dom`) | OK | Approved |
| tailwindcss | npm | 4.3.3 | github.com/tailwindlabs/tailwindcss | OK | Approved |
| lucide-react | npm | 1.47.0 | github.com/lucide-icons/lucide | OK | Approved |
| @playwright/test | npm | 1.63.0 | github.com/microsoft/playwright | OK | Approved |
| playwright | npm | 1.63.0 | github.com/microsoft/playwright | OK | Approved |
| @radix-ui/react-dialog | npm | 1.1.23 | github.com/radix-ui/primitives | OK | Approved |
| @radix-ui/react-tooltip | npm | 1.2.16 | github.com/radix-ui/primitives | OK | Approved |
| @radix-ui/react-collapsible | npm | 1.1.20 | github.com/radix-ui/primitives | OK | Approved |
| @radix-ui/react-radio-group | npm | (current, OK) | github.com/radix-ui/primitives | OK | Approved |
| @radix-ui/react-scroll-area | npm | (current, OK) | github.com/radix-ui/primitives | OK | Approved |
| @radix-ui/react-visually-hidden | npm | (current, OK) | github.com/radix-ui/primitives | OK | Approved |
| @radix-ui/react-checkbox | npm | (current, OK) | github.com/radix-ui/primitives | OK | Approved |

### Component-test DOM stack — NOT audited by this research pass (pending human checkpoint in Plan 05-03)

The five packages below were **not** part of this research pass's `slopcheck` run, because this pass
recommended a Playwright-only component-verification strategy. That recommendation was overturned during
plan review: CLAUDE.md §2.1 makes RED→GREEN test-first non-negotiable, so `packages/ui` and `apps/web`
components get colocated Vitest component tests and the DOM stack below becomes necessary. These rows
therefore carry **no verdict from this research pass** and must not be treated as approved.

| Package | Registry | Resolved version (npm view, 2026-09-19) | Expected repo | slopcheck | Disposition |
|---------|----------|------------------------------------------|---------------|-----------|-------------|
| jsdom | npm | 30.1.0 | github.com/jsdom/jsdom | not run this pass | **pending human checkpoint (05-03)** |
| @testing-library/dom | npm | 10.4.2 | github.com/testing-library/dom-testing-library | not run this pass | **pending human checkpoint (05-03)** |
| @testing-library/react | npm | 16.3.3 | github.com/testing-library/react-testing-library | not run this pass | **pending human checkpoint (05-03)** |
| @testing-library/jest-dom | npm | 7.0.1 | github.com/testing-library/jest-dom | not run this pass | **pending human checkpoint (05-03)** |
| @testing-library/user-event | npm | 14.6.7 | github.com/testing-library/user-event | not run this pass | **pending human checkpoint (05-03)** |

`@testing-library/dom` is listed because `@testing-library/react` 16.x declares it as a required
peerDependency (`^10.0.0`) and `@testing-library/jest-dom` 7.x declares `>=10 <11` — it is not an optional
extra. No React Vitest transform plugin (`@vitejs/plugin-react`) is needed: Vite's esbuild transform honours
`packages/ui/tsconfig.json`'s `jsx: "react-jsx"`, and Fast Refresh is irrelevant in a test run.

Per ADR-0000's `[ASSUMED]`-package rule these five go through the **existing** blocking human checkpoint in
Plan 05-03 Task 1 (extended from three packages to eight) before any install, and then into the **existing**
`EXPECTED_PACKAGES` gate and the ADR-0000 "Phase 5 additions" table with the repositories above. No second
gate is created.

**Packages removed due to slopcheck `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none.

Per ADR-0000's established pattern (Phase 1's `vitest`/`commander` `[SUS]`-then-approved, Phase 4's `bullmq`/`ioredis`/`@testcontainers/redis` clean `[OK]`), `scripts/check-package-provenance.mjs`'s `EXPECTED_PACKAGES` table must be extended with every row above before any of these packages are actually installed in Wave 1 — this is the re-runnable, non-bypassable gate the project already uses, and this phase should follow the identical pattern rather than introduce a parallel one. A new ADR-0000 addendum section ("Phase 5 additions") should record this table, mirroring the existing "Phase 4 additions" section.

Package name provenance note per this agent's own instructions: every package name above was discovered via direct `npm view`/`slopcheck` commands (not training-data guesswork) against the real npm registry, and the packages' identity (Next.js, React, Tailwind, Radix, lucide, Playwright) is common industry knowledge independently confirmed by this project's own STACK.md and 05-UI-SPEC.md — but strictly by this agent's provenance rule, a name is only `[VERIFIED]` when discovered via **official documentation or Context7**, not registry existence alone. No Context7 lookup was performed for these packages this session (they are all well-established, and 05-UI-SPEC.md/STACK.md already named them), so every package name above is tagged `[ASSUMED]` for the purposes of the Assumptions Log even though its registry existence, current version and clean repository provenance are all `[VERIFIED: npm registry]`. The planner should treat "should we use Next.js/Radix/Tailwind/lucide/Playwright" as settled (locked by CONTEXT.md/STACK.md/UI-SPEC), but any *exact version pin* chosen at Wave 1 execution time should be re-verified once more immediately before `pnpm add`, per this project's own repeated practice (e.g. the `ioredis` 5.11.1-vs-6.0.0 RESP3 decision in Phase 4, the `typescript-eslint` 8.70.0-vs-10.x decision in Phase 1).

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────┐   same-origin      ┌──────────────────────┐   Zod-validated    ┌─────────────────┐
│   Browser    │  cookies (Lax)    │  Next.js apps/web     │   fetch + SSE      │  Fastify API      │
│ (admin user) │──────────────────▶│  (App Router, RSC     │───────────────────▶│  apps/control-    │
│              │◀──────────────────│  shell + client       │◀───────────────────│  plane            │
└─────────────┘   HTML/JSON/SSE    │  components for       │   /api/* rewrite   │  (guarded /api    │
                                   │  interactive screens)  │   in dev, same     │   scope)          │
                                   └──────────────────────┘   origin in prod    └────────┬─────────┘
                                                                                          │
                                              ┌───────────────────────────────────────────┼──────────────┐
                                              │                                           │              │
                                     services/ (registerServer, connectAndDiscover, ...)  │       BullMQ  │
                                              │                                           ▼        queue  │
                                              │                                  Postgres (source     │   │
                                              │                                  of truth: servers,    │   │
                                              │                                  discovery_snapshots,  │   │
                                              │                                  activity_events)      │   │
                                              │                                           ▲              │
                                              └──────────────publishServerEvent──────────►│              │
                                                          (best-effort, post-commit)       │              │
                                                                     │                     │              │
                                                                     ▼                     │              │
                                                        Redis pub/sub (SERVER_EVENTS_CHANNEL) ◀───────────┘
                                                                     │                                  worker
                                                                     ▼                          (connect-server-worker
                                                       sse-broadcaster.ts (KNOWN_EVENT_TYPES     runs SSH+discovery,
                                                       allowlist) ──▶ GET /api/events (one        calls connectAndDiscover)
                                                       global stream, EventSource in browser)
```

Trace of the phase's critical path (login → Servers → add → connect → discovery → detail):
1. Browser POSTs `/api/setup` once, then authenticates via Better Auth's routes (already built) → session cookie set.
2. `GET /api/servers` renders the list (SERV-04).
3. Sheet POSTs `/api/servers` (SERV-01/D-01) → 201 `ServerView` → sheet closes, `POST /api/servers/:id/connect` (202, `jobId` for logs only) → browser navigates to `/servers/:id`.
4. `connect-server-worker` picks the BullMQ job, calls `connectAndDiscover`, which today publishes exactly one `server.updated` event after both TX1 (CONNECTING) and TX2 (final result) commit. **DISC-02 needs a third kind of event mid-run** — see Backend Addition Contract below.
5. Browser's single `EventSource` (opened once, shared by list+detail) receives `server.updated` frames and (after this phase's backend addition) `server.discovery_progress` frames; detail page renders the six-step checklist live.
6. On settle, detail page shows System/Docker/Connection groups and the Discovery section's one-line summary (DETL-01/DISC-02).

### Recommended Project Structure

```
apps/web/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Server Component; inlines no-flash theme script (blocking <script>)
│   │   ├── setup/page.tsx
│   │   ├── login/page.tsx
│   │   ├── (shell)/                # route group wrapping sidebar+toolbar shell
│   │   │   ├── layout.tsx          # Client Component boundary: sidebar nav, theme toggle, sign out
│   │   │   ├── servers/page.tsx
│   │   │   ├── servers/[id]/page.tsx
│   │   │   ├── activity/page.tsx
│   │   │   └── settings/page.tsx
│   │   └── api/... (none expected — Next.js route handlers are not needed; rewrites proxy directly to Fastify)
│   ├── lib/
│   │   ├── api-client.ts           # thin fetch wrapper: base URL, credentials:'same-origin', error-body parsing
│   │   ├── use-server-events.ts    # EventSource hook: connect, resync-on-reconnect, KNOWN types only
│   │   └── discovery-steps.ts      # DISCOVERY_CHECK_IDS -> six-step grouping (imports @noodara/domain/discovery)
│   └── components/                 # apps/web-local composition of packages/ui primitives (screens, not primitives)
├── next.config.ts                  # rewrites() proxying /api/* to NOODARA_PUBLIC_URL's origin
└── package.json

packages/ui/
├── tokens.css                      # :root + [data-theme="dark"], every skill §2 token
├── tailwind-preset.ts (or @theme partial consumed by apps/web's tailwind.config)
├── src/
│   ├── Button.tsx, StatusPill.tsx, Input.tsx, Textarea.tsx, SegmentedControl.tsx,
│   │   FileButton.tsx, Sheet.tsx, Dialog.tsx, Banner.tsx, StatTile.tsx, LabelValue.tsx,
│   │   ListRow.tsx, Skeleton.tsx, EmptyState.tsx, Disclosure.tsx, Tooltip.tsx, ThemeToggle.tsx
│   └── index.ts                    # single barrel export, mirrors packages/domain's pattern
└── package.json
```

### Pattern 1: Same-origin API proxy via Next.js rewrites (no CORS)

**What:** `apps/web`'s `next.config.ts` proxies every `/api/*` request to the Fastify API's origin, so cookies (`SameSite=Lax`) and `EventSource` work with zero extra configuration, exactly as CONTEXT.md's inherited D-29 requires.
**When to use:** All fetches and the one `EventSource('/api/events')` call — never point the browser at a cross-origin API URL.
**Example:**
```typescript
// apps/web/next.config.ts — pattern, not verified against Context7 this session [ASSUMED]
import type { NextConfig } from 'next';

const config: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.NOODARA_API_ORIGIN}/api/:path*` }];
  },
};
export default config;
```
Production deployment (Phase 6, Docker Compose) will most likely front both `web` and the API behind one reverse-proxy origin so `rewrites()` isn't even needed in prod — but keeping the same relative-URL fetch code path in both dev and prod (proxy vs. same physical origin) avoids a dev/prod fetch-URL branch anywhere in `apps/web` source, matching this project's existing "no environment-conditional business logic" discipline.

### Pattern 2: EventSource with resync, never replay

**What:** One `EventSource` for the whole authenticated shell (not one per page), consumed by both the servers list and the detail page, exactly matching D-01's "single global stream."
**When to use:** Any screen showing live server state (list status pills, detail discovery section).
**Example:**
```typescript
// apps/web/src/lib/use-server-events.ts — conceptual sketch, not yet implemented
const KNOWN_TYPES = ['server.updated', 'server.deleted', 'server.discovery_progress'] as const; // last one pending Wave-1 naming

export function useServerEvents(onEvent: (evt: ServerEventFrame) => void, onResync: () => void) {
  useEffect(() => {
    const es = new EventSource('/api/events');
    for (const type of KNOWN_TYPES) {
      es.addEventListener(type, (e) => onEvent(JSON.parse(e.data)));
    }
    es.onerror = () => {
      // Fires on both a transient drop and the eventual auto-reconnect. No replay exists server-side
      // (D-01..D-07 locked) — the moment a fresh connection opens again, resync from scratch.
    };
    es.onopen = () => onResync(); // refetch GET /api/servers (list) or GET /api/servers/:id + discovery read endpoint (detail)
    return () => es.close();
  }, [onEvent, onResync]);
}
```
Critically: a `401` closes the stream server-side (the heartbeat's own re-validation, `routes/events.ts:78-96`) — but per the **currently open** T-4-02, that heartbeat's `getSession` call has **no timeout**, so a hung/slow session lookup can leave a revoked session's stream open past the intended ~15s bound. This must be fixed (bounded `Promise.race`, matching `health.ts`'s `withTimeout`) before this phase's E2E can honestly assert "401 always redirects promptly."

### Anti-Patterns to Avoid
- **Polling `jobId` for connect/discover progress:** Locked out by CONTEXT.md (fase 4 D-08) — `jobId` exists for logs/correlation only. Any task that adds a `GET /api/jobs/:id`-style poll is a direct contradiction of a locked decision.
- **A second data-fetching library "just for the discovery page":** If a caching library is adopted at all (see Alternatives Considered), it should cover the whole app, not be introduced ad hoc for one screen — this project's precedent (`bullmq`/`ioredis`/`drizzle-orm` as the *only* instances of their category) argues against tool proliferation.
- **Re-deriving `ServerView`'s shape by hand in `apps/web`:** `ServerViewSchema` (Zod) already exists in `apps/control-plane/src/routes/server-schemas.ts` and is the literal wire contract. If TypeScript types are needed client-side without importing a control-plane-internal module, either (a) publish a narrow, additive `@noodara/api-types` export, or (b) hand-write a matching interface with a comment linking back to `ServerViewSchema`/`SERVER_VIEW_KEYS` so drift is visible in review — never trust a manually-copied field list to stay in sync silently (see `server-schemas.test.ts`'s own drift-guard precedent, `assertServerViewSchemaKeysMatch`).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Focus trap / `Esc`-to-close for Sheet/Dialog | Custom focus-trap logic | Radix `Dialog` primitive | Radix's built-in behavior is exactly what ADR/skill accessibility requirements need (skill §7, UI-SPEC §8) — "do not override it" is UI-SPEC's own explicit instruction. |
| Segmented control accessibility (roving tabindex, ARIA) | Custom `<div role="radiogroup">` | Radix `RadioGroup` styled as segments | Same reasoning — Radix already solves keyboard nav/ARIA for a control this project would otherwise have to test from scratch. |
| Dark/light no-flash theme switching | A hand-tuned CSS-only solution or guessing at `next-themes`'s internals blind | The documented ~15-line inline blocking `<script>` pattern `next-themes` itself uses internally (per 05-UI-SPEC.md's own reasoning) — hand-rolled *because* it's genuinely small, not because "don't hand-roll" is being ignored; a full `next-themes` dependency was evaluated and explicitly declined for ~15 lines of code. |
| Discovery check ID → six-step grouping | A parallel enum/mapping hand-maintained in `apps/web` | Import `DISCOVERY_CHECK_IDS` directly from `@noodara/domain/discovery` (pure, already built, already the frozen source of truth) and layer the six-step grouping as a `Record<DiscoveryCheckId, StepName>` on top — never redeclare the eleven ids as a string literal union in `apps/web`. |
| Cursor-based activity pagination | A hand-rolled offset/limit scheme | The existing opaque `nextCursor` from `GET /api/activity` (D-20, already keyset-based, already tested for tamper-resistance via `decodeActivityCursor`) | The API's cursor already solves "no duplicate/skipped rows across pages under concurrent inserts" — reimplementing offset-based paging client-side would reintroduce exactly the class of bug keyset pagination exists to avoid. |
| Contrast-safe status-pill colors in light mode | Inventing a new token unilaterally in `packages/ui` | Escalate to the skill owner (05-UI-SPEC.md §11 item 1 — computed ≈2.0–3.1:1 contrast, fails AA) before shipping | The skill's tokens are locked; a component-level override would silently diverge from the design system's single source of truth and reintroduce exactly the "invented palette" anti-pattern the skill's own header warns against. |

**Key insight:** Nearly everything DETL-01/SERV-04/ACT-02/SET-01 need is already computed, redacted and exposed by Phase 3/4's services — the temptation in this phase is to duplicate business logic (fingerprint formatting, discovery grouping, activity metadata shaping) in `apps/web` instead of importing the pure domain package or trusting the already-redacted API payload. Every one of those duplications is a drift risk the moment the backend's shape changes.

## Runtime State Inventory

Not applicable — this is a greenfield frontend build (`apps/web`, `packages/ui` do not exist), not a rename/refactor/migration phase. No existing runtime state references anything this phase renames.

## Common Pitfalls

### Pitfall 1: UF-01 TOFU bypass is unfixed and this phase's own UI makes it reachable
**What goes wrong:** An admin edits a server's `host` while it is in `ERROR` (from a `HOST_KEY_CHANGED` outcome against the *old* host), then clicks "Trust new fingerprint" (D-03's exact flow) — the stale `pendingFingerprint`, captured against the old host, gets promoted as if it were the new host's real fingerprint. TOFU is defeated.
**Why it happens:** `edit-server.ts:211` only clears `pendingFingerprint`/`pendingFingerprintSeenAt` `if (row.status === 'CONNECTED')`. But a `pendingFingerprint` is only ever non-null when status is `ERROR` (from `HOST_KEY_CHANGED`) — the one status this guard never covers. Confirmed unfixed by direct code read this session (2026-09-19).
**How to avoid:** Fix `edit-server.ts` to also clear `pendingFingerprint`/`pendingFingerprintSeenAt` whenever the edit changes host/port/user identity while status is `ERROR` (not only `CONNECTED`), or more conservatively: clear it on *any* identity-relevant edit regardless of starting status. This must be Wave 0 (or the very first task) of this phase's plan per D-17, with a new integration test asserting "edit host while ERROR, then trust-fingerprint" now fails safely (`NO_PENDING_FINGERPRINT` or equivalent) rather than promoting a mismatched fingerprint.
**Warning signs:** Any plan that starts directly with `packages/ui`/`apps/web` scaffolding without a preceding backend-security wave has skipped this.

### Pitfall 2: Three more open threats block "phase must not ship" per 04-SECURITY.md's own sign-off
**What goes wrong:** T-4-02 (SSE heartbeat's `getSession` has no timeout — a revoked session's stream can stay open past its intended bound, undermining this phase's own "401 always redirects" UX contract), T-4-10/T-4-38 (pino's default `err` serialization leaks message/stack verbatim — worker failure logs and Redis-publish-failure logs are the two live sites), T-4-32 (`worker.ts`'s `shutdown()` has no try/catch around its `Promise.race`, so a rejecting `handle.close()` skips all cleanup).
**Why it happens:** All four were found during Phase 4's own security audit (`gsd-security-auditor`, 2026-09-18) and never remediated within that phase — `04-SECURITY.md`'s frontmatter still reads `status: open`, `threats_open: 4`, and its own Sign-Off section is explicitly unchecked ("phase must not ship until T-4-02, T-4-10, T-4-32 and T-4-38 are remediated").
**How to avoid:** Treat these four fixes as part of the same Wave 0 as UF-01 (all are small, targeted, code-level fixes per 04-SECURITY.md's own "Fix:" notes for each). Re-run the phase-4 security audit (or at minimum, flip `04-SECURITY.md`'s frontmatter to `status: verified`/`threats_open: 0` with evidence) before treating Phase 5 as unblocked.
**Warning signs:** If the plan's first wave is UI-only and defers "phase 4 cleanup" to "later if there's time," this pitfall has been missed.

### Pitfall 3: Rendering discovery progress that was never received
**What goes wrong:** A page opened mid-run (server status `CONNECTING`) fetches the read endpoint and gets back the *previous* completed run's settled checklist — rendering that as if it were live progress for the run currently happening would show stale pass/fail results as if they belonged to the in-flight run.
**Why it happens:** D-05's own rule ("la UI nunca muestra progreso que no ha recibido") exists precisely because there is no event replay — a client that just fetched at page-load time has strictly less information than a client that's been listening since the run started.
**How to avoid:** 05-UI-SPEC.md §4.3 already specifies the correct behavior: on load, if `server.status === 'CONNECTING'`, discard the fetched settled checklist entirely and render all six steps `pending`/`running`, with a caption "A new discovery run is in progress." Only trust checks that arrive live via `server.discovery_progress` from that point on.
**Warning signs:** Any implementation that renders the read-endpoint's response unconditionally, regardless of current `server.status`.

### Pitfall 4: `mergeDiscoveryFacts` makes "never overwrite a known value with null" a backend guarantee — don't re-implement it client-side
**What goes wrong:** A naive client might do `latestSnapshot.facts.cpuCores ?? previousValue` to simulate "keep old value on partial failure," duplicating logic the backend already guarantees.
**Why it happens:** DETL-02's "facts from the last good discovery stay visible below the banner, dimmed" requirement is trivially satisfiable *because* `mergeDiscoveryFacts` (phase 3) already ensures `servers` columns never regress to null — the client only needs to render `ServerView`'s current fields as-is, with dimming keyed off `lastErrorCode`/`status`, never off null-checking individual fields.
**How to avoid:** Trust `GET /api/servers/:id`'s fields directly; the dimming condition is `status === 'ERROR' && hostname !== null` (has a prior good discovery) vs. `status === 'ERROR' && hostname === null` (never discovered, banner goes above the empty state instead) — exactly UI-SPEC §2.5's two-branch logic.
**Warning signs:** Client code that special-cases individual nullable fields instead of branching once on `status`+`hostname`.

### Pitfall 5: `turbo.json`'s strict `passThroughEnv` will silently strip a new Next.js env var
**What goes wrong:** ADR-0003 records that Turborepo 2's default strict-env mode silently stripped `apps/control-plane`'s env vars before `pnpm dev` even started, until every variable was explicitly added to `passThroughEnv` — this bit Phase 1 hard enough to need its own root-cause fix.
**Why it happens:** Any new env var this phase introduces (e.g. `NOODARA_API_ORIGIN` for the rewrites proxy, or a `NEXT_PUBLIC_*` var) will hit the exact same silent-strip behavior if `apps/web`'s own `turbo.json` (or the root's) doesn't declare it.
**How to avoid:** Every new env var `apps/web` reads must be added to the relevant `turbo.json`'s `passThroughEnv` (dev) and/or `env` (build) arrays in the same task/PR that introduces it — do not assume `.env.local` alone is sufficient under `pnpm dev`.
**Warning signs:** `pnpm dev` boots the API/worker fine but `apps/web` fails to resolve `/api/*` or throws on a missing env var that is visibly set in the shell.

### Pitfall 6: `packages/domain`'s build step (ADR-0003) extends to any new pure package `apps/web` imports from
**What goes wrong:** If `apps/web` imports `DISCOVERY_CHECK_IDS` from `@noodara/domain/discovery` directly, it inherits the same `tsc`-build-before-dev contract ADR-0003 established for `apps/control-plane` — `packages/domain`'s `exports` map points at `dist/*.js`, not `src/*.ts`.
**Why it happens:** `turbo.json`'s `dev`/`build`/`typecheck` tasks already declare `dependsOn: ["^build"]` for existing consumers; a new consumer (`apps/web`) must be wired into the same dependency graph or it will hit `ERR_MODULE_NOT_FOUND` exactly like Phase 1's original bug (01-VERIFICATION.md's BLOCKER).
**How to avoid:** Add `apps/web` to the same `turbo.json` task graph pattern already proven for `apps/control-plane`; verify with a clean-tree `pnpm dev` (deleting `packages/domain/dist` first) before considering Wave 1 done, mirroring `boot-command.test.ts`'s fourth case.
**Warning signs:** `pnpm dev` works on a warm machine (stale `dist/` already present) but fails on a fresh clone/CI runner.

### Pitfall 7: Credential fields must survive round-tripping through `FileReader` without ever touching the URL or being logged
**What goes wrong:** A private-key upload path implemented via `<input type="file">` + naive form submission could accidentally end up as a multipart body, a query param, or a value passed through `router.push()`/URL state.
**Why it happens:** D-04/UI-SPEC §10 mandate the exact opposite: `FileReader.readAsText()` fills the *same* textarea state the paste path uses, and the request body must remain `WireCredentialSchema`'s JSON shape — never `multipart/form-data`.
**How to avoid:** Keep credential state entirely in component-local React state, cleared on unmount/sheet-close, `autoComplete="off"` on all credential inputs, never serialize credential fields into a URL, browser history entry, or `console.*` call — this is QA-05's canary target for the frontend specifically (today's canary only proves backend-side non-leakage).
**Warning signs:** Any `router.push`/`searchParams` call anywhere near the add/edit sheet's credential fields; any `console.log` in a catch block that logs a raw request/response body.

## Code Examples

### GET /api/servers response shape (verified against source, `apps/control-plane/src/services/server-view.ts` + `server-schemas.ts`)
```typescript
// Source: apps/control-plane/src/services/server-view.ts, apps/control-plane/src/routes/server-schemas.ts (read directly, 2026-09-19)
interface ServerView {
  id: string; name: string; host: string; sshPort: number; sshUser: string;
  status: 'PENDING' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'UNREACHABLE' | 'ERROR';
  hostFingerprint: string | null; hostFingerprintCapturedAt: string | null; // Date, ISO on the wire
  pendingFingerprint: string | null; pendingFingerprintSeenAt: string | null;
  hostname: string | null; osDistribution: string | null; osVersion: string | null; arch: string | null;
  cpuCores: number | null; ramMb: number | null; diskTotalMb: number | null; diskUsedMb: number | null;
  uptimeSeconds: number | null;
  dockerInstalled: boolean | null; dockerVersion: string | null; dockerComposeVersion: string | null;
  lastSeenAt: string | null;
  lastErrorCode: 'AUTH_FAILED' | 'HOST_UNRESOLVED' | 'CONNECT_TIMEOUT' | 'COMMAND_TIMEOUT'
    | 'HOST_KEY_CHANGED' | 'CONNECTION_LOST' | 'UNSUPPORTED_OS' | null;
  createdAt: string; updatedAt: string;
  credentialType: 'ssh_private_key' | 'ssh_password';
  // Deliberately absent: credentialId, encryptedValue, keyVersion — never leaks a credential shape.
}
```

### GET /api/activity response shape (verified, `apps/control-plane/src/routes/activity.ts`)
```typescript
// Source: apps/control-plane/src/routes/activity.ts (read directly, 2026-09-19)
interface ActivityItem {
  id: string; occurredAt: string; actorType: 'user' | 'system'; actorId: string | null;
  entityType: string; entityId: string | null; action: string;
  outcome: 'success' | 'failure'; errorCode: string | null; metadata: unknown;
}
interface ActivityResponse { items: ActivityItem[]; nextCursor: string | null; }
// Query: GET /api/activity?limit=50&cursor=<opaque> — limit 1-200, cursor optional, .strict() querystring (unknown keys -> 400)
```

### GET /api/config response shape (verified, `apps/control-plane/src/routes/config.ts`)
```typescript
// Source: apps/control-plane/src/routes/config.ts (read directly, 2026-09-19)
interface ConfigResponse {
  version: string; publicUrl: string; masterKeyFingerprint: string; // truncated SHA-256 only, never key bytes
  sshTimeouts: { connectMs: number; commandMs: number; discoveryMs: number };
  workerConcurrency: number;
}
```

### Error vocabulary (verified, `apps/control-plane/src/routes/http-errors.ts`)
```typescript
// Source: apps/control-plane/src/routes/http-errors.ts (read directly, 2026-09-19)
type ServiceErrorCode = 'VALIDATION_FAILED' | 'INVALID_CREDENTIAL' | 'UNAUTHORIZED' | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND' | 'NAME_TAKEN' | 'HOST_TAKEN' | 'SERVER_BUSY' | 'ALREADY_CONNECTING'
  | 'SERVER_NOT_CONNECTED' | 'NO_PENDING_FINGERPRINT' | 'CONFIRMATION_MISMATCH'
  | 'QUEUE_UNAVAILABLE' | 'SSE_LIMIT_REACHED' | 'INTERNAL_ERROR';
// Plain: { error: ServiceErrorCode, message: string }
// Validation: { error: 'VALIDATION_FAILED', message: string, issues: { path: string, message: string }[] }
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Discovery reported only as one final snapshot | Check-by-check live progress via SSE (DISC-02, this phase's own D-05) | This phase (2026-09-19 planning) | `runDiscovery` gains an `onCheck` callback; this is an additive, backwards-compatible change — existing snapshot persistence and `ServerView` denormalization are unaffected. |
| `apps/web`/`packages/ui` do not exist | Greenfield Next.js 16 + Radix + Tailwind v4 build | This phase | First phase where the frontend build tooling (turbo task graph, ADR-0003's build contract, env passthrough) must be extended beyond `apps/control-plane`. |
| `pnpm test:e2e` is a placeholder that exits 0 | Real Playwright suite against api+worker+web+sshd fixture | This phase | CI's own comment in `ci.yml` says "Full E2E (Playwright) intentionally has no job here: it ships in phase 5" — a new `e2e` CI job (and a separate nightly workflow) must be added, not just the script body. |

**Deprecated/outdated:** None specific to this phase's stack — Next.js 16, React 19, Tailwind v4 and Radix are all current majors, not superseded versions.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Next.js 16.3.5/React 19.3.0/Tailwind 4.3.3/Radix/lucide-react/Playwright 1.63.0 are the right package identities for this phase (names, not just registry existence) | Standard Stack, Package Legitimacy Audit | Low — all six are named explicitly in 05-UI-SPEC.md and/or STACK.md already; this research only re-verified registry existence/version/repo, it did not independently discover the names via Context7. If any name is wrong, the provenance check (`npm view`) would already have failed to resolve a plausible-looking repo, which it did not. |
| A2 | `apps/web`'s rewrites-based same-origin proxy pattern (Pattern 1) is the correct implementation shape for D-29 | Architecture Patterns | Medium — if Next.js 16's `rewrites()` API has changed shape since training data, the exact config syntax could be stale; functionally the same-origin requirement is locked by CONTEXT.md regardless of implementation syntax. Verify against Context7/official Next.js docs at Wave 1 execution time. |
| A3 | A hand-rolled `EventSource` hook (no TanStack Query/SWR) is sufficient for this phase's real-time needs | Architecture Patterns, Alternatives Considered | Low-Medium — 05-UI-SPEC.md itself flags this as open (§11 item 6); if list/detail cache coordination proves unwieldy, the plan may need to introduce a caching library mid-phase, which is a bigger change than initially scoped. |
| A4 | `next-themes`-equivalent hand-rolled no-flash theme script (~15 lines) is preferable to installing `next-themes` | Don't Hand-Roll | Low — explicitly reasoned and small in scope; even if wrong, the fix is adding one small, well-understood dependency, not a rearchitecture. |
| A5 | The discovery-progress SSE event name (`server.discovery_progress`) and read endpoint path (`GET /api/servers/:id/discovery`) proposed in 05-UI-SPEC.md §7 are usable as-is | Architecture Patterns, Backend Addition Contract (below) | Low — 05-UI-SPEC.md itself already flags these as free for the planner to rename (§11 item 4); using them as a starting point is safe as long as the payload/allowlist/best-effort contract is preserved regardless of the final name. |

**If this table is empty:** N/A — assumptions are listed above.

## Open Questions (RESOLVED)

1. **Are 04-SECURITY.md's 4 open threats + UF-01 already fixed by the time this phase is planned/executed?**
   - What we know: as of this research pass (2026-09-19), `edit-server.ts:211` is unfixed (confirmed by direct code read) and `04-SECURITY.md`'s frontmatter still reads `status: open, threats_open: 4`.
   - What's unclear: whether a separate remediation phase/commit lands between this research and plan execution.
   - Recommendation: the plan's Wave 0 must re-check this file's `status`/`threats_open` fields at execution time and only skip the remediation wave if they read `verified`/`0` with a dated audit trail entry newer than 2026-09-18.
   - **RESOLVED:** no separate remediation landed before planning, so D-17's fixes are this phase's first two waves. Plan 05-01 closes UF-01 (`edit-server.ts` clears `pendingFingerprint` on the `ERROR` branch) and T-4-02 (bounded `getSession`); Plan 05-02 closes T-4-10/T-4-38 (pino `err` serializer) and T-4-32 (worker shutdown try/catch); Plan 05-03 Task 3 flips `04-SECURITY.md` to `status: verified` / `threats_open: 0` against those two SUMMARYs' evidence. No `packages/ui` or `apps/web` work starts before that gate.

2. **Exact naming/payload for the DISC-02 backend addition (SSE event + read endpoint).**
   - What we know: 05-UI-SPEC.md §7 proposes `server.discovery_progress` / `GET /api/servers/:id/discovery`, fully specified with payload shapes and constraints (allowlisted, best-effort, session-scoped, `detail`-only).
   - What's unclear: whether these exact names are final or the planner should rename them (UI-SPEC's own §11 item 4 says this is free to change).
   - Recommendation: treat the proposed shape as the default plan; only deviate if a naming collision or a stronger convention emerges during Wave 1 implementation.
   - **RESOLVED:** the proposed names are adopted verbatim — no collision exists. `server.discovery_progress` joins `KNOWN_EVENT_TYPES` in Plan 05-04; `GET /api/servers/:id/discovery` is added in Plan 05-05, which also extends the canary to both surfaces. The client mirrors the same three-type allowlist in Plan 05-12 and consumes the read endpoint in Plan 05-18.

3. **Light-mode status pill contrast failure (skill-level token gap).**
   - What we know: computed contrast for full-saturation status text on `-soft` backgrounds fails WCAG AA in light mode across all four semantic colors (≈2.0–3.1:1 vs. required 4.5:1), while dark mode passes comfortably.
   - What's unclear: whether the skill owner will patch `noodara-ux-apple`'s tokens before or during this phase, or whether this phase should proceed with a documented, accepted accessibility gap.
   - Recommendation: escalate to the user/skill owner before or at the start of planning — do not let the executor invent a new token to fix this unilaterally (05-UI-SPEC.md §11 item 1 already raises this; this research confirms it is a real, computed finding, not a false positive).
   - **RESOLVED:** escalated, not patched. Plan 05-06 reproduces the locked skill tokens verbatim and marks the status block with a comment pointing at 05-UI-SPEC.md Open Question 1; threat `T-5-25` records the disposition as `accept`. The decision (patch the skill / accept as a documented v0.1 gap / hold the phase open) is put to the user at Plan 05-21's blocking `checkpoint:human-verify` and recorded in `docs/ui-review-05.md` plus 05-VALIDATION.md's Manual-Only Verifications table. No executor invents a token.

4. **Whether a client-side data-fetching/cache library is needed.**
   - What we know: 05-UI-SPEC.md defers this to the planner; this research's Architecture Patterns section defaults to hand-rolled fetch+SSE.
   - What's unclear: actual implementation complexity once list+detail+activity all need to react to the same SSE stream with different refetch triggers.
   - Recommendation: attempt the hand-rolled approach first (matches project precedent); revisit only if Wave 1/2 implementation reveals genuine unmanageable complexity, and bring that back to the user rather than deciding unilaterally mid-execution.
   - **RESOLVED:** no library. The plans commit to a hand-rolled `fetch` wrapper (`apps/web/src/lib/api-client.ts`, Plan 05-07) plus one shared `EventSource` owned by the shell (`use-server-events.ts`, Plan 05-12); each screen registers its own refetch with the shell's `onResync` and folds events through its own tested pure reducer (`server-store.ts`, `detail-state.ts`, `activity-groups.ts`, `discovery-progress.ts`). TanStack Query and SWR are not installed and do not appear in the provenance gate. If this proves unmanageable during execution the executor stops and returns to the user rather than adding a cache layer mid-phase.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | apps/web build/dev, Playwright | ✓ | v24.13.0 (project requires ≥22.12.0 per `engines`) | — |
| pnpm | monorepo workspace commands | ✓ | 10.34.5 | — |
| Docker | Testcontainers sshd fixture for E2E (QA-04) | ✓ | 29.2.0 | — |
| Playwright browsers | E2E execution | Not yet installed in this environment (only checked via `npx playwright --version`, which auto-installs the CLI but not browser binaries) | 1.63.0 (CLI) | `npx playwright install --with-deps` must run as part of Wave 1/CI setup — no fallback, this blocks QA-04 entirely if skipped. |
| slopcheck | Package legitimacy gate | ✓ | installed this session (`pip install slopcheck --break-system-packages`) | If unavailable in the actual execution environment, every new package must be tagged `[ASSUMED]` and gated behind `checkpoint:human-verify`, per this agent's own graceful-degradation rule — not applicable here since slopcheck succeeded. |
| GitHub Actions / remote | Nightly workflow (QA-04/05) | ✗ (repo has no remote configured yet, per STATE.md/CONTEXT.md discretion note) | — | The nightly workflow file can be written and validated locally (`act`, or manual repeated local runs) but will not actually execute on a schedule until the user pushes the repo to a remote — this is a known, accepted limitation per CONTEXT.md's own discretion note, not a gap this research can close. |

**Missing dependencies with no fallback:**
- Playwright browser binaries — must be installed as an explicit Wave 1 step (`npx playwright install --with-deps` or the project's CI equivalent); QA-04 cannot proceed without this.

**Missing dependencies with fallback:**
- None beyond the nightly-workflow limitation above, which has an accepted (not silently ignored) fallback already documented in CONTEXT.md.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.0 (unit/integration, already configured) + Playwright 1.63.0 (E2E, net-new this phase) |
| Config file | `vitest.config.ts` / `vitest.integration.config.ts` (existing); a new `playwright.config.ts` at repo root or `apps/web` (does not exist yet — Wave 0 gap) |
| Quick run command | `pnpm test` (existing, unit only — `packages/ui` component tests would join this) |
| Full suite command | `pnpm test:integration && pnpm test:e2e` (the latter is currently a placeholder that must be replaced with a real Playwright invocation) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SERV-04 | Servers list renders name/host/pill/last-seen from real API data | integration (Vitest, render against a mocked or MSW-backed fetch) or E2E | `pnpm test` (component) / part of the QA-04 E2E flow | ❌ Wave 0 (no `packages/ui`/`apps/web` tests exist yet) |
| DETL-01 / DETL-02 | Detail page renders all fields; empty vs. failed states distinguish correctly | integration + E2E | component test + QA-04's `detail` E2E step | ❌ Wave 0 |
| ACT-02 | Activity log renders chronological, curated metadata, no raw JSON | integration | component test against a fixture `ActivityResponse` | ❌ Wave 0 |
| SET-01 | Settings shows version/publicUrl read-only | integration | component test against a fixture `ConfigResponse` | ❌ Wave 0 |
| UI-01 | Shell keyboard navigation, dark/light | E2E (a11y-focused) or Playwright's own accessibility assertions | `pnpm test:e2e -- --grep shell` | ❌ Wave 0 |
| UI-02 | Every screen has empty/loading/error states | integration (component-level, one test per state per screen) | `pnpm test` | ❌ Wave 0 |
| DISC-02 | Six-step checklist updates live from SSE, never shows unreceived progress | integration (Vitest, fake `EventSource`/fake SSE frames) + E2E (real worker+sshd) | `pnpm test` (unit of the sequencing logic) + QA-04's `discovery` E2E step | ❌ Wave 0 (also blocked on the backend addition itself) |
| QA-04 | Full E2E login→...→detail; nightly 20x; 100 consecutive connections | E2E + nightly workflow | `pnpm test:e2e`, new `.github/workflows/nightly.yml` | ❌ Wave 0 — `test:e2e` is currently `echo ... && exit 0` |
| QA-05 | Canary secrets across the full UI+API flow in one CI run | integration (extends existing `pnpm security:scan-leaks`) | `pnpm security:scan-leaks` (extended) | Partial — 3 of the eventual 4 suites exist; the UI-output scan (rendered HTML/console/localStorage) does not exist yet |

### Sampling Rate
- **Per task commit:** `pnpm test` (unit) plus the relevant `pnpm lint`/`pnpm typecheck` for any touched package.
- **Per wave merge:** `pnpm test:integration` (existing suites) + the new `pnpm test:e2e` once it exists; `pnpm security:scan-leaks` after any change touching credentials, SSE, or logging.
- **Phase gate:** Full suite green (`pnpm test`, `pnpm test:integration`, `pnpm test:boot`, `pnpm test:e2e`, `pnpm security:scan-leaks`, `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`) before `/gsd:verify-work`, matching every prior phase's cross-cutting constraint in ROADMAP.md.

### Wave 0 Gaps
- [ ] `edit-server.ts`'s UF-01 fix + a new integration test ("edit host in ERROR, then trust-fingerprint fails safely") — **security-blocking, must precede all other Wave 0 items**
- [ ] Fixes for T-4-02 (bounded `getSession` in `events.ts`/`require-session.ts`), T-4-10/T-4-38 (pino `err` serializer or explicit `err.name`-only logging), T-4-32 (`worker.ts` shutdown try/catch)
- [ ] `apps/web` scaffold + turbo task-graph wiring (dev/build/typecheck `dependsOn: ["^build"]`, `passThroughEnv` for any new env var) — no existing test infra to extend, this is net-new
- [ ] `packages/ui` scaffold + Vitest config for component-level tests (does not exist)
- [ ] `playwright.config.ts` + first E2E spec replacing the `test:e2e` placeholder
- [ ] Discovery `onCheck` callback wiring in `packages/ssh/src/run-discovery.ts` + the new SSE event type in `sse-broadcaster.ts`'s `KNOWN_EVENT_TYPES` + the new read endpoint in `routes/servers.ts` — all three needed before DISC-02's UI can be built against real data
- [ ] `.github/workflows/nightly.yml` (new file) for the 20x E2E repetition + 100 consecutive connections + canary job — written and locally validated per CONTEXT.md's discretion note (repo has no remote yet)
- [ ] `scripts/check-package-provenance.mjs`'s `EXPECTED_PACKAGES` extended with every Package Legitimacy Audit row above, plus a new ADR-0000 "Phase 5 additions" section recording the verdicts

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (indirect — UI only consumes it) | Better Auth session cookie already implemented (Phase 1); UI must redirect to `/login` on any 401, never attempt to "handle" an expired session inline. |
| V3 Session Management | yes | Session re-validation on the SSE heartbeat (T-4-02 must be fixed first); UI never stores session tokens itself (cookie is `HttpOnly`, invisible to JS by design). |
| V4 Access Control | yes | Single-admin model (no roles in v0.1) — UI has no authorization branching to build; every guarded route is all-or-nothing behind `requireSession`. |
| V5 Input Validation | yes | Client-side Zod validation mirrors server schemas for UX (immediate feedback), but the server (`WireCredentialSchema`, `CreateServerBodySchema`, etc.) remains the enforced source of truth — client validation is never trusted as the only gate. |
| V6 Cryptography | yes (indirect) | No client-side crypto needed; credential encryption (AES-256-GCM) is entirely server-side (SEC-01). UI's only crypto-adjacent responsibility is never persisting plaintext credential material anywhere client-side (localStorage, IndexedDB, URL). |
| V7 Error Handling and Logging | yes | UI must render `error.message` from the API's `{ error, message }` body only — never `JSON.stringify` a request payload or expose `Error.stack` in any rendered UI or browser console log (UI-SPEC §10's own explicit rule). |
| V13 API and Web Service | yes | Origin guard (`FORBIDDEN_ORIGIN`) already enforced server-side for every mutation; UI must ensure it never bypasses this by, e.g., using a cross-origin fetch target in any environment. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Credential value rendered back into a form field on edit | Information Disclosure | Never pre-fill credential fields — `ServerView` structurally cannot carry one; sheet always starts from `••••••••` + "Replace" (SEC-02 inheritance, D-04). |
| Foreign/attacker-controlled Redis publisher injecting fake SSE frames | Tampering/Spoofing | Already mitigated server-side via `KNOWN_EVENT_TYPES` allowlist in `sse-broadcaster.ts`; the new `server.discovery_progress` type must be added to this same allowlist explicitly (D-05's own constraint), never inferred. |
| XSS via unsanitized activity metadata / discovery `detail` strings rendered as HTML | Tampering | React's default JSX escaping already protects against this as long as no component uses `dangerouslySetInnerHTML` anywhere near activity/discovery text — a rule this phase's components must simply never violate. |
| Session fixation via a stale SSE connection surviving logout | Elevation of Privilege | T-4-02's fix (bounded heartbeat re-validation) is the server-side control; the UI-side complement is closing its own `EventSource` immediately on any client-detected logout action, not waiting for the server to notice. |
| Credential material leaking through browser autofill/password manager prompts | Information Disclosure | `autoComplete="off"` on private-key/passphrase/ssh-password fields (UI-SPEC §10), while keeping normal `autoComplete="username"/"current-password"` on the actual login form (a legitimate login, not an SSH credential). |
| Clickjacking / cross-origin framing of the admin UI | Tampering | Not explicitly covered by any Phase 4 threat — worth a `X-Frame-Options: DENY` / `frame-ancestors 'none'` CSP check at the Next.js response-header level (Wave 1 addition, not currently present in `app.ts`'s response headers reviewed this session) — **new open item, not previously flagged in 04-SECURITY.md, add to this phase's own threat register when it's created.** |

## Sources

### Primary (HIGH confidence — direct code reads, this session, 2026-09-19)
- `apps/control-plane/src/services/server-view.ts`, `routes/servers.ts`, `routes/server-schemas.ts`, `routes/activity.ts`, `routes/config.ts`, `routes/setup.ts`, `routes/sessions.ts`, `routes/http-errors.ts`, `routes/events.ts`
- `apps/control-plane/src/events/sse-broadcaster.ts`, `events/server-event-publisher.ts`
- `apps/control-plane/src/services/connect-and-discover.ts`, `services/edit-server.ts`, `services/trust-fingerprint.ts`
- `packages/ssh/src/run-discovery.ts`
- `packages/domain/src/discovery/types.ts`, `server/connection-result.ts`, `server/server-state.ts`
- `apps/control-plane/src/env.ts`, `apps/control-plane/src/db/schema/discovery-snapshots.ts`
- `.planning/phases/04-http-routes-worker-bullmq-y-sse/04-SECURITY.md` (open threats, UF-01)
- `docs/adr/0003-runtime-entrypoints-and-module-resolution.md`, `docs/adr/0000-package-legitimacy-approvals.md`
- `scripts/check-package-provenance.mjs`, `.github/workflows/ci.yml`, root `package.json`
- `slopcheck scan --pkg npm <name> --json` for 14 packages (this session) — all `OK`
- `npm view <pkg> version` / `npm view <pkg> repository.url` for the same 14 packages (this session)
- `curl -I https://github.com/facebook/react` (301 → `react/react`, confirming registry metadata is current, not stale)

### Secondary (MEDIUM confidence)
- `.planning/research/STACK.md` (Phase 1 research — Next.js/React/Playwright version pins, cross-checked against live registry this session)
- `.planning/phases/05-ui-web/05-UI-SPEC.md` (already-approved design contract — treated as a near-authoritative source for this research since it was itself produced by a specialized UI-research agent and verified by a checker, but its own open items in §11 are preserved as open here too)
- `.claude/skills/noodara-ux-apple/SKILL.md` (locked design system source of truth)

### Tertiary (LOW confidence)
- None — every claim in this document is either a direct code/tool-output read or explicitly tagged `[ASSUMED]` in the Assumptions Log.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH for package identity/legitimacy (verified via slopcheck + npm registry this session); MEDIUM for exact Next.js App Router implementation syntax (no Context7 fetch performed this session — flagged as A2)
- Architecture: HIGH — the existing API contract was read directly from source, not inferred; the one net-new piece (DISC-02 backend addition) has a fully-specified proposal in 05-UI-SPEC.md that this research independently corroborates against the real `runDiscovery`/`connectAndDiscover` code
- Pitfalls: HIGH — UF-01 and the 3 other open threats were independently re-verified by direct code read this session (not merely cited from 04-SECURITY.md), confirming the vulnerability is still live as of 2026-09-19

**Research date:** 2026-09-19
**Valid until:** 2026-09-26 (7 days — this phase touches a fast-moving frontend ecosystem (Next.js/React/Tailwind majors) and depends on an open security remediation whose status could change at any time; re-verify package versions and 04-SECURITY.md's frontmatter before executing Wave 0 if more than a few days have passed)
