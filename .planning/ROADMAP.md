# Roadmap: Noodara

## Milestones

- ✅ **v0.1 Foundation** — Phases 1-6 (shipped 2026-09-22) — [archive](milestones/v0.1-ROADMAP.md), [requirements](milestones/v0.1-REQUIREMENTS.md), [release gate](../docs/releases/v0.1-gate.md)
- 🚧 **v0.2 Projects & Services** — Phases 7-14 (in progress, roadmap created 2026-09-22) — requisitos en `REQUIREMENTS.md`, research en `research/SUMMARY.md`, alcance en `docs/roadmap-v0.1-v0.5.md` §7

## Phases

<details>
<summary>✅ v0.1 Foundation (Phases 1-6) — SHIPPED 2026-09-22</summary>

- [x] Phase 1: Dominio, persistencia y autenticación (17/17 plans) — completed 2026-09-12 — Base de datos migrada, dominio ≥95% cubierto y un admin único que inicia/cierra sesión de forma segura.
- [x] Phase 2: Adaptador SSH aislado y probado con Testcontainers (10/10 plans) — completed 2026-09-15 — Conexión SSH con TOFU, timeouts, allowlist de comandos y discovery, validado contra un `sshd` real.
- [x] Phase 3: Servicios de aplicación, activity log y redacción (10/10 plans) — completed 2026-09-16 — Registrar/editar/eliminar servidores, snapshots de discovery y un activity log sin fugas de secrets.
- [x] Phase 4: HTTP routes, worker BullMQ y SSE (11/11 plans) — completed 2026-09-18 — La API expone connect/discover en background y el estado llega a tiempo real sin polling.
- [x] Phase 5: UI web (46/46 plans) — completed 2026-09-21 — El flujo login → Servers → add → connect → discovery → detail funciona en el design system Apple-inspired, dark y light.
- [x] Phase 6: Instalador y Docker Compose (15/15 plans) — completed 2026-09-22 — Un comando deja Noodara operativo en un VPS Ubuntu limpio, de forma idempotente.

Full phase details, plans and success criteria: [milestones/v0.1-ROADMAP.md](milestones/v0.1-ROADMAP.md).
</details>

### v0.2 Projects & Services (Phases 7-14)

**Overview.** v0.2 son dos milestones con un solo número. La primera mitad es superficie de producto, en el orden que decidió el usuario para que cada pantalla nueva nazca con la estética definitiva: identidad → rediseño de la app según `docs/ui-build-prompt.md` → settings editables → sitio de docs y landing públicos. La segunda mitad es el primer motor de deploy real: Project → Environment → Service, deploy desde Git/Dockerfile/imagen sobre el servidor conectado en v0.1, logs de build en vivo, estado real del contenedor, cancelación con limpieza y cero recursos huérfanos. El motor se construye de adentro hacia afuera igual que v0.1 (dominio + esquema + primitivas + fixture → cola/worker/API/SSE → UI + E2E) y sus dos fases de backend (11 y 12) no comparten archivos con las fases de superficie (8-10), así que pueden ejecutarse intercaladas sin cambiar el orden en que las features **se cierran**. El hardening y el gate de release cierran último, como siempre.

**Phase Numbering:**

- Integer phases (7, 8, 9…): Planned milestone work; la numeración continúa desde v0.1
- Decimal phases (8.1, 8.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 7: Identidad y brand kit** - Logotipo (monograma + wordmark), favicon y hoja de marca en ambos temas, aplicados en app y README tras aprobación humana.
- [ ] **Phase 8: Rediseño de la app** - Elevación flotante, movimiento con propósito, momentos autorados, fallbacks de accesibilidad y el shell preparado para inspector, jerarquía y menú de cuenta; primera revisión visual humana.
- [ ] **Phase 9: Settings editables** - Perfil del admin (nombre, email, password), tema y preferencias visuales persistidas en el servidor sin parpadeo.
- [ ] **Phase 10: Sitio de docs y landing pública** - `apps/site` estático con Fumadocs, landing honesta con la identidad, publicado a GitHub Pages desde CI con test de exactitud.
- [ ] **Phase 11: Motor de deploy — fundamentos** - Spikes resueltos, dominio y esquema de Project/Environment/Service/Deployment, plantillas parametrizadas, exec en streaming, fixture sshd+dockerd y fixtures oficiales.
- [ ] **Phase 12: Motor de deploy — runtime** - Cola, worker, cancelación con kill confirmado, limpieza en toda salida, reconciliación, API y SSE; 20 deploys y 20 ciclos sin huérfanos.
- [ ] **Phase 13: UI de Projects & Services y E2E de deploy** - Jerarquía, creación de servicio, deploy narrado, logs en vivo en el inspector y el E2E crítico contra fixtures reales.
- [ ] **Phase 14: Hardening y gate de release v0.2** - Rotación de logs, poda de backups, imagen < 600 MB, `check-posix-sh` sin falsos positivos, deuda humana de v0.1 cerrada, `v0.2.0`.

## Decisions carried from research

Decisiones de `research/SUMMARY.md` (D1-D27) ya aceptadas en `REQUIREMENTS.md`. Los planners de cada fase las aplican; no se reabren sin una razón nueva registrada en PROJECT.md.

| Decisión | Qué fija | Fase que la aplica |
|---|---|---|
| **D2 — GitHub Pages** | Un solo `apps/site` (landing en `/`, Fumadocs en `/docs`), exportación estática, publicado desde `public-site.yml` a GitHub Pages en cada push a `main`; dominio por CNAME. Sin Vercel/Cloudflare (SITE-02 sustituye la recomendación original del SUMMARY). | 10 |
| **D3 — Reconciliación por poll en el servidor, eventos en el cliente** | Un `docker ps --format json` por servidor conectado por tick (job repetible, intervalo por env); SSE `service.updated` solo si algo cambió; polls cortos con backoff de `docker inspect` justo después de `docker start`; la UI nunca hace polling; `docker events` rechazado (no hay canal SSH de larga vida). | 12, 13 |
| **D4 — Siete estados de Deployment** | `QUEUED PREPARING BUILDING DEPLOYING SUCCESS FAILED CANCELLED` en `packages/domain`, columnas de v0.3 nullable desde ya; v0.3 solo añade estados. | 11 |
| **D5 — Status de servicio derivado** | `deriveServiceStatus()` función pura + columna cacheada; `UNKNOWN` distinto de `STOPPED`; nunca una segunda FSM ni un valor a mano. | 11, 12 |
| **D6/D7 — Git privado y registry privado en alcance** | Deploy key SSH generada por Noodara (primaria) o token HTTPS vía askpass leyendo un archivo mode-600 remoto; credencial de registry como fila `Credential` cifrada y `docker login --password-stdin`. Nunca en argv, URL, env-over-SSH (`AcceptEnv`), logs, `docker inspect`/`history`, `.git/config`. Mecanismo de transferencia = spike G1. | 11 (G1), 12 |
| **D8 — Logs de runtime bajo demanda** | `docker logs --tail N --timestamps` + follow con duración máxima; no se persisten; `--log-opt max-size/max-file` en `docker create`. Solo los logs de build van a `deployment_log_chunks`. | 12 |
| **D9 — `target` opcional** | Campo opcional; sin `target`, el default de Docker (última etapa); sin fail-fast. | 12 |
| **D10 — Puerto publicado opcional** | `publishedPort` nullable, apagado por defecto; preflight contra `docker ps` real → `PORT_IN_USE`; acceso en v0.2 solo por puerto, sin dominios. | 12 |
| **D11/D12 — Red y retención de imagen** | `noodara-net-<serviceId>` por servicio, eliminada con el servicio; imagen `noodara/<serviceId>:<deploymentId>` por intento, la superada se elimina tras arrancar el nuevo contenedor, las de builds fallidos en cleanup; política global de poda de build cache se define en la Fase 14. | 12, 14 |
| **D13 — Sin build args ni env vars** | Ni `--build-arg` ni `--env` en v0.2 (v0.4); el modelo no expone campos; UI y docs lo dicen sin placeholders ("bake config into the image"). | 11, 10, 13 |
| **D14 — Clone superficial, sin LFS ni submodules** | `git clone --depth 1 --branch <ref>`, SHA capturado; punteros LFS y `.gitmodules` → `UNSUPPORTED_REPOSITORY_FEATURE`; ninguna lógica asume historial. | 11, 12 |
| **D15/D16/D17/D18 — Timeouts, concurrencia, cancel, crash** | `NOODARA_DEPLOY_MAX_MS` + `NOODARA_DEPLOY_IDLE_MS` (`BUILD_TIMEOUT` vs `BUILD_STALLED`, lock de BullMQ derivado del máximo); `jobId = deploy-<deploymentId>` + índice parcial único → 409 `DEPLOYMENT_IN_PROGRESS`; cancel = flag Redis → kill remoto allowlisted → confirmación → destruir canal → limpieza → `CANCELLED`, solo el worker transiciona; barrido de arranque → `FAILED/WORKER_CRASHED` que limpia recursos por-deployment y nunca el contenedor por-servicio. | 11 (G2), 12 |
| **D19 — `motion` acotado al Sheet** | `motion@13.4.1` con `LazyMotion`, solo en el `Sheet` de `packages/ui`; todo lo demás CSS según brief §5.3. | 8 |
| **D20/D21 — Settings en el servidor con espejo de primer pintado** | Preferencias en la fila del usuario + espejo local pre-hidratación por el único write path que posee `ThemeToggle`; cambio de password revoca las demás sesiones con evento sin metadata sensible. | 9 |
| **D22/D23 — Superficie SSE y `kind` de environment** | Solo `service.updated`, `service.deleted`, `deployment.updated`, `deployment.log_chunk`; sin `project.*`/`environment.*` (refetch). Environment `kind` texto libre con sugerencias, no enum. | 11, 12 |
| **D24/D25 — Semántica destructiva** | Proyecto: archivar (reversible) → eliminar solo archivado escribiendo el nombre exacto, cascada de environments/servicios/deployments/logs/credenciales; servidor con servicios → 409 nombrando los servicios; servicio: eliminar escribiendo el nombre detiene y elimina contenedor, red, imágenes propias y workspace. | 12, 13 |
| **D26/D27 — Boundaries y guía** | `packages/git`/`packages/docker` bajo el tag `ssh-adapter` existente; boundary test para `apps/site`; `CLAUDE.md` §3.1/§4 se actualizan (`apps/site`, `DeploymentLogChunk`) — el usuario edita `CLAUDE.md`, fuera del alcance de los planes. | 10, 11 |

## Phase Details

### Phase 7: Identidad y brand kit

**Goal**: Noodara tiene un logotipo propio con significado, documentado en un brand kit, que un humano ha visto renderizado en ambos temas y ha aprobado antes de que se aplique en la app, el README y — vía assets exportados — en el sitio público de la Fase 10.
**Depends on**: Nothing (primera fase de v0.2; v0.1 entregado)
**Requirements**: BRAND-01, BRAND-02, BRAND-03
**Research flag**: none — trabajo de diseño contra la biblioteca de referencias local y la skill `noodara-ux-apple`; la marca obedece las mismas prohibiciones del brief §9 (un solo color de acción, sin gradientes, sin glow).
**Success Criteria** (what must be TRUE):

  1. Existe `docs/brand/` con el monograma y el wordmark en SVG, en variantes para tema claro y oscuro, y una hoja de brand kit (significado, construcción, área de protección, usos prohibidos, paleta y tipografía) con la que una persona reproduce el logo correctamente sin preguntar.
  2. El usuario ha visto screenshots del logotipo renderizado en ambos temas (en la app y en el README) y lo ha aprobado explícitamente antes de que se aplique en todas las superficies; la aprobación queda registrada.
  3. El logotipo aparece en el sidebar/rail, `/login`, `/setup`, favicon y `apple-touch-icon` en ambos temas y en el README; el gate de tokens sigue verde (cero literales de color fuera de `tokens.css`) y los 93 E2E existentes siguen verdes.
  4. Los assets de marca (SVGs, favicon set, imagen OG) quedan exportados desde `packages/ui` para que la Fase 10 los consuma sin copiar archivos.

**Plans**: TBD
**UI hint**: yes

### Phase 8: Rediseño de la app

**Goal**: La app existente (setup, login, servers, detalle, activity, settings) se siente como un producto Apple-grade — elevación flotante, materiales, movimiento con propósito, momentos autorados — sin perder ninguna de las prohibiciones del brief, con fallbacks de accesibilidad intencionales, y con el shell ya preparado para el tercer panel, la navegación jerárquica y el menú de cuenta que las fases 9 y 13 llenan; por primera vez un humano mira cada pantalla renderizada antes de cerrarla.
**Depends on**: Phase 7 (logo en el shell y en login/setup)
**Requirements**: UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, UI-11, UI-12
**Research flag**: light — una verificación Context7 de la API de drag/`useSpring` de `motion` contra los comportamientos del brief §7.4; el resto está especificado por `docs/ui-build-prompt.md` (§8 P0 → P1 → P2, §10 DoD).
**Success Criteria** (what must be TRUE):

  1. `Sheet`, `Dialog` y `RowMenu` flotan con `--shadow-floating` (y escalón de superficie más claro en oscuro); un gate automatizado falla si cualquier otro componente recibe sombra; `RowMenu` cierra al seleccionar, devuelve el foco al trigger, es visible en táctil y anuncia `aria-expanded` — verificado con un lector de pantalla real.
  2. El `Sheet` se cierra arrastrando con la secuencia completa del brief §7.4 (pointer capture, offset de agarre, tracking 1:1, rubber-banding, signo de velocidad, proyección de momentum, handoff, interrumpible) con `motion` acotado a ese componente; todo control presionable da feedback `scale(0.97)`; las curvas y duraciones de §6 sustituyen a los easings built-in; el toolbar usa scroll edge effect; `RowMenu`/`Tooltip` escalan desde el trigger y `Dialog` desde el centro; `Disclosure` anima con `grid-template-rows`; checks de discovery y filas entran con stagger de 40 ms; ninguna acción iniciada por teclado se anima.
  3. La narración del discovery y el bloque de fingerprint/TOFU pasan el test de intercambio de marca como momentos autorados (uno por pantalla); el craft de superficie está presente (numerales tabulares, `text-wrap`, medida 65-75, `::selection`/`caret-color`/scrollbars/`text-underline-offset` tematizados, puente de blur skeleton → contenido, `@starting-style`, medidor de disco con `clip-path`).
  4. `prefers-reduced-motion`, `prefers-reduced-transparency` y `prefers-contrast: more` tienen alternativas intencionales en toolbar, sheet, dialog y menú; el hover se gatea con `(hover: hover) and (pointer: fine)`; nunca hay más de tres `backdrop-filter` simultáneos (contado en el peor caso: toolbar + Sheet + RowMenu + Tooltip).
  5. El shell tiene el slot del inspector, la navegación jerárquica y el menú de cuenta previstos sin placeholders visibles (hoy poblados con Servers/Activity/Settings); cada pantalla rediseñada tiene contraste medido (≥4.5:1 cuerpo, ≥3:1 texto grande y bordes únicos), se probó a 375/900/1280/1920 px con contenido real, y el usuario aprobó screenshots en ambos temas; los 93 E2E existentes siguen verdes y el nightly 20x también.

**Plans**: TBD
**UI hint**: yes

### Phase 9: Settings editables

**Goal**: El admin gestiona su propia cuenta y su experiencia visual desde Settings — nombre, email, password, tema y preferencias — con persistencia en el servidor que sobrevive a navegadores y recargas sin parpadeo, y sin que ninguna fila derivada del entorno pueda volverse editable por accidente.
**Depends on**: Phase 8 (componentes rediseñados y el menú de cuenta del shell)
**Requirements**: SET-02, SET-03, SET-04, SET-05, SET-06
**Research flag**: light — verificar con Context7 las formas de `changePassword`/`changeEmail`/`revokeOtherSessions` de Better Auth durante la planificación; el resto es CRUD estándar sobre los patrones de v0.1 (D20, D21; pitfall P17: el nuevo control de tema llama al único write path de `ThemeToggle`).
**Success Criteria** (what must be TRUE):

  1. El admin edita su nombre y su email desde Settings con validación del dominio y confirmación por contraseña actual; el cambio se refleja en el menú de cuenta y queda en el activity log sin metadata sensible.
  2. El admin cambia su contraseña bajo la política de v0.1 (12-128 caracteres, lista de comunes) y todas las demás sesiones quedan revocadas: una segunda pestaña o navegador es redirigido a login en el siguiente heartbeat.
  3. El tema auto/claro/oscuro se persiste en el servidor con espejo local para el primer pintado: al recargar no hay parpadeo, el override manual gana sobre el SO y la preferencia aparece igual en otro navegador tras iniciar sesión.
  4. Reducir movimiento y densidad compacta/cómoda se persisten del mismo modo y se respetan en toda la app (el `Sheet` cae al fallback sin gesto, las filas cambian de altura).
  5. Las filas de Settings que provienen de variables de entorno siguen siendo de solo lectura y lo dicen; el tipo de `SettingsRow` impide añadirles un handler de edición (test de tipo `@ts-expect-error`).

**Plans**: TBD
**UI hint**: yes

### Phase 10: Sitio de docs y landing pública

**Goal**: Cualquier persona que llega a Noodara desde fuera encuentra una landing honesta con la identidad y una documentación pública (instalación, conceptos, primer deploy, límites de v0.2, upgrade/rollback) que se publica sola desde CI, que nunca miente sobre comandos, variables ni códigos de error, y que cumple el mismo piso de calidad que la app.
**Depends on**: Phase 7 (identidad y assets), Phase 8 (tokens finales y screenshots reales de la app rediseñada); Phase 11 solo para la mitad de códigos de error de DOCS-02 (el test lee las tablas de clasificación reales), que puede añadirse cuando la Fase 11 cierre si esta fase la precede en el calendario.
**Requirements**: DOCS-01, DOCS-02, SITE-01, SITE-02, SITE-03
**Research flag**: yes, light — Fumadocs 16 + Next 16 + Tailwind v4 compartiendo tokens con `packages/ui`, restricciones de exportación estática (búsqueda Orama en modo estático) y GitHub Pages con CNAME (D1, D2).
**Success Criteria** (what must be TRUE):

  1. `apps/site` (Next 16 + Fumadocs) exporta estáticamente con la landing en `/` y los docs en `/docs`: instalación con el mismo comando y la misma tabla de exit codes que `docs/install.md`, conceptos (servidor, proyecto, environment, servicio, deployment), guía de primer deploy, límites de v0.2 dichos sin "coming soon" (sin env vars, sin dominios, "bake config into the image") y actualización/rollback.
  2. Un test de exactitud falla si un comando, variable, exit code o código de error documentado deja de coincidir con `install.sh` o con el vocabulario de errores real, al estilo de `install-docs-accuracy.test.ts`; un boundary test impide importar `apps/control-plane` o `@noodara/domain` desde el sitio.
  3. La landing presenta el producto con su identidad, screenshots reales de la app rediseñada, el comando de instalación y enlaces a docs y GitHub; solo afirma capacidades entregadas (test que contrasta las afirmaciones con el Out of Scope de PROJECT.md); sin imágenes ni fuentes de terceros sin self-hosting; metadatos SEO básicos y Open Graph presentes.
  4. Cada push a `main` publica el sitio a GitHub Pages vía `public-site.yml`; el dominio se cambia solo con el archivo CNAME; el build del sitio es un gate del PR; el sitio nunca entra en `docker-compose.yml` ni en `release.yml`.
  5. El sitio cumple contraste medido, tipografía, ambos temas y `prefers-reduced-motion`, y el usuario aprobó screenshots en ambos temas.

**Plans**: TBD
**UI hint**: yes

### Phase 11: Motor de deploy — fundamentos

**Goal**: Todo lo que el motor necesita para construirse RED-first existe y está probado contra infraestructura real antes de escribir el primer job: los cuatro spikes resueltos con evidencia, el dominio puro de Project/Environment/Service/Deployment con su state machine y validadores, el esquema con la propiedad garantizada por la base de datos, las plantillas parametrizadas de la allowlist, el exec en streaming, los paquetes `git`/`docker`, el fixture sshd+dockerd y los tres fixtures oficiales.
**Depends on**: Nothing de v0.2 (parte de la base de v0.1); backend-only y disjunta en archivos de las fases 8-10, puede ejecutarse intercalada con ellas
**Requirements**: DEP-01, DEP-08, SVC-08, PROJ-04, QA-07, QA-10
**Research flag**: **yes — la única fase de research real del milestone.** Los cuatro spikes de QA-10 se resuelven y se registran como contratos empíricos estilo ADR-0004 antes de escribir los planes que dependen de ellos: G1 transferencia de secretos al remoto sin argv (stdin a `umask 077 && cat > <path validado>` vs. SFTP), G2 kill remoto confirmado (`channel.signal()` en OpenSSH 8.9/9.6 vs. `setsid` + pidfile + `kill -- -pgid` vs. `docker kill` del contenedor BuildKit), G3 BuildKit activo en el Docker del repositorio apt que provisiona `install.sh` (añadir a discovery, no inferir), G4 estabilidad de campos de `docker ps --format '{{json .}}'` en 22.04/24.04. También: G7 (fixtures desde GHCR o registry local, no Docker Hub anónimo en CI).
**Success Criteria** (what must be TRUE):

  1. Los cuatro spikes están resueltos con evidencia medida contra el fixture real y registrados como ADR (G1 mecanismo de transferencia de secretos, G2 kill remoto con el proceso confirmado ausente en `ps`, G3 BuildKit detectado por discovery, G4 parser de `docker ps` probado contra capturas reales de ambas versiones de Ubuntu) antes de que exista ningún plan de la Fase 12.
  2. `packages/domain` tiene la state machine de Deployment con siete estados (`QUEUED → PREPARING → BUILDING → DEPLOYING → SUCCESS | FAILED | CANCELLED`) con tabla de transiciones exhaustiva ≥95% statement/branch, `deriveServiceStatus` como función pura, y validadores con tipos branded para URL de repositorio, rama, contexto/ruta de Dockerfile, `target`, referencia de imagen (tag o digest explícito, nunca `:latest` implícito), nombre de contenedor, red y workspace; un valor con caracteres de shell, `..`, saltos de línea o esquemas no permitidos se rechaza con un error nombrado antes de tocar el servidor; punteros LFS y `.gitmodules` producen `UNSUPPORTED_REPOSITORY_FEATURE`; el modelo no expone campos de build args ni env vars.
  3. La migración 0004 crea `projects`, `environments`, `services`, `deployments` y `deployment_log_chunks`; insertar un servicio cuyo environment pertenece a otro proyecto falla en la base de datos (FK compuesta), un segundo deployment no terminal del mismo servicio viola el índice parcial único, y las migraciones aplican limpio desde cero y desde el snapshot 0003.
  4. La allowlist de `packages/ssh` crece solo con plantillas cerradas parametrizadas (`git.clone`, `git.checkout`, `docker.build/pull/login/create/start/stop/restart/remove/inspect/logs/ps`, `fs.remove_deploy_dir`, kill remoto) cuyos argumentos pasan por validador de dominio y `escapeShellArg` (`--` antes de posicionales, guard de exactitud actualizado); el exec en streaming entrega salida en chunks redactados por chunk, acotados en bytes, abortables y con stdin, con `classifyGitError`/`classifyDockerError` como tablas congeladas que nunca lanzan; `packages/git` y `packages/docker` existen bajo el tag `ssh-adapter`.
  5. Existe la imagen combinada sshd+dockerd de Testcontainers (22.04 y 24.04) con un repositorio Git bare accesible por SSH y deploy keys generadas por corrida, que ejerce un pull real desde registry y la autenticación de registry; existen `fixtures/node-api`, `fixtures/static-app` y `fixtures/failing-build` con `.dockerignore` y contexto de build < 1 MiB asertado; ningún recurso `noodara.test=true` sobrevive a una corrida.

**Plans**: TBD

### Phase 12: Motor de deploy — runtime

**Goal**: A través de la API, una persona crea proyecto → environment → servicio (Git, Dockerfile o imagen, público o privado) sobre un servidor conectado y lo despliega en el worker con logs de build en vivo, estado real del contenedor, cancelación que mata el proceso remoto, limpieza en toda ruta de salida y reconciliación honesta — y 20 deploys y 20 ciclos crear/eliminar no dejan nada huérfano. La UI llega en la Fase 13; esta fase cierra todo al nivel de servicios, cola, rutas y SSE, probado contra el fixture real.
**Depends on**: Phase 11; backend-only, puede ejecutarse intercalada con las fases 8-10
**Requirements**: PROJ-01, PROJ-02, PROJ-03, PROJ-05, SVC-01, SVC-02, SVC-03, SVC-04, SVC-05, SVC-06, SVC-07, DEP-02, DEP-03, DEP-04, DEP-05, DEP-06, DEP-07, DEP-09, LOG-01, LOG-02, LOG-03, REC-01, REC-03, QA-08
**Research flag**: no — cada patrón tiene un archivo precedente en v0.1 que los planes deben citar: `connect-server-queue`/`worker.ts`, `sse-broadcaster.ts`, `write-activity-event.ts`, `failInFlightConnection`, `delete-server.ts`, `createServerServices`, `canary-http.test.ts`. Los números de la tabla "Numbers That Are Reasoned Defaults" del SUMMARY (flush 250 ms/16 KB, 10 MiB por fase, 16 KB por línea, reconcile 30 s, max 60 min, idle 5 min, concurrencia 1, `--log-opt 10m/3`, tail 1000, follow 10 min, 5 polls post-start) son knobs con validación de rango en `env.ts` y `passThroughEnv`, y se **miden** durante la fase (QA-10, segunda mitad).
**Success Criteria** (what must be TRUE):

  1. Vía API se crea un proyecto (nombre único, slug, descripción), sus environments (sugeridos `production`/`staging`/`development`, cualquier nombre válido, único por proyecto) y servicios desde Git (URL, rama, contexto, Dockerfile, `target` opcional, puerto interno), desde imagen (tag o digest) y desde repositorio o registry privados (deploy key mostrada para registrarla, token HTTPS o credencial de registry, cifradas at-rest y eliminadas con el servicio), solo sobre servidores `CONNECTED` con Docker del mismo proyecto; ninguna ruta acepta un id de otro proyecto; un servidor con servicios no puede eliminarse y el error nombra los servicios; archivar bloquea deploys y solo un proyecto archivado se elimina escribiendo su nombre, con cascada de environments, servicios, deployments, logs y credenciales.
  2. `POST /api/services/:id/deploy` responde de inmediato y el worker clona `--depth 1` en `/opt/noodara-deploy/<deploymentId>` (SHA capturado), construye `noodara/<serviceId>:<deploymentId>`, y arranca `noodara-<serviceId>` en `noodara-net-<serviceId>` con puerto publicado opcional (colisiones con otros servicios, el panel y `docker ps` real → `PORT_IN_USE`), con timeouts máximo e idle distinguidos (`BUILD_TIMEOUT` vs `BUILD_STALLED`); el deployment termina `SUCCESS` con el contenedor en ejecución y el status del servicio se deriva (`running`/`stopped`/`deploying`/`failed`/`never_deployed`); un segundo deploy con uno activo responde 409 `DEPLOYMENT_IN_PROGRESS`; redeploy, stop, restart y remove son jobs con timeout registrados en el activity log.
  3. Un build fallido con `failing-build` deja el contenedor anterior intacto y el deployment `FAILED` con un código del vocabulario cerrado y mensaje accionable, nunca texto crudo; cancelar un deployment en cola nunca lo ejecuta y cancelar uno en curso deja el proceso remoto confirmado ausente y termina `CANCELLED`; en ambos casos y en timeout y caída del worker (barrido de arranque → `FAILED/WORKER_CRASHED`) no queda contenedor, imagen parcial, red ni workspace, y `docker system df` no cambia.
  4. Los logs de build llegan por SSE como `deployment.log_chunk` (redactados por chunk, flush por tiempo/tamaño, tope por línea y por fase) y persisten como chunks append-only con `since=<seq>` para resync sin replay y retención configurable; los logs de runtime se sirven bajo demanda (`tail` de N líneas, follow acotado en tiempo, ANSI y binario saneados) sin persistirse; el tick de reconciliación hace un `docker ps` por servidor, actualiza el estado real, emite `service.updated` solo cuando cambia y registra en el activity log un contenedor detenido o eliminado fuera de Noodara.
  5. Contra el fixture sshd+dockerd, 20 deployments consecutivos de `node-api` completan y 20 ciclos crear/eliminar de servicio dejan `docker system df` estable (dos corridas seguidas, sin prune manual) en la suite de integración y en `nightly.yml`; `pnpm security:scan-leaks` cubre token en URL de git, deploy key, credencial de registry y un build que imprime un canary, asertando ausencia en logs, `deployment_log_chunks`, SSE, `activity_events.metadata`, respuestas de API, `docker inspect`, `docker history` y `.git/config` remoto; los números medidos quedan registrados en la verificación de la fase.

**Plans**: TBD

### Phase 13: UI de Projects & Services y E2E de deploy

**Goal**: Las dos pistas se unen: el shell rediseñado de la Fase 8 recibe datos reales de Project → Environment → Service y la API de la Fase 12 recibe su cliente. Una persona crea proyecto, environment y servicio desde la UI, lo despliega viendo el build narrado paso a paso y los logs en vivo en el inspector, ve el estado real del contenedor y recupera de un fallo con una pista accionable — y el E2E crítico del roadmap §7.8 lo prueba contra fixtures reales.
**Depends on**: Phase 8 (lenguaje visual final, nav jerárquica, slot del inspector, `RowMenu` arreglado), Phase 12 (API, SSE, fixtures)
**Requirements**: LOG-04, REC-02, QA-09 — y cierra en la UI lo que la Fase 12 entregó por API: PROJ-01..03, SVC-01, SVC-02, SVC-05, SVC-06, SVC-07, DEP-03, DEP-04, DEP-07, DEP-08 (la UI lo dice), LOG-03, verificados end-to-end por QA-09
**Research flag**: no — Next.js 16 parallel routes (`@inspector`) documentadas y fijadas; una verificación Context7 de las convenciones de `@slot` durante la planificación basta. Pitfalls: P5 lado cliente (función pura de reconciliación por `seq`/`updatedAt`), brief §9 #17 (nunca texto crudo), #18 (nombre exacto), #19 (sin placeholders).
**Success Criteria** (what must be TRUE):

  1. Desde la UI el usuario crea un proyecto, un environment (nombres sugeridos, cualquiera válido) y un servicio con control segmentado de tipo de fuente (Git / Dockerfile / imagen), picker de servidor limitado a `CONNECTED` con Docker, credencial de repo o registry privado sin mostrar nunca el secreto, sin campos de env vars ni build args y con el límite dicho en la pantalla; la navegación jerárquica Project → Environment → Service vive en el shell de la Fase 8 con Servers/Activity/Settings como pares, y los estados vacíos enseñan la jerarquía.
  2. La vista del servicio muestra el status derivado (con `UNKNOWN` mostrado honestamente), una única acción primaria Deploy, el historial de deployments, y cada deploy narra clonar → construir → arrancar → verificar con duración y estado por paso reutilizando el tratamiento de la narración del discovery; un fallo muestra el error clasificado con su recuperación, nunca texto crudo del servidor.
  3. Los logs de build aparecen en vivo en el panel inspector (monoespaciada, auto-scroll con "jump to bottom", no modal) plegando los chunks SSE por `seq` sobre un snapshot GET sin replay; los logs de runtime se ven bajo demanda con tail y follow; los eventos de estado se aplican con la misma función pura de reconciliación por secuencia que v0.1 usa para servidores, probada con reordenamientos para que un evento y un snapshot en vuelo nunca dejen estado obsoleto.
  4. Redeploy, stop, restart, remove, cancelar, archivar/eliminar proyecto, eliminar environment y eliminar servicio están disponibles desde la UI; cada acción destructiva exige escribir el nombre exacto y el cambio de fuente avisa que exige redeploy.
  5. El E2E de Playwright cubre proyecto → environment → servicio desde `node-api` → deploy con logs en vivo → servicio alcanzable por el puerto publicado → build fallido con `failing-build` y error accionable → cancelación en curso sin huérfanos → propiedad entre proyectos, corre en CI y 20/20 en nightly; cada pantalla nueva cumple el DoD de UI (contraste medido, 375/900/1280/1920 px, ambos temas, reduced-motion) y el usuario aprobó screenshots en ambos temas.

**Plans**: TBD
**UI hint**: yes

### Phase 14: Hardening y gate de release v0.2

**Goal**: Los operadores de v0.1 dejan de pagar la deuda que se les debía (logs que crecen sin límite, backups de `.env` que se acumulan, una imagen de 1.2 GB, falsos positivos en el scanner POSIX), la deuda de verificación humana de v0.1 queda cerrada con evidencia real, y el gate de v0.2 se corre contra roadmap §7.8 en un VPS real antes de publicar `v0.2.0`.
**Depends on**: Phases 7-13 (el gate siempre acumula todas las fases del milestone)
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04
**Research flag**: light — técnicas de reducción de la imagen del control plane (multi-stage + `pnpm deploy --prod`) pueden merecer una verificación Context7 corta; el resto es la práctica de la skill `noodara-release-gate` y la checklist "Looks done but isn't" de PITFALLS.
**Success Criteria** (what must be TRUE):

  1. Los seis servicios del `docker-compose.yml` de producción rotan logs (`logging` con `max-size`/`max-file`) y una re-ejecución del instalador poda los `.env.bak-*` dejando los N más recientes; ambos con tests (Compose validado y suite del instalador).
  2. La imagen `noodara-control-plane` pesa menos de 600 MB y los cuatro entrypoints (`api`, `worker`, `migrate`, CLI) siguen arrancando desde `dist`, verificado por el test de imagen existente.
  3. `check-posix-sh` reconoce `$(( ))`, `[[:space:]]`, `$'` en comentarios y `((` en heredocs sin falsos positivos, los workarounds de `install.sh` se retiran y el scanner tiene tests de regresión para cada caso.
  4. La deuda humana de v0.1 está cerrada con evidencia registrada: instalación real en Ubuntu 22.04, en arm64 y con `ufw` activo; un upgrade real entre dos releases publicadas (`v0.1.0` → `v0.2.0`) y su rollback; memoria observada en un VPS de 1-2 GB; nightly real verde.
  5. `docs/releases/v0.2-gate.md` está READY contra los criterios de roadmap §7.8 en un VPS real (connect → project → environment → deploy desde `node-api` → logs → estado → fallo → cancel), con la tabla de números medidos de QA-10 y la política de poda de build cache (D12) registradas; `v0.2.0` publicado con imágenes multi-arch y el sitio público actualizado.

**Plans**: TBD

**Cross-cutting constraints (v0.2):**

- TDD RED → GREEN → REFACTOR en toda tarea con lógica; los componentes visuales se verifican con tests de componente escritos antes (ADR-0005); nada visual se cierra sin que un humano vea la pantalla renderizada (brief §10).
- `packages/domain` sigue puro y ≥95% statement/branch; `ssh2` solo desde `packages/ssh`; `packages/git`/`packages/docker` bajo `ssh-adapter`; `apps/site` sin imports del control plane.
- Toda dependencia nueva (`motion`, `fumadocs-*`) pasa por `scripts/check-package-provenance.mjs` antes de instalarse.
- Ningún secreto en argv, URL, env-over-SSH, logs, `docker inspect`/`history`, `.git/config`, respuestas de API, SSE ni activity metadata; cada chunk de log pasa por el Redactor antes de persistir o difundir.
- `pnpm test`, `pnpm test:integration`, `pnpm test:boot`, `pnpm test:e2e`, `pnpm security:scan-leaks`, `pnpm check:ui-safety`, `pnpm typecheck`, `pnpm lint` y `pnpm boundaries` en verde antes de verificar cada fase; los 93 E2E de v0.1 no se rompen en ninguna fase.

## Progress

**Execution Order:**
Las features cierran en orden 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14. Las fases 11 y 12 son backend-only y disjuntas en archivos de 8-10, así que pueden ejecutarse intercaladas con ellas si el wall-clock importa; la 13 espera a 8 y 12; la 14 espera a todas.

| Milestone | Phases | Plans | Status | Shipped |
|---|---|---|---|---|
| v0.1 Foundation | 6 | 109/109 | Complete | 2026-09-22 |
| v0.2 Projects & Services | 8 | 0/TBD | In progress | |

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 7. Identidad y brand kit | 0/TBD | Not started | - |
| 8. Rediseño de la app | 0/TBD | Not started | - |
| 9. Settings editables | 0/TBD | Not started | - |
| 10. Sitio de docs y landing pública | 0/TBD | Not started | - |
| 11. Motor de deploy — fundamentos | 0/TBD | Not started | - |
| 12. Motor de deploy — runtime | 0/TBD | Not started | - |
| 13. UI de Projects & Services y E2E de deploy | 0/TBD | Not started | - |
| 14. Hardening y gate de release v0.2 | 0/TBD | Not started | - |
