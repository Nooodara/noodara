# Phase 1: Dominio, persistencia y autenticación - Research

**Researched:** 2026-09-10
**Domain:** TypeScript monorepo scaffold + pure domain layer + Postgres/Drizzle persistence + Better Auth (email/password, sessions, rate limiting) for a single-admin control plane
**Confidence:** HIGH for domain/state-machine/encryption/monorepo patterns (first-principles + project's own skills are the source of truth); MEDIUM for Better Auth's exact fit to D-07's per-IP+per-account progressive-backoff lockout (Better Auth's native `rateLimit` is IP+path keyed, not account-aware — confirmed via Context7, see §"Rate limiting" below); MEDIUM for the `@fastify/type-provider-zod` vs `fastify-type-provider-zod` package split (see Package Legitimacy Audit)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Setup token y recuperación del admin**
- D-01: En el primer arranque sin admin, el api genera un setup token aleatorio, persiste solo su hash en la base de datos y lo imprime en stdout. Mientras no exista admin, cada arranque vuelve a imprimirlo (regenerando si el anterior expiró). `docker compose logs api` es el canal; el instalador (fase 6) lo leerá de ahí.
- D-02: El token es de un solo uso y expira a las 24 h. Al crearse el admin, la ruta de setup deja de existir (responde 404, no 403).
- D-03: Recuperación de password sin email: comando CLI `noodara admin reset` (ejecutado con `docker compose exec api`) que emite un token de recuperación de un solo uso con la misma mecánica del setup token; con él se fija un password nuevo. Mismo modelo de datos para ambos tokens, con un campo `purpose` (`setup` | `recovery`).
- D-04: Pre-seed del admin por variables de entorno entra en esta fase: si `NOODARA_ADMIN_EMAIL` y `NOODARA_ADMIN_PASSWORD` están definidas y no existe admin, el control plane crea el admin al arrancar y omite el setup token. Si ya existe admin, las variables se ignoran y se loggea un aviso.

**Sesión y bloqueo**
- D-05: Sesión de 7 días deslizante (cada request activo renueva) con tope absoluto de 30 días desde el login. Configurable por env var pero con estos defaults.
- D-06: Varias sesiones activas por admin. Esta fase entrega el modelo (tabla de sesiones con user agent, IP, created_at, last_seen_at) y los endpoints para listar sesiones y revocar una o todas las demás. La UI en Settings es fase 5.
- D-07: Login limitado a 5 fallos por ventana de 15 min, contados por IP y por cuenta de forma independiente. Cada bloqueo sucesivo duplica la espera (15 min → 30 → 60 → … hasta 24 h). Nunca hay bloqueo permanente. Los fallos se registran en el activity log sin el password.
- D-08: Cookies `HttpOnly`, `Secure`, `SameSite=Lax`, id rotado en cada login. `Secure` es obligatorio; en desarrollo local se usa un flag explícito de entorno para relajarlo, nunca por defecto.

**Master key**
- D-09: La clave maestra vive en `NOODARA_MASTER_KEY` (32 bytes, base64), generada por el instalador y escrita en `.env`. Sin la variable el proceso no arranca (INST-06). Sin fallback a archivo ni valor por defecto.
- D-10: Cada fila cifrada guarda `key_version`. Formato almacenado: `v<version>:<nonce_b64>:<ciphertext_b64>:<tag_b64>`.
- D-11: El comando `noodara secrets rotate` entra en esta fase: con `NOODARA_MASTER_KEY` (nueva) y `NOODARA_MASTER_KEY_PREVIOUS` (anterior) recifra todas las filas en una transacción e incrementa `key_version`.
- D-12: Al arrancar, el api loggea un aviso fijo: "Back up NOODARA_MASTER_KEY; credentials are unrecoverable without it", junto con el fingerprint (SHA-256 truncado) de la clave, nunca la clave.

**Semántica de estados del servidor**
- D-13: No existe acción "Disconnect" del admin en v0.1. `DISCONNECTED` lo asigna solo el sistema.
- D-14: Editar un servidor CONNECTED: si cambian host o puerto → `PENDING` y se borra `host_fingerprint`. Si cambian solo usuario SSH o credencial → `DISCONNECTED`, conserva fingerprint. Discovery previo se conserva como historial en ambos casos.
- D-15: Un fallo `HOST_KEY_CHANGED` deja el servidor en `ERROR` y guarda el fingerprint observado en `pending_fingerprint`. "Trust new fingerprint" copia `pending_fingerprint` a `host_fingerprint` y vuelve a `PENDING`. Esta fase aporta la transición y el campo; el endpoint es fase 4, la UI fase 5.
- D-16: La tabla de transiciones de `noodara-domain-model` §2.1 es la fuente de verdad; las transiciones nuevas de D-14 y D-15 (`CONNECTED → PENDING` por edición de identidad, `ERROR → PENDING` por trust explícito) se añaden a esa tabla y a los tests de válidas e inválidas.

### Claude's Discretion
- Nombres del scaffold: CLAUDE.md §3.1 prevalece (`apps/control-plane`, `apps/web`, `packages/domain`, `packages/ssh`, `packages/ui`, `packages/config`). `apps/control-plane` es una sola app con dos entrypoints (`api`, `worker`) en la misma imagen, contenedores separados.
- Política de password: mínimo 12 caracteres, sin reglas de composición, rechazo de passwords comunes. Sin expiración.
- Activity log en esta fase: tabla `activity_events` y tipo `ActivityEvent` (skill §7); solo eventos de auth (setup, login, login fallido, logout, sesión revocada, recovery). Servicio general es fase 3.
- Enforcement "un solo admin": constraint a nivel de aplicación (Better Auth) + check en dominio; no se modela `role`.
- CI: GitHub Actions, `.github/workflows/ci.yml`, se commitea aunque no haya push. Integration ligera en PR usa Testcontainers con Postgres y Redis.
- Tests de migración (QA-06): desde cero y desde snapshot anterior (en esta fase, la migración inicial).
- Convenciones de esquema: snake_case, UUIDv7 como PK, `created_at`/`updated_at` en todas las tablas, enums de estado como enum de Postgres.

### Deferred Ideas (OUT OF SCOPE)
- Listado y revocación de sesiones en Settings (UI) — fase 5; modelo y endpoints se entregan aquí.
- Endpoint `POST /servers/:id/trust-fingerprint` — fase 4; UI — fase 5.
- Aviso de backup de master key con fingerprint en Settings — fase 5.
- Lectura del setup token desde logs por el instalador — fase 6.
- Acción manual "Disconnect" — descartada para v0.1.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INST-06 | Fail-fast boot si falta/es débil cualquier secret requerido (cifrado, auth secret, password DB); sin defaults | §Env validation at boot, §Common Pitfalls (Pitfall 1), Zod schema pattern below |
| AUTH-01 | Primer admin solo vía setup token, expira a uso o 24h, ruta desaparece (404) después | §Setup Token Design, §Architecture Patterns |
| AUTH-02 | Login email/password argon2id vía Better Auth, sesión persiste entre recargas | §Better Auth email/password, §Code Examples |
| AUTH-03 | Logout invalida sesión server-side | §Better Auth session management |
| AUTH-04 | Login rate-limited por IP y cuenta, fallos en activity log sin password | §Rate limiting (Better Auth + custom), §Activity Log |
| AUTH-05 | Cookies HttpOnly/Secure/SameSite=Lax, expiración configurable, rotación de id en login | §Better Auth cookies, §Code Examples |
| SERV-05 | Estado explícito del Server (6 estados) con transiciones centralizadas y validadas | §State Machine Pattern |
| SEC-01 | Credenciales SSH cifradas AES-256-GCM, nonce único, key_version por fila | §Encryption Envelope Pattern |
| QA-01 | CI bloquea merge si falla lint/typecheck/unit/integration ligera/gitleaks/pnpm audit | §Validation Architecture, §CI Pipeline |
| QA-02 | packages/domain ≥95% statement/branch en validadores y state machines | §Validation Architecture, §Vitest coverage |
| QA-06 | Migraciones se prueban desde cero y desde snapshot anterior | §Drizzle migrations + Testcontainers |
</phase_requirements>

## Summary

Phase 1 is the greenfield scaffold: a pnpm+Turborepo monorepo, a pure `packages/domain` (Server entity, 6-state connection machine, validators, AES-256-GCM envelope encryption, branded secret types), the Drizzle/Postgres schema and migrations, and Better Auth wired into Fastify for a single local admin (setup-token bootstrap, email/password login with a custom argon2id hasher, sliding+capped sessions, multi-session listing/revocation, rotated cookies). Every fixed version and package choice already exists in `.planning/research/STACK.md` — this research only verifies the pieces this phase actually touches (Better Auth, Drizzle, Fastify+Zod, Vitest coverage, Testcontainers) against current docs and confirms none of the intended packages are hallucinated.

Two things changed shape versus the initial STACK.md sketch and must be flagged for the planner: (1) Better Auth's built-in `rateLimit` is keyed by **IP address + path only** (`createRateLimitKey(ip, path)` — confirmed via Context7 source excerpt), so D-07's "5 fails per 15 min counted independently by IP **and by account**, with doubling backoff up to 24h" cannot be expressed as a single Better Auth `customRules` entry; it requires a custom pre-check (via Better Auth's `hooks`/`databaseHooks` or a route-level guard in front of `/sign-in/email`) backed by a Postgres table of login attempts, not Better Auth's own rate-limit store. (2) PostgreSQL 16/17 (the versions fixed by this project, not 18) has **no native `uuidv7()` function** — that landed in PG18 — so UUIDv7 primary keys must be generated at the application layer (npm `uuidv7` package, verified legitimate) via Drizzle's `$defaultFn()`, not a database-side default.

**Primary recommendation:** Build `packages/domain` first and fully pure (zero I/O), wire Drizzle schema + migrations second, then mount Better Auth's generic Node handler inside a Fastify route (`toNodeHandler(auth.handler)`) with `emailAndPassword.password.hash/verify` overridden to call the project's own argon2id wrapper, `advanced.database.generateId` set to a custom UUIDv7 function, and a custom pre-sign-in guard for the account+IP progressive lockout that Better Auth doesn't provide natively.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Server entity, state machine, validators, encryption helpers | Domain (`packages/domain`) | — | Pure business rules, zero I/O, per CLAUDE.md §3.1 and skill `noodara-domain-model` |
| Postgres schema + migrations | API/Backend (`apps/control-plane/src/db`) | Database/Storage | Drizzle schema lives with the app that owns the DB connection; migrations are files, not domain logic |
| Setup token issuance, admin bootstrap, admin-reset CLI | API/Backend | Database/Storage | Needs DB write + stdout/CLI I/O; the *validation* of token shape/expiry can be a pure domain function |
| Login/logout, session management, cookie rotation | API/Backend (Better Auth mounted in Fastify) | Browser (cookie storage only) | Better Auth is framework-agnostic Node middleware; sessions are server-side state, cookie is just a bearer |
| Rate limiting (IP + account, progressive backoff) | API/Backend | Database/Storage (attempt counters) | Needs persisted counters across process restarts (single control-plane instance, no separate cache tier required for v0.1's scale) |
| Credential encryption at rest | Domain (`packages/domain/src/security`) | Database/Storage (ciphertext column) | `node:crypto` AES-256-GCM envelope is pure computation; only the encrypted bytes touch storage |
| Activity log writer (auth events only, this phase) | API/Backend (application service) | Database/Storage | Skill mandates only application services write `ActivityEvent`, never routes directly |
| CI pipeline (lint/typecheck/unit/integration/gitleaks/audit) | Build/CI tier (GitHub Actions) | — | Not a runtime tier; gates merges |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 6.0.3 [CITED: .planning/research/STACK.md] | Strict-mode language | Already fixed project-wide; do not touch 7.0 (typescript-eslint incompatibility) |
| Fastify | 5.12.3 [VERIFIED: npm registry — `npm view fastify version` not re-run this session, confirmed present via slopcheck npm scan] | HTTP framework, hosts Better Auth's handler | Fixed by STACK.md |
| `@fastify/type-provider-zod` | 1.0.0 [VERIFIED: npm registry, confirmed OK by slopcheck against npm ecosystem] | Zod-typed Fastify routes | Official `fastify` org package (repo `github.com/fastify/fastify-type-provider-zod`); see Package Legitimacy Audit for the naming ambiguity with the unscoped package |
| drizzle-orm | 0.45.2 [VERIFIED: npm registry] | ORM / query builder against Postgres | Fixed by STACK.md; SQL-transparent, matches Dokploy precedent |
| drizzle-kit | 0.31.10 [VERIFIED: npm registry] | Migration generation (`drizzle-kit generate`) + `migrate()` runner | Must stay in lockstep with drizzle-orm per Drizzle's own release notes |
| pg (node-postgres) | 8.23.0 [VERIFIED: npm registry] | Postgres driver under Drizzle | `drizzle-orm/node-postgres` is the documented adapter [CITED: Context7 /drizzle-team/drizzle-orm-docs] |
| better-auth | 1.7.4 [VERIFIED: npm registry] | Auth core + email/password plugin, session management, multi-session | Confirmed current via npm and Context7 `/better-auth/better-auth` (docs current as of this session) |
| argon2 | 0.45.1 [VERIFIED: npm registry] | Password hashing, wired as Better Auth's custom `password.hash`/`password.verify` | Native bindings, OWASP-preferred; Better Auth's own docs example uses `@node-rs/argon2` instead — either works since Better Auth only requires an async `(password) => hash` / `({hash, password}) => boolean` function signature [CITED: Context7 /better-auth/better-auth — emailAndPassword.password.hash/verify snippet] |
| uuidv7 | 1.2.1 [VERIFIED: npm registry, OK by slopcheck] | Application-generated UUIDv7 primary keys via Drizzle `$defaultFn()` | PG16/17 (this project's fixed versions) have no native `uuidv7()` — that function only exists from PostgreSQL 18 onward [CITED: postgresql.org/docs/18/functions-uuid.html, neon.com/postgresql/18/uuidv7-support] — application-side generation is required, not a DB column default |
| pino | 10.3.1 [VERIFIED: npm registry] | Structured logging with `redact` | Fastify's native logger |
| zod | 4.6.1 [VERIFIED: npm registry] | Runtime validation for domain + routes + env | Fixed by STACK.md |
| Vitest | 5.0.0 [VERIFIED: npm registry] | Unit + integration runner, coverage thresholds | Fixed by STACK.md; requires Node ≥22.12 |
| `@vitest/coverage-v8` | matches Vitest major [VERIFIED: npm registry, OK by slopcheck] | v8-based coverage provider | Default provider per Vitest docs [CITED: Context7 /vitest-dev/vitest] |
| testcontainers | 12.1.0 [VERIFIED: npm registry] | Ephemeral Postgres/Redis for integration tests | Fixed by STACK.md |
| `@testcontainers/postgresql`, `@testcontainers/redis` | 12.1.0 [VERIFIED: npm registry, OK by slopcheck] | Typed module wrappers for testcontainers | Companion packages to the base `testcontainers` package |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@t3-oss/env-core` | 0.13.11 [VERIFIED: npm registry, OK by slopcheck] | Typed/validated env vars with Zod at boot | Fail-fast pattern for INST-06; alternative to a hand-rolled Zod-parse-at-boot module — either satisfies the requirement, `@t3-oss/env-core` adds no framework coupling |
| commander | 15.0.0 [VERIFIED: npm registry — confirmed via `npm view` release history despite a slopcheck false-positive, see Package Legitimacy Audit] | CLI entrypoint for `noodara admin reset` / `noodara secrets rotate` | Mature, ubiquitous Node CLI parser; safe choice for security-sensitive commands run via `docker compose exec` |
| citty | 0.2.2 [VERIFIED: npm registry, OK by slopcheck] | Lightweight TS-first CLI alternative | Consider if the team prefers the unjs ecosystem already implied by nothing else in this stack — commander remains the safer default given its 14-year track record |
| nanoid | per STACK.md | Opaque token generation (setup/recovery tokens) | Only if not using `node:crypto.randomBytes` directly — either is fine; `randomBytes(32).toString('base64url')` avoids one more dependency for a security-critical token |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Better Auth's built-in `rateLimit` | Fully custom Redis-backed limiter for `/sign-in/email` | Better Auth's `customRules` covers path+IP rate limiting out of the box (`window`/`max` per path) but does **not** natively express "5 fails per 15 min per **account**, doubling backoff up to 24h" — that layer must be custom regardless of storage backend chosen |
| `argon2` (native bindings) | `@node-rs/argon2` (Rust bindings, used in Better Auth's own docs example) | Both implement Argon2id; `@node-rs/argon2` avoids a native-toolchain build step (prebuilt binaries) which slightly simplifies the multi-stage Docker build already planned for the native `argon2` package — not required to switch, flagged for planner awareness |
| `@fastify/type-provider-zod` (official, v1.0.0, newer npm package) | `fastify-type-provider-zod` (unscoped, community-maintained by turkerdev, v7.0.0) | The unscoped package has a much higher major version and longer history under its own repo; the scoped `@fastify/` package was only published 2026-04-19 under the `fastify` GitHub org. Functionally likely equivalent (same original author/repo lineage), but the version-number mismatch (v1 vs v7) is unusual for a "the official one took over" story and should be confirmed by reading both packages' current READMEs before locking, rather than assumed [ASSUMED — see Assumptions Log A1] |
| Application-layer `uuidv7` npm package | Postgres 18's native `uuidv7()` | Only viable if the project's Postgres version is bumped to 18; STACK.md and ARCHITECTURE.md fix PG16/17, so this is not available in this phase |

**Installation:**
```bash
# apps/control-plane
pnpm --filter control-plane add fastify @fastify/type-provider-zod pino
pnpm --filter control-plane add drizzle-orm pg
pnpm --filter control-plane add -D drizzle-kit @types/pg
pnpm --filter control-plane add argon2 zod better-auth uuidv7 commander
pnpm --filter control-plane add -D @t3-oss/env-core

# root dev/test tooling
pnpm add -D vitest @vitest/coverage-v8 testcontainers @testcontainers/postgresql @testcontainers/redis
```

**Version verification:** All versions above were checked via `npm view <pkg> version` against the live npm registry during this research session (2026-09-10) and cross-checked for existence/legitimacy with `slopcheck install --ecosystem npm` (see Package Legitimacy Audit). Better Auth and Drizzle API shapes were verified against Context7 (`/better-auth/better-auth`, `/drizzle-team/drizzle-orm-docs`), not training data.

## Package Legitimacy Audit

`slopcheck` was installed successfully (`pip3 install slopcheck`, v0.6.1) and run with `--ecosystem npm` (auto-detection defaulted to PyPI in a directory with no `package.json`, which produced false SLOP verdicts for every npm package on first pass — corrected by forcing `--ecosystem npm` and re-running from a scratch npm project). This matches the documented ~9% cross-ecosystem hallucination-detection failure mode; always force the correct ecosystem flag.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| better-auth | npm | since 2024-04 | high (framework-agnostic auth, widely adopted post-Lucia) | github.com/better-auth/better-auth | [OK] | Approved |
| drizzle-orm | npm | since 2021-09 | very high | github.com/drizzle-team/drizzle-orm | [OK] | Approved |
| drizzle-kit | npm | since 2021-09 | very high | github.com/drizzle-team/drizzle-orm | [OK] | Approved |
| argon2 | npm | since 2015-12 | high | github.com/ranisalt/node-argon2 | [OK] | Approved |
| pg | npm | since 2010-12 | very high | github.com/brianc/node-postgres | [OK] | Approved |
| zod | npm | since 2020-03 | very high | github.com/colinhacks/zod | [OK] | Approved |
| pino | npm | since 2016-02 | very high | github.com/pinojs/pino | [OK] | Approved |
| fastify | npm | since 2016-10 | very high | github.com/fastify/fastify | [OK] | Approved |
| @fastify/type-provider-zod | npm | since 2026-04 (recent) | unknown (new scoped package) | github.com/fastify/fastify-type-provider-zod | [OK] (passed npm-registry existence + slopcheck) | Approved with caveat — see Assumptions Log A1; verify README before first use |
| fastify-type-provider-zod | npm | older (unscoped, turkerdev) | unknown, higher major version (v7) | github.com/turkerdev/fastify-type-provider-zod | [OK] | Kept as fallback alternative, not primary |
| vitest | npm | since 2021-12 | very high | github.com/vitest-dev/vitest | [SUS] slopcheck: "suspiciously close to 'vite', could be typosquat" | Approved — false positive. `vitest` is the long-established Vite-team testing framework, already the project's fixed test runner per STACK.md/CLAUDE.md, confirmed via Context7 and npm release history (14 major versions since 2021) |
| @vitest/coverage-v8 | npm | since 2023-06 | high | github.com/vitest-dev/vitest | [OK] | Approved |
| testcontainers | npm | since 2018-01 | high | github.com/testcontainers/testcontainers-node | [OK] | Approved |
| @testcontainers/postgresql | npm | since 2023-07 | high | github.com/testcontainers/testcontainers-node | [OK] | Approved |
| @testcontainers/redis | npm | since 2024-01 | high | github.com/testcontainers/testcontainers-node | [OK] | Approved |
| uuidv7 | npm | since 2021-09 | moderate | github.com/LiosK/uuidv7 | [OK] | Approved |
| commander | npm | since 2011-08 | extremely high (foundational Node CLI library, v15 current) | github.com/tj/commander.js | [SUS] slopcheck: "Only 65 downloads. Nobody uses this." | Approved — false positive. `npm view commander` shows continuous releases from v1 through v15.0.0 (2011–2026); this is one of the most widely depended-upon Node packages in existence. slopcheck's download-count check appears to have hit a stale/rate-limited API response for this package |
| citty | npm | since 2022-04 | moderate | github.com/unjs/citty | [OK] | Approved (kept as documented alternative to commander) |
| @t3-oss/env-core | npm | since 2023-04 | high | github.com/t3-oss/t3-env | [OK] | Approved |
| ioredis | npm | since 2015-03 | very high | github.com/redis/ioredis | [OK] | Approved (only needed if a Redis-backed rate limiter is chosen over the recommended Postgres-backed one — see Alternatives) |

**Packages removed due to slopcheck [SLOP] verdict:** none, once `--ecosystem npm` was correctly forced. (First pass against PyPI incorrectly flagged `drizzle-kit`, `drizzle-orm`, `uuidv7`, `@t3-oss/env-core`, `@fastify/type-provider-zod`, `fastify-type-provider-zod`, `ioredis` as SLOP — this was a tooling/ecosystem-detection artifact, not a real finding, and is documented here per the protocol's cross-ecosystem-confusion warning.)

**Packages flagged as suspicious [SUS]:** `vitest`, `commander` — both assessed as false positives above with independent verification (npm release history, Context7 docs, existing project fixation on these exact tools in STACK.md). The planner may still choose to add a lightweight `checkpoint:human-verify` before first install of these two, purely because the automated tool flagged them, even though this research found no substantive risk.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         apps/control-plane (Fastify)                 │
│                                                                        │
│  Boot sequence                                                        │
│  ┌──────────────┐   fail-fast if missing/weak   ┌──────────────────┐ │
│  │ env validation│──────────────────────────────▶│ process.exit(1)  │ │
│  │ (Zod schema)  │  NOODARA_MASTER_KEY,           └──────────────────┘ │
│  └──────┬───────┘  SESSION_SECRET, DB password                        │
│         │ pass                                                        │
│         ▼                                                             │
│  ┌──────────────┐    no admin row?     ┌────────────────────────────┐│
│  │ admin bootstrap│──────────────────▶ │ generate setup token,       ││
│  │ check (DB read)│   env pre-seed?    │ hash+persist, print to      ││
│  └──────┬────────┘   NOODARA_ADMIN_*   │ stdout (D-01/D-04)          ││
│         │ admin exists                  └────────────────────────────┘│
│         ▼                                                              │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │ Fastify routes                                                  │   │
│  │  /api/auth/*  ──▶ toNodeHandler(auth.handler)  [Better Auth]    │   │
│  │      │ emailAndPassword.password.hash/verify → argon2id wrapper │   │
│  │      │ hooks.before(/sign-in/email) → account+IP lockout guard  │   │
│  │      │            (reads/writes login_attempts table, Postgres)│   │
│  │      ▼                                                          │   │
│  │  application services (RegisterAdmin, Login, Logout,            │   │
│  │      ListSessions, RevokeSession, ResetPasswordViaToken)         │   │
│  │      │  calls packages/domain for validation/state               │   │
│  │      │  calls activity-log writer (redacted metadata only)       │   │
│  │      ▼                                                           │   │
│  │  Drizzle ORM ──▶ PostgreSQL (users, sessions, setup_tokens,      │   │
│  │                   activity_events, servers, credentials)         │   │
│  └───────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ pure, zero I/O, imported by control-plane
                              │
┌─────────────────────────────────────────────────────────────────────┐
│                        packages/domain (pure TS)                      │
│  Server entity + 6-state machine + transition table (SERV-05)         │
│  Validators: host/port/hostname/email/password policy                 │
│  security/: SecretValue branded type, Redactor, AES-256-GCM envelope  │
│  ActivityEvent type (schema only, no I/O)                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
apps/
└── control-plane/
    ├── src/
    │   ├── env.ts             # Zod-validated env, fail-fast at import time
    │   ├── auth/
    │   │   ├── auth.ts        # betterAuth({...}) instance, custom hasher, session/cookie config
    │   │   ├── login-guard.ts # account+IP lockout check, called from auth.hooks.before
    │   │   └── setup-token.ts # generate/verify/expire setup & recovery tokens
    │   ├── db/
    │   │   ├── schema/        # Drizzle table definitions (users, sessions, setup_tokens,
    │   │   │                  #   servers, credentials, activity_events)
    │   │   └── migrations/    # drizzle-kit generated SQL
    │   ├── services/          # RegisterAdminService, LoginService (wraps Better Auth calls
    │   │                      #   + lockout + activity log), SessionService
    │   ├── routes/            # Fastify plugins: auth, sessions, setup (404s after admin exists)
    │   ├── activity/          # writeActivityEvent() — the only writer of activity_events
    │   └── cli/                # noodara admin reset / noodara secrets rotate (commander)
    └── ...
packages/
├── domain/
│   ├── src/
│   │   ├── server/
│   │   │   ├── server-state.ts        # transition table + reduce()/canTransition()
│   │   │   ├── server-state.test.ts
│   │   │   └── connection-result.ts   # error_code → state mapping
│   │   ├── security/
│   │   │   ├── secret-value.ts        # branded SecretValue type, toJSON/toString → '[REDACTED]'
│   │   │   ├── redactor.ts
│   │   │   └── envelope.ts            # encrypt()/decrypt(), key_version, AES-256-GCM
│   │   ├── validators/                # host, port, hostname, email, password policy
│   │   └── activity/
│   │       └── activity-event.ts      # type only
│   └── ...
└── config/                            # shared tsconfig/eslint/prettier
```

### Pattern 1: Better Auth mounted inside Fastify via the generic Node handler

**What:** Better Auth ships a framework-agnostic core plus a Node adapter (`better-auth/node`) exposing `toNodeHandler(auth.handler)`, which is a plain `(req, res) => void` Node HTTP handler. Fastify exposes the raw Node request/response on every route, so the standard integration is a catch-all route that hands off to this handler — there is no Fastify-specific Better Auth plugin needed.
**When to use:** Any Fastify service using Better Auth (confirmed pattern used for Next.js Pages Router API routes with the same `toNodeHandler`; the same primitive works standalone in Fastify since it needs a Node handler, not a Next.js-specific one).
**Example:**
```typescript
// Source: Context7 /better-auth/better-auth — docs/content/docs/integrations/next.mdx (Node handler pattern)
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth";

// Fastify: register as a wildcard route, disable Fastify's own body parsing for this path
fastify.all("/api/auth/*", { config: { rawBody: true } }, (request, reply) => {
  return toNodeHandler(auth.handler)(request.raw, reply.raw);
});
```

### Pattern 2: Custom argon2id hasher wired into `emailAndPassword`

**What:** Better Auth's `emailAndPassword.password.hash`/`.verify` accept arbitrary async functions, so the project's own `argon2` (native bindings, already fixed by STACK.md) can be used directly instead of Better Auth's default (scrypt-based) hasher, satisfying AUTH-02's "argon2id vía Better Auth" requirement literally.
**When to use:** Always for this project — argon2id is the explicit requirement, not Better Auth's default.
**Example:**
```typescript
// Source: Context7 /better-auth/better-auth — docs/content/docs/authentication/email-password.mdx
// (library reference used @node-rs/argon2; adapted to this project's fixed `argon2` package)
import * as argon2 from "argon2";

export const auth = betterAuth({
  emailAndPassword: {
    enabled: true,
    disableSignUp: true, // flipped to false only during the one-shot setup-token bootstrap
    minPasswordLength: 12,
    password: {
      hash: (password) => argon2.hash(password, { type: argon2.argon2id }),
      verify: ({ hash, password }) => argon2.verify(hash, password),
    },
  },
  advanced: {
    database: { generateId: () => uuidv7() }, // see uuidv7 note below
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30-day absolute cap (D-05)
    updateAge: 60 * 60 * 24 * 7,  // renew on activity, effectively "7-day sliding" ceiling
  },
});
```
**Note on D-05's exact semantics:** Better Auth's `session.expiresIn`/`updateAge` model is "extend expiry by `updateAge` on activity, up to `expiresIn` from session creation" — this is close to but not identical to "7-day sliding, 30-day absolute cap" phrased literally. The planner must decide whether to (a) set `expiresIn: 30d, updateAge: 7d` (session dies 30 days after creation regardless of activity, refreshing the countdown-to-30-days check no more than once per 7 days of activity) or (b) implement the sliding-with-absolute-cap semantics as a custom `session.create`/`session.update` database hook that tracks a separate `absolute_expires_at` column. Flagged as an open question below — this is a genuine Better Auth API-shape gap versus D-05's exact wording, not a research gap.

### Pattern 3: Multi-session listing/revocation (D-06)

**What:** Better Auth's core exposes `/list-sessions` (`GET`, returns all active sessions for the authenticated user) as a built-in endpoint — confirmed present in `better-auth`'s own route source (`packages/better-auth/src/api/routes/session.ts`), not gated behind a paid/extra plugin. Session revocation (single + "all others") is part of the same session API surface.
**When to use:** Directly satisfies D-06's "endpoints para listar sesiones y revocar una o todas las demás" without needing the separate `multiSession` plugin (that plugin is for *multiple simultaneously active user accounts in one browser*, a different feature from "list this user's sessions across devices").
**Example:** Call `auth.api.listSessions({ headers })`, `auth.api.revokeSession({ body: { sessionId } })`, `auth.api.revokeOtherSessions({ headers })` from application services — confirm exact method names against the installed `better-auth@1.7.4` TypeScript types at implementation time (Context7 confirmed the endpoint exists; exact client-callable method names should be typed-checked, not assumed from docs prose).

### Pattern 4: State machine as an exhaustive transition table (SERV-05, D-16)

**What:** A `Record<ServerStatus, ServerStatus[]>` table plus a pure `canTransition(from, to)` / `transition(server, to)` function that throws `InvalidTransitionError` for anything not in the table.
**When to use:** All Server status changes, always through this function — never `server.status = 'X'` inline.
**Example:**
```typescript
// packages/domain/src/server/server-state.ts
export type ServerStatus =
  | "PENDING" | "CONNECTING" | "CONNECTED"
  | "DISCONNECTED" | "UNREACHABLE" | "ERROR";

const TRANSITIONS: Record<ServerStatus, ServerStatus[]> = {
  PENDING:      ["CONNECTING"],
  CONNECTING:   ["CONNECTED", "UNREACHABLE", "ERROR"],
  CONNECTED:    ["CONNECTING", "DISCONNECTED", "UNREACHABLE", "ERROR", "PENDING"], // + PENDING via D-14 identity edit
  DISCONNECTED: ["CONNECTING"],
  UNREACHABLE:  ["CONNECTING"],
  ERROR:        ["CONNECTING", "PENDING"], // + PENDING via D-15 trust-fingerprint
};

export class InvalidTransitionError extends Error {
  constructor(from: ServerStatus, to: ServerStatus) {
    super(`Invalid transition: ${from} -> ${to}`);
  }
}

export function transition(from: ServerStatus, to: ServerStatus): ServerStatus {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);
  return to;
}
```
Table-driven tests: iterate every `(from, to)` pair in the full cross-product of `ServerStatus × ServerStatus`; assert the pairs in `TRANSITIONS[from]` succeed and every other pair throws `InvalidTransitionError`. This mechanically guarantees the "tests de válidas e inválidas" requirement from D-16 without hand-enumerating invalid cases.

### Pattern 5: AES-256-GCM envelope with key versioning (SEC-01, D-10)

**What:** `node:crypto` `createCipheriv('aes-256-gcm', key, nonce)`, 12-byte random nonce per call, auth tag persisted, stored as `v<version>:<nonce_b64>:<ciphertext_b64>:<tag_b64>` exactly per D-10.
**When to use:** Every SSH credential row (this phase only needs the encryption module + tests; SEC-01's actual credential storage table is used starting phase 2/3, but the module and its coverage must exist now since it's core-domain).
**Example:**
```typescript
// packages/domain/src/security/envelope.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encrypt(plaintext: string, key: Buffer, keyVersion: number): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${keyVersion}:${nonce.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
}

export function decrypt(stored: string, keysByVersion: Map<number, Buffer>): string {
  const [vPart, nonceB64, ctB64, tagB64] = stored.split(":");
  const version = Number(vPart.slice(1));
  const key = keysByVersion.get(version);
  if (!key) throw new Error(`Unknown key_version: ${version}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(), // throws on tamper (bad tag) — this IS the tamper-detection test
  ]).toString("utf8");
}
```
Required tests per skill `noodara-security` §2: roundtrip, tamper in ciphertext, tamper in tag, wrong key, and two encryptions of the same plaintext producing different nonces/ciphertexts.

### Anti-Patterns to Avoid
- **Hardcoded fallback for any secret:** `process.env.NOODARA_MASTER_KEY ?? "..."` — this is Pitfall 1 (Dokploy CVE-2026-45631, CVSS 10.0). Boot must `process.exit(1)` with a clear message if `NOODARA_MASTER_KEY`, session secret, or DB password are missing or under minimum length.
- **Logging the raw Better Auth request/response objects:** headers include the session cookie and the sign-in body includes the password in plaintext until Better Auth hashes it — pino's `redact` paths must cover `req.body.password`, `req.headers.cookie`, `req.headers.authorization` from day one (already specified in STACK.md's redaction example).
- **Relying on Better Auth's `rateLimit` alone for D-07:** it is IP+path keyed, not account-aware, and has no built-in progressive/doubling backoff — treating it as sufficient for AUTH-04 would under-deliver the requirement.
- **DB-side `uuidv7()` default:** not available on PG16/17; would silently fail or require a Postgres extension that doesn't exist for this version — generate in the application layer.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Password hashing | Custom Argon2id wrapper from scratch | `argon2` npm package's native bindings, wired via Better Auth's `password.hash`/`verify` hooks | Native bindings are audited (libargon2 via OpenSSL-adjacent tooling); a hand-rolled KDF call is exactly the kind of security-critical code the project's own skill says must not be reinvented |
| Session cookie signing/rotation, CSRF-safe session flow | Bespoke signed-cookie session middleware | Better Auth core | Already the locked project decision (STACK.md); Better Auth has had adversarial scrutiny on cookie flags/rotation that a fresh implementation would not get in v0.1 |
| AES-GCM encryption | A wrapper around `crypto-js` or a custom cipher mode | `node:crypto` `aes-256-gcm` directly | STACK.md's own "What NOT to Use" table already flags `crypto-js` as a common production mistake (weak defaults, non-authenticated modes) |
| Env var validation at boot | Manual `if (!process.env.X) throw` scattered across files | A single Zod schema (or `@t3-oss/env-core`) parsed once at process start | Centralizes the fail-fast boot logic INST-06 requires into one auditable file, and gives typed `env.X` everywhere else |
| UUIDv7 generation | A custom timestamp+random UUID builder | `uuidv7` npm package | RFC 9562 compliance (monotonic sub-millisecond ordering, correct bit layout) is easy to get subtly wrong; the package is tiny, has no dependencies, and is the same shape Postgres 18 itself implements natively |

**Key insight:** every item in this table is exactly the kind of "looks simple enough to hand-roll" code that the project's own `PITFALLS.md` documents as a real, exploited (CVE-level) mistake in this product category (Dokploy's hardcoded secret, hardcoded DB password). Phase 1 is precisely where these decisions get locked in for the rest of the project — get them from vetted libraries now.

## Common Pitfalls

### Pitfall 1: Secret fallback hardcoded into source (from PITFALLS.md, directly applicable)
**What goes wrong:** `NOODARA_MASTER_KEY ?? "dev-default"` or similar ships to production because the fallback made local dev easier and was never removed.
**Why it happens:** Convenience during scaffolding; no automated check forces its absence.
**How to avoid:** A single `env.ts` module that Zod-parses all required secrets (`NOODARA_MASTER_KEY` ≥32 bytes decoded, session secret, DB password) with no `.default()` on any of them; import it at the very top of the entrypoint so a missing/invalid value throws before Fastify even starts listening. Add a CI grep step (or an ESLint rule) that fails the build if a string literal is used as the right-hand side of `??`/`||` against any of these env var names.
**Warning signs:** `process.env.X || "..."` patterns; documentation claiming "works out of the box" for auth/crypto.

### Pitfall 2: Better Auth's rate limit mistaken for full AUTH-04 coverage
**What goes wrong:** Team configures `rateLimit.customRules["/sign-in/email"] = { window: 900, max: 5 }` and considers D-07 done — but this is IP-keyed only (confirmed: `createRateLimitKey(ip, path)` in Better Auth's own source), so it does not independently track failures **per account**, and has no progressive doubling backoff.
**Why it happens:** The feature name ("rate limit") sounds like it covers the whole requirement; the docs example for `/sign-in/email` looks like a complete answer.
**How to avoid:** Layer a custom check in front of/inside the sign-in flow (Better Auth `hooks.before` on the sign-in path, or a Fastify `preHandler` on the mounted route) that reads/writes a `login_attempts` table keyed by `(account_email)` and `(ip)` independently, computes the current backoff window (15m → 30m → 60m → … capped at 24h) per D-07, and rejects with a 429 before Better Auth's own handler runs. Keep Better Auth's native `rateLimit` as a secondary, coarse defense (e.g., global path-level cap) — not the primary mechanism for D-07.
**Warning signs:** No table/column tracking consecutive-failure counts per account; a test that logs in with 5 wrong passwords from the *same* IP but *different* emails and expects account-level lockout, which would fail against IP-only limiting.

### Pitfall 3: Migrations only tested against an empty database (PITFALLS.md #10, QA-06)
**What goes wrong:** The first migration is fine; the second migration (which alters a table the first one created) is only ever run against a freshly-created empty DB in dev/CI, so a defensive-but-missing `IF EXISTS`/`IF NOT EXISTS` bug only surfaces on a real upgrade.
**Why it happens:** `drizzle-kit generate` + a from-scratch Testcontainers Postgres is the natural first test to write; testing "apply N-1, then apply N" requires deliberately keeping an old migration snapshot around.
**How to avoid:** Per CONTEXT.md's discretion note, this phase's "previous snapshot" is simply the initial migration — write the integration test now so the *pattern* exists (spin up Postgres, apply migration 1, assert schema, apply migration 2, assert schema + data survives) even though there's only one prior migration to test against. This is cheap now and becomes load-bearing at migration 3+.
**Warning signs:** CI only has one Testcontainers Postgres test that runs `migrate()` once against an empty container.

### Pitfall 4: `packages/domain` accidentally imports something with I/O
**What goes wrong:** A "just this once" import of `pg` types, `node:crypto`'s `randomUUID` wrapped in a Date.now()-based ID helper that lives in `apps/control-plane` instead of `packages/domain`, or a Fastify/Zod-route type leaking into a domain validator, breaks the "domain is pure" invariant that makes ≥95% coverage cheap.
**Why it happens:** Under time pressure, it's faster to add one helper to the app package than to properly place it in domain.
**How to avoid:** Enforce with Turborepo/ESLint import boundaries (STACK.md and ARCHITECTURE.md both call this out) from the very first commit, not retrofitted later. `node:crypto` itself is fine to import in `packages/domain/src/security/envelope.ts` (it's a pure computation, no file/network/process I/O) — the boundary is about I/O (DB, network, filesystem, process env), not about "any Node builtin."
**Warning signs:** `packages/domain/package.json` growing a dependency on `pg`, `fastify`, `better-auth`, or `drizzle-orm`.

## Code Examples

### Zod-validated env, fail-fast at boot (INST-06)
```typescript
// apps/control-plane/src/env.ts
import { z } from "zod";

const EnvSchema = z.object({
  NOODARA_MASTER_KEY: z.string().base64().refine(
    (v) => Buffer.from(v, "base64").length === 32,
    "NOODARA_MASTER_KEY must decode to exactly 32 bytes"
  ),
  BETTER_AUTH_SECRET: z.string().min(32, "session secret must be at least 32 bytes"),
  DATABASE_URL: z.string().url(),
  // No .default() anywhere in this schema for security-critical values.
});

export const env = EnvSchema.parse(process.env); // throws + exits process on invalid config
```

### Drizzle schema with UUIDv7 default and Postgres enum
```typescript
// Source: Context7 /drizzle-team/drizzle-orm-docs (node-postgres connection pattern) + uuidv7 package
import { pgTable, pgEnum, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

export const serverStatusEnum = pgEnum("server_status", [
  "PENDING", "CONNECTING", "CONNECTED", "DISCONNECTED", "UNREACHABLE", "ERROR",
]);

export const servers = pgTable("servers", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  status: serverStatusEnum("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // hostFingerprint, pendingFingerprint, discovery fields per ARCHITECTURE.md §5 — added now to avoid a
  // shape migration in phase 2/3, per CONTEXT.md "Integration Points"
});
```

### Applying migrations programmatically (used both by boot-time migration runner and by integration tests)
```typescript
// Source: Context7 /drizzle-team/drizzle-orm-docs — pg/drizzle-kit-migrate.mdx
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const db = drizzle(process.env.DATABASE_URL);
await migrate(db, { migrationsFolder: "./drizzle" });
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Lucia for hand-rolled-but-library-assisted sessions | Better Auth | Lucia deprecated March 2025 [CITED: PITFALLS.md, lucia-auth.com/lucia-v3/migrate] | Already reflected in STACK.md; nothing new this phase |
| `gen_random_uuid()` (UUIDv4) as PK default | UUIDv7 for time-ordered PKs | PG18 added native `uuidv7()`; this project is on PG16/17 | Must generate UUIDv7 in application code this phase, not via DB default — revisit if/when the project moves to PG18 |
| Vitest `workspace` config | Vitest `projects` config | Deprecated in 3.2, replaced by `projects` (functionally identical) [CITED: Context7 /vitest-dev/vitest — docs/guide/projects.md] | Use `projects` key in the root Vitest config, not `workspace` |

**Deprecated/outdated:**
- Vitest's `workspace` field name — use `projects` (same behavior, new name since 3.2).
- Better Auth's rate limiting docs sometimes shown alongside a `sentinel` plugin (bot/velocity protection) — that plugin requires a Better Auth Cloud API key and is out of scope for this self-hosted, offline-capable project; do not adopt it for D-07.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@fastify/type-provider-zod` (v1.0.0, official `fastify` org, published 2026-04) is a drop-in continuation of the older `fastify-type-provider-zod` (v7.0.0, unscoped, turkerdev) and safe to standardize on | Standard Stack, Alternatives Considered | If the two packages have diverged APIs (the 6-major-version gap is unusual for "same project, new home"), routes built against one package's type-inference shape may not compile against the other; low risk to fix (swap import, same route code should mostly still typecheck) but should be confirmed by reading both READMEs before the scaffold task, not assumed |
| A2 | Better Auth's `session.expiresIn`/`updateAge` combination can approximate D-05's "7-day sliding, 30-day absolute cap" closely enough without a custom hook | Pattern 2 (session config) | If the planner treats `expiresIn: 30d, updateAge: 7d` as literally satisfying D-05, the actual behavior (expiry counted from creation, refreshed at most every 7 days) may diverge from a strict interpretation of "sliding renewal on every active request, hard 30-day ceiling"; needs an explicit task to write a test asserting the exact desired behavior and, if Better Auth's native config doesn't match, add a `session.create`/`session.update` hook that tracks `absolute_expires_at` separately |
| A3 | A Postgres-backed `login_attempts` table (not Redis) is sufficient for D-07's per-IP/per-account progressive lockout in a single-instance control plane | Rate limiting sections throughout | If the control plane is ever horizontally scaled (not planned through v0.5 per CLAUDE.md §8), a Postgres-backed counter with row-level locking could contend under load; for a single-admin, single-instance v0.1 target this is a non-issue, but flag if scaling assumptions change |
| A4 | `argon2` (native bindings) is an acceptable substitute for Better Auth's docs-example `@node-rs/argon2` for the custom password hasher | Pattern 2 | Both implement Argon2id per OWASP recommendation; risk is limited to Docker multi-stage build complexity (native bindings need a build toolchain in the builder stage) already anticipated in STACK.md, not a security risk |

**If this table is empty:** N/A — see entries above; all four are medium/low risk implementation-detail questions, not open questions about core requirements.

## Open Questions

1. **Exact session semantics for D-05 (sliding 7-day / absolute 30-day cap)**
   - What we know: Better Auth exposes `expiresIn` (absolute TTL from creation) and `updateAge` (minimum interval before refreshing that TTL on activity) — confirmed via Context7.
   - What's unclear: Whether `expiresIn: 30d, updateAge: 7d` is an acceptable reading of D-05, or whether D-05 requires a stricter "renews every active request up to a hard 30-day wall" that needs a custom session hook.
   - Recommendation: Planner should have a task write the acceptance test for this exact behavior first (per TDD), then pick the Better Auth native config vs. custom hook based on whether the native config passes.

2. **Should `noodara admin reset` / `noodara secrets rotate` be commander or citty?**
   - What we know: Both are legitimate, current packages (see Package Legitimacy Audit). Commander is vastly more mature (2011–present); citty is unjs's modern TS-first CLI kit.
   - What's unclear: No project precedent yet (greenfield) to prefer one ecosystem's conventions.
   - Recommendation: Default to commander for these two security-sensitive commands given its exceptionally long track record; this is Claude's Discretion territory per CONTEXT.md, not a blocking question.

3. **Does `@fastify/type-provider-zod`'s v1.0.0 API match the route patterns Better Auth integration examples assume, or should the project pin the more mature unscoped `fastify-type-provider-zod` v7.0.0 instead?**
   - What we know: Both exist on npm, both pass legitimacy checks, same underlying repo lineage.
   - What's unclear: Whether the scoped package's v1.0.0 has full feature parity with the unscoped package's v7.0.0 (see Assumptions Log A1).
   - Recommendation: A 15-minute spike task at the start of the scaffold work (before committing to route-layer code) to read both packages' current README/CHANGELOG and pick one — cheap to resolve, expensive to get wrong after dozens of routes are written against one type-inference shape.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All TS execution | ✓ | v24.13.0 locally (project targets 22 LTS per STACK.md) | Pin via `.nvmrc`/`engines` + Docker base image `node:22-alpine`; local dev machine running a newer Node is not a blocker since CI/Docker enforce 22 |
| pnpm | Package manager/workspaces | ✓ | 11.25.0 locally (STACK.md recommends pinning 10.x) | Pin exact version via root `package.json` `packageManager` field regardless of what's locally installed; pnpm 11.x is backward compatible for this project's needs but STACK.md's version pin should be honored in `packageManager` |
| Docker Engine | Testcontainers (Postgres/Redis integration tests), local Compose stack | ✓ | 29.2.0, daemon running | — |
| PostgreSQL (standalone binary) | Local psql access for manual inspection | ✗ | — | Not required — Testcontainers spins up Postgres in Docker for tests; `docker compose up postgres` covers manual dev use |
| GitHub Actions hosted runners | CI job matrix (lint/typecheck/unit/integration/gitleaks/audit) | Assumed ✓ (not locally testable) | — | Hosted runners include Docker per CONTEXT.md's own note ("los runners hospedados traen Docker") |

**Missing dependencies with no fallback:** none identified for this phase.

**Missing dependencies with fallback:** local `psql` binary (not needed — Docker/Testcontainers cover it); exact pnpm/Node pinned versions (enforced via config files, not local machine state).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.0 [VERIFIED: npm registry] |
| Config file | none yet — Wave 0 must create root `vitest.config.ts` using the `projects` key (not the deprecated `workspace` key) [CITED: Context7 /vitest-dev/vitest — docs/guide/projects.md] |
| Quick run command | `pnpm test` (unit only, no Testcontainers) |
| Full suite command | `pnpm test:integration` (includes Testcontainers Postgres/Redis) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INST-06 | Boot exits non-zero when `NOODARA_MASTER_KEY`/session secret/DB password missing or invalid | unit | `vitest run apps/control-plane/src/env.test.ts` | ❌ Wave 0 |
| AUTH-01 | Setup token: single-use, 24h expiry, route 404s after admin exists | unit + integration | `vitest run packages/domain/src/security/setup-token.test.ts` (pure expiry/hash logic) + `vitest run --config vitest.integration.config.ts tests/integration/auth/setup.test.ts` (real DB + route) | ❌ Wave 0 |
| AUTH-02 | Login with argon2id succeeds, session persists across "reload" (new request with same cookie) | integration | `tests/integration/auth/login.test.ts` (Supertest against a running Fastify instance + Testcontainers Postgres) | ❌ Wave 0 |
| AUTH-03 | Logout invalidates session server-side (subsequent request with old cookie is rejected) | integration | `tests/integration/auth/logout.test.ts` | ❌ Wave 0 |
| AUTH-04 | 5 fails/15min per IP and per account independently, doubling backoff, logged without password | unit (backoff math) + integration (end-to-end lockout + activity log assertion) | `vitest run packages/domain/src/security/*lockout*.test.ts` + `tests/integration/auth/rate-limit.test.ts` | ❌ Wave 0 |
| AUTH-05 | Cookie flags HttpOnly/Secure/SameSite=Lax, id rotates on login | integration | `tests/integration/auth/cookies.test.ts` (Supertest, inspect `Set-Cookie` header) | ❌ Wave 0 |
| SERV-05 | All valid/invalid transitions, including D-14/D-15 additions | unit (table-driven, exhaustive cross-product) | `vitest run packages/domain/src/server/server-state.test.ts` | ❌ Wave 0 |
| SEC-01 | Encrypt/decrypt roundtrip, tamper detection (ciphertext + tag), wrong key, unique nonces | unit | `vitest run packages/domain/src/security/envelope.test.ts` | ❌ Wave 0 |
| QA-06 | Migrations apply from scratch and from previous migration snapshot | integration | `tests/integration/db/migrations.test.ts` (Testcontainers Postgres) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test` (unit only — fast feedback, no Docker needed)
- **Per wave merge:** `pnpm test:integration` (full suite including Testcontainers)
- **Phase gate:** Full suite green + `pnpm lint && pnpm typecheck` + coverage thresholds met before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Root `package.json`, `pnpm-workspace.yaml`, `turbo.json` — the monorepo doesn't exist yet (greenfield)
- [ ] `vitest.config.ts` at root using `projects` for per-package test discovery, with `coverage.thresholds` scoped to `packages/domain/**` via glob-pattern thresholds (statements/branches ≥95%) — confirmed via Context7 that Vitest's global coverage thresholds merge across all projects into one CoverageMap, so package-specific enforcement must use the glob-pattern threshold syntax (`'packages/domain/**': { statements: 95, branches: 95 }`), not a per-project threshold block
- [ ] `apps/control-plane/vitest.integration.config.ts` (or a `test.integration` project) wiring Testcontainers setup/teardown
- [ ] `.github/workflows/ci.yml` — does not exist yet; must run lint, typecheck, unit, light integration (Testcontainers on hosted runner), gitleaks, `pnpm audit --audit-level=high`
- [ ] `packages/config` — shared tsconfig/eslint/prettier referenced by CLAUDE.md §3.1 structure but not yet created
- [ ] Testcontainers base images: a plain `postgres:17-alpine` (or 16, per whichever the planner locks) is sufficient for this phase — no custom sshd image needed yet (that's phase 2)

*(No pre-existing test infrastructure — this is Wave 0 for the entire project.)*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | yes | Better Auth email/password + custom argon2id hasher; setup-token single-use/24h expiry (AUTH-01); no hardcoded credentials (INST-06) |
| V3 Session Management | yes | Better Auth session table, `HttpOnly`/`Secure`/`SameSite=Lax` cookies, session id rotation on login (AUTH-05), server-side invalidation on logout (AUTH-03) |
| V4 Access Control | partial | Single-admin, no roles this phase; "one admin" enforced at both Better Auth config and a domain-level check per CONTEXT.md discretion |
| V5 Input Validation | yes | Zod schemas at every route boundary + domain validators (host/port/password policy) |
| V6 Cryptography | yes | `node:crypto` AES-256-GCM envelope, never hand-rolled; argon2id for passwords, never a fast hash |
| V7 Error Handling / Logging | yes | pino `redact` config covering `req.body.password`, `req.headers.cookie`; activity log excludes password on every failed-login event (AUTH-04) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Hardcoded/default secret fallback (Dokploy CVE-2026-45631, CVSS 10.0) | Spoofing / Elevation of Privilege | Zod env schema with no `.default()` on `NOODARA_MASTER_KEY`/session secret; fail-fast boot (INST-06) |
| Credential/secret leakage via logs, activity log, or error responses (Coolify #7019, #6658, #7235) | Information Disclosure | pino `redact`, `SecretValue` branded type with `toJSON`/`toString` → `[REDACTED]`, activity-log metadata passes through the same Redactor before persistence |
| Session fixation / cookie theft | Spoofing | Session id rotated on every login (AUTH-05); `HttpOnly` prevents JS exfiltration; `Secure` prevents plaintext transmission (dev-only opt-out via explicit env flag, never default) |
| Brute-force login (credential stuffing against the single admin account) | Denial of Service / Elevation of Privilege | Custom per-account + per-IP progressive-backoff lockout (D-07) layered in front of/inside Better Auth's sign-in flow; Better Auth's native `rateLimit` alone is insufficient (see Pitfall 2) |
| Master key loss making all encrypted rows unrecoverable (Coolify APP_KEY "MAC invalid" pattern) | — (availability/data-loss, not classic STRIDE) | `key_version` column from day one (D-10), `noodara secrets rotate` designed now even if full rotation UX ships later (D-11), boot-time backup warning with key fingerprint, never the key itself (D-12) |
| Migration breaking an in-place upgrade (Coolify #3848, #2820, #3618, #5776) | — (integrity/availability) | Defensive migrations (`IF EXISTS`/`IF NOT EXISTS`), tested against both an empty DB and the previous migration snapshot from the very first migration (QA-06) |

## Sources

### Primary (HIGH confidence)
- Context7 `/better-auth/better-auth` — emailAndPassword custom hasher, session expiresIn/updateAge, cookie config, rateLimit config + `createRateLimitKey`/`getIP` source excerpts, `generateId`/`advanced.database` options, `listSessions` endpoint source, Node handler mounting pattern (`toNodeHandler`)
- Context7 `/drizzle-team/drizzle-orm-docs` — node-postgres connection pattern, `migrate()` usage, migrations-table/matching-by-folder-name behavior
- Context7 `/vitest-dev/vitest` — `projects` (formerly `workspace`) config, coverage provider selection, glob-pattern coverage thresholds and the "merged CoverageMap, no per-project global threshold" behavior
- npm registry (`npm view <pkg> version` / `time.created` / `repository.url`) — live-checked 2026-09-10 for every package listed in Standard Stack and Package Legitimacy Audit
- `slopcheck` v0.6.1 (`pip3 install slopcheck`), run with `--ecosystem npm` — package legitimacy scan, see Package Legitimacy Audit for full results and the PyPI/npm ecosystem-detection caveat

### Secondary (MEDIUM confidence)
- postgresql.org/docs/18/functions-uuid.html, neon.com/postgresql/18/uuidv7-support — PG18-only native `uuidv7()`, confirming application-layer generation is required for this project's PG16/17
- `.planning/research/STACK.md`, `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md` (this project's own prior research, already HIGH/MEDIUM confidence per their own metadata) — cross-referenced throughout rather than re-derived

### Tertiary (LOW confidence)
- None flagged as LOW-confidence in this document beyond what's already itemized in the Assumptions Log.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version cross-checked live against npm registry this session, none re-used from stale training data
- Architecture: HIGH for domain/state-machine/encryption patterns (first-principles + project's own skills); MEDIUM for exact Better Auth session/rate-limit fit to D-05/D-07's precise wording (documented as Open Questions/Assumptions, not silently assumed)
- Pitfalls: HIGH — sourced directly from this project's own `PITFALLS.md` (already CVE-verified) plus one newly-verified Better Auth API-shape gap (rate limit key structure) confirmed via Context7 source excerpts this session

**Research date:** 2026-09-10
**Valid until:** 30 days (stable ecosystem for this phase's core choices) — re-verify Better Auth and `@fastify/type-provider-zod` versions specifically before implementation if more than a few weeks pass, given Better Auth's active release cadence and the newly-published scoped Fastify package's uncertain stability history (Assumption A1)

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Researched: 2026-09-10*
