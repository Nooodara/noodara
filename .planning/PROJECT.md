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

### Active

Alcance del primer milestone: **v0.1 Foundation** del roadmap ([docs/roadmap-v0.1-v0.5.md](../docs/roadmap-v0.1-v0.5.md), sección 6).

- [ ] Instalación de Noodara en un VPS Ubuntu con un solo comando, al nivel de simplicidad de Coolify y Dokploy.
- [ ] Registrar, editar y eliminar servidores con host, puerto SSH y usuario SSH configurables, y credencial (clave o password) cifrada at-rest.
- [ ] Probar conectividad y reflejar el estado real del servidor: PENDING, CONNECTING, CONNECTED, DISCONNECTED, UNREACHABLE, ERROR.
- [ ] Discovery del servidor: hostname, distribución, versión de OS, arquitectura, CPU, RAM, disco, uptime, Docker instalado y su versión.
- [ ] Vista de detalle del servidor con hostname, status, OS, CPU, RAM, disk, uptime, Docker y last seen.
- [ ] Activity log de las operaciones relevantes sobre servidores y sesión.
- [ ] Configuración global del control plane.
- [ ] Credenciales nunca expuestas en API responses, logs, errores ni telemetría; timeouts explícitos en SSH; estrategia de host fingerprint (TOFU) definida; eliminar servidor elimina sus credenciales.
- [ ] Soporte comprobado para Ubuntu 22.04 LTS y 24.04 LTS.
- [ ] Suite de calidad: unit ≥95% en core-domain, integration con infraestructura temporal (Testcontainers) para los escenarios SSH del roadmap, E2E del flujo connect-server, CI verde.
- [ ] UI conforme al design system Apple-inspired de Noodara (dark y light), con el flujo login → Servers → add server → connect → discovery → detail.
- [ ] Usuario SSH no-root con sudo sin password soportado, con validación de sudo y grupo docker durante el discovery.
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
| v0.1 opera por SSH desde el control plane, sin agent | Reduce superficie y complejidad; el roadmap no exige agent para conectar y descubrir | — Pending |
| Stack abierto lo decide research | Evita fijar librerías con datos desactualizados; el usuario aprueba en la revisión de requisitos | — Pending |
| Licencia Apache-2.0 | Alineada con Coolify/Dokploy, incluye grant de patentes, protege contribuidores | — Pending (LICENSE commiteado; MIT sigue siendo opción) |
| Stack v0.1: pnpm + Turborepo, Fastify 5, Drizzle, BullMQ, ssh2, pino, Zod 4, TypeScript 6.0, Node 22 LTS | Research 2026-09-10: TS 7 bloqueado por typescript-eslint; Redis ya fijado hace a BullMQ la opción natural; Drizzle es el precedente de Dokploy | ✓ Good (Fase 1) |
| Runtime: `packages/domain` compilado a `dist` con exports a `dist`, tests con alias a `src`, `tsx` para dev y CLI, node puro para `start` (ADR 0003) | Gap de la fase 1: Node no remapea `.js`→`.ts` y el paquete exportaba fuentes | ✓ Good (Fase 1) |
| Auth con Better Auth (email/password + Drizzle adapter) | Sucesor de Lucia, menos código propio que auditar; lo usa Dokploy. Aprobado por el usuario | — Pending |
| UI web con Next.js 16 App Router como cliente delgado de la API Fastify | Madurez y ecosistema; revisar TanStack Start en v0.2 si crece la superficie en tiempo real. Aprobado por el usuario | — Pending |
| Clave SSH por defecto, password como fallback documentado | Cumple el roadmap; ambos competidores priorizan clave. Aprobado por el usuario | — Pending |
| Adiciones a v0.1: setup token, sudo no-root, narrativa de discovery, pre-seed de admin | Recomendadas por research (features + pitfalls); bajo costo, alto valor de confianza. Aprobadas por el usuario | — Pending |
| Topología: Docker Compose con api y worker separados, SSE para estado en tiempo real, DiscoverySnapshot append-only, key-version en filas cifradas | Research de arquitectura: evita refactors forzados en v0.3 y v0.5 | — Pending |
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
*Last updated: 2026-09-12 after Phase 1 completion*
