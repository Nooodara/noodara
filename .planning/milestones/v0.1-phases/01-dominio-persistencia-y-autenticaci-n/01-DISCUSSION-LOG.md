# Phase 1: Dominio, persistencia y autenticación - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-10
**Phase:** 1-Dominio, persistencia y autenticación
**Areas discussed:** Setup token y recuperación de admin, Política de sesión y bloqueo, Master key: ubicación y rotación, Semántica de estados del servidor

---

## Setup token y recuperación de admin

**¿Cómo llega el setup token al admin en el primer arranque?**

| Option | Description | Selected |
|--------|-------------|----------|
| Impreso en logs al arrancar | El api genera el token al primer boot, guarda su hash en DB y lo imprime en stdout mientras no exista admin | ✓ |
| Archivo en el volumen de datos | `/data/setup-token` con permisos 600 | |
| Comando CLI bajo demanda | `noodara setup-token` genera uno nuevo cada vez | |

**¿Cómo recupera el admin su password sin email saliente?**

| Option | Description | Selected |
|--------|-------------|----------|
| CLI que emite token de recuperación | `noodara admin reset` imprime token de un solo uso; reusa el mecanismo del setup token | ✓ |
| Password nuevo por variable de entorno al reiniciar | Definir `NOODARA_ADMIN_PASSWORD` y reiniciar fuerza el reset | |
| Ambos | CLI principal y env var de respaldo | |

**¿La creación del admin por env vars entra en fase 1 o fase 6?**

| Option | Description | Selected |
|--------|-------------|----------|
| En fase 1 | Lógica de auth del control plane; el instalador solo pasa variables; facilita E2E | ✓ |
| En fase 6 | Implementar junto al instalador | |

**User's choice:** las tres opciones recomendadas.
**Notes:** ninguna adicional.

---

## Política de sesión y bloqueo

**¿Duración de la sesión del admin?**

| Option | Description | Selected |
|--------|-------------|----------|
| 7 días deslizante, tope 30 días | Renueva con actividad; nunca más de 30 días sin re-login | ✓ |
| 24 horas fija | Re-login diario | |
| 30 días fija | Sin renovación | |

**¿Cuántas sesiones activas puede tener el admin?**

| Option | Description | Selected |
|--------|-------------|----------|
| Varias, con revocación desde Settings | Modelo y endpoints en fase 1, UI en fase 5 | ✓ |
| Una sola sesión | Un login nuevo invalida el anterior | |

**¿Umbral de rate limit y bloqueo en login?**

| Option | Description | Selected |
|--------|-------------|----------|
| 5 fallos / 15 min por IP y cuenta, backoff progresivo | Duplica la espera hasta 24 h; sin bloqueo permanente | ✓ |
| 10 fallos / 5 min, sin backoff | Ventana corta fija | |
| Bloqueo permanente tras N fallos | Requiere CLI para desbloquear | |

**User's choice:** las tres opciones recomendadas.
**Notes:** ninguna adicional.

---

## Master key: ubicación y rotación

**¿Dónde vive la clave maestra?**

| Option | Description | Selected |
|--------|-------------|----------|
| Variable de entorno en .env | `NOODARA_MASTER_KEY` generada por el instalador; backup = datos + .env | ✓ |
| Archivo en el volumen de datos | `/data/master.key` junto a PostgreSQL | |
| Env var con fallback a archivo | Prioriza la variable; si no, archivo | |

**¿Alcance de la rotación en v0.1?**

| Option | Description | Selected |
|--------|-------------|----------|
| Metadato de versión + comando de rotación en fase 1 | `key_version` por fila y `noodara secrets rotate` | ✓ |
| Solo metadato de versión | Comando en versión posterior | |

**¿Cómo se advierte que la master key es irrecuperable?**

| Option | Description | Selected |
|--------|-------------|----------|
| Aviso en logs de arranque y en Settings | Con fingerprint de la clave, nunca la clave | ✓ |
| Solo en la documentación del instalador | Una vez al final del instalador | |

**User's choice:** las tres opciones recomendadas.
**Notes:** ninguna adicional.

---

## Semántica de estados del servidor

**¿Existe acción explícita "Disconnect" en v0.1?**

| Option | Description | Selected |
|--------|-------------|----------|
| No; DISCONNECTED lo pone solo el sistema | Sin conexiones persistentes; DISCONNECTED = cierre limpio tras edición | ✓ |
| Sí, botón Disconnect | Ruta y transición disparadas por el usuario | |

**¿Qué pasa con estado y fingerprint al editar un servidor CONNECTED?**

| Option | Description | Selected |
|--------|-------------|----------|
| Vuelve a PENDING y borra el fingerprint si cambió host o puerto | Usuario/credencial → DISCONNECTED conservando fingerprint; discovery previo se conserva | ✓ |
| Siempre vuelve a PENDING y borra todo | Reset total | |
| Mantiene el estado hasta el próximo connect | Sin cambios al editar | |

**¿Cómo se re-confirma un HOST_KEY_CHANGED?**

| Option | Description | Selected |
|--------|-------------|----------|
| Acción explícita "Trust new fingerprint" | Muestra viejo y nuevo; al confirmar vuelve a PENDING con el nuevo fijado | ✓ |
| Editar el servidor y reconectar | Sin acción dedicada | |

**User's choice:** las tres opciones recomendadas.
**Notes:** ninguna adicional.

---

## Claude's Discretion

- Nombres del scaffold (prevalece CLAUDE.md sobre research: `apps/control-plane` con entrypoints `api` y `worker`).
- Política de password (mínimo 12 caracteres, lista de comunes, sin composición ni expiración).
- Esquema del activity log en esta fase (tabla y tipo; solo eventos de auth).
- Enforcement de "un solo admin" sin modelo de roles.
- CI en GitHub Actions con Testcontainers para integration ligera.
- Estrategia de tests de migración y convenciones de esquema.

## Deferred Ideas

- UI de sesiones en Settings (fase 5).
- Endpoint y UI de "Trust new fingerprint" (fases 4 y 5).
- Aviso de master key en Settings (fase 5).
- Instalador lee el setup token de los logs (fase 6).
- Acción manual "Disconnect" (descartada en v0.1).
