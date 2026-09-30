# Phase 11: Motor de deploy — fundamentos - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-29
**Phase:** 11-motor-de-deploy-fundamentos
**Areas discussed:** Spikes y ADRs, Vocabulario de validadores, Fixtures/registry/CI, Esquema de credenciales

---

## Spikes y ADRs

| Option | Description | Selected |
|--------|-------------|----------|
| Un ADR 0008 combinado | Formato ADR-0004, una sección por spike | ✓ |
| Un ADR por spike (0008–0011) | Cuatro documentos independientes | |

| Option | Description | Selected |
|--------|-------------|----------|
| Contract tests permanentes | El spike queda como integration test que falla si cambia el comportamiento | ✓ |
| Desechable | Se borra tras el ADR | |

| Option | Description | Selected |
|--------|-------------|----------|
| Check en fail, bloquea servicios Dockerfile | Check de discovery con mensaje accionable; imagen no se bloquea | ✓ |
| Warning, no bloquea | Builder legacy sin progreso estructurado | |
| Forzar DOCKER_BUILDKIT=1 | La plantilla siempre lo activa | |

| Option | Description | Selected |
|--------|-------------|----------|
| Combinar candidatos | setsid+pidfile+kill -pgid y docker kill del build | ✓ |
| Parar y replantear | No avanzar a Fase 12 | |
| Tú decides | Planner elige según evidencia | |

**User's choice:** las cuatro opciones recomendadas.

---

## Vocabulario de validadores

| Option | Description | Selected |
|--------|-------------|----------|
| https:// + scp-like + ssh:// | Rechaza http, git://, file://, credenciales embebidas, query | ✓ |
| Solo https:// y git@host:path | Sin ssh:// ni puertos no estándar | |

| Option | Description | Selected |
|--------|-------------|----------|
| Cualquier hostname público válido | Rechaza IPs privadas literales y localhost | ✓ |
| Cualquier host incl. IPs privadas | Permite Gitea en LAN | |
| Solo github.com | Máximo cierre | |

| Option | Description | Selected |
|--------|-------------|----------|
| Cualquier registry, tag o digest explícito | ':latest' escrito se acepta; omitirlo no | ✓ |
| ':latest' explícito rechazado | Obliga a versionar | |
| Solo Docker Hub y GHCR | Allowlist de registries | |

| Option | Description | Selected |
|--------|-------------|----------|
| Subconjunto estricto | [A-Za-z0-9._/-] con reglas de borde | ✓ |
| git check-ref-format completo | Todo lo que Git acepta | |

**User's choice:** las cuatro opciones recomendadas.

---

## Fixtures, registry y CI

| Option | Description | Selected |
|--------|-------------|----------|
| Registry local con auth | registry:2 + htpasswd en red Testcontainers, precargado | ✓ |
| GHCR real | Depende de red y token en CI | |
| Local en PR, GHCR en nightly | Dos caminos | |

| Option | Description | Selected |
|--------|-------------|----------|
| 24.04 en PR, ambas en main y nightly | PR rápido | ✓ |
| Ambas en cada PR | Máxima cobertura, job más lento | |

| Option | Description | Selected |
|--------|-------------|----------|
| Extender installer-dind + sshd-common | Reutiliza imágenes existentes; G3 mide el Docker real | ✓ |
| Imagen nueva desde cero | Duplica instalación de Docker | |

| Option | Description | Selected |
|--------|-------------|----------|
| node:22-alpine y nginx:alpine por digest | failing-build falla en RUN determinista | ✓ |
| Tú decides | Planner elige bases mínimas | |

**User's choice:** las cuatro opciones recomendadas.

---

## Esquema de credenciales

| Option | Description | Selected |
|--------|-------------|----------|
| En la migración 0005 de esta fase | El fixture ya ejerce deploy keys y registry | ✓ |
| En la Fase 12 | Solo las cinco tablas del criterio 3 | |

| Option | Description | Selected |
|--------|-------------|----------|
| Misma tabla credentials, enum ampliado | git_deploy_key, git_https_token, registry_password | ✓ |
| Tabla service_credentials nueva | Duplica cifrado y cascadas | |

| Option | Description | Selected |
|--------|-------------|----------|
| Dos FKs nullable en services | repository_credential_id, registry_credential_id, RESTRICT | ✓ |
| credentials.service_id | CASCADE, menos explícito | |
| Tú decides | Según patrón de servers.credential_id | |

| Option | Description | Selected |
|--------|-------------|----------|
| Columna public_key en claro | Solo la privada cifrada | ✓ |
| Derivar al vuelo | Descifrar en cada lectura | |

**User's choice:** las cuatro opciones recomendadas.

---

## Claude's Discretion

- Forma interna del exec en streaming y números por defecto (medidos en verificación).
- Formato exacto de los tipos branded para nombres deterministas.
- Cómo el fixture expone el host del repo bare de forma compatible con el validador de hosts.
- Nombre/id del check de discovery de BuildKit.
- Estructura interna de `packages/git` y `packages/docker`.

## Deferred Ideas

- Aplicación del bloqueo "sin BuildKit → no servicios Dockerfile" en creación de servicios (Fase 12).
- GHCR real en nightly (descartado por ahora).
