# Noodara

## What This Is

Noodara es un PaaS open-source, self-hostable y AI-native que despliega, opera y **entiende** aplicaciones e infraestructura sobre servidores propios. Está pensado para desarrolladores indie y solo con uno o pocos VPS que hoy usan Coolify o Dokploy y quieren la misma facilidad de instalación y despliegue, más una capa de comprensión de su infraestructura (grafo, diagnóstico, preguntas en lenguaje natural) que esas herramientas no tienen.

Lema: *Your infrastructure, understood.* Principio interno de producto: *Complex infrastructure. Calm interface.*

## Core Value

Noodara puede conocer, registrar y comunicarse con infraestructura real de forma **segura y consistente**: sin fugas de credenciales, sin estados falsos, sin caídas por fallos del servidor remoto. Si esto no funciona, nada de lo que se construya encima vale.

## Requirements

### Validated

- ✓ Control plane con PostgreSQL, migraciones versionadas (0000, 0001), autenticación local de un admin y gestión de sesión (Better Auth, argon2id, cookies HttpOnly/Secure/Lax, sesión 7d deslizante con tope 30d, revocación) — Fase 1 (2026-09-12)
- ✓ Primer admin solo con setup token de un solo uso (24 h, 404 tras existir admin, carrera de 10 intentos → 1 usuario) y pre-seed por env vars; recovery por CLI `noodara admin reset` — Fase 1
- ✓ Lockout progresivo por IP y cuenta (5/15 min, backoff hasta 24 h) con activity log sin password — Fase 1
- ✓ State machine de Server con 6 estados y transiciones D-13/D-14/D-15, validadores y política de password en `packages/domain` al 100% de cobertura — Fase 1
- ✓ Cifrado AES-256-GCM con `key_version` y rotación `noodara secrets rotate`; arranque fail-fast sin secrets por defecto — Fase 1
- ✓ CI con 7 puertas (lint, typecheck, boundaries, unit+coverage, integration, security, boot-smoke); arranque real por `pnpm dev` y `pnpm start` probado — Fase 1
- ✓ Adaptador SSH (`packages/ssh`) sobre ssh2: claves OpenSSH/PEM con passphrase, password + keyboard-interactive, TOFU con fingerprint `SHA256:` y tipo, allowlist de 11 plantillas sin interpolación, timeouts independientes (10/30/60 s por env), reintento único para transitorios, clasificador exhaustivo de los 7 error codes, redacción y truncado — Fase 2 (2026-09-15)
- ✓ `runDiscovery` en una sola conexión con checks por paso (hostname, arch, OS, CPU, RAM, disco, uptime, Docker + compose, sudo y grupo docker para no-root), OS no soportado y Docker ausente como advertencias en CONNECTED — Fase 2
- ✓ Suite QA-03: ocho escenarios × Ubuntu 22.04 y 24.04 contra sshd real con Testcontainers (incluida pérdida de conexión a mitad de comando), matriz sudo/docker-group, canary de redacción; 620 unit + 208 integration — Fase 2
- ✓ Servicios de aplicación `registerServer`, `editServer`, `deleteServer`, `connectAndDiscover` y `trustFingerprint` compuestos por `createServerServices`: host, puerto y usuario SSH configurables, credencial (clave o password) validada con `loadPrivateKey` y cifrada at-rest, reemplazo in-place de credencial, borrado con confirmación por nombre que elimina credencial y snapshots en la misma transacción — Fase 3 (2026-09-16)
- ✓ Snapshots de discovery (`discovery_snapshots`, migración 0003) con `mergeDiscoveryFacts` (null nunca sobrescribe), `classifySnapshotOutcome`, desnormalización de facts en `servers` e índices únicos por nombre y host:puerto — Fase 3
- ✓ Activity log con seis acciones `server.*`, escritura en la misma transacción que la operación, guard de metadata sensible y test de frontera que restringe `writeActivityEvent` a servicios y módulo `activity` — Fase 3
- ✓ `ServerView` con allowlist de 27 campos sin material de credencial; canary full-flow (register → connect → edit → host-key change → trust → connect → delete contra sshd real) sin fuga en logger, resultados, `activity_events.metadata` ni `discovery_snapshots.payload`; `pnpm security:scan-leaks` en el job `security` de CI; 739 unit + 102 integration del alcance de la fase — Fase 3
- ✓ API HTTP de servidores (ocho rutas `/api/servers`: CRUD, trust-fingerprint, connect y discover) con schemas Zod estrictos, un único mapa código→status, handler global de errores opaco con redacción y scope `/api` protegido por sesión y guard de Origin — Fase 4 (2026-09-19)
- ✓ Worker BullMQ como segundo proceso (`pnpm start:worker`): `connectAndDiscover` corre fuera del proceso de la API, jobId determinístico `connect-<serverId>`, recuperación de conexiones abandonadas (listener `stalled` + barrido al arrancar vía `failInFlightConnection`), heartbeat y apagado acotado — Fase 4
- ✓ Estado en tiempo real por SSE (`GET /api/events`) sobre Redis pub/sub, con allowlist de tipos de evento, tope de conexiones y revalidación de sesión en el heartbeat; re-ejecución de discovery bajo demanda (SERV-06, DISC-05) — Fase 4
- ✓ Activity log paginado por cursor, `/api/config` de solo lectura y `/health` que distingue Postgres, Redis y worker; E2E contra sshd, Redis y worker reales, canary de fuga extendido a HTTP y SSE, boot smoke de dos procesos; 865 unit — Fase 4. Pendiente antes de Fase 5: cuatro amenazas abiertas en `04-SECURITY.md`, un bypass de TOFU en `editServer` y dos sub-tests flaky de `events-sse.test.ts` por verificar en CI

### Active

Alcance del primer milestone: **v0.1 Foundation** del roadmap ([docs/roadmap-v0.1-v0.5.md](../docs/roadmap-v0.1-v0.5.md), sección 6).

- [ ] Instalación de Noodara en un VPS Ubuntu con un solo comando, al nivel de simplicidad de Coolify y Dokploy.
- [ ] Vista de detalle del servidor con hostname, status, OS, CPU, RAM, disk, uptime, Docker y last seen.
- [ ] Configuración global del control plane.
- [ ] Suite de calidad: unit ≥95% en core-domain, integration con infraestructura temporal (Testcontainers) para los escenarios SSH del roadmap, E2E del flujo connect-server, CI verde.
- [ ] UI conforme al design system Apple-inspired de Noodara (dark y light), con el flujo login → Servers → add server → connect → discovery → detail.
- [ ] Discovery mostrado paso a paso con pass/fail por check en la UI.

### Out of Scope

- Projects, Environments, Services, deployments Docker y Git — v0.2; v0.1 solo demuestra conexión y discovery.
- Deployment engine, webhooks, healthchecks, rollback — v0.3.
- Dominios, reverse proxy (Traefik), TLS, env vars y secrets de aplicación — v0.4.
- Observabilidad, Infrastructure Graph, AI read-only, evals — v0.5.
- Noodara Agent instalado en el servidor — v0.1 opera vía SSH desde el control plane; research evaluará en qué versión entra el agent.
- Debian, CentOS, Alpine, Windows, macOS como servidores objetivo — solo Ubuntu LTS hasta que v0.1 esté validada.
- Multiusuario, roles, equipos, SSO — un único admin local basta para indie devs en v0.1.
- Kubernetes, provisioning cloud, CI/CD genérico, monitoring avanzado, DB HA, multi-node, AI con escritura, billing, multi-tenancy cloud — fuera hasta después de v0.5 por definición del roadmap.

## Context

- **Origen:** el usuario (Pablo Gutiérrez) define el producto a partir de un roadmap técnico detallado v0.1–v0.5 que ya fija principios de ingeniería (TDD obligatorio, Definition of Done, pirámide de tests), principios de diseño y criterios de aceptación por versión. Ese documento es la fuente de verdad del alcance.
- **Referencias de producto:** Coolify y Dokploy. Noodara debe igualar su facilidad de instalación y despliegue desde el inicio; su diferencial es entender la infraestructura, no solo administrarla.
- **Repositorio:** repo público en GitHub. Por ahora solo se hacen commits locales, siempre con la autoría del usuario y sin atribución a asistentes de IA. Los archivos `CLAUDE.md` y `.claude/` están fuera de versión (gitignore). El repo git raíz es `~/work/myself`; este proyecto vive en `noodara/code/` como subdirectorio anidado.
- **Guía operativa del repo:** `CLAUDE.md` (local) y siete skills de proyecto en `.claude/skills/` (`noodara-tdd`, `noodara-security`, `noodara-domain-model`, `noodara-ux-apple`, `noodara-ux-review`, `noodara-ai-readonly`, `noodara-release-gate`) que codifican TDD, seguridad, modelo de dominio y design system.
- **Design system:** inspirado en Apple (HIG y apple.com): un solo color de acción, hairlines y escalones de superficie en lugar de sombras, tipografía del sistema, dark-first con light obligatorio, progressive disclosure. Biblioteca de referencias locales en `~/.claude/design-references/design-md/` (apple, linear.app, vercel, raycast).
- **Idioma:** código, commits, copy de UI y errores de producto en inglés; documentación de planificación en español.

## Constraints

- **Tech stack (fijado por roadmap):** TypeScript estricto, PostgreSQL, Redis, Docker, Traefik (v0.4), Vitest, Playwright, Testcontainers, Supertest, MSW. Las piezas restantes (framework HTTP, ORM, framework web, monorepo tooling, queue) las decide la fase de research con documentación actual y el usuario las aprueba.
- **Compatibilidad:** servidores objetivo Ubuntu 22.04 LTS y 24.04 LTS en v0.1.
- **Seguridad:** credenciales y secrets cifrados at-rest; nunca en API responses, logs, telemetría ni contexto AI; timeouts explícitos en toda operación remota; restricciones aplicadas en backend.
- **Calidad:** TDD (RED → GREEN → REFACTOR) obligatorio; core-domain ≥95% statement y branch; cero tests skipped sin justificación, cero flaky, cero errores de TypeScript y lint; CI verde como condición de terminado.
- **Instalación:** un comando en un VPS limpio debe dejar Noodara operativo; sin pasos manuales de SSH en el happy path.
- **Alcance:** orden estricto de versiones; nada de v0.2+ salvo que desbloquee un criterio de aceptación de v0.1.
- **Licencia:** Apache-2.0 (misma que Coolify y Dokploy; concesión de patentes explícita). Archivo LICENSE commiteado; el usuario puede cambiar a MIT si lo prefiere.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Primer milestone = solo v0.1 Foundation | Un milestone por versión del roadmap permite revisar arquitectura y producto antes de crecer | — Pending |
| Público objetivo inicial: devs indie / solo con un VPS | Mismo público que Coolify/Dokploy; exige instalación de un comando y onboarding cuidado desde v0.1 | — Pending |
| v0.1 opera por SSH desde el control plane, sin agent | Reduce superficie y complejidad; el roadmap no exige agent para conectar y descubrir | ✓ Good (Fase 2) |
| `UNSUPPORTED_OS` y Docker ausente son advertencias con el servidor en CONNECTED (D-11/D-12 fase 2), revirtiendo el mapeo a ERROR de la fase 1 | El admin ve su servidor y sus datos; v0.2 bloqueará el deploy sobre él | ✓ Good (Fase 2) |
| Tests de integración nunca dependen del resolver DNS de la máquina (ADR 0004 row 4 resultó variable) | Un spike midió `client-timeout` y otra máquina dio `client-socket`; se aserta la unión de formas | ✓ Good (Fase 2) |
| Stack abierto lo decide research | Evita fijar librerías con datos desactualizados; el usuario aprueba en la revisión de requisitos | — Pending |
| Licencia Apache-2.0 | Alineada con Coolify/Dokploy, incluye grant de patentes, protege contribuidores | — Pending (LICENSE commiteado; MIT sigue siendo opción) |
| Stack v0.1: pnpm + Turborepo, Fastify 5, Drizzle, BullMQ, ssh2, pino, Zod 4, TypeScript 6.0, Node 22 LTS | Research 2026-09-10: TS 7 bloqueado por typescript-eslint; Redis ya fijado hace a BullMQ la opción natural; Drizzle es el precedente de Dokploy | ✓ Good (Fase 1) |
| Runtime: `packages/domain` compilado a `dist` con exports a `dist`, tests con alias a `src`, `tsx` para dev y CLI, node puro para `start` (ADR 0003) | Gap de la fase 1: Node no remapea `.js`→`.ts` y el paquete exportaba fuentes | ✓ Good (Fase 1) |
| Auth con Better Auth (email/password + Drizzle adapter) | Sucesor de Lucia, menos código propio que auditar; lo usa Dokploy. Aprobado por el usuario | — Pending |
| UI web con Next.js 16 App Router como cliente delgado de la API Fastify | Madurez y ecosistema; revisar TanStack Start en v0.2 si crece la superficie en tiempo real. Aprobado por el usuario | — Pending |
| Clave SSH por defecto, password como fallback documentado | Cumple el roadmap; ambos competidores priorizan clave. Aprobado por el usuario | — Pending |
| Adiciones a v0.1: setup token, sudo no-root, narrativa de discovery, pre-seed de admin | Recomendadas por research (features + pitfalls); bajo costo, alto valor de confianza. Aprobadas por el usuario | — Pending |
| Topología: Docker Compose con api y worker separados, SSE para estado en tiempo real, DiscoverySnapshot append-only, key-version en filas cifradas | Research de arquitectura: evita refactors forzados en v0.3 y v0.5 | ✓ Good (Fase 4: api y worker separados + SSE; Compose llega en Fase 6) |
| JobId de BullMQ `connect-<serverId>` con guion, y borrado del job terminal retenido antes de re-encolar | BullMQ 6.x rechaza `:` en ids custom; un job `completed` retenido hacía que todo re-discover posterior fuera un no-op silencioso (hallado por el E2E de 04-11) | ✓ Good (Fase 4) |
| TDD obligatorio y DoD estricto desde v0.1 | Definido en el roadmap; el valor central es confiabilidad, no velocidad | — Pending |
| Design system Apple-inspired dark-first | Principios de diseño del roadmap + preferencia explícita del usuario por UX de Apple | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-19 after Phase 4 completion*
