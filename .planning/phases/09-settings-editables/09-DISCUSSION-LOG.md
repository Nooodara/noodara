# Phase 9: Settings editables - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-27
**Phase:** 09-settings-editables
**Areas discussed:** Edición de perfil, Cambio de password, Tema y primer pintado, Preferencias visuales

---

## Edición de perfil

| Option | Description | Selected |
|--------|-------------|----------|
| Sheet por campo | Fila con valor + Edit; Sheet existente con campo, contraseña actual y Save | ✓ |
| Inline en la fila | Fila se convierte en input; rompe la retícula de 44 px | |
| Un solo formulario Profile | Grupo con todos los campos y un Save | |

| Option | Description | Selected |
|--------|-------------|----------|
| En cada cambio sensible | Nombre, email y password piden la actual | ✓ |
| Solo email y password | Nombre sin confirmar | |
| Una vez por 10 min | Sudo mode con ventana temporal | |

| Option | Description | Selected |
|--------|-------------|----------|
| Formato + DNS del dominio | Zod + MX/A en servidor, sin correo | ✓ |
| Solo formato | Zod email | |
| Formato + repetir email | Sin red, doble entrada | |

| Option | Description | Selected |
|--------|-------------|----------|
| Inmediato, sin recarga | AccountMenu se actualiza revalidando la sesión | ✓ |
| En el siguiente heartbeat | Se actualiza al volver a pedir get-session | |

**User's choice:** las cuatro recomendadas.
**Notes:** ninguna.

---

## Cambio de password

| Option | Description | Selected |
|--------|-------------|----------|
| Se mantiene | revokeOtherSessions; la pestaña actual sigue viva | ✓ |
| Re-login en todas | Revoca también la actual | |

| Option | Description | Selected |
|--------|-------------|----------|
| Notice en Settings tras guardar | "Password updated. Other sessions were signed out." | ✓ |
| Confirmación previa | Dialog antes de guardar | |
| Solo activity log | Sin aviso en pantalla | |

| Option | Description | Selected |
|--------|-------------|----------|
| Heartbeat existente | get-session falla → /login con aviso | ✓ |
| Evento SSE inmediato | Empujar por SSE | |

| Option | Description | Selected |
|--------|-------------|----------|
| Tres eventos sin metadata sensible | name_changed, email_changed, password_changed | ✓ |
| Un solo account.updated | Evento genérico | |
| También cambios de apariencia | Añadir preferences_changed | |

**User's choice:** las cuatro recomendadas.
**Notes:** ninguna.

---

## Tema y primer pintado

| Option | Description | Selected |
|--------|-------------|----------|
| Cookie espejo + script inline | Servidor fuente; cookie leída en SSR para data-theme | ✓ |
| Solo localStorage + script inline | Script bloqueante en head; no viaja entre navegadores | |
| Solo servidor (SSR) | Sin espejo; /login no sabe el tema | |

| Option | Description | Selected |
|--------|-------------|----------|
| Servidor gana al cargar sesión | Sobrescribe el espejo local | ✓ |
| Local gana hasta tocar el control | Evita cambio automático | |

| Option | Description | Selected |
|--------|-------------|----------|
| Cookie espejo si existe, si no auto/SO | /login y /setup | ✓ |
| Siempre auto/SO | Ignoran la preferencia | |

| Option | Description | Selected |
|--------|-------------|----------|
| Segmented Auto / Light / Dark | Tres estados visibles; ThemeToggle único write path | ✓ |
| Mantener el icono cíclico | ThemeToggle actual | |

**User's choice:** las cuatro recomendadas.
**Notes:** ninguna.

---

## Preferencias visuales

| Option | Description | Selected |
|--------|-------------|----------|
| Tres estados System / On / Off | data-motion en html; fallbacks de fase 8 lo leen | ✓ |
| Switch On/Off | No permite forzar animaciones | |

| Option | Description | Selected |
|--------|-------------|----------|
| Solo altura de fila y padding | 44→36 px; data-density remapea --row-height | ✓ |
| Filas + espaciado entre grupos | Más densidad, más superficie | |

| Option | Description | Selected |
|--------|-------------|----------|
| Segmented para ambos | Mismo patrón que Theme | ✓ |
| Switch + segmented | Mezcla | |

| Option | Description | Selected |
|--------|-------------|----------|
| Un objeto preferences + una cookie | jsonb validado por Zod, PATCH único, cookie única | ✓ |
| Columnas y endpoints separados | Más plomería | |

**User's choice:** las cuatro recomendadas.
**Notes:** ninguna.

## Claude's Discretion

Orden de grupos en Settings; copy; límites de nombre y normalización de email; rate limit de la contraseña actual; nombres exactos de endpoints y uso de los nativos de Better Auth; diseño del test de no-flash.

## Deferred Ideas

Verificación/recuperación por correo (mailer), avatar con imagen, sudo mode, eventos de apariencia, densidad global, lista de sesiones revocables en UI.
