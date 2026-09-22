# Phase 2: Adaptador SSH aislado y probado con Testcontainers - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-12
**Phase:** 2-Adaptador SSH aislado y probado con Testcontainers
**Areas discussed:** Credenciales SSH: formatos y passphrase, Fingerprint: formato y tipos de host key, Timeouts y reintentos, Discovery ante fallos parciales

---

## Credenciales SSH: formatos y passphrase

| Option | Description | Selected |
|--------|-------------|----------|
| OpenSSH y PEM; ed25519, ECDSA y RSA | Lo que produce ssh-keygen y lo que exportan los proveedores cloud; RSA ≥2048 | ✓ |
| Solo OpenSSH, solo ed25519 | Un único camino, menos superficie | |

| Option | Description | Selected |
|--------|-------------|----------|
| Sí, passphrase guardada cifrada junto a la clave | Campo adicional en el envelope AES-256-GCM | ✓ |
| No, solo claves sin passphrase | Como Coolify | |

| Option | Description | Selected |
|--------|-------------|----------|
| password y keyboard-interactive | Misma password para ambos, sin prompts adicionales | ✓ |
| Solo password | Falla con AUTH_FAILED si el sshd solo ofrece keyboard-interactive | |

**User's choice:** las tres recomendadas. **Notes:** ninguna.

---

## Fingerprint: formato y tipos de host key

| Option | Description | Selected |
|--------|-------------|----------|
| `SHA256:<base64>` estilo OpenSSH | Igual que `ssh-keygen -lf` | ✓ |
| Hex con dos puntos (MD5 legacy) | Obsoleto | |

| Option | Description | Selected |
|--------|-------------|----------|
| ed25519, ECDSA y RSA; preferir ed25519 | Tipo guardado junto al fingerprint; cambio de tipo = cambio de clave | ✓ |
| Solo ed25519 y ECDSA | Rechaza servidores solo-RSA | |

| Option | Description | Selected |
|--------|-------------|----------|
| Ambos fingerprints con tipo y fecha de captura | Columnas de timestamp nuevas; el error muestra los dos | ✓ |
| Solo el nuevo fingerprint pendiente | Sin fechas | |

**User's choice:** las tres recomendadas. **Notes:** implica migración 0002 con dos columnas de fecha.

---

## Timeouts y reintentos

| Option | Description | Selected |
|--------|-------------|----------|
| Conexión 10 s, comando 30 s, discovery 60 s | Defaults de la skill de seguridad | ✓ |
| 20 s / 60 s / 120 s | Para redes malas | |
| 5 s / 15 s / 30 s | Feedback rápido, riesgo de falsos UNREACHABLE | |

| Option | Description | Selected |
|--------|-------------|----------|
| Por env var global con defaults | NOODARA_SSH_*_TIMEOUT_MS validadas en env.ts | ✓ |
| Fijos en v0.1 | Sin variables | |

| Option | Description | Selected |
|--------|-------------|----------|
| Un reintento con 2 s, solo CONNECT_TIMEOUT y CONNECTION_LOST | AUTH_FAILED y HOST_KEY_CHANGED nunca; se registra attempts | ✓ |
| Ninguno en v0.1 | Un fallo es un fallo | |

**User's choice:** las tres recomendadas. **Notes:** ninguna.

---

## Discovery ante fallos parciales

| Option | Description | Selected |
|--------|-------------|----------|
| CONNECTED con aviso UNSUPPORTED_OS y discovery completo | Cambia el mapeo de la fase 1 (ERROR → CONNECTED); deploy bloqueado en v0.2 | ✓ |
| ERROR con UNSUPPORTED_OS | Bloqueo explícito | |

| Option | Description | Selected |
|--------|-------------|----------|
| Aviso: docker_installed=false, estado CONNECTED | Detección con `docker version --format json` + versión de compose | ✓ |
| Fallo: servidor no listo | ERROR hasta instalar Docker | |

| Option | Description | Selected |
|--------|-------------|----------|
| Solo para no-root; root 'not applicable' | `sudo -n true` y `id -nG`; fallo = aviso | ✓ |
| Siempre, incluido root | Uniforme, menos claro | |

**User's choice:** las tres recomendadas. **Notes:** la decisión sobre UNSUPPORTED_OS revierte el mapeo a ERROR que fijó la fase 1; se documenta como D-11 con la actualización de tabla, tests y espejo.

---

## Claude's Discretion

- Estructura de `packages/ssh` e interfaz `SshPort`; allowlist de plantillas y su ubicación; parsers puros en `packages/domain`; tabla de clasificación de errores de ssh2; mutex por servidor; truncado de salida; imágenes de test propias y estrategia para cada escenario de red; keepalive.

## Deferred Ideas

- Timeouts por servidor; auto-instalar Docker (v2); pool SSH y agent; bloqueo de deploy en OS no soportado (v0.2); toxiproxy solo si hace falta.
