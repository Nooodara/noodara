# Requirements: Noodara — v0.2 Projects & Services

**Defined:** 2026-09-22
**Core Value:** Noodara puede conocer, registrar y comunicarse con infraestructura real de forma segura y consistente — y ahora también desplegar sobre ella — sin fugas de credenciales, sin estados falsos y sin caídas por fallos del servidor remoto. Y debe enamorar al verla.

Fuentes: `PROJECT.md` (Current Milestone v0.2), `docs/roadmap-v0.1-v0.5.md` §7, `.planning/research/SUMMARY.md` (decisiones D1–D27), `docs/ui-build-prompt.md` (brief de UI). Los requisitos de v0.1 archivados en `milestones/v0.1-REQUIREMENTS.md`; la numeración de las categorías que ya existían (UI, SET, QA) continúa.

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Identidad (BRAND)

- [x] **BRAND-01**: Noodara tiene un logotipo (monograma + wordmark) con significado documentado, entregado como SVG en variantes para tema claro y oscuro, y una hoja de brand kit (construcción, área de protección, usos prohibidos, paleta y tipografía) en `docs/brand/`.
- [x] **BRAND-02**: El logotipo se aplica en la app (sidebar/rail, `/login`, `/setup`, favicon y `apple-touch-icon`), en el README y en el sitio público, en ambos temas, sin literales de color fuera de los tokens. (Sitio público: assets exportados vía `@noodara/ui/brand/*`; la aplicación en `apps/site` la hace la Fase 10.)
- [x] **BRAND-03**: El usuario revisa el logotipo renderizado (screenshots en ambos temas, en la app y en el README) y lo aprueba antes de que se aplique en todas las superficies.

### Rediseño de la app (UI)

- [x] **UI-03**: `Sheet`, `Dialog` y `RowMenu` tienen el nivel de elevación flotante (`--shadow-floating`, con escalón de superficie más claro en oscuro); ningún otro componente recibe sombra (gate automatizado).
- [ ] **UI-04**: `RowMenu` cierra al seleccionar, devuelve el foco al trigger, es visible en dispositivos táctiles y anuncia su estado abierto/cerrado a lectores de pantalla.
- [x] **UI-05**: Todo control presionable da feedback en el press (`scale(0.97)`, 160 ms, `--ease-out`); las curvas de easing custom y la tabla de duraciones del brief §6 sustituyen a los easings built-in en todo el inventario; ninguna acción iniciada por teclado se anima.
- [x] **UI-06**: El `Sheet` se cierra arrastrando con la secuencia completa del brief §7.4 (pointer capture, offset de agarre, tracking 1:1, rubber-banding, decisión por signo de velocidad, proyección de momentum, handoff de velocidad, interrumpible), con `motion` acotado a ese componente.
- [x] **UI-07**: El toolbar usa scroll edge effect en lugar del borde permanente; `RowMenu` y `Tooltip` escalan desde el origen del trigger; `Dialog` desde el centro; `Disclosure` anima con `grid-template-rows`; los checks de discovery y las filas de la lista entran con stagger de 40 ms sin bloquear la interacción.
- [x] **UI-08**: Los momentos de firma del producto — la narración del discovery y el bloque de fingerprint/confianza (TOFU) — están tratados como momentos autorados (uno por pantalla), distinguibles de cualquier otro producto (test de intercambio de marca).
- [x] **UI-09**: Craft de superficie: numerales tabulares en todo dato numérico, `text-wrap: balance/pretty`, medida de 65–75 caracteres en copy, `::selection`/`caret-color`/scrollbars/`text-underline-offset` tematizados, puente de blur en el crossfade skeleton → contenido, `@starting-style` en las entradas, medidor de disco revelado con `clip-path`.
- [x] **UI-10**: `prefers-reduced-motion`, `prefers-reduced-transparency` y `prefers-contrast: more` tienen alternativas intencionales en toolbar, sheet, dialog y menú; el hover se gatea con `(hover: hover) and (pointer: fine)`; nunca más de tres `backdrop-filter` simultáneos.
- [ ] **UI-11**: El shell deja previstos, sin placeholders visibles, el tercer panel (inspector), la navegación jerárquica Project → Environment → Service y el menú de cuenta (avatar/nombre, perfil, apariencia, cerrar sesión), de forma que v0.2–v0.5 no exigen reescribirlo.
- [x] **UI-12**: Cada pantalla rediseñada se verifica con contraste medido (≥4.5:1 cuerpo, ≥3:1 texto grande y bordes únicos), a 375/900/1280/1920 px con contenido real, y con screenshots en ambos temas revisados por un humano antes de cerrarse; los 93 E2E existentes siguen verdes.

### Settings editables (SET)

- [x] **SET-02**: El admin puede editar su nombre y su email desde Settings, con validación del dominio y confirmación por contraseña actual.
- [x] **SET-03**: El admin puede cambiar su contraseña (política de v0.1: 12–128 caracteres, lista de comunes) y el cambio revoca todas las demás sesiones activas.
- [x] **SET-04**: El admin elige el tema (auto/claro/oscuro) y la preferencia se persiste en el servidor con espejo local para el primer pintado, sin parpadeo al recargar; el override manual siempre gana sobre el SO.
- [x] **SET-05**: El admin ajusta preferencias visuales (reducir movimiento, densidad compacta/cómoda) que se persisten como la anterior y se respetan en toda la app.
- [x] **SET-06**: Las filas de Settings que provienen de variables de entorno siguen siendo de solo lectura y lo dicen; el tipo de `SettingsRow` impide añadirles un handler de edición.

### Proyectos y environments (PROJ)

- [x] **PROJ-01**: El usuario crea un proyecto con nombre único (slug derivado) y descripción opcional, lo edita y lo lista.
- [x] **PROJ-02**: El usuario archiva un proyecto; un proyecto archivado no acepta nuevos deploys y solo un proyecto archivado puede eliminarse, escribiendo su nombre exacto; al eliminarlo se eliminan sus environments, servicios, deployments, logs y credenciales asociadas.
- [x] **PROJ-03**: El usuario crea, edita y elimina environments dentro de un proyecto; `production`, `staging` y `development` se sugieren pero cualquier nombre válido se acepta; el nombre es único dentro del proyecto.
- [x] **PROJ-04**: La propiedad es jerárquica y la garantiza la base de datos: un environment pertenece a un solo proyecto y un servicio a un solo environment; ninguna ruta acepta un id de otro proyecto.
- [x] **PROJ-05**: Un servidor con servicios no puede eliminarse; el error nombra los servicios que lo bloquean.

### Servicios (SVC)

- [x] **SVC-01**: El usuario crea un servicio desde un repositorio Git (URL, rama, contexto de build, ruta del Dockerfile, puerto interno) asignado a un servidor conectado del mismo proyecto.
- [x] **SVC-02**: El usuario crea un servicio desde un Dockerfile del repositorio con `target` opcional, y desde una imagen Docker (referencia con tag o digest explícito, nunca `:latest` implícito).
- [x] **SVC-03**: Un repositorio privado se autentica con una deploy key generada por Noodara (clave pública mostrada para registrarla en el proveedor) o con un token HTTPS; la credencial se cifra at-rest, nunca aparece en argv, URL, logs ni API, y se elimina con el servicio.
- [x] **SVC-04**: Una imagen de un registry privado (GHCR, Docker Hub) se autentica con una credencial de registry cifrada, pasada al remoto por `--password-stdin`, nunca por argv ni logs.
- [x] **SVC-05**: Cada servicio registra name, project, environment, server, source type, repository/image, branch, internal port, published port opcional, status, created_at y updated_at; el usuario lo edita (el cambio de fuente exige redeploy) y lo elimina escribiendo el nombre exacto, lo que detiene y elimina su contenedor, red, imágenes propias y workspace remoto.
- [x] **SVC-06**: El usuario puede publicar opcionalmente un puerto del host para el servicio; la validación rechaza colisiones con otros servicios del mismo servidor, con el panel y con puertos en uso reales (`PORT_IN_USE`); por defecto no se publica nada.
- [x] **SVC-07**: El estado mostrado de un servicio se deriva del estado real de su contenedor y de su último deployment (`running`, `stopped`, `deploying`, `failed`, `never_deployed`), nunca de un valor guardado a mano.
- [x] **SVC-08**: Toda URL de repositorio, rama, ruta y referencia de imagen se valida en `packages/domain` contra un vocabulario cerrado y se pasa al shell remoto solo a través de plantillas de la allowlist con `escapeShellArg`; un valor con caracteres de shell, `..`, saltos de línea o esquemas no permitidos se rechaza con un error nombrado antes de tocar el servidor.

### Deployments y operaciones remotas (DEP)

- [x] **DEP-01**: El usuario lanza un deploy manual; el deployment pasa por `QUEUED → PREPARING → BUILDING → DEPLOYING → SUCCESS | FAILED | CANCELLED`, definido en `packages/domain` con tabla de transiciones validada y forward-compatible con los estados de v0.3.
- [x] **DEP-02**: El deploy clona el repositorio en el servidor (`--depth 1`, rama indicada, SHA capturado), construye la imagen con etiqueta por intento (`<servicio>:<deploymentId>`) y arranca el contenedor con nombre determinista en una red propia del servicio (`noodara-net-<serviceId>`), todo con timeouts explícitos (máximo total y de inactividad).
- [x] **DEP-03**: Un build fallido nunca reemplaza el contenedor en ejecución; el deployment termina `FAILED` con un código de error de vocabulario cerrado (`CLONE_FAILED`, `AUTH_FAILED`, `BUILD_FAILED`, `IMAGE_PULL_FAILED`, `PORT_IN_USE`, `START_FAILED`, `TIMEOUT`, …) y un mensaje accionable, nunca texto crudo del servidor.
- [x] **DEP-04**: El usuario cancela un deployment en cola (nunca llega a ejecutarse) y uno en curso (señal cooperativa → kill confirmado del proceso remoto → cierre del canal SSH → limpieza); ambos casos terminan `CANCELLED` sin dejar contenedores, imágenes parciales, redes ni directorios temporales.
- [x] **DEP-05**: Cada deployment mantiene un registro de los recursos que creó y los limpia en toda ruta de salida (éxito, fallo, cancelación, timeout, caída del worker); un deployment interrumpido por una caída del worker se marca `FAILED` al reiniciar, nunca queda `BUILDING` para siempre.
- [x] **DEP-06**: Solo puede haber un deployment activo por servicio (índice parcial único en base de datos + jobId `deploy-<deploymentId>`); un segundo intento se encola o se rechaza con un error nombrado, nunca corre en paralelo.
- [x] **DEP-07**: El usuario redespliega (re-ejecuta el build actual), detiene, reinicia y elimina el contenedor de un servicio desde la UI y la API; cada operación es un job con timeout y queda en el activity log.
- [x] **DEP-08**: En v0.2 no existen build args ni variables de entorno de aplicación (llegan en v0.4); la UI y los docs lo dicen explícitamente y el modelo no expone campos para ello; LFS y submodules se rechazan con `UNSUPPORTED_REPOSITORY_FEATURE`.
- [x] **DEP-09**: Ningún secreto (deploy key, token, credencial de registry) aparece en `docker inspect`, `docker history`, argv, logs de build o activity log; el canary de fugas se extiende a estas superficies.

### Logs (LOG)

- [x] **LOG-01**: Los logs de build se transmiten en vivo a la UI por el SSE existente (nuevo tipo de evento), en chunks acotados (flush por tiempo/tamaño, límite por línea, tope por fase), pasados por el Redactor antes de salir del worker.
- [x] **LOG-02**: Los logs de build se persisten en chunks append-only con secuencia y se pueden consultar después (`since=<seq>` en el resync sin replay), con tope de tamaño por deployment y retención configurable.
- [x] **LOG-03**: El usuario ve los logs de runtime del contenedor bajo demanda (tail de N líneas y follow acotado en tiempo), con ANSI y salida binaria saneados; no se persisten.
- [x] **LOG-04**: La UI de deploy narra los pasos (clonar, construir, arrancar, verificar) con duración y estado cada uno, reutilizando el patrón de la narración del discovery, y muestra el error clasificado con su recuperación cuando falla.

### Reconciliación de estado (REC)

- [x] **REC-01**: Un ciclo de reconciliación por servidor (un `docker ps` por tick, no por servicio) actualiza el estado real de los contenedores y emite eventos SSE solo cuando algo cambia; la UI nunca hace polling propio.
- [x] **REC-02**: La UI aplica los eventos de estado con la misma función pura de reconciliación por secuencia que v0.1 usa para servidores, de modo que un evento y un snapshot en vuelo nunca dejan un estado obsoleto.
- [x] **REC-03**: Un contenedor detenido o eliminado fuera de Noodara se refleja en la UI en el siguiente ciclo, y el activity log registra la discrepancia.

### Documentación y sitio público (DOCS, SITE)

- [x] **DOCS-01**: Existe `apps/site` (Next 16 + Fumadocs, exportación estática) con la documentación pública: instalación (mismo comando y misma tabla de exit codes que `docs/install.md`), conceptos (servidor, proyecto, environment, servicio, deployment), guía de primer deploy, límites de v0.2 dichos sin "coming soon", y actualización/rollback. (Fase 10 entrega "Your first server"; "Your first deploy" llega con la Fase 13, que reabre este requisito — D-09 de la Fase 10).
- [x] **DOCS-02**: Un test de exactitud verifica que los comandos, variables y códigos de error de la documentación coinciden con `install.sh` y con el vocabulario de errores real, igual que `install-docs-accuracy.test.ts`.
- [x] **SITE-01**: La landing pública (modo Persuade) presenta el producto con su identidad, screenshots reales de la app, el comando de instalación y enlaces a docs y GitHub; sin afirmaciones que el producto no cumpla, sin imágenes ni fuentes de terceros sin self-hosting, con metadatos SEO básicos y Open Graph.
- [x] **SITE-02**: El sitio se publica automáticamente desde CI (`public-site.yml`) a Cloudflare Pages (proyecto `noodara-site`, Direct Upload) en cada push a `main`, siempre en la raíz (sin gating por CNAME), y su build forma parte de los gates del PR. (Enmendado quick-260928-gmm: hosting movido de GitHub Pages a Cloudflare Pages, decisión bloqueada del usuario 2026-09-28.)
- [x] **SITE-03**: El sitio cumple el mismo piso de calidad que la app (contraste, tipografía, ambos temas, reduced-motion) y lo revisa un humano con screenshots.

### Hardening y deuda de v0.1 (OPS)

- [x] **OPS-01**: Los servicios del `docker-compose.yml` de producción rotan logs (`logging` con `max-size`/`max-file`) y el instalador poda los `.env.bak-*` dejando los N más recientes; ambos con tests.
- [x] **OPS-02**: La imagen de control-plane deja de embarcar el workspace completo (objetivo: por debajo de 600 MB) sin romper la resolución de módulos, verificado por el test de imagen existente.
- [x] **OPS-03**: `check-posix-sh` reconoce `$(( ))`, `[[:space:]]`, `$'` en comentarios y `((` en heredocs sin falsos positivos, y los workarounds de `install.sh` se retiran.
- [x] **OPS-04**: La deuda humana de v0.1 se cierra con evidencia: instalación real en Ubuntu 22.04, en arm64 y con ufw activo; un upgrade real entre dos releases publicadas y su rollback; memoria observada en un VPS de 1–2 GB. _Completo en lo verificado (upgrade real entre releases publicadas y rollback, `docs/releases/v0.2-HUMAN-UAT.md`). Las verificaciones en host real quedan sin cumplir y pasan a OPS-05 (DECISIONS 2026-10-14)._ — *Cumplido en lo verificado (upgrade v0.1.0 → v0.2 y rollback reales, memoria observada); la parte de host real (VPS público, 22.04, arm64, ufw, 1–2 GB) pasó a OPS-05 / Fase 15 por decisión del usuario (2026-10-14).*
- [ ] **OPS-05**: Deuda de verificación en host real, sin cumplir y diferida: instalación y deploy en un VPS público real, en Ubuntu 22.04, en arm64, con `ufw` activo y en un VPS de 1–2 GB (memoria y tiempos QA-10), con logs en `docs/releases/`. Owner: usuario. Objetivo: v0.2.1 o inicio de v0.3. _Parcial (15-01, 2026-10-30): verificados Ubuntu 22.04, arm64, `ufw` activo y host de 1969 MiB (memoria y tiempos) con el flujo completo, evidencia en `docs/releases/v0.2-realhost-logs/`. Falta el VPS público real._

### Calidad (QA)

- [x] **QA-07**: Existen los fixtures oficiales `node-api`, `static-app` y `failing-build` (contexto de build < 1 MiB) y un fixture Testcontainers sshd+dockerd que ejerce el pull real desde registry y la autenticación de registry.
- [x] **QA-08**: 20 deployments consecutivos del mismo servicio completan correctamente y 20 ciclos create/delete de servicio no dejan contenedores, redes, imágenes ni workspaces huérfanos (`docker system df` estable), en la suite de integración y en nightly.
- [x] **QA-09**: El E2E crítico cubre proyecto → environment → servicio desde `node-api` → deploy con logs en vivo → servicio alcanzable por el puerto publicado → build fallido con `failing-build` y error accionable → cancelación en curso sin huérfanos.
- [x] **QA-10**: Los cuatro spikes de la investigación (transferencia de secretos sin argv, kill remoto confirmado, BuildKit por defecto en Docker 23+, estabilidad del JSON de `docker ps`) se resuelven con evidencia antes de implementar el motor, y los números por defecto (flush, topes de logs, intervalo de reconciliación, timeouts) se miden y se registran como en v0.1.

## v0.3 Requirements — Reliable Deployment Engine

Planificados 2026-10-14 (fases 16–20). Fuente: `docs/roadmap-v0.1-v0.5.md` §8. Sustituyen a DEPL-01. Las categorías existentes (UI, DOCS, QA) continúan su numeración.

### Motor (ENG)

- [x] **ENG-01**: La state machine de Deployment tiene los diez estados del roadmap (`QUEUED PREPARING BUILDING DEPLOYING HEALTHCHECK SUCCESS FAILED ROLLING_BACK ROLLED_BACK CANCELLED`), centralizada en `packages/domain`, con cada par ordenado testeado y 100% de branch coverage forzado por un gate.
- [x] **ENG-02**: Cada deployment conserva trazabilidad completa e inmutable: trigger (`manual | redeploy | webhook | rollback`), actor o delivery de webhook, commit, imagen, deployment previo, deployment del que es rollback y snapshot de la configuración de runtime; el historial se lista paginado por API.
- [x] **ENG-03**: Deploy, redeploy y rollback por API aceptan `Idempotency-Key`; la misma clave devuelve el mismo deployment y un reintento del job del worker nunca crea contenedores ni filas duplicadas.
- [x] **ENG-04**: La cancelación y la recuperación tras caída del worker dejan la infraestructura consistente desde cualquier estado no terminal, incluidos `HEALTHCHECK` y `ROLLING_BACK`: nunca queda el servicio sin versión cuando había una healthy.
- [x] **ENG-05**: Un deployment fallido nunca reemplaza una versión healthy sin mecanismo de recuperación: el contenedor anterior se conserva (detenido) hasta que el nuevo pasa el healthcheck.

### Healthchecks (HC)

- [x] **HC-01**: Cada servicio configura un healthcheck `http`, `tcp` o `container` (path, port, timeout, interval, retries, expected status, start period) validado en `packages/domain` con límites acotados; los servicios de v0.2 sin configuración usan `container` y conservan su comportamiento.
- [x] **HC-02**: El healthcheck se ejecuta desde el servidor del usuario según ADR 0010, con timeouts explícitos, resultado narrado en los logs del deployment y fallos de vocabulario cerrado (`HEALTHCHECK_FAILED`, `HEALTHCHECK_TIMEOUT`).

### Rollback (RBK)

- [x] **RBK-01**: Si el arranque o el healthcheck fallan y existe una versión anterior, el deployment pasa a `ROLLING_BACK`, restaura el contenedor anterior y solo termina `ROLLED_BACK` cuando su healthcheck pasa; si no, `FAILED` con `ROLLBACK_FAILED`. Activable por servicio (por defecto activo).
- [x] **RBK-02**: El usuario hace rollback manual a un deployment anterior known-good cuya imagen sigue en el servidor: un deployment nuevo con trigger `rollback`, sin build, que restaura su configuración de runtime y pasa el healthcheck antes de `SUCCESS`.
- [x] **RBK-03**: Una política de retención mantiene la imagen actual y las N anteriores known-good por servicio (N configurable, acotado); un objetivo cuya imagen ya no existe se rechaza con `ROLLBACK_TARGET_UNAVAILABLE`.

### Webhooks (HOOK)

- [x] **HOOK-01**: Cada servicio Git puede activar un webhook de GitHub con un secreto generado por Noodara, cifrado at-rest, mostrado una sola vez, rotable y eliminado con el servicio; la URL del webhook no expone ids internos adivinables.
- [x] **HOOK-02**: El receptor verifica la firma HMAC-SHA256 en tiempo constante sobre el cuerpo crudo antes de parsearlo, con tope de tamaño y rate limit; acepta `push` y `ping`, valida el evento, ignora tags, borrados y ramas que no coinciden, y despliega exactamente el SHA empujado.
- [x] **HOOK-03**: Una entrega duplicada o reentregada (mismo `X-GitHub-Delivery`) nunca crea otro deployment; los pushes que llegan con un deployment activo se coalescen en uno pendiente con el último SHA; cada entrega queda registrada con su resultado y es visible en la UI.

### UI, docs y calidad

- [ ] **UI-13**: La UI configura healthcheck y auto-rollback, activa y rota el webhook, narra los pasos de healthcheck y rollback, muestra el historial con su trazabilidad y lanza el rollback manual con confirmación, todo dentro del design system y aprobado por `noodara-ux-review` y un humano en ambos temas.
- [ ] **DOCS-03**: El sitio documenta healthchecks, webhooks de GitHub y rollback (con sus límites de v0.3) y el test de exactitud cubre sus códigos de error y defaults.
- [x] **QA-11**: La suite de integración simula, contra sshd+dockerd reales: deploy exitoso, fallo de clone, fallo de dependencias/build, fallo de `docker build`, crash del contenedor, timeout y status incorrecto del healthcheck, interrupción de red, webhook duplicado, reintento del worker, rollback exitoso y rollback fallido.
- [x] **QA-12**: Los E2E cubren happy path (push firmado → webhook → `QUEUED … HEALTHCHECK → SUCCESS`), failure path (commit roto → la versión buena sigue sirviendo) y rollback path (`FAILED` → rollback → versión previa healthy → `ROLLED_BACK`).
- [x] **QA-13**: 100 ciclos deploy/rollback sin corrupción de estado, cero contenedores huérfanos y cero deployment records perdidos, en un gate de stress y en nightly.
- [x] **QA-14**: Gate de release v0.3 con evidencia por criterio de `docs/roadmap-v0.1-v0.5.md` §8.10, CI y nightly verdes, y `v0.3.0` publicado. Gate 2026-10-19 en 890bf60 = público 2d1e1c69 (v0.3.0-rc.1, `docs/releases/v0.3-gate.md`): READY, los 12 criterios §8.10 con evidencia; CI 39281147566 y nightly 39281208524 verdes sobre ese commit. `v0.3.0` publicado 2026-10-30 en a0b45618 (CI 41012499661, Release 41016597518).

## v0.4 Requirements — Domains, Networking & Secrets

Planificados 2026-10-30 (fases 21–25). Fuente: `docs/roadmap-v0.1-v0.5.md` §9. Sustituyen a DOM-01. Las categorías existentes (UI, DOCS, QA) continúan su numeración. Decisiones de planificación en `.planning/DECISIONS.md` (2026-10-30); contratos remotos en ADR 0011 (tarea 21-01).

### Reverse proxy (PRX)

- [x] **PRX-01**: Noodara instala y opera un reverse proxy Traefik por servidor (`noodara-traefik`, imagen fijada por digest, puertos 80/443 del host, configuración por file provider sin montar `docker.sock`, directorio `/opt/noodara-proxy`) con un job acotado por timeout; el preflight rechaza puertos 80/443 ocupados con `PROXY_PORT_IN_USE` nombrando el proceso; el estado del proxy (`NOT_INSTALLED | INSTALLING | RUNNING | FAILED`) se ve en el servidor y en el activity log.
- [x] **PRX-02**: El proxy se instala automáticamente al añadir el primer dominio de un servidor y se puede retirar solo cuando no quedan dominios (`PROXY_IN_USE`); eliminar un servidor sin servicios retira el proxy con mejor esfuerzo y sin bloquear la eliminación; la configuración dinámica de un servicio se escribe de forma atómica (temp + rename), se verifica contra la API local de Traefik y, si el proxy no la carga, se restaura la versión anterior (`PROXY_ROUTE_FAILED`).

### Dominios (DMN)

- [x] **DMN-01**: El usuario añade y elimina dominios de un servicio: FQDN en minúsculas validado en `packages/domain` (sin esquema ni path, punycode aceptado, ≤253 chars, sin IPs ni `localhost`), único globalmente (`DOMAIN_ALREADY_ASSIGNED`, 409), nunca el host de `NOODARA_PUBLIC_URL` (`DOMAIN_RESERVED`), con tope por servicio (`DOMAIN_LIMIT_REACHED`); cada dominio registra hostname, servicio, `https_redirect`, estado DNS, estado de certificado y timestamps.
- [x] **DMN-02**: Al añadir un dominio la UI/API dan instrucciones DNS concretas (registro A/AAAA hacia la IP del servidor, alternativa CNAME) y una validación básica de resolución (`RESOLVES | MISMATCH | UNRESOLVED | UNAVAILABLE`) con timeout acotado, re-ejecutable bajo demanda; la validación es orientativa y nunca bloquea añadir el dominio.
- [x] **DMN-03**: El routing HTTP y HTTPS de cada dominio al contenedor `noodara-<serviceId>:<internalPort>` lo genera una función pura y determinística (`renderDynamicConfig`) en `packages/domain`, con redirect HTTP → HTTPS por dominio (por defecto activo); las rutas sobreviven a replace, rollback automático y manual, y se eliminan con el dominio o con el servicio (desconectando el proxy de la red del servicio antes de borrarla).

### TLS (TLS)

- [x] **TLS-01**: Los certificados se emiten automáticamente por ACME (challenge http-01) desde el proxy (CA configurable con `NOODARA_ACME_CA_URL`, por defecto Let's Encrypt producción; email de cuenta = email del admin salvo override por servidor) y se almacenan solo en el servidor (`acme.json` 0600); el control plane nunca lee claves privadas.
- [x] **TLS-02**: Noodara deriva el estado de certificado de cada dominio (`NONE | PENDING | ISSUED | RENEWING | FAILED | EXPIRED`, tabla de transiciones en `packages/domain` al 100% de branch coverage) con una sonda TLS desde el host del servidor que solo devuelve emisor y `notAfter`, en un ciclo acotado (`NOODARA_CERT_CHECK_INTERVAL_MS`) y tras cada cambio de dominio; `FAILED` llega con causa de vocabulario cerrado (`CERT_DNS_MISMATCH`, `CERT_ISSUANCE_FAILED`, `CERT_PROXY_UNAVAILABLE`) tras `NOODARA_CERT_ISSUE_TIMEOUT_MS`; la fecha de expiración es visible en la UI.
- [x] **TLS-03**: La renovación se prueba de verdad contra Pebble con certificados de validez corta en Testcontainers (`it-tls-renewal`, nightly): el certificado se renueva sin intervención, el estado pasa por `RENEWING` y vuelve a `ISSUED`, y el tráfico HTTPS no se interrumpe.

### Variables de entorno (ENV)

- [x] **ENV-01**: El usuario crea, edita y elimina variables en tres scopes (`project`, `environment`, `service`); la clave cumple `^[A-Z_][A-Z0-9_]*$` (≤128 chars), el valor es de una sola línea (≤32 KiB, `ENV_VALUE_MULTILINE` con mensaje accionable), única por scope (`ENV_KEY_DUPLICATE`), con tope por scope (`ENV_LIMIT_REACHED`); toda mutación es un `ActivityEvent` sin valores.
- [x] **ENV-02**: La precedencia `service > environment > project` es una función pura `resolveEnv` en `packages/domain` testeada por cada combinación de sombra, documentada en el sitio; la API expone la vista efectiva por servicio con el origen de cada variable y las sombreadas.
- [x] **ENV-03**: Las variables se inyectan en el contenedor en el deploy con `docker create --env-file` desde `<workspace>/secrets/env` (0600, fuera del build context, eliminado al terminar), nunca por argv ni build args; el snapshot de runtime config (v2) guarda valores planos y referencias a secrets (nunca valores de secrets), el rollback restaura los valores planos del snapshot y resuelve las referencias en ese momento; los servicios sin variables conservan el comportamiento de v0.3.
- [x] **ENV-04**: Un cambio de variables o secrets no toca el contenedor en ejecución; la UI y la API indican que aplica en el siguiente deploy y señalan cuando la configuración efectiva difiere de la del deployment en ejecución.

### Secrets (SCR)

- [x] **SCR-01**: Un `Secret` (nombre `^[a-z][a-z0-9_]{0,63}$`, scope `project | environment | service`) se cifra at-rest con el envelope de cifrado existente (AES-GCM de 256 bits) y `key_version`, se modela como `SecretValue` (`kind: app_secret`) y lo cubre `noodara secrets rotate`; la API nunca devuelve el valor tras crearlo y muestra una vista redactada (`••••••••` + últimos 4 chars solo si el valor tiene ≥16).
- [x] **SCR-02**: Una variable referencia un secret como `<secret:name>`; el dominio parsea y valida la referencia, la API rechaza referencias a secrets inexistentes (`SECRET_NOT_FOUND`), un secret referenciado no puede eliminarse (`SECRET_IN_USE` nombra las variables) y la resolución ocurre solo en la capa de ejecución del deploy, registrando los valores en el Redactor y liberándolos al terminar; una referencia que no resuelve en el deploy termina `FAILED` con `SECRET_UNRESOLVED` sin tocar el contenedor en ejecución.
- [x] **SCR-03**: Ningún secret de aplicación aparece en API responses, errores HTTP, logs de aplicación, logs de deployment, activity log, SSE, excepciones, snapshots de runtime ni en la salida de `docker inspect`/`docker ps` que Noodara lee (formatos que nunca seleccionan `.Config.Env`); el canary de fugas siembra un secret de aplicación y recorre las nueve superficies de §9.9 (las de AI quedan registradas como no aplicables hasta v0.5).
- [x] **SCR-04**: La exposición inherente del valor resuelto en el entorno del contenedor (visible con acceso Docker al servidor del usuario) queda documentada como límite de v0.4; el `-prev` y el contenedor nuevo se tratan igual y la eliminación de un servicio borra sus variables y secrets de scope `service` en la misma transacción.

### UI, docs y calidad

- [x] **UI-14**: La UI añade y elimina dominios con instrucciones DNS, pills de estado DNS y certificado (colores semánticos de infraestructura, fecha de expiración bajo demanda), edita variables y secrets en los tres scopes con filas de secret redactadas y vista efectiva con origen, muestra el estado del proxy en el detalle del servidor y narra el paso de configuración del deploy, todo dentro del design system y aprobado por `noodara-ux-review` y un humano en ambos temas.
- [x] **DOCS-04**: El sitio documenta dominios y HTTPS (DNS, puertos 80/443, `NOODARA_PORT` fuera de 80/443, límites de Let's Encrypt, ventana de replace), variables y secrets (precedencia, referencias, límites de una línea, exposición en el servidor) y los códigos de error nuevos, con test de exactitud sobre códigos, defaults y límites.
- [x] **QA-15**: La suite de integración cubre, contra sshd+dockerd reales y Pebble: instalación del proxy, puerto ocupado, alta/baja de dominio con configuración aplicada y revertida, emisión, fallo por DNS, renovación, routing tras replace y rollback, inyección de variables y secrets, referencia sin resolver y borrado de servicio con dominios.
- [x] **QA-16**: Los E2E cubren `deploy → add domain → validate DNS → certificate issued → HTTPS /health 200` contra Pebble y `create secret → deploy → el servicio lee el secret → UI/API/logs nunca muestran el plaintext`.
- [x] **QA-17**: 50 ciclos create/update/delete de dominio no dejan configuración dinámica corrupta ni huérfana (archivos, routers en Traefik, redes conectadas) y la base de datos coincide con el servidor al final, en un gate de stress y en nightly.
- [x] **QA-18**: Gate de release v0.4 con evidencia por criterio de `docs/roadmap-v0.1-v0.5.md` §9.11, security review (`docs/security/v0.4-review.md`), CI y nightly verdes, UAT en host real (Lima) y `v0.4.0` publicado.

## v0.5 Requirements — Observability + AI Read-Only

Planificados 2026-11-03 (fases 26–31). Fuente: `docs/roadmap-v0.1-v0.5.md` §10. Sustituyen a OBS-01. Las categorías existentes (LOG, UI, DOCS, QA) continúan su numeración. Decisiones en `.planning/DECISIONS.md` (2026-11-03); contratos remotos y de proveedor en ADR 0012 (tarea 26-01).

### Métricas y estado (MET)

- [x] **MET-01**: Noodara muestrea por SSH, en un ciclo acotado por servidor `CONNECTED` (`NOODARA_METRICS_INTERVAL_MS`), CPU, RAM, disco, uptime y estado de conexión del host, y CPU/memoria por contenedor gestionado; las muestras se guardan con retención (`NOODARA_METRICS_RETENTION_HOURS`) y poda acotada; un servidor inalcanzable registra su estado sin tumbar el worker.
- [x] **MET-02**: Cada servicio expone estado del contenedor, restart count, estado de healthcheck, último deployment y runtime status, leídos con `docker inspect` restringido a `.State` y `.HostConfig.Memory` (nunca `.Config.Env`); crash loop y OOM generan un `ActivityEvent` de sistema.
- [x] **MET-03**: Umbrales `high_memory` y `high_disk`, detección de crash loop y OOM, y la clasificación de evidencia en el vocabulario cerrado de diagnósticos (incluido `unknown`) son funciones puras en `packages/domain` con 100% de branch coverage.

### Logs (LOG)

- [x] **LOG-05**: Una vista unificada por servicio reúne build logs, deployment logs, runtime logs (ventana acotada de `docker logs` pedida bajo demanda, nunca copiada en masa) y actividad, cada línea con timestamp e identificación de fuente.
- [x] **LOG-06**: Los logs se filtran por fuente, ventana de tiempo y nivel, admiten búsqueda por substring y modo follow acotado; todo pasa por el Redactor y los límites devuelven `truncated` en vez de fallar.

### Infrastructure Graph (GRF)

- [x] **GRF-01**: `buildGraph(snapshot)` en `packages/domain` deriva nodos Server, Project, Environment, Service, Domain y relaciones `RUNS_ON`, `BELONGS_TO`, `EXPOSED_BY`, `DEPENDS_ON` (inferida de valores de env planos que nombran otro servicio registrado, nunca de secrets), determinística y con invariantes probados por propiedades.
- [x] **GRF-02**: La API sirve el graph global, por proyecto y por environment desde un snapshot consistente, y refleja altas y bajas de infraestructura registrada sin relaciones colgantes.

### AI read-only (AI)

- [x] **AI-01**: `packages/ai` define `AIProvider` (`chat`, `stream`, `toolCall`) con Anthropic y OpenAI implementados y la interfaz abierta a OpenAI-compatible, OpenRouter, Azure OpenAI y Bedrock; ningún SDK de proveedor se importa fuera de `packages/ai/src/providers`.
- [x] **AI-02**: BYOK: la API key se guarda cifrada (`ai_provider_key`), se valida al guardarla, nunca vuelve por API, logs ni activity, y se borra con la configuración; el modelo se elige de una allowlist por proveedor.
- [x] **AI-03**: La AI es técnicamente incapaz de escribir: el registry de tools es cerrado y solo contiene las diez tools de lectura, el tipo `AITool` solo admite `kind: 'read'`, ninguna tool llega a un shell, y un nombre fuera del registry se rechaza sin ejecutarse y se cuenta como intento no autorizado.
- [x] **AI-04**: La AI solo ve recursos autorizados: cada tool recibe un `AuthorizationScope` aplicado en backend y lo que queda fuera responde `NOT_FOUND`.
- [x] **AI-05**: La AI nunca recibe secrets en claro: todo input y output del modelo pasa por el Redactor, los secrets aparecen solo como `<secret:name>`, las conversaciones se guardan redactadas y el canary de fugas cubre prompt, tool results, respuesta, SSE y conversación guardada.
- [x] **AI-06**: El agente responde con `diagnosis`, `entities`, `evidence` y `confidence` validados por schema, dentro de presupuestos de iteraciones, tool calls, tokens y tiempo; entidades y evidencia sin respaldo en una tool se descartan y marcan como alucinadas; la UI muestra las tools consultadas.
- [x] **AI-07**: Los nueve diagnósticos de §10.8 se sostienen con evidencia real capturada (OOM, crash loop, contenedor detenido, healthcheck timeout, puerto sin respuesta, deploy fallido, memoria alta, disco alto, servidor inalcanzable), probada con fallos reales en integración.

### Evaluación (EVAL)

- [x] **EVAL-01**: `tests/ai/evals/` versiona al menos 50 escenarios YAML (fixture, evidencia, pregunta, entidades esperadas, diagnóstico esperado, claims prohibidos) que cubren las ocho preguntas de §10.7, los nueve diagnósticos y `unknown`.
- [x] **EVAL-02**: Un scorer mide entity selection, evidence grounding, diagnosis accuracy, hallucinated resources, secret leakage y unauthorized writes sin comparar wording; `baseline.json` versiona el resultado de una corrida en vivo (modelo, versión del dataset, fecha).
- [x] **EVAL-03**: CI reproduce la suite (cassettes de respuestas grabadas en vivo a través del loop, tools y scorer reales) como job obligatorio que bloquea el merge bajo ≥95% entidades, ≥90% diagnóstico, <1% alucinación, 0% fugas, 0 escrituras no autorizadas o ante una caída frente al baseline; nightly corre en vivo cuando hay key.
- [x] **EVAL-04**: La suite adversarial (§10.11 más inyección vía nombre de servicio, contenido de logs y commit message) afirma ninguna escritura ejecutada y ningún secret revelado.

### UI, docs y calidad

- [x] **UI-15**: Métricas y estado de servidores y servicios, la vista de logs y el Infrastructure Graph dentro del design system, aprobados por `noodara-ux-review` en ambos temas.
- [x] **UI-16**: Settings de AI (proveedor, modelo, key write-only) y el chat en el inspector: respuesta primero, diagnóstico y confianza, chips de entidades navegables, evidencia colapsada, tools consultadas, `unknown` explica la evidencia faltante; la salida del modelo se renderiza inerte.
- [x] **DOCS-05**: El sitio documenta métricas (intervalo, retención), logs, el graph y su regla de inferencia, setup BYOK por proveedor, qué datos se envían al proveedor, la garantía read-only y cómo se aplica, y los códigos de error nuevos, con test de exactitud.
- [x] **QA-19**: La suite de integración de observabilidad pasa en Ubuntu 22.04 y 24.04, y un soak del collector mantiene las tablas dentro de la retención sin fugas de sesiones SSH.
- [x] **QA-20**: Los E2E cubren los tres flujos de §10.12 (consulta de infraestructura, diagnóstico OOM, seguridad de secrets) contra el stack real.
- [ ] **QA-21**: Gate de release v0.5 con evidencia por criterio de §10.13, security review (`docs/security/v0.5-review.md`), CI y nightly verdes, UAT en host real (Lima) con proveedor en vivo y `v0.5.0` publicado.

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Deployment Engine (v0.3)

- ~~**DEPL-01**~~: sustituido por ENG/HC/RBK/HOOK (v0.3 Requirements, 2026-10-14).

### Domains & Secrets (v0.4)

- ~~**DOM-01**~~: sustituido por PRX/DMN/TLS/ENV/SCR (v0.4 Requirements, 2026-10-30). Build args quedan fuera de v0.4 (no son criterio de §9 y entrarían en `docker history`); Cloudflare DNS integration (§9.4 opcional) fuera de v0.4.

### Observability & AI (v0.5)

- ~~**OBS-01**~~: sustituido por MET/LOG/GRF/AI/EVAL (v0.5 Requirements, 2026-11-03). AI con escritura, providers más allá de Anthropic/OpenAI y almacenamiento de logs tipo Loki quedan fuera de v0.5.

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
| BRAND-01 | Phase 7 | Complete |
| BRAND-02 | Phase 7 | Complete |
| BRAND-03 | Phase 7 | Complete |
| UI-03 | Phase 8 | Complete |
| UI-04 | Phase 8 | Pending |
| UI-05 | Phase 8 | Complete |
| UI-06 | Phase 8 | Complete |
| UI-07 | Phase 8 | Complete |
| UI-08 | Phase 8 | Complete |
| UI-09 | Phase 8 | Complete |
| UI-10 | Phase 8 | Complete |
| UI-11 | Phase 8 | Pending |
| UI-12 | Phase 8 | Complete |
| SET-02 | Phase 9 | Complete |
| SET-03 | Phase 9 | Complete |
| SET-04 | Phase 9 | Complete |
| SET-05 | Phase 9 | Complete |
| SET-06 | Phase 9 | Complete |
| DOCS-01 | Phase 10, 13 | Complete |
| DOCS-02 | Phase 10 | Complete |
| SITE-01 | Phase 10 | Complete |
| SITE-02 | Phase 10 | Complete |
| SITE-03 | Phase 10 | Complete |
| DEP-01 | Phase 11 | Complete |
| DEP-08 | Phase 11 | Complete |
| SVC-08 | Phase 11 | Complete |
| PROJ-04 | Phase 11 | Complete |
| QA-07 | Phase 11 | Complete |
| QA-10 | Phase 11 | Complete |
| PROJ-01 | Phase 12 | Complete |
| PROJ-02 | Phase 12 | Complete |
| PROJ-03 | Phase 12 | Complete |
| PROJ-05 | Phase 12 | Complete |
| SVC-01 | Phase 12 | Complete |
| SVC-02 | Phase 12 | Complete |
| SVC-03 | Phase 12 | Complete |
| SVC-04 | Phase 12 | Complete |
| SVC-05 | Phase 12 | Complete |
| SVC-06 | Phase 12 | Complete |
| SVC-07 | Phase 12 | Complete |
| DEP-02 | Phase 12 | Complete |
| DEP-03 | Phase 12 | Complete |
| DEP-04 | Phase 12 | Complete |
| DEP-05 | Phase 12 | Complete |
| DEP-06 | Phase 12 | Complete |
| DEP-07 | Phase 12 | Complete |
| DEP-09 | Phase 12 | Complete |
| LOG-01 | Phase 12 | Complete |
| LOG-02 | Phase 12 | Complete |
| LOG-03 | Phase 12 | Complete |
| REC-01 | Phase 12 | Complete |
| REC-03 | Phase 12 | Complete |
| QA-08 | Phase 12 | Complete |
| LOG-04 | Phase 13 | Complete |
| REC-02 | Phase 13 | Complete |
| QA-09 | Phase 13 | Complete |
| OPS-01 | Phase 14 | Complete |
| OPS-02 | Phase 14 | Complete |
| OPS-03 | Phase 14 | Complete |
| OPS-04 | Phase 14 | Complete (host real → OPS-05) |
| OPS-05 | Phase 15 | Partial: falta VPS público (owner: usuario) |
| ENG-01 | Phase 16 | Complete |
| ENG-02 | Phase 16 | Complete |
| HC-01 | Phase 16 | Complete |
| ENG-05 | Phase 17 | Complete |
| ENG-04 | Phase 17 | Complete |
| HC-02 | Phase 17 | Complete |
| RBK-01 | Phase 17 | Complete |
| RBK-02 | Phase 17 | Complete |
| RBK-03 | Phase 17 | Complete |
| ENG-03 | Phase 18 | Complete |
| HOOK-01 | Phase 18 | Complete |
| HOOK-02 | Phase 18 | Complete |
| HOOK-03 | Phase 18 | Complete |
| UI-13 | Phase 19 | Pending |
| DOCS-03 | Phase 19 | Pending |
| QA-12 | Phase 19 | Complete |
| QA-11 | Phase 20 | Complete |
| QA-13 | Phase 20 | Complete |
| QA-14 | Phase 20 | Complete (v0.3.0 → a0b45618, 2026-10-30) |
| DMN-01 | Phase 21 | Complete |
| DMN-03 | Phase 21 | Complete |
| ENV-02 | Phase 21 | Complete |
| TLS-02 | Phase 21 | Complete |
| PRX-01 | Phase 22 | Complete |
| PRX-02 | Phase 22 | Complete |
| DMN-02 | Phase 22 | Complete |
| TLS-01 | Phase 22 | Complete (Pebble on Lima; LE production UNVERIFIED, OPEN_QUESTIONS #20) |
| TLS-03 | Phase 22 | Complete |
| ENV-01 | Phase 23 | Complete |
| ENV-03 | Phase 23 | Complete |
| ENV-04 | Phase 23 | Complete |
| SCR-01 | Phase 23 | Complete |
| SCR-02 | Phase 23 | Complete |
| SCR-04 | Phase 23 | Complete |
| UI-14 | Phase 24 | Complete |
| DOCS-04 | Phase 24 | Complete |
| QA-16 | Phase 24 | Complete |
| SCR-03 | Phase 25 | Complete |
| QA-15 | Phase 25 | Complete |
| QA-17 | Phase 25 | Complete |
| QA-18 | Phase 25 | Complete (v0.4.0 → d1d956bc, 2026-11-02) |
| MET-03 | Phase 26 | Complete |
| GRF-01 | Phase 26 | Complete |
| MET-01 | Phase 27 | Complete |
| MET-02 | Phase 27 | Complete |
| LOG-05 | Phase 27 | Complete |
| LOG-06 | Phase 27 | Complete |
| GRF-02 | Phase 27 | Complete |
| AI-01 | Phase 28 | Complete |
| AI-02 | Phase 28 | Complete |
| AI-03 | Phase 28 | Complete |
| AI-04 | Phase 28 | Complete |
| AI-05 | Phase 28 | Complete |
| AI-06 | Phase 28 | Complete |
| AI-07 | Phase 28 | Complete |
| EVAL-01 | Phase 29 | Complete |
| EVAL-02 | Phase 29 | Complete |
| EVAL-03 | Phase 29 | Complete |
| EVAL-04 | Phase 29 | Complete |
| UI-15 | Phase 30 | Complete |
| UI-16 | Phase 30 | Complete |
| DOCS-05 | Phase 30 | Complete |
| QA-20 | Phase 30 | Complete |
| QA-19 | Phase 31 | Complete |
| QA-21 | Phase 31 | Pending (gate local 31-05 NOT READY: CI/nightly, UAT y tag en 31-06) |

**Coverage:**
- v1 requirements: 61 total
- Mapped to phases: 60 (Phase 7: 3 · Phase 8: 10 · Phase 9: 5 · Phase 10: 5 · Phase 11: 6 · Phase 12: 24 · Phase 13: 3 · Phase 14: 4)
- Phase 15: 1 (OPS-05, añadido 2026-10-14 tras la revisión de la fase 14)
- v0.3 requirements: 19 total, mapped to Phases 16–20 (16: 3 · 17: 6 · 18: 4 · 19: 3 · 20: 3)
- v0.4 requirements: 23 total, mapped to Phases 21–25 (21: 4 · 22: 5 · 23: 6 · 24: 3 · 25: 4)
- v0.5 requirements: 24 total, mapped to Phases 26–31 (26: 2 · 27: 5 · 28: 7 · 29: 4 · 30: 4 · 31: 2)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-22*
*Last updated: 2026-09-22 after roadmap creation (traceability mapped to Phases 7-14)*
