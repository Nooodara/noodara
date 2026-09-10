# Noodara

## What This Is

Noodara es un PaaS open-source, self-hostable y AI-native que despliega, opera y **entiende** aplicaciones e infraestructura sobre servidores propios. Está pensado para desarrolladores indie y solo con uno o pocos VPS que hoy usan Coolify o Dokploy y quieren la misma facilidad de instalación y despliegue, más una capa de comprensión de su infraestructura (grafo, diagnóstico, preguntas en lenguaje natural) que esas herramientas no tienen.

Lema: *Your infrastructure, understood.* Principio interno de producto: *Complex infrastructure. Calm interface.*

## Core Value

Noodara puede conocer, registrar y comunicarse con infraestructura real de forma **segura y consistente**: sin fugas de credenciales, sin estados falsos, sin caídas por fallos del servidor remoto. Si esto no funciona, nada de lo que se construya encima vale.

## Requirements

### Validated

(None yet — ship to validate)

### Active

Alcance del primer milestone: **v0.1 Foundation** del roadmap ([docs/roadmap-v0.1-v0.5.md](../docs/roadmap-v0.1-v0.5.md), sección 6).

- [ ] Instalación de Noodara en un VPS Ubuntu con un solo comando, al nivel de simplicidad de Coolify y Dokploy.
- [ ] Control plane con PostgreSQL, migraciones versionadas, autenticación local de un usuario admin y gestión de sesión.
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
- **Licencia:** Apache-2.0 (misma que Coolify y Dokploy; concesión de patentes explícita). Pendiente de confirmación del usuario, que consideraba MIT.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Primer milestone = solo v0.1 Foundation | Un milestone por versión del roadmap permite revisar arquitectura y producto antes de crecer | — Pending |
| Público objetivo inicial: devs indie / solo con un VPS | Mismo público que Coolify/Dokploy; exige instalación de un comando y onboarding cuidado desde v0.1 | — Pending |
| v0.1 opera por SSH desde el control plane, sin agent | Reduce superficie y complejidad; el roadmap no exige agent para conectar y descubrir | — Pending |
| Stack abierto lo decide research | Evita fijar librerías con datos desactualizados; el usuario aprueba en la revisión de requisitos | — Pending |
| Licencia Apache-2.0 | Alineada con Coolify/Dokploy, incluye grant de patentes, protege contribuidores | — Pending (usuario consideraba MIT) |
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
*Last updated: 2026-09-10 after initialization*
