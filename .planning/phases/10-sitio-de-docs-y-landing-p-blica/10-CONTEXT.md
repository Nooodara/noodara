# Phase 10: Sitio de docs y landing pública - Context

**Gathered:** 2026-09-27
**Status:** Ready for planning

<domain>
## Phase Boundary

La cara pública de Noodara: `apps/site` (Next 16 + Fumadocs 16, exportación estática) con la **landing en `/`** y los **docs en `/docs`**, publicado a **GitHub Pages en `noodara.com`** desde `public-site.yml` en cada push a `main`. Docs de instalación (misma verdad que `install.sh`), conceptos, "Your first server", operate (upgrade/rollback/backups/troubleshooting), referencia (variables, exit codes, error codes, alcance de la release). Tests que hacen imposible mentir: exactitud contra `install.sh` y el vocabulario de errores, afirmaciones de la landing contra el Out of Scope de `PROJECT.md`, boundary que impide importar `apps/control-plane` o `@noodara/domain`. Mismo piso de calidad que la app (contraste medido, ambos temas, reduced-motion) y aprobación humana con capturas.

Fuera: cualquier feature de producto, analytics, newsletter, blog, versionado de docs, la página "Your first deploy" (Fase 13).

</domain>

<decisions>
## Implementation Decisions

### Landing: mensaje y secciones
- **D-01: Hero = wordmark + lema + una frase + comando + captura.** Arriba del pliegue: lockup/wordmark, "Your infrastructure, understood.", una frase de qué es Noodara, el comando `curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sh` copiable (el MISMO string que `install.sh`/README, verificado por test) y debajo la captura real de Servers (`docs/ui/approved/servers-{light,dark}.png`) según el tema del visitante. Botones: primario "Read the docs" (`/docs`), secundario "View on GitHub".
- **D-02: Solo lo entregado, con captura real por pilar.** Tres pilares, cada uno con una captura de `docs/ui/approved/`: **Connect** (SSH con huella verificada: login/servers), **Discover** (discovery paso a paso con checks: server-detail), **Understand** (activity + settings/temas/densidad). Ninguna sección de futuro, sin roadmap, sin "planned".
- **D-03: Bloque explícito de límites en la landing.** Sección corta "What it does not do yet" con la lista de v0.2 (sin env vars ni secrets de app, sin dominios/HTTPS/Traefik, sin deploy engine avanzado, sin multiusuario) redactada como hechos y con enlace a `/docs/reference/scope`. Sin fechas, sin "coming soon".
- **D-04: Posicionamiento sin nombrar a nadie.** Una frase propia del tipo "Most panels manage your servers. Noodara helps you understand them." Sin citar Coolify/Dokploy ni tablas comparativas.
- **D-05: "How it works" en tres pasos con diagrama SVG propio.** 1) Install Noodara on an Ubuntu VPS, 2) add your servers over SSH (no agent), 3) Noodara discovers and watches them. El diagrama se dibuja en SVG en tinta (`currentColor`), geometría del brand kit; ninguna ilustración ni icono de terceros.
- **D-06: Footer = Docs, GitHub, licencia, versión.** Licencia tal como dice `LICENSE` (""); la versión se lee en build del último tag o de `package.json`, nunca escrita a mano. GitHub como botón secundario sin contador de estrellas (cero llamadas a APIs de terceros).

### Docs: arquitectura y fuente única
- **D-07: La instalación se muda al sitio.** El MDX de `apps/site` pasa a ser la ÚNICA fuente del texto de instalación; `docs/install.md` queda como stub corto que enlaza a `https://noodara.com/docs/getting-started/install` (README e `install.sh` ya enlazan a `docs/install.md`, así que el stub mantiene esas rutas vivas). `tests/unit/docs/install-docs-accuracy.test.ts` se re-apunta al MDX y conserva todas sus aserciones (mismo comando, misma tabla de exit codes leída de `noodara_exit_code_for`, variables soportadas, sección First login/exit 53).
- **D-08: Cuatro grupos en el sidebar.** Getting started (Install, First login, Your first server) · Concepts (Server, Project, Environment, Service, Deployment) · Operate (Upgrade, Rollback, Backups, Troubleshooting) · Reference (Supported variables, Exit codes, Error codes, Scope of this release). Búsqueda estática de Fumadocs (Orama) activada; sin versionado de docs (solo la versión actual).
- **D-09: "Your first server" ahora; "Your first deploy" cuando cierre la Fase 13.** La guía cubre el flujo real de hoy: instalar → primer login → añadir servidor → confiar la huella → discovery → leer el detalle. Se anota en ROADMAP/REQUIREMENTS que la Fase 13 añade la página de deploy y reabre DOCS-01 en ese punto. Los conceptos Project/Environment/Service/Deployment se explican como modelo (qué son y cómo se relacionan) sin afirmar que la UI ya los gestiona; la nota de alcance (D-10) lo deja claro.
- **D-10: Límites como hechos: página "Scope of this release" + notas en contexto.** Página de referencia con tabla "Included / Not included" en presente ("Noodara does not manage domains or TLS. Put configuration in the image."), y una nota breve en cada página afectada (Service, Environment, Install). Prohibidas las palabras "coming soon", "soon", "roadmap" y las fechas en `apps/site/content` (test).

### Dominio y publicación
- **D-11: `noodara.com` en raíz.** Landing en `/`, docs en `/docs`. Archivo `apps/site/public/CNAME` con `noodara.com`; `www.noodara.com` lo redirige Pages (el plan documenta los registros DNS: A/AAAA de Pages para el apex + CNAME de www). "Enforce HTTPS" en Pages. Cambiar de dominio = cambiar solo el CNAME.
- **D-12: Pages desde el mismo repo vía artifact de Actions.** `public-site.yml`: build estático de `apps/site` → `actions/upload-pages-artifact` → `actions/deploy-pages`; sin rama `gh-pages`. El `basePath`/`assetPrefix` se calcula en build: raíz cuando existe CNAME, subruta `/noodara` cuando no (para que el sitio funcione aunque el dominio aún no apunte). `metadataBase` y las URLs canónicas usan `https://noodara.com`.
- **D-13: Cada push a `main` publica; el PR corre el sitio como gate.** Sin filtro de paths (capturas, tokens y textos que afectan al sitio viven fuera de `apps/site`). El job de PR en `ci.yml` añade: `pnpm --filter @noodara/site build` (export estático), el test de exactitud, el test de afirmaciones y el boundary test. El sitio nunca aparece en `docker-compose.yml` ni en `release.yml`.
- **D-14: Piezas web estándar, cero terceros.** `sitemap.xml`, `robots.txt`, página 404 con la identidad, metadatos SEO y Open Graph (imagen 1200×630 de la Fase 7 D-12, self-hosted). Sin analytics en esta fase; se deja documentado dónde se enchufaría un analytics self-hosted más adelante (idea diferida), sin código ni placeholder visible.

### Enmienda 2026-09-28: Cloudflare Pages en vez de GitHub Pages

Decisión bloqueada del usuario (2026-09-28), ejecutada en `quick-260928-gmm`: sin GitHub Pages,
hosting en Cloudflare Pages vía Direct Upload; `noodara.com` sigue registrado en Namecheap y solo
mueve sus nameservers a Cloudflare. Esta enmienda amplía (no borra) las mecánicas de hosting de
D-11/D-12/D-13.

- **D-11a (amends D-11).** `noodara.com` sigue en raíz, pero ahora vía un custom domain de
  Cloudflare Pages (no un `CNAME` file; el dominio se añade en el dashboard de Cloudflare Pages
  tras mover los nameservers desde Namecheap). TLS lo gestiona Cloudflare.
- **D-12a (amends D-12).** Publicación por `wrangler-action` (Direct Upload) en vez de
  `upload-pages-artifact`/`deploy-pages`; sin `gh-pages`, sin artifact de Actions. `basePath`/
  `assetPrefix` son siempre raíz — Cloudflare Pages no tiene el caso "subruta de preview" que
  GitHub Pages project-sites sí tenía, así que `resolveBasePath`/`readCname` se eliminan en vez de
  mantenerse condicionales. `metadataBase`/URLs canónicas siguen en `https://noodara.com`, sin
  cambio.
- **D-13a (amends D-13).** El trigger (`push: branches: [main]` + `workflow_dispatch`, sin filtro
  de paths) y el PR gate en `ci.yml` (`site` job) se mantienen exactamente igual — solo cambia el
  job de publicación.

### Look del sitio: temas y tipografía
- **D-15: Sigue al SO + toggle en el header.** `prefers-color-scheme` por defecto, toggle en la cabecera del sitio y de los docs, preferencia en `localStorage` (el sitio no tiene servidor); script de bootstrap sin flash como el de la app. Los tokens vienen de `packages/ui/tokens.css` (mismos valores claro/oscuro), nunca copiados a mano.
- **D-16: Fuente del sistema, como la app.** Misma pila que `packages/ui` (SF Pro → Inter del SO → sans-serif); mono del sistema para comandos, códigos y variables. Cero fuentes descargadas, cero terceros. El wordmark y el monograma son los SVG de `packages/ui/brand/` (lockup claro/oscuro).
- **D-17: Capturas planas.** La captura tal cual, borde hairline, radio `lg`, sin marco de ventana ni sombra; `<picture>` con la versión clara y oscura según el tema del sitio. Solo capturas de `docs/ui/approved/` (las aprobadas por el usuario en la Fase 8), copiadas/optimizadas en build, nunca capturas nuevas sin aprobar.
- **D-18: Un solo momento de movimiento.** El monograma Viewfinder enfoca una vez al cargar el hero (misma animación que `/login`, Fase 8 D-11, reutilizando `packages/ui/src/brand/geometry.ts`); hover/focus sutiles; nada al hacer scroll, sin parallax, sin gradientes ni glow. `prefers-reduced-motion` lo sustituye por crossfade/estático.

### Round 1 amendment (2026-09-28)

User feedback at the 10-12 human checkpoint: the landing was correct but "muy simplona". Direction:
use the `impeccable` skill and Emil Kowalski's animation/design skills, taking dokploy.com and
coolify.io as structural (not visual) references. Full brief:
`.planning/phases/10-sitio-de-docs-y-landing-p-blica/10-12-ROUND1-BRIEF.md`.

- **D-02a (amends D-02).** The three pillars become a **feature grid** rendering every entry in
  `DELIVERED_CAPABILITIES` (hairline shared-border grid, own inline SVG glyph + title + claim,
  no card shadows) plus a **tabbed product tour** over the six approved captures (setup, login,
  servers, server-detail, activity, settings — `APPROVED_SCREENS`), each tab captioned by an
  existing `DELIVERED_CAPABILITIES` claim. Two capabilities were added to back new "how it's
  built" copy: `encrypted-credentials` (evidence `apps/control-plane/src/services/credential-store.ts`)
  and `explicit-timeouts` (evidence `packages/ssh/src/exec-with-timeout.ts`). Still only approved
  captures (D-17), still only what ships — no new claim anywhere without a `DELIVERED_CAPABILITIES`
  or `SCOPE_EXCLUSIONS` entry backing it.
- **D-18a (amends D-18).** More than one motion moment is now allowed: the hero's aperture focus
  (unchanged), a one-shot clip-path reveal on the hero screenshot, a once-only scroll reveal
  (opacity + small translate, IntersectionObserver-driven, applied once per section — never
  parallax, never repeated) on the feature grid/principles/FAQ sections, and a crossfade +
  translate transition between product-tour tabs. All CSS transitions/`@starting-style`, no
  motion library. `prefers-reduced-motion` removes transform-based movement everywhere, keeping
  opacity-only or static fallbacks. The scroll-reveal hook lives in `apps/site/src/lib/` (not
  `components/landing/`) so the existing "landing files contain no IntersectionObserver" source
  scan keeps testing what it always tested: the landing components themselves stay declarative,
  observing via an imported hook rather than each owning its own observer.
- **New sections added:** a "How it's built" principles band (4 cards: encrypted credentials,
  verified fingerprints, explicit timeouts, no agent — all `DELIVERED_CAPABILITIES` claims, no new
  prose), an FAQ (native `<details>/<summary>`, zero new JS, every answer is an existing
  capability claim or the build-time license/version fact — never a `SCOPE_EXCLUSIONS` statement
  outside `ScopeBlock`, to keep the "no excluded term outside the scope block" test meaningful), a
  closing CTA band re-rendering `InstallCommand` (now appears twice on the page: hero + closing
  band), and a four-column footer (one column per D-08 docs group, one link each, plus the
  existing Docs/GitHub/license/version column).
- **Stays locked, unchanged by this round:** CLAUDE.md §5 (one accent, no shadows, no gradients/
  glows/gradient text, system font), zero third-party requests, approved-captures-only, D-03/D-04/
  D-10 honesty rules, dark+light parity.

### Claude's Discretion
- Mecanismo del test de afirmaciones (SITE-01): cómo se marcan las capacidades afirmadas en la landing (p. ej. un JSON/MDX frontmatter de `claims` con la lista cerrada de capacidades entregadas) y cómo se contrastan con el Out of Scope de `PROJECT.md` y con la lista de "Not included" de la página de alcance.
- Forma exacta del boundary test (Turborepo boundaries ya existe en `pnpm boundaries`: añadir `apps/site` con tags que prohíban `apps/control-plane` y `@noodara/domain`; `@noodara/ui` sí se permite).
- Cómo comparte `apps/site` los tokens y componentes de `packages/ui` con Fumadocs (Tailwind v4 `@source`/`@import` de `tokens.css` y `theme.css`) y qué componentes de Fumadocs se re-skinean.
- Estructura interna de `apps/site/content`, nombres de rutas dentro de los cuatro grupos, y la redacción en inglés de todos los textos (CLAUDE.md §7.1).
- Ancho máximo de la landing, tamaño del wordmark en el hero, estilo de bloques de código (copiable, mono del sistema).
- Cómo se hace la revisión humana del sitio: capturas de landing y docs en ambos temas a 375/900/1280/1920 con el pipeline `pnpm ui:review` extendido, registradas en `docs/ui/APPROVAL.md` (mismo formato que las fases 7–9), más una URL de Pages real tras el primer despliegue.
- Cómo se lee la versión en build (tag vs `package.json`) y qué muestra antes del primer tag de v0.2.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Alcance y requisitos
- `.planning/ROADMAP.md` §"Phase 10: Sitio de docs y landing pública" — objetivo, 5 criterios de éxito, dependencias (Fase 11 solo para códigos de error).
- `.planning/REQUIREMENTS.md` — DOCS-01, DOCS-02, SITE-01, SITE-02, SITE-03; fila "Vercel/Netlify para el sitio" (descartado: GitHub Pages).
- `.planning/PROJECT.md` §"Out of Scope" y §"Current Milestone: v0.2" — la lista contra la que se contrastan las afirmaciones de la landing.
- `.planning/research/STACK.md` §Fumadocs y `.planning/research/ARCHITECTURE.md` (workflow `public-site.yml` separado de `release.yml`) — decisiones de stack ya tomadas.

### Verdad de instalación y errores
- `docs/install.md` — texto actual de instalación (Requirements, Install, sin pipe, What gets installed, First login, Plain HTTP warning, Firewall, Supported variables, Upgrade, Rollback, Troubleshooting, Backups); se muda al sitio (D-07).
- `install.sh` — `noodara_exit_code_for`, variables soportadas y el comando canónico.
- `tests/unit/docs/install-docs-accuracy.test.ts` — el test de exactitud a re-apuntar y ampliar (DOCS-02).
- `apps/control-plane/src/routes/http-errors.ts` — vocabulario real de códigos de error para la página Reference › Error codes.
- `docs/adr/0007-production-topology-and-installer.md` y `docs/adr/0006-web-app-same-origin-proxy-and-ports.md` — topología que los docs describen.

### Identidad y diseño
- `docs/brand/BRAND.md` y `packages/ui/brand/` (`lockup-{light,dark}.svg`, `monogram-*.svg`, `favicon.*`, iconos, OG) — assets y reglas de uso; Fase 7 D-09…D-12.
- `packages/ui/tokens.css`, `packages/ui/theme.css`, `packages/ui/aperture.css` — tokens y temas que el sitio importa; `packages/ui/src/brand/geometry.ts` — monograma animable (D-18).
- `docs/ui-build-prompt.md` §9 (prohibiciones) y §10 (DoD de UI) — el sitio cumple el mismo piso.
- `.claude/skills/noodara-ux-apple/SKILL.md` y `.claude/skills/noodara-ux-review/SKILL.md` — design system y auditoría.
- `docs/ui/approved/*.png` y `docs/ui/approved/README.md` — las únicas capturas admitidas en la landing (D-17); `docs/ui/APPROVAL.md` — formato del registro de aprobación humana.
- `scripts/ui/capture-ui-review.ts`, `scripts/ui/review-paths.ts` — pipeline de capturas a extender para el sitio.

### CI
- `.github/workflows/ci.yml` — job de PR al que se añade el gate del sitio; `.github/workflows/release.yml` — donde el sitio NO entra.
- `turbo.json` y la configuración de `pnpm boundaries` — para el boundary test de `apps/site`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/ui` (tokens, `theme.css`, componentes como `Button`, `SegmentedControl`, `CopyButton`, `Disclosure`, `ThemeToggle`'s `applyPreferences`) — el sitio comparte tokens y puede reutilizar primitivas neutras; el toggle del sitio escribe solo `localStorage` (no hay cookie de servidor).
- `packages/ui/brand/` y `packages/ui/src/brand/geometry.ts` — lockups, favicon, OG image y el monograma animable del hero.
- `apps/web/src/lib/theme-script.ts` — patrón del script de bootstrap sin flash (versión localStorage-only para el sitio).
- `tests/unit/docs/install-docs-accuracy.test.ts` y `tests/unit/brand/approval-record.test.ts` / `tests/unit/ui/approval-record.test.ts` — patrones de "doc que no puede mentir" y de registro de aprobación pineado.
- `scripts/ui/capture-ui-review.ts` — captura Playwright multi-tema/multi-ancho reutilizable para la landing y los docs.

### Established Patterns
- Monorepo pnpm + Turborepo; `pnpm boundaries` ya vigila `packages/domain` puro — el sitio entra como app con sus propias reglas de importación.
- Next 16 App Router en `apps/web`; `apps/site` debe ser `output: 'export'` y no compartir `next.config` (el de web exige `NOODARA_API_ORIGIN`).
- Inglés en código, copy y docs de producto; español solo en `.planning/`.
- Anti-slop del brief: un solo acento, sin sombras decorativas, sin gradientes, fuente del sistema, movimiento con propósito.

### Integration Points
- `docs/install.md` → stub que enlaza al sitio; README enlaza a `docs/install.md` (sin cambios) o directamente a `noodara.com/docs` (Claude decide).
- `ci.yml` job de PR → build + tests del sitio; nuevo `public-site.yml` → Pages.
- `docs/ui/APPROVAL.md` → bloque "Phase 10 — Public site" tras la revisión humana.
- ROADMAP/REQUIREMENTS → nota de que la página "Your first deploy" reabre DOCS-01 al cerrar la Fase 13.

</code_context>

<specifics>
## Specific Ideas

- El comando de instalación de la landing y de los docs es literalmente el de `install.sh`/README (`curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sh`), con la alternativa "download, read, run" enlazada.
- Frase de posicionamiento de referencia: "Most panels manage your servers. Noodara helps you understand them." (ajustable en redacción, no en intención).
- Tono de los límites: hechos en presente, como `docs/install.md` hoy ("Noodara does not manage domains. Put configuration in the image."), nunca promesas.
- El dominio es `noodara.com`; el usuario configura el DNS con los registros que el plan documente.

</specifics>

<deferred>
## Deferred Ideas

- Página "Your first deploy" en los docs — Fase 13 (reabre DOCS-01 al cerrar).
- Analytics self-hosted (Plausible/Umami autoalojado) — fase posterior; sin código en esta.
- Contador de estrellas de GitHub en la landing — descartado por ahora (API de terceros).
- Versionado de docs por release y i18n — no en v0.2.
- Previews de PR del sitio (URL efímera) — no en esta fase; el gate del PR es el build.

</deferred>

---

*Phase: 10-sitio-de-docs-y-landing-pública*
*Context gathered: 2026-09-27*
