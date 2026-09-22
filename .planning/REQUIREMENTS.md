# Requirements: Noodara — v0.2 Projects & Services

**Defined:** 2026-09-22
**Core Value:** Noodara puede conocer, registrar y comunicarse con infraestructura real de forma segura y consistente — y ahora también desplegar sobre ella — sin fugas de credenciales, sin estados falsos y sin caídas por fallos del servidor remoto. Y debe enamorar al verla.

Fuentes: `PROJECT.md` (Current Milestone v0.2), `docs/roadmap-v0.1-v0.5.md` §7, `.planning/research/SUMMARY.md` (decisiones D1–D27), `docs/ui-build-prompt.md` (brief de UI). Los requisitos de v0.1 archivados en `milestones/v0.1-REQUIREMENTS.md`; la numeración de las categorías que ya existían (UI, SET, QA) continúa.

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Identidad (BRAND)

- [ ] **BRAND-01**: Noodara tiene un logotipo (monograma + wordmark) con significado documentado, entregado como SVG en variantes para tema claro y oscuro, y una hoja de brand kit (construcción, área de protección, usos prohibidos, paleta y tipografía) en `docs/brand/`.
- [ ] **BRAND-02**: El logotipo se aplica en la app (sidebar/rail, `/login`, `/setup`, favicon y `apple-touch-icon`), en el README y en el sitio público, en ambos temas, sin literales de color fuera de los tokens.
- [ ] **BRAND-03**: El usuario revisa el logotipo renderizado (screenshots en ambos temas, en la app y en el README) y lo aprueba antes de que se aplique en todas las superficies.

### Rediseño de la app (UI)

- [ ] **UI-03**: `Sheet`, `Dialog` y `RowMenu` tienen el nivel de elevación flotante (`--shadow-floating`, con escalón de superficie más claro en oscuro); ningún otro componente recibe sombra (gate automatizado).
- [ ] **UI-04**: `RowMenu` cierra al seleccionar, devuelve el foco al trigger, es visible en dispositivos táctiles y anuncia su estado abierto/cerrado a lectores de pantalla.
- [ ] **UI-05**: Todo control presionable da feedback en el press (`scale(0.97)`, 160 ms, `--ease-out`); las curvas de easing custom y la tabla de duraciones del brief §6 sustituyen a los easings built-in en todo el inventario; ninguna acción iniciada por teclado se anima.
- [ ] **UI-06**: El `Sheet` se cierra arrastrando con la secuencia completa del brief §7.4 (pointer capture, offset de agarre, tracking 1:1, rubber-banding, decisión por signo de velocidad, proyección de momentum, handoff de velocidad, interrumpible), con `motion` acotado a ese componente.
- [ ] **UI-07**: El toolbar usa scroll edge effect en lugar del borde permanente; `RowMenu` y `Tooltip` escalan desde el origen del trigger; `Dialog` desde el centro; `Disclosure` anima con `grid-template-rows`; los checks de discovery y las filas de la lista entran con stagger de 40 ms sin bloquear la interacción.
- [ ] **UI-08**: Los momentos de firma del producto — la narración del discovery y el bloque de fingerprint/confianza (TOFU) — están tratados como momentos autorados (uno por pantalla), distinguibles de cualquier otro producto (test de intercambio de marca).
- [ ] **UI-09**: Craft de superficie: numerales tabulares en todo dato numérico, `text-wrap: balance/pretty`, medida de 65–75 caracteres en copy, `::selection`/`caret-color`/scrollbars/`text-underline-offset` tematizados, puente de blur en el crossfade skeleton → contenido, `@starting-style` en las entradas, medidor de disco revelado con `clip-path`.
- [ ] **UI-10**: `prefers-reduced-motion`, `prefers-reduced-transparency` y `prefers-contrast: more` tienen alternativas intencionales en toolbar, sheet, dialog y menú; el hover se gatea con `(hover: hover) and (pointer: fine)`; nunca más de tres `backdrop-filter` simultáneos.
- [ ] **UI-11**: El shell deja previstos, sin placeholders visibles, el tercer panel (inspector), la navegación jerárquica Project → Environment → Service y el menú de cuenta (avatar/nombre, perfil, apariencia, cerrar sesión), de forma que v0.2–v0.5 no exigen reescribirlo.
- [ ] **UI-12**: Cada pantalla rediseñada se verifica con contraste medido (≥4.5:1 cuerpo, ≥3:1 texto grande y bordes únicos), a 375/900/1280/1920 px con contenido real, y con screenshots en ambos temas revisados por un humano antes de cerrarse; los 93 E2E existentes siguen verdes.

### Settings editables (SET)

- [ ] **SET-02**: El admin puede editar su nombre y su email desde Settings, con validación del dominio y confirmación por contraseña actual.
- [ ] **SET-03**: El admin puede cambiar su contraseña (política de v0.1: 12–128 caracteres, lista de comunes) y el cambio revoca todas las demás sesiones activas.
- [ ] **SET-04**: El admin elige el tema (auto/claro/oscuro) y la preferencia se persiste en el servidor con espejo local para el primer pintado, sin parpadeo al recargar; el override manual siempre gana sobre el SO.
- [ ] **SET-05**: El admin ajusta preferencias visuales (reducir movimiento, densidad compacta/cómoda) que se persisten como la anterior y se respetan en toda la app.
- [ ] **SET-06**: Las filas de Settings que provienen de variables de entorno siguen siendo de solo lectura y lo dicen; el tipo de `SettingsRow` impide añadirles un handler de edición.

### Proyectos y environments (PROJ)

- [ ] **PROJ-01**: El usuario crea un proyecto con nombre único (slug derivado) y descripción opcional, lo edita y lo lista.
- [ ] **PROJ-02**: El usuario archiva un proyecto; un proyecto archivado no acepta nuevos deploys y solo un proyecto archivado puede eliminarse, escribiendo su nombre exacto; al eliminarlo se eliminan sus environments, servicios, deployments, logs y credenciales asociadas.
- [ ] **PROJ-03**: El usuario crea, edita y elimina environments dentro de un proyecto; `production`, `staging` y `development` se sugieren pero cualquier nombre válido se acepta; el nombre es único dentro del proyecto.
- [ ] **PROJ-04**: La propiedad es jerárquica y la garantiza la base de datos: un environment pertenece a un solo proyecto y un servicio a un solo environment; ninguna ruta acepta un id de otro proyecto.
- [ ] **PROJ-05**: Un servidor con servicios no puede eliminarse; el error nombra los servicios que lo bloquean.

### Servicios (SVC)

- [ ] **SVC-01**: El usuario crea un servicio desde un repositorio Git (URL, rama, contexto de build, ruta del Dockerfile, puerto interno) asignado a un servidor conectado del mismo proyecto.
- [ ] **SVC-02**: El usuario crea un servicio desde un Dockerfile del repositorio con `target` opcional, y desde una imagen Docker (referencia con tag o digest explícito, nunca `:latest` implícito).
- [ ] **SVC-03**: Un repositorio privado se autentica con una deploy key generada por Noodara (clave pública mostrada para registrarla en el proveedor) o con un token HTTPS; la credencial se cifra at-rest, nunca aparece en argv, URL, logs ni API, y se elimina con el servicio.
- [ ] **SVC-04**: Una imagen de un registry privado (GHCR, Docker Hub) se autentica con una credencial de registry cifrada, pasada al remoto por `--password-stdin`, nunca por argv ni logs.
- [ ] **SVC-05**: Cada servicio registra name, project, environment, server, source type, repository/image, branch, internal port, published port opcional, status, created_at y updated_at; el usuario lo edita (el cambio de fuente exige redeploy) y lo elimina escribiendo el nombre exacto, lo que detiene y elimina su contenedor, red, imágenes propias y workspace remoto.
- [ ] **SVC-06**: El usuario puede publicar opcionalmente un puerto del host para el servicio; la validación rechaza colisiones con otros servicios del mismo servidor, con el panel y con puertos en uso reales (`PORT_IN_USE`); por defecto no se publica nada.
- [ ] **SVC-07**: El estado mostrado de un servicio se deriva del estado real de su contenedor y de su último deployment (`running`, `stopped`, `deploying`, `failed`, `never_deployed`), nunca de un valor guardado a mano.
- [ ] **SVC-08**: Toda URL de repositorio, rama, ruta y referencia de imagen se valida en `packages/domain` contra un vocabulario cerrado y se pasa al shell remoto solo a través de plantillas de la allowlist con `escapeShellArg`; un valor con caracteres de shell, `..`, saltos de línea o esquemas no permitidos se rechaza con un error nombrado antes de tocar el servidor.

### Deployments y operaciones remotas (DEP)

- [ ] **DEP-01**: El usuario lanza un deploy manual; el deployment pasa por `QUEUED → PREPARING → BUILDING → DEPLOYING → SUCCESS | FAILED | CANCELLED`, definido en `packages/domain` con tabla de transiciones validada y forward-compatible con los estados de v0.3.
- [ ] **DEP-02**: El deploy clona el repositorio en el servidor (`--depth 1`, rama indicada, SHA capturado), construye la imagen con etiqueta por intento (`<servicio>:<deploymentId>`) y arranca el contenedor con nombre determinista en una red propia del servicio (`noodara-net-<serviceId>`), todo con timeouts explícitos (máximo total y de inactividad).
- [ ] **DEP-03**: Un build fallido nunca reemplaza el contenedor en ejecución; el deployment termina `FAILED` con un código de error de vocabulario cerrado (`CLONE_FAILED`, `AUTH_FAILED`, `BUILD_FAILED`, `IMAGE_PULL_FAILED`, `PORT_IN_USE`, `START_FAILED`, `TIMEOUT`, …) y un mensaje accionable, nunca texto crudo del servidor.
- [ ] **DEP-04**: El usuario cancela un deployment en cola (nunca llega a ejecutarse) y uno en curso (señal cooperativa → kill confirmado del proceso remoto → cierre del canal SSH → limpieza); ambos casos terminan `CANCELLED` sin dejar contenedores, imágenes parciales, redes ni directorios temporales.
- [ ] **DEP-05**: Cada deployment mantiene un registro de los recursos que creó y los limpia en toda ruta de salida (éxito, fallo, cancelación, timeout, caída del worker); un deployment interrumpido por una caída del worker se marca `FAILED` al reiniciar, nunca queda `BUILDING` para siempre.
- [ ] **DEP-06**: Solo puede haber un deployment activo por servicio (índice parcial único en base de datos + jobId `deploy-<deploymentId>`); un segundo intento se encola o se rechaza con un error nombrado, nunca corre en paralelo.
- [ ] **DEP-07**: El usuario redespliega (re-ejecuta el build actual), detiene, reinicia y elimina el contenedor de un servicio desde la UI y la API; cada operación es un job con timeout y queda en el activity log.
- [ ] **DEP-08**: En v0.2 no existen build args ni variables de entorno de aplicación (llegan en v0.4); la UI y los docs lo dicen explícitamente y el modelo no expone campos para ello; LFS y submodules se rechazan con `UNSUPPORTED_REPOSITORY_FEATURE`.
- [ ] **DEP-09**: Ningún secreto (deploy key, token, credencial de registry) aparece en `docker inspect`, `docker history`, argv, logs de build o activity log; el canary de fugas se extiende a estas superficies.

### Logs (LOG)

- [ ] **LOG-01**: Los logs de build se transmiten en vivo a la UI por el SSE existente (nuevo tipo de evento), en chunks acotados (flush por tiempo/tamaño, límite por línea, tope por fase), pasados por el Redactor antes de salir del worker.
- [ ] **LOG-02**: Los logs de build se persisten en chunks append-only con secuencia y se pueden consultar después (`since=<seq>` en el resync sin replay), con tope de tamaño por deployment y retención configurable.
- [ ] **LOG-03**: El usuario ve los logs de runtime del contenedor bajo demanda (tail de N líneas y follow acotado en tiempo), con ANSI y salida binaria saneados; no se persisten.
- [ ] **LOG-04**: La UI de deploy narra los pasos (clonar, construir, arrancar, verificar) con duración y estado cada uno, reutilizando el patrón de la narración del discovery, y muestra el error clasificado con su recuperación cuando falla.

### Reconciliación de estado (REC)

- [ ] **REC-01**: Un ciclo de reconciliación por servidor (un `docker ps` por tick, no por servicio) actualiza el estado real de los contenedores y emite eventos SSE solo cuando algo cambia; la UI nunca hace polling propio.
- [ ] **REC-02**: La UI aplica los eventos de estado con la misma función pura de reconciliación por secuencia que v0.1 usa para servidores, de modo que un evento y un snapshot en vuelo nunca dejan un estado obsoleto.
- [ ] **REC-03**: Un contenedor detenido o eliminado fuera de Noodara se refleja en la UI en el siguiente ciclo, y el activity log registra la discrepancia.

### Documentación y sitio público (DOCS, SITE)

- [ ] **DOCS-01**: Existe `apps/site` (Next 16 + Fumadocs, exportación estática) con la documentación pública: instalación (mismo comando y misma tabla de exit codes que `docs/install.md`), conceptos (servidor, proyecto, environment, servicio, deployment), guía de primer deploy, límites de v0.2 dichos sin "coming soon", y actualización/rollback.
- [ ] **DOCS-02**: Un test de exactitud verifica que los comandos, variables y códigos de error de la documentación coinciden con `install.sh` y con el vocabulario de errores real, igual que `install-docs-accuracy.test.ts`.
- [ ] **SITE-01**: La landing pública (modo Persuade) presenta el producto con su identidad, screenshots reales de la app, el comando de instalación y enlaces a docs y GitHub; sin afirmaciones que el producto no cumpla, sin imágenes ni fuentes de terceros sin self-hosting, con metadatos SEO básicos y Open Graph.
- [ ] **SITE-02**: El sitio se publica automáticamente desde CI (`public-site.yml`) a GitHub Pages en cada push a `main`, con el dominio configurable por CNAME sin cambiar el sitio, y su build forma parte de los gates del PR.
- [ ] **SITE-03**: El sitio cumple el mismo piso de calidad que la app (contraste, tipografía, ambos temas, reduced-motion) y lo revisa un humano con screenshots.

### Hardening y deuda de v0.1 (OPS)

- [ ] **OPS-01**: Los servicios del `docker-compose.yml` de producción rotan logs (`logging` con `max-size`/`max-file`) y el instalador poda los `.env.bak-*` dejando los N más recientes; ambos con tests.
- [ ] **OPS-02**: La imagen de control-plane deja de embarcar el workspace completo (objetivo: por debajo de 600 MB) sin romper la resolución de módulos, verificado por el test de imagen existente.
- [ ] **OPS-03**: `check-posix-sh` reconoce `$(( ))`, `[[:space:]]`, `$'` en comentarios y `((` en heredocs sin falsos positivos, y los workarounds de `install.sh` se retiran.
- [ ] **OPS-04**: La deuda humana de v0.1 se cierra con evidencia: instalación real en Ubuntu 22.04, en arm64 y con ufw activo; un upgrade real entre dos releases publicadas y su rollback; memoria observada en un VPS de 1–2 GB.

### Calidad (QA)

- [ ] **QA-07**: Existen los fixtures oficiales `node-api`, `static-app` y `failing-build` (contexto de build < 1 MiB) y un fixture Testcontainers sshd+dockerd que ejerce el pull real desde registry y la autenticación de registry.
- [ ] **QA-08**: 20 deployments consecutivos del mismo servicio completan correctamente y 20 ciclos create/delete de servicio no dejan contenedores, redes, imágenes ni workspaces huérfanos (`docker system df` estable), en la suite de integración y en nightly.
- [ ] **QA-09**: El E2E crítico cubre proyecto → environment → servicio desde `node-api` → deploy con logs en vivo → servicio alcanzable por el puerto publicado → build fallido con `failing-build` y error accionable → cancelación en curso sin huérfanos.
- [ ] **QA-10**: Los cuatro spikes de la investigación (transferencia de secretos sin argv, kill remoto confirmado, BuildKit por defecto en Docker 23+, estabilidad del JSON de `docker ps`) se resuelven con evidencia antes de implementar el motor, y los números por defecto (flush, topes de logs, intervalo de reconciliación, timeouts) se miden y se registran como en v0.1.

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Deployment Engine (v0.3)

- **DEPL-01**: State machine determinística completa (HEALTHCHECK, ROLLED_BACK), webhooks de Git con idempotencia, healthchecks configurables, rollback a un deployment anterior con historial inmutable.

### Domains & Secrets (v0.4)

- **DOM-01**: Traefik, dominios, HTTPS automático, env vars con precedence y secrets referenciados; build args.

### Observability & AI (v0.5)

- **OBS-01**: Métricas históricas, logs persistidos con filtro, Infrastructure Graph, AI read-only BYOK con evals.

### Server extras

- **SRVX-01**: Auto-instalar Docker en un servidor gestionado cuando falta (hoy solo se detecta).
- **SRVX-02**: Soporte Debian y otras distribuciones.
- **SRVX-03**: Noodara Agent instalado en el servidor como adaptador alternativo a SSH.

### Cuenta y equipo

- **TEAM-01**: Multiusuario, roles, invitaciones, SSO (post-v0.5 por roadmap; el shell de v0.2 lo deja previsto).

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Env vars, secrets de aplicación, build args | v0.4 por roadmap; en v0.2 la configuración va horneada en la imagen y la guía lo dice |
| Dominios, HTTPS, reverse proxy | v0.4; en v0.2 el acceso es por puerto publicado opcional |
| Webhooks, healthchecks, rollback automático | v0.3; el estado `SUCCESS` de v0.2 significa "contenedor arrancado y en ejecución tras N comprobaciones" |
| Compose multi-contenedor como servicio, marketplace de templates | Ningún hito del roadmap lo reclama |
| `docker events` como fuente de reconciliación | Requiere un canal SSH de larga vida que `packages/ssh` no fue diseñado para sostener; se usa poll por servidor |
| Builds en el control plane | El control plane nunca construye; todo ocurre en el servidor del usuario |
| Multiusuario, roles, equipos, SSO | Post-v0.5; solo se diseña el espacio en el shell |
| Vercel/Netlify para el sitio | GitHub Pages desde CI basta; sin dependencias de servicio nuevas |
| Kubernetes, Terraform, CI/CD genérico, DB HA, billing, multi-tenancy | Fuera hasta después de v0.5 por roadmap |

## Traceability

Which phases cover which requirements. Updated during roadmap creation (2026-09-22).

Cada requisito mapea a exactamente una fase: la primera que puede entregarlo de forma observable. Los requisitos de PROJ/SVC/DEP/LOG que describen comportamiento de usuario se entregan por API en la Fase 12 y se cierran en la UI en la Fase 13, donde QA-09 los verifica end-to-end.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BRAND-01 | Phase 7 | Pending |
| BRAND-02 | Phase 7 | Pending |
| BRAND-03 | Phase 7 | Pending |
| UI-03 | Phase 8 | Pending |
| UI-04 | Phase 8 | Pending |
| UI-05 | Phase 8 | Pending |
| UI-06 | Phase 8 | Pending |
| UI-07 | Phase 8 | Pending |
| UI-08 | Phase 8 | Pending |
| UI-09 | Phase 8 | Pending |
| UI-10 | Phase 8 | Pending |
| UI-11 | Phase 8 | Pending |
| UI-12 | Phase 8 | Pending |
| SET-02 | Phase 9 | Pending |
| SET-03 | Phase 9 | Pending |
| SET-04 | Phase 9 | Pending |
| SET-05 | Phase 9 | Pending |
| SET-06 | Phase 9 | Pending |
| DOCS-01 | Phase 10 | Pending |
| DOCS-02 | Phase 10 | Pending |
| SITE-01 | Phase 10 | Pending |
| SITE-02 | Phase 10 | Pending |
| SITE-03 | Phase 10 | Pending |
| DEP-01 | Phase 11 | Pending |
| DEP-08 | Phase 11 | Pending |
| SVC-08 | Phase 11 | Pending |
| PROJ-04 | Phase 11 | Pending |
| QA-07 | Phase 11 | Pending |
| QA-10 | Phase 11 | Pending |
| PROJ-01 | Phase 12 | Pending |
| PROJ-02 | Phase 12 | Pending |
| PROJ-03 | Phase 12 | Pending |
| PROJ-05 | Phase 12 | Pending |
| SVC-01 | Phase 12 | Pending |
| SVC-02 | Phase 12 | Pending |
| SVC-03 | Phase 12 | Pending |
| SVC-04 | Phase 12 | Pending |
| SVC-05 | Phase 12 | Pending |
| SVC-06 | Phase 12 | Pending |
| SVC-07 | Phase 12 | Pending |
| DEP-02 | Phase 12 | Pending |
| DEP-03 | Phase 12 | Pending |
| DEP-04 | Phase 12 | Pending |
| DEP-05 | Phase 12 | Pending |
| DEP-06 | Phase 12 | Pending |
| DEP-07 | Phase 12 | Pending |
| DEP-09 | Phase 12 | Pending |
| LOG-01 | Phase 12 | Pending |
| LOG-02 | Phase 12 | Pending |
| LOG-03 | Phase 12 | Pending |
| REC-01 | Phase 12 | Pending |
| REC-03 | Phase 12 | Pending |
| QA-08 | Phase 12 | Pending |
| LOG-04 | Phase 13 | Pending |
| REC-02 | Phase 13 | Pending |
| QA-09 | Phase 13 | Pending |
| OPS-01 | Phase 14 | Pending |
| OPS-02 | Phase 14 | Pending |
| OPS-03 | Phase 14 | Pending |
| OPS-04 | Phase 14 | Pending |

**Coverage:**
- v1 requirements: 60 total
- Mapped to phases: 60 (Phase 7: 3 · Phase 8: 10 · Phase 9: 5 · Phase 10: 5 · Phase 11: 6 · Phase 12: 24 · Phase 13: 3 · Phase 14: 4)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-22*
*Last updated: 2026-09-22 after roadmap creation (traceability mapped to Phases 7-14)*
