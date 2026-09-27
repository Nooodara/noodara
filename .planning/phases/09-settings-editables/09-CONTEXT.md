# Phase 9: Settings editables - Context

**Gathered:** 2026-09-27
**Status:** Ready for planning

<domain>
## Phase Boundary

El admin gestiona su propia cuenta y su experiencia visual desde `/settings`: nombre, email y contraseña (SET-02, SET-03), tema auto/claro/oscuro (SET-04) y dos preferencias visuales — reducir movimiento y densidad (SET-05) — todo persistido en el servidor sobre el usuario, con espejo local para el primer pintado sin parpadeo, y sin que ninguna fila derivada del entorno pueda volverse editable (SET-06). Un solo admin local (v0.1); nada de multiusuario, avatar con imagen, verificación por correo ni 2FA.

</domain>

<decisions>
## Implementation Decisions

### Edición de perfil (SET-02)
- **D-01: Sheet por campo.** Las filas Name y Email del nuevo grupo inset `Account` muestran el valor y un botón `Edit` (rol `callout`, sin icono nuevo). Abre el `Sheet` lateral existente (`packages/ui/src/Sheet.tsx`, mismo que add-server) con el campo, el campo `Current password` y `Save`. Las filas inset quedan intactas (D-01/D-04 de fase 8); nada de edición inline ni formulario único.
- **D-02: Contraseña actual en cada cambio sensible.** Nombre, email y contraseña piden la contraseña actual en el mismo formulario. Sin "sudo mode" ni ventana de reautenticación; sin estado nuevo en servidor.
- **D-03: Email: formato + DNS del dominio, sin correo.** Validación de forma con Zod (`packages/domain`) y comprobación en servidor de que el dominio resuelve MX o A antes de aceptar. No se envía correo (v0.2 no tiene mailer). La comprobación DNS tiene timeout explícito y sus tests NO dependen del resolver de la máquina (lección de ADR 0004): se inyecta el resolver y en integración se asertan las formas posibles.
- **D-04: Reflejo inmediato en el shell.** Tras guardar, `AccountMenu` (iniciales, nombre, email) se actualiza sin recarga revalidando la sesión (`/api/auth/get-session` vía el helper existente), no en el siguiente heartbeat.

### Cambio de contraseña (SET-03)
- **D-05: La sesión actual se mantiene.** Better Auth `changePassword` con `revokeOtherSessions: true`: caen todas las demás sesiones; la pestaña donde se hizo el cambio sigue viva. Política de v0.1 sin cambios (`packages/domain/src/validators/password.ts`, 12–128 + lista de comunes) aplicada en servidor; el formulario pide actual + nueva (+ confirmar nueva).
- **D-06: Aviso por `Notice` en Settings tras guardar:** `Password updated. Other sessions were signed out.` con el número de sesiones revocadas si la API lo devuelve. Sin diálogo de confirmación previa.
- **D-07: La pestaña revocada se entera por el heartbeat existente** (`require-session.ts` / `get-session`): al fallar redirige a `/login?reason=password-changed` y `/login` muestra un `Notice` "Signed out because your password changed" (mismo mecanismo que `?setup=success`). Sin evento SSE nuevo.
- **D-08: Tres eventos de Activity sin metadata sensible:** `account.name_changed` (nombre nuevo), `account.email_changed` (email nuevo, nunca el anterior), `account.password_changed` (`sessions_revoked: n`). Nunca contraseñas, hashes, tokens ni IPs de las sesiones revocadas. Los cambios de apariencia NO generan eventos.

### Tema y primer pintado (SET-04)
- **D-09: El servidor es la fuente; cookie espejo + SSR.** La preferencia vive en el usuario. Al guardar se escribe además una cookie `noodara-prefs` (no `HttpOnly`, `SameSite=Lax`, sin datos sensibles) que el root layout de Next lee en SSR para poner `data-theme` (y `data-motion`, `data-density`) en `<html>` antes del primer pintado. `localStorage['noodara-theme']` queda solo como caché interna de `ThemeToggle`. Cero flash con o sin JS.
- **D-10: Servidor gana al cargar la sesión.** Si el espejo local y el servidor difieren (cambio hecho en otro navegador), el valor del servidor sobrescribe el espejo y se aplica en el acto tras obtener la sesión.
- **D-11: `/login` y `/setup` usan la cookie espejo si existe; si no, auto/SO.**
- **D-12: Control `SegmentedControl` Auto / Light / Dark** en la fila Theme del grupo Appearance. `ThemeToggle` sigue siendo el ÚNICO write path (P17): se adapta para aceptar un valor explícito y para escribir cookie + localStorage + `data-theme` en una sola función; el icono cíclico desaparece de la UI (ya no está en el menú de cuenta desde G3 de fase 8).

### Preferencias visuales (SET-05)
- **D-13: Reducir movimiento con tres estados: System / On / Off.** Por defecto sigue `prefers-reduced-motion`; el usuario puede forzar. Se aplica con `data-motion="reduce|allow"` en `<html>` (ausente = sistema); las variantes `motion-safe:`/`motion-reduce:` de la fase 8 se redefinen en el config de Tailwind para leer el atributo además de la media query, de modo que los fallbacks existentes (Sheet sin gesto, crossfades, anillo estático) se activan sin duplicar CSS.
- **D-14: Densidad compacta = solo altura de fila y padding.** Filas de lista e inset pasan de 44 a 36 px con padding vertical proporcional; tipografía, espaciado entre grupos y padding de página no cambian. Se implementa con `data-density="compact"` en `<html>` remapeando un token `--row-height` (y el padding de fila) que `ListRow`, `InsetGroup` rows y `NavTree` consumen. Un solo escritor del token.
- **D-15: `SegmentedControl` para ambos:** `Reduce motion: System / On / Off`, `Density: Comfortable / Compact`. Mismo patrón que Theme; ningún switch.
- **D-16: Un objeto `preferences` en el usuario.** Columna `preferences` JSON (Drizzle `jsonb`, migración 0004) validada por un schema Zod en `packages/domain` (`{ theme: 'auto'|'light'|'dark', reduceMotion: 'system'|'on'|'off', density: 'comfortable'|'compact' }`, defaults explícitos), un endpoint `PATCH /api/account/preferences`, y la única cookie espejo `noodara-prefs` con las tres. Nunca se exponen en `session-user.ts` más campos que los ya permitidos + preferences.

### Filas de entorno (SET-06)
- **D-17: `SettingsRow` sigue sin handler de edición.** Las filas editables son un tipo nuevo (`EditableAccountRow` o equivalente) en un módulo distinto; el test de tipo `@ts-expect-error` demuestra que añadir `onEdit` a `SettingsRow` no compila. Las filas de `Instance` y `Advanced` conservan su caption "Set by an environment variable".

### Claude's Discretion
- Orden de los grupos en `/settings`: `Account` (Name, Email, Password) → `Appearance` (Theme, Reduce motion, Density) → `Instance` → `Advanced` (Disclosure). El único movimiento de la pantalla sigue siendo la Disclosure (D-11 fase 8).
- Copy de errores y de los `Notice` en inglés, voz del producto, nombrando problema y recuperación; nunca revelar si un email existe.
- Límites del nombre (1–80 caracteres, sin control chars) y normalización del email (trim + lowercase) en `packages/domain`.
- Rate limit de intentos de contraseña actual reutilizando el lockout progresivo de v0.1 si aplica al mismo usuario; si no, un límite simple en el endpoint.
- Nombres exactos de endpoints (`/api/account/profile`, `/api/account/password`, `/api/account/preferences`) y si conviene delegar a los endpoints nativos de Better Auth (`/api/auth/change-password`, `/api/auth/update-user`, `/api/auth/change-email`) — decidir en research con Context7 según qué ofrece cada uno para `revokeOtherSessions` y la confirmación por contraseña actual.
- Pruebas de "sin parpadeo": test E2E que recarga con tema oscuro forzado y aserta el `data-theme` del primer HTML servido (respuesta SSR) y ningún cambio de `background-color` en los primeros frames.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requisitos, roadmap y research
- `.planning/ROADMAP.md` §"Phase 9: Settings editables" — goal, 5 criterios de éxito, research flag (Context7 para `changePassword`/`changeEmail`/`revokeOtherSessions`).
- `.planning/REQUIREMENTS.md` — SET-02…SET-06 (texto exacto de cada requisito).
- `.planning/research/SUMMARY.md` §"Phase 3: Editable settings" y pitfall P17 — un solo write path de tema, test de no-flash contra el path nuevo; brief §9 #16 (nunca mostrar una credencial, ni enmascarada).
- `.planning/research/PITFALLS.md` P17 — theme flicker.

### Decisiones heredadas
- `.planning/phases/08-redise-o-de-la-app/08-CONTEXT.md` — D-01/D-04 (grupos inset, layout intacto), D-05 (menú de cuenta; **modificado en G3**: Appearance vive en Settings), D-06 (avatar de iniciales), D-11 (un momento por pantalla: la Disclosure Advanced).
- `.planning/phases/08-redise-o-de-la-app/deferred-items.md` §"Decisions changed at G3" y §"Status at G3 close" — Appearance movido a Settings; login silencioso ante origen rechazado (candidato a arreglar aquí al tocar `/login`).
- `.planning/phases/05-*/05-UI-SPEC.md` §2.7 y D-16 de v0.1 — Settings de solo lectura, caption "Set by an environment variable", forma de `SettingsRow`.
- `docs/adr/0004-*.md` — tests nunca dependen del resolver DNS de la máquina (aplica a la validación de dominio del email).

### Design system y brief
- `docs/ui-build-prompt.md` §4.4 (quality floor), §9 (prohibiciones: #1 un solo acento, #16 credenciales), §10 DoD.
- `.claude/skills/noodara-ux-apple/SKILL.md` — inset groups, segmented control, sheet, notices, copy.
- `.claude/skills/noodara-security/SKILL.md` — redacción en logs/activity, timeouts, nada sensible en cookies ni respuestas.
- `.claude/skills/noodara-tdd/SKILL.md` — RED→GREEN→REFACTOR, Testcontainers para la capa de auth.
- `docs/ui/APPROVAL.md` — patrón de gate humano; esta fase tiene `UI hint: yes` (capturas en ambos temas antes de cerrar).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/ui/src/Sheet.tsx` (drag-to-dismiss, motion acotado), `Field.tsx`, `Input.tsx`, `Button.tsx`, `Notice.tsx`, `Banner.tsx`, `SegmentedControl.tsx`, `InsetGroup.tsx`, `Disclosure.tsx`: todo lo que la pantalla necesita ya existe; no se crean primitivas nuevas salvo la fila editable.
- `packages/ui/src/ThemeToggle.tsx` — `STORAGE_KEY = 'noodara-theme'`, único escritor de `data-theme`; se extiende, no se duplica.
- `packages/domain/src/validators/password.ts` + `common-passwords.ts` — política de contraseña de v0.1.
- `apps/web/src/lib/settings-rows.ts` — `SettingsRow`, `instanceRows`, `advancedRows` (SET-06 vive aquí).
- `apps/web/src/components/SettingsGroups.tsx` — ya monta el grupo Appearance (G3 fase 8) con `ThemeToggle`; la fase lo sustituye por las tres filas segmented.
- `apps/web/src/lib/session-user.ts`, `require-session.ts` — carga de sesión y heartbeat; `AccountMenu` consume `session-user`.
- `apps/web/src/app/login/page.tsx` — patrón `?setup=success` → `Notice`, reutilizable para `?reason=password-changed`.
- Activity: catálogo de eventos `auth.*` / `server.*` en `packages/domain` y servicio de activity en control-plane; `auth.password_reset` y `auth.session_revoked` son los análogos más cercanos.

### Established Patterns
- Better Auth (`apps/control-plane/src/auth/auth.ts`): `emailAndPassword` con `minPasswordLength: 12`, `maxPasswordLength: 128`, `baseURL = NOODARA_PUBLIC_URL`; origin guard propio (`auth/origin-guard.ts`). Users table (`db/schema/auth.ts`): `id, name, email, emailVerified, image, createdAt, updatedAt` — `preferences` es columna nueva (migración `0004_*`).
- Web es cliente delgado de Fastify vía rewrite `/api/*` (ADR 0006); `api-client.ts` con `ApiFailure` tipado.
- Migraciones versionadas en `apps/control-plane/src/db/migrations/` (última: `0003_phase3_discovery_snapshots.sql`).
- Gates estáticos en `scripts/check-ui-safety.mjs` (12): cualquier CSS nuevo respeta tokens, easings, sombras, backdrop.
- Root layout `apps/web/src/app/layout.tsx` ya usa `suppressHydrationWarning` en `<html>`; hoy no pone `data-theme` en SSR — punto exacto donde entra la cookie espejo.

### Integration Points
- `SettingsGroups.tsx` → nuevos grupos `Account` y `Appearance` reescrito; `Instance`/`Advanced` sin cambios.
- `AccountMenu` (packages/ui) ← `session-user.ts` revalidado tras editar perfil.
- `layout.tsx` (root) ← lectura de `noodara-prefs` en SSR → `data-theme|motion|density`.
- Tailwind config / `packages/ui/tokens.css` ← `--row-height` y variantes `motion-*` sensibles a `data-motion`.
- Control plane: rutas nuevas bajo `/api/account/*` (o nativas de Better Auth) dentro del `api-scope` autenticado, con activity y sin secretos en logs.
- E2E: `tests/e2e/shell.spec.ts` (AccountMenu), `a11y-fallbacks.spec.ts` (reduce motion forzado por preferencia además de por media query), nuevo `settings.spec.ts` (perfil, password, sesión revocada en segundo contexto de navegador, no-flash).

</code_context>

<specifics>
## Specific Ideas

- "Appearance en Settings, no como sección aparte" (usuario, G3 de fase 8): el menú de cuenta queda con cabecera, Settings y Sign out.
- El usuario acaba de sufrir un login que fallaba en silencio (origen rechazado) y no recordaba su contraseña: los mensajes de `/login` y de Settings deben decir siempre qué pasó y qué hacer. Arreglar la rama genérica de `/login` (banner siempre visible) entra en esta fase al tocar esa pantalla.
- Sin parpadeo significa cero cambio de color tras el primer frame, con o sin JS, en ambos temas, y la preferencia idéntica en un segundo navegador tras iniciar sesión.

</specifics>

<deferred>
## Deferred Ideas

- Verificación de email por correo y recuperación de contraseña por email — requieren un mailer; fuera de v0.2.
- Avatar con imagen (columna `image` existe pero D-06 fase 8 fija iniciales monocromas).
- "Sudo mode" con ventana temporal — descartado por ahora (D-02); reconsiderar si aparecen más acciones sensibles.
- Eventos de Activity para cambios de apariencia — descartado (D-08).
- Densidad que también reduzca espaciado entre grupos y padding de página — descartado (D-14); revisar si la fase 13 lo pide para listas de servicios.
- Sesiones activas listadas y revocables una a una desde Settings — ya existe `/api/sessions`; UI en un ciclo posterior de settings.
- Título truncado a 375px en `ServerDetailToolbar`, scroll edge del detail toolbar, foco tras Esc del Sheet — abiertos en `08 deferred-items.md`, no de esta fase.

</deferred>

---

*Phase: 09-settings-editables*
*Context gathered: 2026-09-27*
