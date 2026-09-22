# Phase 6: Instalador y Docker Compose - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-21
**Phase:** 6-Instalador y Docker Compose
**Areas discussed:** Imágenes y hosting del script, Acceso al panel sin HTTPS, Re-ejecución y upgrade, Preflight e instalación Docker

---

## Imágenes y hosting del script

### ¿Cómo llegan las imágenes al VPS?

| Option | Description | Selected |
|--------|-------------|----------|
| Prebuilt en GHCR | CI publica imágenes multi-arch; el instalador solo hace pull. Requiere remoto de GitHub y workflow de release. | ✓ |
| Build en el VPS | Clona y compila en el VPS; riesgo de OOM en VPS de 1-2 GB, instalación lenta. | |
| Prebuilt + fallback a build | Pull por defecto con variable para compilar localmente; más superficie que probar. | |

**User's choice:** Prebuilt en GHCR

### ¿Cómo tratamos la falta de remoto en GitHub?

| Option | Description | Selected |
|--------|-------------|----------|
| El usuario crea el repo; la fase lo asume | Paso manual documentado como prerequisito de la verificación final; destraba QA-04/QA-05. | ✓ |
| Todo verificable en local primero | Override de registry/tag; push a GHCR como último plan bloqueado. | |
| Claude lo crea con gh | Acción hacia afuera; requeriría confirmación explícita. | |

**User's choice:** El usuario crea el repo; la fase lo asume

### ¿Desde qué URL se sirve install.sh?

| Option | Description | Selected |
|--------|-------------|----------|
| raw.githubusercontent.com | Cero infraestructura extra; migrable a dominio propio después. | ✓ |
| Asset de GitHub Release | Script versionado junto a las imágenes; URL más larga. | |
| Dominio propio | URL corta de marca; requiere dominio, DNS y hosting. | |

**User's choice:** raw.githubusercontent.com

### ¿Qué versión instala por defecto?

| Option | Description | Selected |
|--------|-------------|----------|
| Última release estable, tag fijado en .env | Tag exacto en `.env`, `NOODARA_VERSION` como override, nunca `:latest`. | ✓ |
| Tag :latest | Simple, pero un reinicio puede mezclar versiones. | |
| Versión embebida en el script | Sin llamadas a la API de GitHub; main debe llevar el script bumpeado. | |

**User's choice:** Última release estable, tag fijado en .env

---

## Acceso al panel sin HTTPS

### ¿Qué hace la instalación por defecto con las cookies Secure?

| Option | Description | Selected |
|--------|-------------|----------|
| HTTP con opt-out automático y aviso | `NOODARA_COOKIE_INSECURE=true` solo si la URL es `http://`, con aviso; `https://` deja cookies Secure. | ✓ |
| Exigir https:// siempre | Más seguro; rompe "un comando en un VPS limpio". | |
| Solo localhost + túnel SSH | Muy seguro; contradice "sin pasos manuales de SSH". | |

**User's choice:** HTTP con opt-out automático y aviso

### ¿En qué puerto queda el panel?

| Option | Description | Selected |
|--------|-------------|----------|
| 3000 con override NOODARA_PORT | Igual que dev y Dokploy; deja 80/443 para Traefik en v0.4. | ✓ |
| 8000 con override | El de Coolify; colisiones conocidas. | |
| Puerto poco común con override | Casi nunca colisiona; menos memorable. | |

**User's choice:** 3000 con override NOODARA_PORT

### ¿Cómo se determina NOODARA_PUBLIC_URL?

| Option | Description | Selected |
|--------|-------------|----------|
| Override > servicio externo > IP local | Como Coolify; imprime la URL elegida y cómo cambiarla. | ✓ |
| Solo IP local | Sin terceros; falla en VPS con NAT (FORBIDDEN_ORIGIN). | |
| Obligar a pasarla siempre | Determinista; deja de ser copiar y pegar. | |

**User's choice:** Override > servicio externo > IP local

### ¿Qué hace el instalador con ufw?

| Option | Description | Selected |
|--------|-------------|----------|
| Detectar y avisar, no tocar | Imprime el comando exacto; recuerda el firewall del proveedor. | ✓ |
| Abrir el puerto automáticamente | Menos fricción; cambia la postura de seguridad sin permiso. | |
| Ignorar el firewall | Solo documentación. | |

**User's choice:** Detectar y avisar, no tocar

---

## Re-ejecución y upgrade

### ¿Qué hace una re-ejecución por defecto?

| Option | Description | Selected |
|--------|-------------|----------|
| Actualiza a la última release | Conserva `.env` y volúmenes; no-op si ya está al día. | ✓ |
| No hace nada salvo con flag | Más conservador; segundo comando que aprender. | |
| Repara, nunca cambia de versión | Re-aplica compose con el tag fijado. | |

**User's choice:** Actualiza a la última release

### ¿Dónde vive la instalación?

| Option | Description | Selected |
|--------|-------------|----------|
| /opt/noodara + volúmenes nombrados | `.env` modo 600; `/opt/noodara/.env` como señal de instalación existente. | ✓ |
| /opt/noodara + bind mounts | Backup con un tar; riesgo de permisos y `rm -rf`. | |
| /data/noodara | Estilo Coolify; menos estándar según FHS. | |

**User's choice:** /opt/noodara + volúmenes nombrados

### ¿Cómo se trata el .env existente?

| Option | Description | Selected |
|--------|-------------|----------|
| Nunca regenerar; solo añadir claves nuevas | Merge aditivo con `.env.bak-<timestamp>` modo 600. | ✓ |
| Igual, sin backup | Menos archivos con secrets; sin deshacer. | |
| No tocar .env jamás | Falla si falta una variable nueva. | |

**User's choice:** Nunca regenerar; solo añadir claves nuevas

### ¿Qué pasa si el upgrade no pasa healthcheck?

| Option | Description | Selected |
|--------|-------------|----------|
| Falla con diagnóstico, sin rollback automático | Exit ≠ 0, servicio no sano + logs, instrucciones con `NOODARA_VERSION=<anterior>`. | ✓ |
| Rollback automático de imágenes | No deshace migraciones; duplica caminos a probar. | |
| Backup de Postgres antes de migrar | Más tiempo, disco y otro archivo sensible. | |

**User's choice:** Falla con diagnóstico, sin rollback automático
**Notes:** El setup token no requirió decisión: el API ya lo imprime y re-imprime por stdout mientras no exista admin; el instalador lo lee de los logs.

---

## Preflight e instalación Docker

### ¿Cómo se instala Docker si falta?

| Option | Description | Selected |
|--------|-------------|----------|
| Repo apt oficial de Docker, paso a paso | Auditable, errores por paso, sin segundo script remoto como root. | ✓ |
| get.docker.com | Menos código; script opaco con errores genéricos. | |
| No instalar; exigirlo | Contradice INST-01. | |

**User's choice:** Repo apt oficial de Docker, paso a paso

### ¿Qué mínimos de recursos?

| Option | Description | Selected |
|--------|-------------|----------|
| RAM <1 GB falla, <2 GB avisa; disco <5 GB falla | Override `NOODARA_SKIP_RESOURCE_CHECK=1`. | ✓ |
| RAM <2 GB falla | Deja fuera VPS de 1 GB. | |
| Solo avisos | Contradice el success criterion 2. | |

**User's choice:** RAM <1 GB falla, <2 GB avisa; disco <5 GB falla

### ¿Qué arquitecturas?

| Option | Description | Selected |
|--------|-------------|----------|
| amd64 y arm64 | Multi-arch con buildx; probar dependencias nativas en arm64. | ✓ |
| Solo amd64 | Release más simple; arm64 falla en preflight. | |

**User's choice:** amd64 y arm64

### ¿Cómo se prueba el instalador?

| Option | Description | Selected |
|--------|-------------|----------|
| Tres capas | Shell unit + Testcontainers DinD con doble corrida + VPS real manual. | ✓ |
| Solo integration DinD + VPS manual | Sin capa unitaria de shell. | |
| VM real en CI | Más fiel; depende del remoto. | |

**User's choice:** Tres capas

---

## Claude's Discretion

- Estructura de `install.sh` (sh vs bash), exit codes, root vs sudo.
- Formato y tono de la salida; log de instalación sin secrets.
- Dockerfiles (multi-stage, base, usuario no-root, standalone de Next.js).
- Ejecución de migraciones en producción (one-shot en Compose vs `compose run`).
- Servicio de IP pública y resolución de "última release".
- Nombres de imágenes, triggers del workflow de release, provenance.
- Healthchecks de `redis`/`web`, límites de memoria.
- Documentación mínima de instalación.
- Nombre del override de registry/tag usado solo por los tests.

## Deferred Ideas

- Rollback automático de imágenes tras upgrade fallido (v0.3+).
- Backup `pg_dump` previo a cada upgrade.
- Dominio propio para el instalador.
- Job nightly con `install.sh` real en runner Ubuntu limpio.
- Build desde fuente en el VPS.
- Desinstalador y wrapper CLI `noodara` en el host.
- HTTPS automático / Traefik / dominios (v0.4).
