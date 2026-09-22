# Roadmap: Noodara

## Milestones

- ✅ **v0.1 Foundation** — Phases 1-6 (shipped 2026-09-22) — [archive](milestones/v0.1-ROADMAP.md), [requirements](milestones/v0.1-REQUIREMENTS.md), [release gate](../docs/releases/v0.1-gate.md)
- 🔜 **v0.2 Projects & Services** — not yet planned (`/gsd-new-milestone`); scope in `docs/roadmap-v0.1-v0.5.md` §7

## Phases

<details>
<summary>✅ v0.1 Foundation (Phases 1-6) — SHIPPED 2026-09-22</summary>

- [x] Phase 1: Dominio, persistencia y autenticación (17/17 plans) — completed 2026-09-12 — Base de datos migrada, dominio ≥95% cubierto y un admin único que inicia/cierra sesión de forma segura.
- [x] Phase 2: Adaptador SSH aislado y probado con Testcontainers (10/10 plans) — completed 2026-09-15 — Conexión SSH con TOFU, timeouts, allowlist de comandos y discovery, validado contra un `sshd` real.
- [x] Phase 3: Servicios de aplicación, activity log y redacción (10/10 plans) — completed 2026-09-16 — Registrar/editar/eliminar servidores, snapshots de discovery y un activity log sin fugas de secrets.
- [x] Phase 4: HTTP routes, worker BullMQ y SSE (11/11 plans) — completed 2026-09-18 — La API expone connect/discover en background y el estado llega a tiempo real sin polling.
- [x] Phase 5: UI web (46/46 plans) — completed 2026-09-21 — El flujo login → Servers → add → connect → discovery → detail funciona en el design system Apple-inspired, dark y light.
- [x] Phase 6: Instalador y Docker Compose (15/15 plans) — completed 2026-09-22 — Un comando deja Noodara operativo en un VPS Ubuntu limpio, de forma idempotente.

Full phase details, plans and success criteria: [milestones/v0.1-ROADMAP.md](milestones/v0.1-ROADMAP.md).
</details>

## Progress

| Milestone | Phases | Plans | Status | Shipped |
|---|---|---|---|---|
| v0.1 Foundation | 6 | 109/109 | Complete | 2026-09-22 |
| v0.2 Projects & Services | — | — | Not started | |
