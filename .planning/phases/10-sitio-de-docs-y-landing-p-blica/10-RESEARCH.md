# Phase 10: Sitio de docs y landing pública - Research

**Researched:** 2026-09-27
**Domain:** Next.js 16 static export + Fumadocs 16 docs/landing site, GitHub Pages CI publishing
**Confidence:** HIGH (stack/versions/static-export mechanics all Context7/npm-verified); MEDIUM (GitHub Pages Action SHAs from GitHub API, not Context7); LOW (none load-bearing)

## Summary

`apps/site` is a single new Next.js 16 App Router workspace app, built with `output: 'export'`, that serves the landing at `/` and Fumadocs-powered docs at `/docs`, exported to static HTML and published to GitHub Pages from a dedicated `public-site.yml` workflow on every push to `main`. This differs from `.planning/research/ARCHITECTURE.md`'s original `apps/docs` + `apps/site` two-app sketch — CONTEXT.md's D-01..D-18 supersede that with **one app** (`apps/site`), landing and docs together, which is also simpler for the static-export/basePath computation (one build, one CNAME check).

Fumadocs 16.15.15 (`fumadocs-core`, `fumadocs-ui`) and `fumadocs-mdx` 15.4.5 are current on npm and peer-compatible with the repo's pinned `next@16.3.5`/`react@19.3.0` — confirmed both via npm registry and via Fumadocs' own official docs (Context7 `/websites/fumadocs_dev`). One correction to `.planning/research/STACK.md`: that document said the built-in static search is "Orama" — the current official Fumadocs static-search docs show **`fumadocs-core/search/flexsearch`** (`flexsearchFromSource` + `flexsearchStaticClient`), not Orama, as the mechanism that works inside `output: 'export'`. Orama is exposed as a *separate*, server-based search backend (`@orama/core`, a peer dep) for non-static deployments — it is the wrong one for this phase. Algolia is a third, external option, explicitly out of scope here (D-14: cero terceros).

Static export changes what Next.js features are available: no API routes as dynamic handlers (must be `force-static`/`staticGET`), `images.unoptimized: true` required (or skip `next/image` entirely — capture PNGs are plain `<picture><img>` per D-17, so this is moot), no ISR/on-demand revalidation, and `generateStaticParams` (via `source.generateParams()`) is mandatory for the catch-all docs route. GitHub Pages publishing from an Actions artifact (no `gh-pages` branch) is a well-established, three-action pattern: `actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages`, requiring `pages: write` + `id-token: write` permissions and a `github-pages` environment.

**Primary recommendation:** Scaffold `apps/site` as a fourth Next.js workspace app (mirroring `apps/web`'s tsconfig/eslint/package.json shape but with its own `next.config.ts` using `output: 'export'`, no rewrites, no env-derived origin), wire Fumadocs via `fumadocs-mdx`'s macro API (`defineDocs`/`loader` in `lib/source.ts`), import `packages/ui/tokens.css` + `theme.css` into the site's global CSS alongside Fumadocs' own Tailwind v4 preset, and publish via a new `public-site.yml` using the pinned-SHA action versions below.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Landing page (hero, pillars, positioning, scope block, footer) | Static/CDN (GitHub Pages) | — | Pure static HTML/CSS generated at build time; no server, no data fetching, D-01–D-06 content is all build-time-known. |
| Docs pages (MDX content, sidebar, TOC) | Static/CDN | Browser (client nav) | Fumadocs renders MDX to static HTML at build via `fumadocs-mdx`; client-side App Router navigation between pages after first load. |
| Docs search | Browser (client) | Static/CDN (pre-built index) | `flexsearchStaticClient` runs entirely in the browser against a JSON index emitted at build time — no server, no API route at runtime. |
| Theme toggle (light/dark) | Browser (client) | — | `localStorage`-only, no server cookie (the site has no server) — D-15 explicit. Bootstrap script mirrors `apps/web/src/lib/theme-script.ts` but strips the cookie-read branch (no SSR layout to set `data-theme` server-side). |
| Version footer string | Build time (CI) | — | Read from last git tag or `package.json` at `next build` time inside the CI runner, baked into the static HTML via `NEXT_PUBLIC_*` env or `next.config.ts` `env`, never computed client-side (no server, no API to ask). |
| Accuracy tests (install/error-code/claims/boundary) | Node test runner (CI) | — | Vitest unit tests reading `apps/site/content/**`, `install.sh`, `apps/control-plane/src/routes/http-errors.ts` directly off disk — same "doc that can't lie" pattern as `tests/unit/docs/install-docs-accuracy.test.ts`. |
| Publishing | CI (GitHub Actions) → GitHub Pages | — | `public-site.yml`, separate from `release.yml`/`docker-compose.yml` per D-13/D-14 and the prior architecture research's own reasoning (decoupled deploy cadence). |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions (D-01 .. D-18 — verbatim from 10-CONTEXT.md)

**Landing: mensaje y secciones**
- D-01: Hero = wordmark + lema + una frase + comando + captura. Arriba del pliegue: lockup/wordmark, "Your infrastructure, understood.", una frase de qué es Noodara, el comando `curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sh` copiable (el MISMO string que `install.sh`/README, verificado por test) y debajo la captura real de Servers (`docs/ui/approved/servers-{light,dark}.png`) según el tema del visitante. Botones: primario "Read the docs" (`/docs`), secundario "View on GitHub".
- D-02: Solo lo entregado, con captura real por pilar. Tres pilares, cada uno con una captura de `docs/ui/approved/`: **Connect** (SSH con huella verificada: login/servers), **Discover** (discovery paso a paso con checks: server-detail), **Understand** (activity + settings/temas/densidad). Ninguna sección de futuro, sin roadmap, sin "planned".
- D-03: Bloque explícito de límites en la landing. Sección corta "What it does not do yet" con la lista de v0.2 (sin env vars ni secrets de app, sin dominios/HTTPS/Traefik, sin deploy engine avanzado, sin multiusuario) redactada como hechos y con enlace a `/docs/reference/scope`. Sin fechas, sin "coming soon".
- D-04: Posicionamiento sin nombrar a nadie. Una frase propia del tipo "Most panels manage your servers. Noodara helps you understand them." Sin citar Coolify/Dokploy ni tablas comparativas.
- D-05: "How it works" en tres pasos con diagrama SVG propio. 1) Install Noodara on an Ubuntu VPS, 2) add your servers over SSH (no agent), 3) Noodara discovers and watches them. El diagrama se dibuja en SVG en tinta (`currentColor`), geometría del brand kit; ninguna ilustración ni icono de terceros.
- D-06: Footer = Docs, GitHub, licencia, versión. Licencia tal como dice `LICENSE`; la versión se lee en build del último tag o de `package.json`, nunca escrita a mano. GitHub como botón secundario sin contador de estrellas (cero llamadas a APIs de terceros).

**Docs: arquitectura y fuente única**
- D-07: La instalación se muda al sitio. El MDX de `apps/site` pasa a ser la ÚNICA fuente del texto de instalación; `docs/install.md` queda como stub corto que enlaza a `https://noodara.com/docs/getting-started/install` (README e `install.sh` ya enlazan a `docs/install.md`, así que el stub mantiene esas rutas vivas). `tests/unit/docs/install-docs-accuracy.test.ts` se re-apunta al MDX y conserva todas sus aserciones (mismo comando, misma tabla de exit codes leída de `noodara_exit_code_for`, variables soportadas, sección First login/exit 53).
- D-08: Cuatro grupos en el sidebar. Getting started (Install, First login, Your first server) · Concepts (Server, Project, Environment, Service, Deployment) · Operate (Upgrade, Rollback, Backups, Troubleshooting) · Reference (Supported variables, Exit codes, Error codes, Scope of this release). Búsqueda estática de Fumadocs activada; sin versionado de docs (solo la versión actual).
- D-09: "Your first server" ahora; "Your first deploy" cuando cierre la Fase 13. La guía cubre el flujo real de hoy: instalar → primer login → añadir servidor → confiar la huella → discovery → leer el detalle. Se anota en ROADMAP/REQUIREMENTS que la Fase 13 añade la página de deploy y reabre DOCS-01 en ese punto. Los conceptos Project/Environment/Service/Deployment se explican como modelo (qué son y cómo se relacionan) sin afirmar que la UI ya los gestiona; la nota de alcance (D-10) lo deja claro.
- D-10: Límites como hechos: página "Scope of this release" + notas en contexto. Página de referencia con tabla "Included / Not included" en presente ("Noodara does not manage domains or TLS. Put configuration in the image."), y una nota breve en cada página afectada (Service, Environment, Install). Prohibidas las palabras "coming soon", "soon", "roadmap" y las fechas en `apps/site/content` (test).

**Dominio y publicación**
- D-11: `noodara.com` en raíz. Landing en `/`, docs en `/docs`. Archivo `apps/site/public/CNAME` con `noodara.com`; `www.noodara.com` lo redirige Pages (el plan documenta los registros DNS: A/AAAA de Pages para el apex + CNAME de www). "Enforce HTTPS" en Pages. Cambiar de dominio = cambiar solo el CNAME.
- D-12: Pages desde el mismo repo vía artifact de Actions. `public-site.yml`: build estático de `apps/site` → `actions/upload-pages-artifact` → `actions/deploy-pages`; sin rama `gh-pages`. El `basePath`/`assetPrefix` se calcula en build: raíz cuando existe CNAME, subruta `/noodara` cuando no (para que el sitio funcione aunque el dominio aún no apunte). `metadataBase` y las URLs canónicas usan `https://noodara.com`.
- D-13: Cada push a `main` publica; el PR corre el sitio como gate. Sin filtro de paths (capturas, tokens y textos que afectan al sitio viven fuera de `apps/site`). El job de PR en `ci.yml` añade: `pnpm --filter @noodara/site build` (export estático), el test de exactitud, el test de afirmaciones y el boundary test. El sitio nunca aparece en `docker-compose.yml` ni en `release.yml`.
- D-14: Piezas web estándar, cero terceros. `sitemap.xml`, `robots.txt`, página 404 con la identidad, metadatos SEO y Open Graph (imagen 1200×630 de la Fase 7 D-12, self-hosted). Sin analytics en esta fase; se deja documentado dónde se enchufaría un analytics self-hosted más adelante (idea diferida), sin código ni placeholder visible.

**Look del sitio: temas y tipografía**
- D-15: Sigue al SO + toggle en el header. `prefers-color-scheme` por defecto, toggle en la cabecera del sitio y de los docs, preferencia en `localStorage` (el sitio no tiene servidor); script de bootstrap sin flash como el de la app. Los tokens vienen de `packages/ui/tokens.css` (mismos valores claro/oscuro), nunca copiados a mano.
- D-16: Fuente del sistema, como la app. Misma pila que `packages/ui` (SF Pro → Inter del SO → sans-serif); mono del sistema para comandos, códigos y variables. Cero fuentes descargadas, cero terceros. El wordmark y el monograma son los SVG de `packages/ui/brand/` (lockup claro/oscuro).
- D-17: Capturas planas. La captura tal cual, borde hairline, radio `lg`, sin marco de ventana ni sombra; `<picture>` con la versión clara y oscura según el tema del sitio. Solo capturas de `docs/ui/approved/` (las aprobadas por el usuario en la Fase 8), copiadas/optimizadas en build, nunca capturas nuevas sin aprobar.
- D-18: Un solo momento de movimiento. El monograma Viewfinder enfoca una vez al cargar el hero (misma animación que `/login`, Fase 8 D-11, reutilizando `packages/ui/src/brand/geometry.ts`); hover/focus sutiles; nada al hacer scroll, sin parallax, sin gradientes ni glow. `prefers-reduced-motion` lo sustituye por crossfade/estático.

### Claude's Discretion
- Mecanismo del test de afirmaciones (SITE-01): cómo se marcan las capacidades afirmadas en la landing (p. ej. un JSON/MDX frontmatter de `claims` con la lista cerrada de capacidades entregadas) y cómo se contrastan con el Out of Scope de `PROJECT.md` y con la lista de "Not included" de la página de alcance.
- Forma exacta del boundary test (Turborepo boundaries ya existe en `pnpm boundaries`: añadir `apps/site` con tags que prohíban `apps/control-plane` y `@noodara/domain`; `@noodara/ui` sí se permite).
- Cómo comparte `apps/site` los tokens y componentes de `packages/ui` con Fumadocs (Tailwind v4 `@source`/`@import` de `tokens.css` y `theme.css`) y qué componentes de Fumadocs se re-skinean.
- Estructura interna de `apps/site/content`, nombres de rutas dentro de los cuatro grupos, y la redacción en inglés de todos los textos (CLAUDE.md §7.1).
- Ancho máximo de la landing, tamaño del wordmark en el hero, estilo de bloques de código (copiable, mono del sistema).
- Cómo se hace la revisión humana del sitio: capturas de landing y docs en ambos temas a 375/900/1280/1920 con el pipeline `pnpm ui:review` extendido, registradas en `docs/ui/APPROVAL.md` (mismo formato que las fases 7–9), más una URL de Pages real tras el primer despliegue.
- Cómo se lee la versión en build (tag vs `package.json`) y qué muestra antes del primer tag de v0.2.

### Deferred Ideas (OUT OF SCOPE)
- Página "Your first deploy" en los docs — Fase 13 (reabre DOCS-01 al cerrar).
- Analytics self-hosted (Plausible/Umami autoalojado) — fase posterior; sin código en esta.
- Contador de estrellas de GitHub en la landing — descartado por ahora (API de terceros).
- Versionado de docs por release y i18n — no en v0.2.
- Previews de PR del sitio (URL efímera) — no en esta fase; el gate del PR es el build.

</user_constraints>

## Phase Requirements

<phase_requirements>

| ID | Description | Research Support |
|----|-------------|------------------|
| DOCS-01 | `apps/site` (Next 16 + Fumadocs, exportación estática) con documentación pública: instalación, conceptos, primer deploy, límites v0.2, upgrade/rollback | Fumadocs `source.config.ts`/`loader()`/MDX macro API pattern below; sidebar groups D-08; `output: 'export'` config; content moved from `docs/install.md` (D-07) |
| DOCS-02 | Test de exactitud: comandos, variables, códigos de error coinciden con `install.sh` y el vocabulario real | Existing `tests/unit/docs/install-docs-accuracy.test.ts` pattern re-pointed at MDX (see Code Examples); `apps/control-plane/src/routes/http-errors.ts` `SERVICE_ERROR_STATUS` as the error-code vocabulary source |
| SITE-01 | Landing (modo Persuade): identidad, screenshots reales, comando de instalación, enlaces docs/GitHub; sin afirmaciones falsas, sin terceros sin self-host, SEO + OG básico | D-01..D-06 content spec; claims-test mechanism (Claude's Discretion, proposed below); `metadataBase`/OG via `getPageImageUrl`-style static metadata; `packages/ui/brand/og-image.png` reuse |
| SITE-02 | Publicación automática desde CI a GitHub Pages en cada push a `main`, dominio por CNAME, build en gates de PR | `public-site.yml` three-action pattern (configure-pages/upload-pages-artifact/deploy-pages) below; `apps/site/public/CNAME`; basePath/assetPrefix computed at build |
| SITE-03 | Mismo piso de calidad que la app: contraste, tipografía, ambos temas, reduced-motion, revisión humana con capturas | `packages/ui/tokens.css`/`theme.css` import pattern; `scripts/ui/capture-ui-review.ts`/`review-paths.ts` extension pattern; `docs/ui/APPROVAL.md` format |

</phase_requirements>

## Project Constraints (from CLAUDE.md)

- TDD obligatorio (RED→GREEN→REFACTOR) for every behavior — applies to the accuracy test, claims test, forbidden-words test, and boundary test this phase adds.
- English for all code, identifiers, commits, UI copy, error messages (product docs are UI copy → English MDX content). `.planning/` docs stay Spanish.
- No secrets/credentials in logs, telemetry, exceptions, or AI prompts — not directly applicable to a static site with no backend, but the version-read-at-build step and any future analytics stub must not leak env values into the static HTML.
- Timeouts explicit on every remote operation — N/A for this phase (no SSH/Docker/network calls at runtime; the CI build itself already has job-level `timeout-minutes` per `ci.yml`'s existing convention).
- Security review required when touching credentials, secrets, shell, network, or AI — not triggered by this phase (no such surface), but the `public-site.yml` workflow still needs pinned-SHA `uses:` per the existing `check-workflow-pins.mjs` gate (`tests/unit/scripts/check-workflow-pins.test.ts`), least-privilege `permissions:` block, and a `timeout-minutes`.
- Conventional Commits, English, no Claude/Co-Authored-By trailers, subject ≤72 chars.
- Zero TypeScript errors, zero lint errors, CI green, zero skipped tests without justification — same bar as every other app in the monorepo; `apps/site` gets its own `lint`/`typecheck`/`test` scripts mirroring `apps/web`'s.
- UX consistent with `noodara-ux-apple` design system — single accent color, no decorative shadows/gradients, system font stack, purposeful motion only (D-18's single hero focus moment).

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fumadocs-core` | 16.15.15 | Docs source loader, search primitives (`loader`, `flexsearchFromSource`), MDX plugin utilities | `[VERIFIED: npm registry]` current published version (checked live via `npm view`); peer deps (`next: 16.x.x`, `react: ^19.2.0`) match repo pins exactly — confirmed via Context7 official docs `/websites/fumadocs_dev` |
| `fumadocs-ui` | 16.15.15 | Pre-built docs layout, sidebar/TOC/search-dialog React components, Tailwind v4 CSS preset | Same as above; must match `fumadocs-core`'s version (peer dep `fumadocs-core: 16.15.15`) |
| `fumadocs-mdx` | 15.4.5 | Content-source adapter (`defineDocs`, `.toFumadocsSource()`, macro API in `lib/source.ts`) | `[VERIFIED: npm registry]` current version; STACK.md's pinned `15.4.3` is one patch behind — use `15.4.5` or the caret range `^15.4.0` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | 4.x (peer, already usable via workspace or a fresh install) | Fumadocs frontmatter schema validation (optional, `defineDocs({ schema: ... })`) | Only if a stricter-than-default frontmatter shape is wanted (e.g. the "claims" frontmatter for SITE-01's claims test) — otherwise Fumadocs' default frontmatter (title/description) needs no extra dependency |
| Tailwind v4 (`tailwindcss` 4.3.3, already pinned) | 4.3.3 | Styling, shared with `packages/ui`/`apps/web` | Reuse the exact pinned version — no version drift across the monorepo's Tailwind installs |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `fumadocs-core/search/flexsearch` (static) | `@orama/core` (Orama, server-based) | Orama's current Fumadocs integration is server/API-route-based, not designed for `output: 'export'` — would require a Node runtime the static export explicitly avoids. Rejected for this phase; flexsearch's static client is the one that works inside export mode. |
| `fumadocs-core/search/flexsearch` (static) | Algolia (`fumadocs-core/search/algolia`) | External, third-party service requiring an API key — violates D-14 "cero terceros" outright. Rejected. |
| `fumadocs-mdx` macro API (`defineDocs`/`toFumadocsSource`) | Hand-rolled MDX loading with `next-mdx-remote` or raw `@mdx-js/mdx` | Loses Fumadocs' built-in TOC extraction, `generateParams`, frontmatter validation, and sidebar-tree generation that D-08's four-group nav needs — re-implementing all of that is exactly the "hand-rolled MDX" case STACK.md already rejected. |

**Installation:**
```bash
pnpm --filter @noodara/site add fumadocs-core@16.15.15 fumadocs-ui@16.15.15
pnpm --filter @noodara/site add -D fumadocs-mdx@15.4.5
```

**Version verification:** confirmed live via `npm view fumadocs-core version` → `16.15.15`, `npm view fumadocs-ui version` → `16.15.15`, `npm view fumadocs-mdx version` → `15.4.5` (2026-09-27). Peer-dependency ranges (`next: 16.x.x`, `react: ^19.2.0`, `react-dom: ^19.2.0` for `fumadocs-core`/`fumadocs-ui`; `fumadocs-core: 16.15.15` for `fumadocs-mdx`) checked via `npm view <pkg> peerDependencies` — all satisfied by this repo's pinned `next@16.3.5`/`react@19.3.0`.

## Package Legitimacy Audit

| Package | Registry | slopcheck | Disposition |
|---------|----------|-----------|-------------|
| fumadocs-core | npm | [OK] | Approved |
| fumadocs-ui | npm | [OK] | Approved |
| fumadocs-mdx | npm | [OK] | Approved |
| flexsearch | npm | [OK] | Approved (added by planner: optional peer of fumadocs-core required by `fumadocs-core/search/flexsearch`; `slopcheck scan` 2026-09-27, pin 0.8.212, repo nextapps-de/flexsearch) |
| @types/mdx | npm | [OK] | Approved (added by planner: peer of fumadocs-mdx/fumadocs-ui; `slopcheck scan` 2026-09-27, pin 2.0.14, repo DefinitelyTyped/DefinitelyTyped) |

All three ran through `slopcheck install fumadocs-core fumadocs-ui fumadocs-mdx` (2026-09-27) and scored `[OK]` ("scanned 3 packages, 3 OK"). No packages removed or flagged suspicious. (The subsequent `npm install` step inside slopcheck's own sandbox failed only because it tried a literal `npm install` against this pnpm workspace's `workspace:*` protocol references — that failure is unrelated to the legitimacy scan itself and made no changes to this repo, confirmed via `git status`.)

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
                    ┌───────────────────────────────┐
   git push main    │        public-site.yml         │
  ──────────────────▶  (permissions: pages:write,     │
                    │   id-token:write)                │
                    │                                   │
                    │  1. pnpm --filter @noodara/site  │
                    │     build   (output: 'export')   │
                    │        │                          │
                    │        ▼                          │
                    │  apps/site/out/  (static HTML,     │
                    │    CSS, flexsearch JSON index,     │
                    │    CNAME if present)                │
                    │        │                          │
                    │        ▼                          │
                    │  actions/upload-pages-artifact     │
                    │        │                          │
                    │        ▼                          │
                    │  actions/deploy-pages ─────────────┼──▶  GitHub Pages
                    └───────────────────────────────┘        (noodara.com via CNAME,
                                                                Enforce HTTPS)

   Browser request
  ──────────────────▶  Static HTML (landing / or /docs/*)
                             │
                             ├─ theme bootstrap script (inline, no-flash,
                             │  localStorage-only — no server, no cookie)
                             ├─ flexsearchStaticClient (fetches pre-built
                             │  index JSON, searches client-side)
                             └─ hero Viewfinder focus animation (one-shot,
                                packages/ui/src/brand/geometry.ts, gated on
                                prefers-reduced-motion)

   PR gate (ci.yml, existing "unit"/"lint" jobs extended or a new "site" job):
     pnpm --filter @noodara/site build   (proves the export still builds)
     vitest: install-docs-accuracy (re-pointed at MDX)
     vitest: landing-claims-vs-out-of-scope
     vitest: forbidden-words-in-content
     turbo boundaries  (apps/site forbidden from apps/control-plane, @noodara/domain)
```

### Recommended Project Structure
```
apps/site/
├── app/
│   ├── layout.tsx              # root layout: theme bootstrap script, fonts, metadataBase
│   ├── page.tsx                 # landing (D-01..D-06)
│   ├── sitemap.ts                # force-static, D-14
│   ├── robots.ts                 # force-static, D-14
│   ├── not-found.tsx             # 404 with identity, D-14
│   ├── api/search/route.ts       # staticGET from flexsearchFromSource(source)
│   └── docs/
│       └── [[...slug]]/
│           ├── page.tsx          # generateStaticParams via source.generateParams()
│           └── layout.tsx        # Fumadocs DocsLayout (sidebar groups D-08)
├── content/
│   └── docs/
│       ├── getting-started/      # install, first-login, first-server
│       ├── concepts/             # server, project, environment, service, deployment
│       ├── operate/              # upgrade, rollback, backups, troubleshooting
│       └── reference/            # variables, exit-codes, error-codes, scope
├── lib/
│   └── source.ts                 # defineDocs + loader (fumadocs-mdx macro API)
├── source.config.ts               # global MDX config/plugins (defineConfig())
├── public/
│   └── CNAME                      # "noodara.com" (D-11)
├── next.config.ts                 # output: 'export', basePath/assetPrefix logic (D-12)
├── postcss.config.mjs
├── package.json
└── tsconfig.json
```

### Pattern 1: `output: 'export'` with computed basePath (D-12)

**What:** Static export whose `basePath`/`assetPrefix` is root when `public/CNAME` exists on disk at build time, `/noodara` otherwise (so the site still works from `<owner>.github.io/noodara` before DNS is configured).

**When to use:** `next.config.ts`, evaluated once per build (Node `fs.existsSync`, synchronous, config-time — not per-request, since there is no request in a static export).

```typescript
// Source: https://www.fumadocs.dev/docs/deploying/static (Context7, HIGH confidence)
// Pattern (basePath computation) synthesized from D-12's requirement — no single official
// source for "CNAME presence gates basePath"; this is this repo's own build-time convention,
// analogous to apps/web/next.config.ts's own fail-fast readApiOrigin() pattern.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

const hasCname = existsSync(path.join(import.meta.dirname, 'public', 'CNAME'));
const basePath = hasCname ? '' : '/noodara';

const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath,
  images: { unoptimized: true }, // required by output: 'export' if next/image is ever used
  trailingSlash: false, // keep /docs/install, not /docs/install/ -- matches D-11's flat URL style
};

export default nextConfig;
```

**Note:** every internal `<Link href="/docs/...">` in App Router automatically gets `basePath` prepended by Next.js itself — do not hand-prepend it. Only truly external strings (the OG `metadataBase`, the CNAME-based canonical URL) hard-code `https://noodara.com`.

### Pattern 2: Fumadocs MDX macro-API content source (`lib/source.ts`)

**What:** `defineDocs` (fumadocs-mdx macro) + `loader` (fumadocs-core) wires `content/docs/**/*.mdx` into a typed page tree with sidebar/TOC/frontmatter already parsed.

```typescript
// Source: https://www.fumadocs.dev/docs/mdx/macro (Context7, HIGH confidence)
import { defineDocs } from 'fumadocs-mdx/macro';
import { loader } from 'fumadocs-core/source';

export const docs = defineDocs({ dir: 'content/docs' });

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
```

```typescript
// app/docs/[[...slug]]/page.tsx
// Source: https://www.fumadocs.dev/docs/headless/source-api (Context7, HIGH confidence)
import { source } from '@/lib/source';

export function generateStaticParams() {
  return source.generateParams();
}
```

### Pattern 3: Static search (D-08 "búsqueda estática de Fumadocs activada")

**What:** Build-time search index emitted as a static route, consumed client-side — the only search mechanism that survives `output: 'export'` without a running Node server.

```typescript
// app/api/search/route.ts
// Source: https://www.fumadocs.dev/docs/headless/search/flexsearch (Context7, HIGH confidence)
import { source } from '@/lib/source';
import { flexsearchFromSource } from 'fumadocs-core/search/flexsearch';

export const revalidate = false;
export const { staticGET: GET } = flexsearchFromSource(source);
```

```tsx
// A client search dialog component
// Source: https://www.fumadocs.dev/docs/search/flexsearch (Context7, HIGH confidence)
'use client';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { flexsearchStaticClient } from 'fumadocs-core/search/client/flexsearch-static';

const { search, setSearch, query } = useDocsSearch({ client: flexsearchStaticClient({}) });
```

**Important export-mode subtlety:** a route handler under `output: 'export'` is prerendered to a static JSON file at build time (`/api/search` becomes a literal file emitted once, not a live endpoint) — this is exactly why `revalidate = false` + `staticGET` exist: they tell Next.js "bake this response into the export" instead of "serve this dynamically." Confirm at build (`next build` output listing `○ /api/search` as static, not `ƒ`) that it did not silently fall back to dynamic (which `output: 'export'` would then hard-fail on).

### Pattern 4: Tailwind v4 + Fumadocs UI + shared `packages/ui` tokens (D-15/D-16)

**What:** Fumadocs UI ships its own Tailwind v4 preset (`fumadocs-ui/css/preset.css` + a base theme like `neutral.css`) that must be imported *alongside*, not instead of, `packages/ui/tokens.css`/`theme.css` — and Fumadocs' own `--color-fd-*` CSS variables need mapping to Noodara's `--accent`/`--surface-*`/`--ink*` tokens so the docs UI doesn't ship a second, un-audited color system.

```css
/* apps/site/app/global.css */
/* Source: https://www.fumadocs.dev/docs/manual-installation/next (Context7, HIGH confidence)
   for the @import lines; token-mapping approach below is this repo's own pattern (Claude's
   Discretion per 10-CONTEXT.md), not an official Fumadocs recipe. */
@import 'tailwindcss';
@import 'fumadocs-ui/css/neutral.css';
@import 'fumadocs-ui/css/preset.css';

/* packages/ui's own tokens -- imported, never copied by hand (D-15). */
@import '@noodara/ui/tokens.css';
@import '@noodara/ui/theme.css';

/* Map Fumadocs' own CSS variable namespace onto Noodara's tokens instead of letting
   neutral.css's own greys/blues stand -- otherwise the docs half of the site would visibly
   diverge from the app's token-governed palette (violates "mismo piso de calidad", SITE-03). */
:root {
  --color-fd-background: var(--canvas);
  --color-fd-foreground: var(--ink);
  --color-fd-muted-foreground: var(--ink-secondary);
  --color-fd-border: var(--hairline);
  --color-fd-primary: var(--accent);
  --color-fd-card: var(--surface-1);
  /* ...remaining --color-fd-* variables mapped 1:1 during implementation; enumerate fully
     against fumadocs-ui/css/neutral.css's actual variable list at implementation time. */
}
[data-theme='dark'] {
  /* Same variables, dark-mode token values -- tokens.css already carries both under
     :root / [data-theme="dark"], so this block only needs to exist if Fumadocs' own dark
     selector differs from Noodara's [data-theme="dark"] convention (verify at implementation
     time: Fumadocs UI supports next-themes' class-based dark mode by default and may need a
     small adapter, since this site has no next-themes dependency per D-15's "no server" note). */
}
```

**Tailwind `@source` note:** Tailwind v4's CSS-first config auto-scans the current package by default; if `apps/site` imports React components from `packages/ui` (e.g. Button, ThemeToggle primitives) whose class names must survive Tailwind's tree-shaking, add an explicit `@source "../../../packages/ui/src"` directive (verify exact Tailwind v4 `@source` glob syntax against the already-working example in `apps/web`'s own `postcss.config.mjs`/global CSS during implementation).

### Pattern 5: GitHub Pages publish workflow (D-11/D-12/D-13)

```yaml
# Source: GitHub official docs pattern (community-standard three-action Pages workflow) —
# actions/configure-pages, actions/upload-pages-artifact, actions/deploy-pages; SHAs resolved
# live via GitHub's own API (2026-09-27), tags kept as trailing comments per this repo's
# check-workflow-pins.mjs convention (tests/unit/scripts/check-workflow-pins.test.ts).
name: Publish site

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

env:
  NODE_VERSION: '22'

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @noodara/site build
      - uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6
      - uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5
        with:
          path: apps/site/out

  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1
```

**GHA-specific gotchas verified via WebSearch + GitHub API (MEDIUM confidence — no Context7 entry for GitHub Actions marketplace actions):**
- `actions/deploy-pages@v4` or newer is *required* if `upload-pages-artifact` is on its current major (v5 shown above resolves to the same v4-compatible artifact format per GitHub's own deprecation notice on the v3→v4 artifact format migration) — using the matched, current majors above avoids that specific incompatibility.
- The `deploy` job needs the `environment: { name: github-pages }` block for GitHub to expose a live Pages deployment URL — omitting it still deploys but the `page_url` output and the repo's "Environments" UI panel won't populate.
- Repo Settings → Pages → "Build and deployment" source must be switched to **"GitHub Actions"** (not "Deploy from a branch") for this workflow to be allowed to run at all — a one-time manual repo setting, not something the workflow YAML can set; the plan must call this out as a manual step or a `gh api` call in a setup task.
- `.nojekyll`: **not required for the Actions-artifact deployment path** (only the legacy `gh-pages` branch + Jekyll processing needs it) — omit unless a build artifact happens to contain a leading-underscore path that GitHub's *artifact upload* step itself mangles (rare; Next.js's own `out/` doesn't produce underscore-prefixed top-level paths by default other than `_next/`, which the artifact-upload path does preserve correctly, unlike old Pages-from-branch Jekyll processing).

### Pattern 6: DNS records for `noodara.com` apex + www (D-11)

Documented for the plan to surface to the user (the user configures DNS, not Noodara's CI):
- Apex (`noodara.com`): four **A** records to GitHub Pages' current IPs — `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` — plus, optionally, **AAAA** records `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` for IPv6.
- `www.noodara.com`: a **CNAME** record pointing at `<owner>.github.io.` (GitHub's redirect from www→apex, or apex→www depending on which the repo's Pages settings designates as primary — `public/CNAME`'s content decides the primary).
- After DNS propagates, "Enforce HTTPS" becomes selectable in repo Settings → Pages (GitHub auto-provisions the cert once DNS resolves correctly) — this is a manual, one-time UI action, not automatable from the workflow.

`[CITED: docs.github.com/pages — custom domain A/AAAA record values]` — these are GitHub's long-published, stable Pages IPs (unchanged across recent years per multiple current sources); flagged MEDIUM confidence since verified via WebSearch/community corroboration rather than a Context7-indexed source, but low-risk to get wrong since GitHub Pages itself will show a clear DNS-check error in repo settings if these are stale.

### Anti-Patterns to Avoid
- **Using `next/image` with a remote loader or without `unoptimized: true`:** `output: 'export'` hard-fails the build if `next/image`'s default loader is used without `images.unoptimized: true` — since D-17 uses plain `<picture>` elements for captures anyway, simplest is to avoid `next/image` in `apps/site` entirely rather than configuring around it.
- **A dynamic API route without `force-static`/`staticGET` in `output: 'export'`:** any `app/api/*/route.ts` that doesn't explicitly opt into static behavior fails the export build outright (Next.js refuses to emit a dynamic route with no server to run it on).
- **Server Components reading `cookies()`/`headers()`:** these APIs throw or return empty in static export — the whole app must be render-once-at-build; theme/preferences must stay client-only (`localStorage`), matching D-15's explicit "no server" framing.
- **Copying Fumadocs' `neutral.css` palette instead of mapping it to `packages/ui` tokens:** ships a second, unaudited color system into a repo whose entire design system discipline is "zero color literals outside `tokens.css`" (`check:ui-safety` gate) — the docs half of the site would silently violate that gate's *spirit* even if the literal grep only scans `apps/web`/`packages/ui` today (the plan should decide whether `check:ui-safety` extends to `apps/site` too).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Docs sidebar tree, TOC extraction, MDX→page mapping | A custom filesystem-walking MDX loader | `fumadocs-mdx`'s `defineDocs`/`loader` (Pattern 2) | Fumadocs already solves frontmatter parsing, nested-group sidebar generation (needed for D-08's four groups), and heading-based TOC extraction; hand-rolling duplicates a well-tested library for no gain. |
| Client-side full-text search over static docs | A hand-written substring/regex search | `fumadocs-core/search/flexsearch` + `flexsearchStaticClient` (Pattern 3) | Purpose-built for exactly this constraint (static export, no server) with tokenization/ranking already solved. |
| No-flash theme bootstrap | A fresh inline script written from scratch | Same technique as `apps/web/src/lib/theme-script.ts`, trimmed to the localStorage-only branch (no cookie read, since the site has no SSR layout setting `data-theme` server-side) | The app already solved the exact flash-of-wrong-theme problem; the site's version is a strict subset (drop the cookie branch), not a new problem. |
| GitHub Pages custom-domain HTTPS provisioning | Manually generating/renewing a TLS cert | GitHub Pages' built-in "Enforce HTTPS" (auto Let's Encrypt) once DNS + CNAME are correct | GitHub already automates this entirely; no cert management belongs in this repo. |

**Key insight:** Every "don't hand-roll" here is a case where Fumadocs, GitHub Pages, or this repo's own prior art (`apps/web/src/lib/theme-script.ts`) already solved the exact problem — the phase's actual net-new work is content (MDX copy), wiring (config/imports), token-mapping (Fumadocs CSS vars → Noodara tokens), and the four accuracy/claims/boundary/forbidden-words tests.

## Common Pitfalls

### Pitfall 1: `docs/install.md` stub breaking README/install.sh links (D-07)
**What goes wrong:** Deleting or gutting `docs/install.md` outright breaks any existing link from `README.md` or `install.sh` output messages that point at it.
**Why it happens:** D-07 explicitly requires the file survive as a short stub, not disappear — easy to over-execute "move to site" as "delete the old file."
**How to avoid:** Keep `docs/install.md` as a short stub linking to `https://noodara.com/docs/getting-started/install`; re-run `tests/unit/docs/install-docs-accuracy.test.ts`'s existing assertions (re-pointed at the new MDX file) to prove nothing broke.
**Warning signs:** Any grep for `docs/install.md` in `README.md`/`install.sh` returning a path that 404s once the stub is gone.

### Pitfall 2: Forbidden words / dates leaking into MDX content (D-10)
**What goes wrong:** Writing docs pages in normal product-writing style naturally reaches for "coming soon", "roadmap", or a literal date ("as of September 2026") when describing scope boundaries.
**Why it happens:** These phrases are the default vocabulary for describing unfinished features; D-10 requires present-tense factual phrasing instead ("Noodara does not manage domains or TLS").
**How to avoid:** Write a Vitest test (`apps/site/content/**/*.mdx` scan) that fails the build on `/\b(coming soon|soon|roadmap)\b/i` and on date-like patterns (`\b(19|20)\d{2}\b` or month names) *before* writing any content — TDD RED first, matching CLAUDE.md §2.1.
**Warning signs:** The forbidden-words test passing trivially because it was written after the content (an anti-pattern this repo's own CLAUDE.md explicitly rejects as "not TDD").

### Pitfall 3: Static export silently falling back to dynamic rendering for a route
**What goes wrong:** A page or route handler that reads a request-scoped API (`cookies()`, `headers()`, non-static `fetch`, a dynamic route param without `generateStaticParams`) causes `next build` with `output: 'export'` to either hard-fail or (in some Next.js versions) silently mark that one route dynamic, which then has no server to serve it once exported.
**Why it happens:** Easy to reach for a familiar Next.js API (e.g. reading `headers()` for locale) without realizing it's incompatible with static export.
**How to avoid:** After scaffolding, run `pnpm --filter @noodara/site build` and read the route-type summary Next.js prints (`○` = static, `●` = SSG with params, `ƒ` = dynamic — a `ƒ` anywhere in an `output: 'export'` build is either an error or a bug waiting to 404 in production). CI's PR gate build step (D-13) is exactly the automated form of this check.
**Warning signs:** `next build` output showing `ƒ` for any route, or the build succeeding but `apps/site/out/` missing an expected `.html` file for a route.

### Pitfall 4: `basePath` breaking the CNAME-present production build if tested wrong
**What goes wrong:** Testing the `/noodara` subpath basePath locally (no CNAME file) and then shipping to production where CNAME *is* present (root basePath) without ever having built with an empty basePath — bugs in absolute-URL construction (the OG image URL, `metadataBase`, canonical link) only surface in the root-basePath build.
**Why it happens:** The two build modes produce genuinely different HTML (different asset prefixes, different absolute URLs) — a developer who only ever runs `pnpm dev`/`pnpm build` locally without the CNAME file present never exercises the production path.
**How to avoid:** CI's PR gate (D-13) should build with `apps/site/public/CNAME` present (matching production) — since D-13 says "no path filter... the sitio nunca aparece en docker-compose.yml", the plan should make sure the PR build step reflects the real, CNAME-present production shape, not a subpath-basePath dev shape, so this exact class of bug is caught pre-merge.
**Warning signs:** Broken image/asset paths that only appear on the live `noodara.com` site but never in local dev.

### Pitfall 5: `fumadocs-ui`'s dark mode convention diverging from this repo's `[data-theme="dark"]` selector
**What goes wrong:** Fumadocs UI's default theme provider typically expects a `class="dark"` toggle (the common `next-themes` convention) — this repo's tokens use `[data-theme="dark"]` attribute selectors instead (see `packages/ui/tokens.css` header comment: "always explicit... never a bare `prefers-color-scheme` media query"). Wiring Fumadocs' theme components naively could end up driving a `class` attribute that nothing in `tokens.css` responds to, or double-toggling both a class and an attribute.
**Why it happens:** Fumadocs' out-of-box theme integration examples assume `next-themes`, which this site deliberately does not install (D-15: no server, no need for `next-themes`' SSR cookie machinery — a plain bootstrap script suffices, mirroring `apps/web`).
**How to avoid:** During implementation, verify exactly which selector Fumadocs UI's shipped components/CSS actually key off (check `fumadocs-ui/css/preset.css` and any `ThemeProvider`/`RootProvider` component docs at build time) and either configure Fumadocs to use `data-theme` directly (if it exposes that option) or have the site's bootstrap script set *both* the `dark` class and `data-theme="dark"` on `<html>` so both Fumadocs' own CSS and `packages/ui/tokens.css` respond correctly in one write.
**Warning signs:** Docs pages rendering in the wrong theme, or the toggle changing the landing page's theme but not the docs pages' (or vice versa).

## Code Examples

### Re-pointing `install-docs-accuracy.test.ts` at the MDX source (DOCS-02)

```typescript
// Adapt tests/unit/docs/install-docs-accuracy.test.ts's existing reader functions.
// Source: this repo, tests/unit/docs/install-docs-accuracy.test.ts (read directly, HIGH confidence).
const installSh = () => readFileSync('install.sh', 'utf8');
// BEFORE: const installDocs = () => readFileSync('docs/install.md', 'utf8');
// AFTER:
const installDocs = () => readFileSync('apps/site/content/docs/getting-started/install.mdx', 'utf8');
// The Troubleshooting-table regex, the NOODARA_ variable scan, the exit-code-set comparison,
// and every other existing assertion in this file keep working unmodified against MDX text,
// since MDX is a strict superset of Markdown for all the patterns this test already matches
// (tables, headings, inline code spans). Verify at implementation time that Fumadocs frontmatter
// (--- title: ... --- at the top of the MDX file) doesn't shift any line-relative regex.
```

### Error-code vocabulary source for the Reference › Error codes page (DOCS-01/SITE-01 honesty)

```typescript
// The real, current error-code vocabulary this phase's "Error codes" reference page must match
// exactly — read directly, never hand-copied:
// apps/control-plane/src/routes/http-errors.ts
export const SERVICE_ERROR_STATUS = Object.freeze({
  VALIDATION_FAILED: 400, INVALID_CREDENTIAL: 400, UNAUTHORIZED: 401, FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404, NAME_TAKEN: 409, HOST_TAKEN: 409, SERVER_BUSY: 409, ALREADY_CONNECTING: 409,
  SERVER_NOT_CONNECTED: 409, NO_PENDING_FINGERPRINT: 409, FINGERPRINT_MISMATCH: 409,
  SERVER_NOT_TRUSTABLE: 409, CONFIRMATION_MISMATCH: 409, QUEUE_UNAVAILABLE: 503,
  SSE_LIMIT_REACHED: 503, INTERNAL_ERROR: 500, EMAIL_DOMAIN_UNRESOLVABLE: 400,
  EMAIL_DOMAIN_CHECK_UNAVAILABLE: 503, REAUTH_LOCKED: 429, SESSION_REVOKED_PASSWORD_CHANGED: 401,
});
// A test analogous to install-docs-accuracy.test.ts's exit-code-set comparison should assert
// every key in this frozen object appears in the docs' error-codes MDX table with the same
// HTTP status, and no extra code appears in the docs — same "doc can't lie" discipline (DOCS-02).
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Orama as Fumadocs' default/recommended static search | `fumadocs-core/search/flexsearch` + `flexsearchStaticClient` for static export; Orama repositioned as a server-based backend (`@orama/core` peer dep) | Current as of fumadocs-core 16.15.15's own docs (checked 2026-09-27) | Corrects `.planning/research/STACK.md`'s "Orama static search" assumption — the plan must wire flexsearch's static client, not Orama, for D-08's "búsqueda estática" requirement. |
| GitHub Pages "Deploy from a branch" (`gh-pages` branch, Jekyll processing, needs `.nojekyll`) | Actions-artifact deployment (`configure-pages`/`upload-pages-artifact`/`deploy-pages`, no branch, no Jekyll) | Long-established as the recommended path (GitHub's own current default recommendation) | D-12 already specifies the artifact path — confirmed as the currently-recommended, non-deprecated approach; no `.nojekyll` file needed. |

**Deprecated/outdated:**
- `actions/upload-pages-artifact@v3` / older `actions/deploy-pages` majors are subject to GitHub's own "artifacts actions v4" deprecation notice — use the v5/v6-line SHAs pinned above, not older cached examples found in older blog posts.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Fumadocs UI's shipped `RootProvider`/theme components can be configured to key off `data-theme` (or an equivalent adapter is trivial) rather than requiring `next-themes`' `class` convention | Pitfall 5, Pattern 4 | If Fumadocs hard-requires `next-themes` or a `class`-based toggle with no override point, the plan needs either a small wrapper component or a CSS bridge (`[data-theme="dark"] :where(.dark) { ... }` selector aliasing) — a implementation-time Context7/doc check before writing the theme-toggle task is warranted. |
| A2 | GitHub Pages' apex A/AAAA IPs (`185.199.108-111.153` / `2606:50c0:8000-8003::153`) are still current | Pattern 6 | These are GitHub's long-stable, widely-published values, but verified here via WebSearch/community corroboration, not a Context7-indexed primary source — the plan should tell the user to double-check `docs.github.com/pages` at DNS-configuration time in case GitHub rotates them. |
| A3 | Repo Settings → Pages source must be manually switched to "GitHub Actions" before `public-site.yml` can run | Pattern 5 | Low risk — this is a one-time, well-documented GitHub UI setting; if wrong, the workflow simply fails clearly on first run with an actionable GitHub error, not a silent failure. |
| A4 | Tailwind v4's `@source` directive syntax for pulling `packages/ui/src` class names into `apps/site`'s scan matches the pattern already working in `apps/web` | Pattern 4 | If `apps/web` doesn't actually need an explicit `@source` (e.g. because it only imports pre-built components, not raw Tailwind classes from `packages/ui/src`), the plan should verify `apps/web`'s actual working CSS-import setup directly rather than assuming a generic Tailwind v4 monorepo pattern. |

## Open Questions

1. **Does `apps/site` need `check:ui-safety` (zero color literals, zero `outline:none`, etc.) extended to cover it, given SITE-03's "mismo piso de calidad"?**
   - What we know: `check:ui-safety` today scans specific paths (likely `apps/web`/`packages/ui` — verify exact glob in `scripts/check-ui-safety.mjs` at plan time); D-15/D-16 require the site to use the same token discipline.
   - What's unclear: whether extending the existing gate's glob to include `apps/site` is in-scope for this phase or an acceptable follow-up, given the phase's own "Claude's Discretion" list doesn't explicitly name this gate.
   - Recommendation: the planner should read `scripts/check-ui-safety.mjs`'s current glob directly and decide whether extending it is a task in this phase (cheap, one glob-string change) or explicitly deferred — leaving it silently un-covered would be an easy SITE-03 gap.

2. **Exact frontmatter/claims-test mechanism for SITE-01 (explicitly "Claude's Discretion" in CONTEXT.md)**
   - What we know: the test must contrast landing-asserted capabilities against `PROJECT.md`'s "Out of Scope" section and the docs' own "Scope of this release" Not-included list.
   - What's unclear: whether a JSON `claims` frontmatter block on the landing page, or a separate `apps/site/content/claims.json` manifest, is the cleaner mechanism — both work; the planner should pick one based on how the landing page component itself needs to consume the same list (rendering D-03's "What it does not do yet" section from the identical source the test reads, so the two can never drift).
   - Recommendation: prefer a single source of truth file (e.g. `apps/site/content/scope.ts` exporting a typed array of "included"/"not included" strings) that both the landing component and the "Scope of this release" MDX page import/reference, and that the claims test reads directly — avoids maintaining the same list in three places (landing copy, docs page, test fixture).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | `next build` for `apps/site` | ✓ (repo-wide requirement) | 22 (pinned via `.nvmrc`/CI `NODE_VERSION`) | — |
| pnpm | Workspace install | ✓ | (repo-pinned via `pnpm/action-setup`) | — |
| GitHub Pages (external service) | SITE-02 publishing | Cannot verify from this environment — requires the actual GitHub repo to exist with Pages enabled | — | None — this is an external, one-time manual repo-settings step (Settings → Pages → Source → GitHub Actions) that must happen before `public-site.yml` can succeed; the plan should include a `checkpoint:human-verify` or explicit manual-step task for this. |
| DNS control for `noodara.com` | D-11 custom domain | Cannot verify from this environment — user-owned domain | — | None — user must add the A/AAAA/CNAME records documented in Pattern 6; until then, the site is reachable at `<owner>.github.io/noodara` via the basePath fallback (D-12's own stated purpose for that fallback). |

**Missing dependencies with no fallback:**
- GitHub Pages repo-settings enablement (manual, one-time, blocks `public-site.yml` succeeding at all until done).

**Missing dependencies with fallback:**
- DNS/CNAME — the `/noodara` basePath fallback (D-12) means the site still builds and is reachable via GitHub's default Pages URL even before DNS is configured.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5 (already pinned, root `vitest.config.ts` projects) |
| Config file | `vitest.config.ts` (root) — a new `include` glob or project entry for `apps/site/**/*.test.ts` and/or a new `tests/unit/docs/**` file covers the accuracy/claims/forbidden-words tests |
| Quick run command | `pnpm test -- tests/unit/docs` (or the specific new test file paths) |
| Full suite command | `pnpm test --coverage` (existing root script) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DOCS-01 | `apps/site` builds as a valid static export with all four sidebar groups present | build smoke | `pnpm --filter @noodara/site build` | ❌ Wave 0 (new app scaffold) |
| DOCS-02 | Install command, exit-code table, variables match `install.sh` exactly | unit | `pnpm test -- tests/unit/docs/install-docs-accuracy.test.ts` (re-pointed) | ✅ exists, needs re-pointing (see Pitfall 1 / Code Examples) |
| DOCS-02 | Error codes in Reference page match `SERVICE_ERROR_STATUS` exactly | unit | `pnpm test -- tests/unit/docs/error-codes-accuracy.test.ts` (new) | ❌ Wave 0 |
| SITE-01 | Landing claims are a subset of what's actually delivered (cross-checked against `PROJECT.md` Out of Scope) | unit | `pnpm test -- tests/unit/site/landing-claims.test.ts` (new) | ❌ Wave 0 |
| SITE-01/D-10 | No forbidden words ("coming soon"/"soon"/"roadmap") or bare dates in `apps/site/content/**` | unit | `pnpm test -- tests/unit/site/forbidden-words.test.ts` (new) | ❌ Wave 0 |
| SITE-02 | `apps/site` cannot import `apps/control-plane` or `@noodara/domain` | static (turbo boundaries) | `pnpm boundaries` (extend `turbo.json`'s `boundaries.tags`) | ❌ Wave 0 (new tag entry) |
| SITE-02 | `public-site.yml`'s `uses:` lines are all pinned to commit SHAs | unit | `pnpm test -- tests/unit/scripts/check-workflow-pins.test.ts` (extend existing structural assertions to the new file) | ✅ scanner exists, needs the new workflow file added to its structural-proof list |
| SITE-03 | Landing + docs pass contrast/theme/reduced-motion review at 375/900/1280/1920px, both themes | manual + E2E-assisted capture | `pnpm ui:review` (extended, per `scripts/ui/capture-ui-review.ts`/`review-paths.ts` pattern) + human sign-off in `docs/ui/APPROVAL.md` | ❌ Wave 0 (extend existing script to cover site screens) |

### Sampling Rate
- **Per task commit:** the specific new/modified test file(s) for that task.
- **Per wave merge:** `pnpm test -- tests/unit/docs tests/unit/site` plus `pnpm --filter @noodara/site build`.
- **Phase gate:** `pnpm test --coverage`, `pnpm --filter @noodara/site build`, `pnpm boundaries`, `pnpm lint`, `pnpm typecheck`, full `pnpm ui:review` human approval round before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] `apps/site/package.json` + `next.config.ts` + `tsconfig.json` + `postcss.config.mjs` — new workspace app scaffold (no existing config to extend; must mirror `apps/web`'s pattern, not copy `apps/web/next.config.ts` verbatim since it has `output: 'standalone'`/rewrites this app must not have).
- [ ] `apps/site/source.config.ts` + `apps/site/lib/source.ts` — Fumadocs wiring, no existing equivalent.
- [ ] `tests/unit/docs/error-codes-accuracy.test.ts` — new, covers DOCS-02's error-code half (the existing test only covers install.sh).
- [ ] `tests/unit/site/landing-claims.test.ts` — new, covers SITE-01.
- [ ] `tests/unit/site/forbidden-words.test.ts` — new, covers D-10.
- [ ] `turbo.json` boundaries — new `tags` entry for `apps/site` (allow: `pure-domain`? verify — CONTEXT.md says `@noodara/ui` allowed, `apps/control-plane`/`@noodara/domain` forbidden; likely `apps/site` gets a fresh tag like `public-site` with `allow: ["ui-components", "@noodara/config"]` only, no `pure-domain` unless a content-scope constant genuinely needs a domain type).
- [ ] `scripts/ui/review-paths.ts` — extend `SCREENS`/add a new `SITE_SCREENS` (or equivalent) for landing + a representative docs page, both themes, four widths.
- [ ] Framework install: none needed (Vitest already the workspace default).

## Security Domain

> `security_enforcement` config key not found in `.planning/config.json` — treated as enabled per the reference's default.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Static site has no auth surface. |
| V3 Session Management | No | No sessions, no server. |
| V4 Access Control | No | Fully public content by design. |
| V5 Input Validation | Minimal | No user input accepted anywhere on this site (no forms, no server) — the only "input" is the build-time MDX/frontmatter, validated by Fumadocs' own frontmatter schema if one is configured. |
| V6 Cryptography | No | No secrets, no crypto on this site. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Supply-chain risk in a new third-party docs framework dependency | Tampering | slopcheck legitimacy audit (done, all `[OK]`); `pnpm audit` already runs repo-wide in the existing `ci.yml` `security` job — no new gate needed, `apps/site`'s new deps flow through the same `pnpm install --frozen-lockfile` + audit path. |
| Workflow-pin tampering (`public-site.yml`'s `uses:` lines pointing at a mutable tag an attacker could re-point) | Tampering | Pin every `uses:` to a commit SHA (Pattern 5), verified by the existing `check-workflow-pins.mjs` gate extended to this new file. |
| Landing/docs content making a false security or capability claim (e.g. implying HTTPS/secrets features that don't exist yet) | Spoofing (of capability) | D-03/D-10's factual-scope-block requirement + the landing-claims test (SITE-01) — this is this phase's actual primary "security-adjacent" control, framed as an honesty gate rather than a classic ASVS category. |

This phase's real security-relevant surface is narrower than most: no credentials, no shell, no network calls at runtime, no AI. The one genuine repo-wide security concern this phase introduces is the new CI workflow's action pins (already covered by an existing gate) and third-party dependency provenance (already covered by slopcheck + `pnpm audit`).

## Sources

### Primary (HIGH confidence)
- Context7 `/websites/fumadocs_dev` — `output: 'export'` config, `defineDocs`/`loader` macro API, `generateStaticParams`/`source.generateParams()`, static search (`flexsearchFromSource`/`flexsearchStaticClient`), Algolia's separate static-export pattern, Tailwind v4 CSS import setup, OG metadata generation pattern.
- `npm view fumadocs-core version` / `npm view fumadocs-ui version` / `npm view fumadocs-mdx version` / `npm view fumadocs-core peerDependencies` / `npm view fumadocs-ui peerDependencies` — live registry data confirming current versions (16.15.15 / 16.15.15 / 15.4.5) and peer-dep compatibility with this repo's pinned Next/React.
- `slopcheck install fumadocs-core fumadocs-ui fumadocs-mdx` — all three `[OK]`, run live 2026-09-27.
- Direct repo reads: `.planning/phases/10-.../10-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/PROJECT.md`, `.planning/research/STACK.md`, `.planning/research/ARCHITECTURE.md`, `install.sh`, `tests/unit/docs/install-docs-accuracy.test.ts`, `apps/control-plane/src/routes/http-errors.ts`, `apps/web/next.config.ts`, `apps/web/package.json`, `turbo.json`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `tests/unit/scripts/check-workflow-pins.test.ts`, `packages/ui/package.json`, `packages/ui/tokens.css`, `scripts/ui/review-paths.ts`, `scripts/ui/capture-ui-review.ts`, `apps/web/src/lib/theme-script.ts`, `docs/ui/APPROVAL.md`, `packages/ui/brand/` directory listing.

### Secondary (MEDIUM confidence)
- GitHub REST API (`api.github.com/repos/<owner>/<repo>/git/refs/tags`, live 2026-09-27) — resolved commit SHAs for `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5.0.1` (authoritative source for the SHA itself, but the *choice* of which major/minor to pin was informed by WebSearch, hence MEDIUM not HIGH).
- WebSearch — "actions/deploy-pages actions/upload-pages-artifact actions/configure-pages latest release version" — corroborated current majors (v4-compatible artifact format requirement, GitHub's own deprecation notice) across GitHub's own repos and Marketplace listing.

### Tertiary (LOW confidence)
- GitHub Pages apex A/AAAA IP addresses (Pattern 6) — from training knowledge, cross-checked only informally (these are widely and consistently published values across many independent sources over a long period, but not re-verified live against `docs.github.com/pages` in this session) — flagged in Assumptions Log (A2) for the user/planner to double check at DNS-configuration time.

## Metadata

**Confidence breakdown:**
- Standard stack (Fumadocs versions/peer-deps/static-search mechanism): HIGH — Context7 + live npm registry checks agree, and corrected a stale assumption in prior research (Orama → flexsearch).
- Architecture (static export mechanics, GitHub Pages Actions workflow shape): HIGH for Next.js/Fumadocs static-export specifics (Context7-sourced); MEDIUM for the exact GitHub Actions version/SHA choices (WebSearch + GitHub API, no Context7 coverage of GitHub Marketplace actions).
- Pitfalls: HIGH for the Next.js/Fumadocs-specific ones (grounded in official static-export docs and this repo's own existing code); MEDIUM for the Fumadocs-dark-mode-selector pitfall (reasoned from the token file's own comments, not yet verified against Fumadocs UI's actual shipped theme component API — flagged as Assumption A1).

**Research date:** 2026-09-27
**Valid until:** 2026-10-11 (14 days — Fumadocs is an actively-developed, frequently-released package; re-verify exact patch versions before `pnpm install` if planning is delayed past that window)

---
*Phase: 10-sitio-de-docs-y-landing-pública*
*Researched: 2026-09-27*
