# Phase 9: Settings editables - Research

**Researched:** 2026-09-27
**Domain:** Better Auth account mutations (custom endpoints), server-authoritative UI preferences with SSR no-flash first paint, Tailwind v4 custom variants, row-height density token
**Confidence:** HIGH (Better Auth API shapes, codebase patterns) / MEDIUM (DNS resolver-injection pattern — no precedent exists in this repo, designed fresh) / MEDIUM (Tailwind v4 custom-variant + Next 16 async-cookies SSR wiring — verified against docs, not yet built here)

## Summary

This phase is CRUD-shaped but sits on top of two architectural firsts for this codebase: (1) Better Auth's native `changeEmail` endpoint is unusable without a mailer (it requires `sendVerificationEmail`/`sendChangeEmailConfirmation`, both absent by design in v0.2), so email (and, per D-02, name) changes must go through **custom `/api/account/*` endpoints** that verify the current password directly against the `accounts.password` hash and update `users` via Drizzle — never through `auth.api.updateUser`/`changeEmail`. Password changes, by contrast, map directly onto Better Auth's native `changePassword` with `revokeOtherSessions: true`, which is exactly what D-05 needs. (2) The theme/motion/density preferences move from a pure client-side (`localStorage` + inline bootstrap `<script>`) architecture to a **server-authoritative** one: a `preferences` JSONB column on `users`, a mirror cookie (`noodara-prefs`, non-`HttpOnly`) written by the server response, and a root layout that becomes an `async` Server Component reading that cookie via `await cookies()` to set `data-theme`/`data-motion`/`data-density` on `<html>` before first paint. This is a bigger lift than "add a `SegmentedControl`" — it replaces `apps/web/src/lib/theme-script.ts`'s bootstrap-script approach and forces the whole app into dynamic rendering (no static optimization for `/login`/`/setup`), which the planner must budget as its own task, not a side effect of Task "wire up ThemeToggle".

Every current usage of `motion-safe:`/`motion-reduce:` in `packages/ui`/`apps/web` (11+ files: `press.ts`, `Disclosure.tsx`, `Sheet.tsx`, `RowMenu.tsx`, `Dialog.tsx`, `Tooltip.tsx`, `Skeleton.tsx`, `StatusPill.tsx`, `NavTree.tsx`, `AccountMenu.tsx`, several `apps/web` components) relies on Tailwind v4's built-in media-query variants. Tailwind v4 configures variants in CSS (`@custom-variant`), not a JS config file (none exists in this repo) — D-13's requirement that these variants also honor `data-motion="reduce|allow"` on `<html>` means redefining `motion-safe`/`motion-reduce` as `@custom-variant` blocks combining the media query OR the attribute selector, in `packages/ui/theme.css` or `tokens.css`, with zero changes to the ~15 call sites already using the utility class names. Similarly, no `--row-height` token exists yet: `ListRow.tsx` hardcodes `ROW_HEIGHT_PX = 44` as an inline `style` object, so D-14 requires introducing the token in `tokens.css`, redefining it under `html[data-density="compact"]`, and refactoring `ListRow`/`InsetGroup` rows/`NavTree` to read `var(--row-height)` instead of the constant.

**Primary recommendation:** Build three custom control-plane endpoints under `/api/account/*` (`profile` for name+email, `password` delegating to Better Auth's native endpoint, `preferences` for the new JSONB column), reuse `verifyPassword` from `password-hasher.ts` directly (not `signInEmail`) for current-password confirmation on all three, and treat the theme/motion/density SSR migration as an explicit up-front task before any Settings UI work — it changes `layout.tsx`, deletes `theme-script.ts`'s role, and touches every `motion-safe:`/`motion-reduce:` call site's underlying CSS definition (not its usage).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Name/email format + length validation | Domain (`packages/domain`) | — | Pure, no I/O; reuses/extends `validators/identity.ts` |
| Current-password verification | API/Backend (control-plane) | — | Needs `accounts.password` hash + `verifyPassword` (argon2) — I/O, must not touch domain |
| Email domain MX/A resolution | API/Backend (control-plane) | — | `node:dns` is explicitly banned in `packages/domain` (`purity.test.ts`); needs network I/O + injectable resolver |
| Password change (policy + revoke) | API/Backend, delegated to Better Auth | Domain (existing `validators/password.ts`) | Better Auth's native `/change-password` already implements `revokeOtherSessions` |
| Preferences persistence (theme/motion/density) | API/Backend (Drizzle on `users.preferences`) | Database | New JSONB column, migration 0004 |
| Preferences mirror for first paint | Frontend Server (SSR, Next root layout) | Browser (cookie storage) | `noodara-prefs` cookie set by API response, read via `cookies()` in the Next.js Server Component root layout — not by a client script |
| Theme/motion/density write-on-interaction | Browser/Client | Frontend Server (calls `/api/account/preferences`) | `ThemeToggle`'s extended single-write-path function stays the only DOM writer |
| Session revocation propagation to other tabs | Browser/Client (heartbeat poll) | API/Backend (session invalidation) | Existing `require-session.ts`/`get-session` polling mechanism, no new SSE channel |
| Activity event emission | API/Backend (service layer only) | — | `writeActivityEvent` is the sole permitted `activity_events` writer, per `ARCHITECTURE.md §6` |
| `SettingsRow` vs editable-row type separation | Frontend Server/Client (shared type module) | — | Structural TypeScript separation, no runtime component |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions

- **D-01 (Sheet per campo):** Name/Email rows in a new `Account` InsetGroup show value + `Edit` button (role `callout`, no new icon), opening the existing `Sheet` (`packages/ui/src/Sheet.tsx`) with the field, `Current password`, and `Save`. Inset rows stay intact (D-01/D-04 phase 8); no inline editing, no single mega-form.
- **D-02 (current password on every sensitive change):** Name, email, and password all require current password in the same form. No "sudo mode," no reauth window, no new server state.
- **D-03 (email: format + DNS, no mail):** Zod format validation in `packages/domain`; server-side check that the domain resolves MX or A before accepting. No email sent (no mailer in v0.2). DNS check has explicit timeout; tests never depend on the machine's real resolver (ADR 0004 lesson) — inject the resolver, assert possible shapes in integration tests.
- **D-04 (immediate shell reflection):** After saving, `AccountMenu` (initials, name, email) updates without reload by revalidating the session (`/api/auth/get-session` via the existing helper), not on the next heartbeat.
- **D-05 (current session survives):** Better Auth `changePassword` with `revokeOtherSessions: true` — all other sessions drop; the tab where the change happened stays alive. v0.1 password policy (`packages/domain/src/validators/password.ts`, 12–128 chars + common-password list) applied server-side; form asks current + new (+ confirm new).
- **D-06 (Notice after save):** `Password updated. Other sessions were signed out.` with revoked-session count if the API returns it. No pre-confirmation dialog.
- **D-07 (revoked tab learns via existing heartbeat):** `require-session.ts`/`get-session` failing redirects to `/login?reason=password-changed`; `/login` shows a `Notice` "Signed out because your password changed" (same mechanism as `?setup=success`). No new SSE event.
- **D-08 (three Activity events, no sensitive metadata):** `account.name_changed` (new name), `account.email_changed` (new email, never old), `account.password_changed` (`sessions_revoked: n`). Never passwords, hashes, tokens, or revoked-session IPs. Appearance changes emit no events.
- **D-09 (server is the source; cookie mirror + SSR):** Preference lives on the user. On save, also write a `noodara-prefs` cookie (not `HttpOnly`, `SameSite=Lax`, no sensitive data) that the Next.js root layout reads in SSR to set `data-theme`/`data-motion`/`data-density` on `<html>` before first paint. `localStorage['noodara-theme']` remains only `ThemeToggle`'s internal cache. Zero flash with or without JS.
- **D-10 (server wins on session load):** If local mirror and server differ (change made on another browser), the server value overwrites the mirror and applies immediately after the session loads.
- **D-11 (`/login`/`/setup` use the mirror cookie if present; else auto/OS).**
- **D-12 (`SegmentedControl` Auto/Light/Dark)** in the Theme row of the Appearance group. `ThemeToggle` stays the ONLY write path (P17): extended to accept an explicit value and to write cookie + localStorage + `data-theme` in one function; the cyclic icon disappears from the UI (already removed from the account menu since G3 of phase 8).
- **D-13 (reduce motion, three states: System/On/Off):** Defaults to `prefers-reduced-motion`; user can force. Applied via `data-motion="reduce|allow"` on `<html>` (absent = system); phase-8 `motion-safe:`/`motion-reduce:` variants are redefined in Tailwind config to also read the attribute, so existing fallbacks (Sheet without gesture, crossfades, static ring) activate without duplicating CSS.
- **D-14 (compact density = row height/padding only):** List/inset rows go from 44 to 36px with proportional vertical padding; typography, inter-group spacing, page padding unchanged. Implemented via `data-density="compact"` on `<html>` remapping a `--row-height` token (and row padding) that `ListRow`, `InsetGroup` rows, and `NavTree` consume. Single writer of the token.
- **D-15 (`SegmentedControl` for both):** `Reduce motion: System/On/Off`, `Density: Comfortable/Compact`. Same pattern as Theme; no switches.
- **D-16 (one `preferences` object on the user):** `preferences` JSON column (Drizzle `jsonb`, migration 0004) validated by a Zod schema in `packages/domain` (`{ theme: 'auto'|'light'|'dark', reduceMotion: 'system'|'on'|'off', density: 'comfortable'|'compact' }`, explicit defaults), one endpoint `PATCH /api/account/preferences`, and the single mirror cookie `noodara-prefs` carrying all three. `session-user.ts` never exposes more fields than currently allowed + preferences.
- **D-17 (`SettingsRow` keeps no edit handler):** Editable rows are a new type (`EditableAccountRow` or equivalent) in a separate module; a `@ts-expect-error` type test proves adding `onEdit` to `SettingsRow` doesn't compile. `Instance`/`Advanced` rows keep the "Set by an environment variable" caption.

### Claude's Discretion

- Order of groups in `/settings`: `Account` (Name, Email, Password) → `Appearance` (Theme, Reduce motion, Density) → `Instance` → `Advanced` (Disclosure). The screen's only "moment" stays the Disclosure (D-11 phase 8).
- Error copy and `Notice` text in English, product voice, naming problem + recovery; never reveal whether an email exists.
- Name limits (1–80 chars, no control chars) and email normalization (trim + lowercase) in `packages/domain`.
- Rate limit for current-password attempts: reuse v0.1's progressive login lockout if it applies to the same user; otherwise a simple endpoint-level limit.
- Exact endpoint names (`/api/account/profile`, `/api/account/password`, `/api/account/preferences`) and whether to delegate to Better Auth's native endpoints (`/api/auth/change-password`, `/api/auth/update-user`, `/api/auth/change-email`) — **resolved by this research below** (see Standard Stack / Don't Hand-Roll).
- "No flicker" tests: E2E reload with forced dark theme asserting `data-theme` on the first served HTML (SSR response) and no `background-color` change in the first frames.

### Deferred Ideas (OUT OF SCOPE)

- Email verification by mail and password recovery by mail — need a mailer; out of v0.2.
- Avatar with image (the `image` column exists but D-06 phase 8 fixes monochrome initials).
- "Sudo mode" with a temporary reauth window — dropped for now (D-02); reconsider if more sensitive actions appear.
- Activity events for appearance changes — dropped (D-08).
- Density that also reduces inter-group spacing or page padding — dropped (D-14); revisit if phase 13 needs it for service lists.
- Listed/revocable active sessions in Settings — `/api/sessions` already exists; UI in a later Settings cycle.
- `ServerDetailToolbar` title truncation at 375px, detail toolbar scroll edge, Sheet focus-after-Esc — open in `08 deferred-items.md`, not this phase's scope.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SET-02 | Edit name and email from Settings, with domain validation and current-password confirmation | Custom `/api/account/profile` endpoint (Don't Hand-Roll #1); `validateEmail`/new `validateName` in `packages/domain`; DNS MX/A check design (Common Pitfalls #1); `verifyPassword` reuse pattern |
| SET-03 | Change password (v0.1 policy) revoking all other active sessions | Better Auth native `changePassword` + `revokeOtherSessions: true` (Code Examples #2); existing `validators/password.ts` reused unchanged |
| SET-04 | Theme auto/light/dark persisted server-side with local mirror, no flicker on reload, manual override always wins | Server-authoritative SSR architecture (Architecture Patterns #1); `ThemeToggle` single-write-path extension (Pitfall P17 continuity) |
| SET-05 | Reduce-motion and density (compact/comfortable) persisted the same way, respected app-wide | `preferences` JSONB shape (D-16); Tailwind v4 `@custom-variant` redefinition (Architecture Patterns #3); `--row-height` token refactor (Architecture Patterns #4) |
| SET-06 | Environment-derived Settings rows stay read-only and say so; `SettingsRow`'s type structurally forbids an edit handler | Existing `settings-rows.ts` `SettingsRow` type (already has no edit affordance) + new sibling `EditableAccountRow` type; `@ts-expect-error` type test pattern |

</phase_requirements>

## Project Constraints (from CLAUDE.md)

- TDD mandatory: RED → GREEN → REFACTOR for all behavior; no "build then test."
- ~65/25/10 unit/integration/E2E split, prioritizing real risk over ratio.
- No infrastructure failure (SSH, Docker, network — here: DNS lookup, session lookup) may crash the API; explicit error handling required.
- Credentials/secrets encrypted at rest, never in API responses, logs, telemetry, exceptions, or AI prompts (not directly applicable here beyond "never log the password/hash," which this phase must honor for current-password verification).
- Every remote operation (SSH, Docker, Git, HTTP) needs an explicit timeout — the new DNS MX/A lookup must have one too.
- All permission restrictions enforced in the backend, never only in UI/prompt — `requireSession` guard already covers `/api/account/*` if registered inside `api-scope.ts`.
- English for code, identifiers, commits, UI copy, error messages.
- Zero TypeScript/lint errors, CI green, no skipped/flaky tests, no critical vulnerabilities.
- UX consistent with `noodara-ux-apple` design system; UI hint is `yes` for this phase — capture screenshots in both themes before closing (`docs/ui/APPROVAL.md` pattern).
- `packages/domain` has zero I/O (`purity.test.ts` bans `node:dns`, `node:net`, `pg`, `fastify`, etc., and forbids importing other `@noodara/*` packages) — DNS resolution and password-hash verification must live in `apps/control-plane`, never in `packages/domain`.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-auth | 1.7.4 (installed, `[VERIFIED: apps/control-plane/package.json + pnpm-lock.yaml]`) | Auth/session/password-change engine | Already the project's auth layer; native `changePassword`+`revokeOtherSessions` covers SET-03 exactly |
| drizzle-orm | 0.45.2 (installed) | `users.preferences` JSONB column, migration 0004 | Already the project's ORM; versioned SQL migrations via `drizzle-kit generate` (no `db:push`, per `drizzle.config.ts` comment) |
| next | 16.3.5 (installed) | Root layout SSR cookie read (`await cookies()`) | Already the project's web framework; Next 16 keeps `cookies()` async (confirmed via Context7 docs for `/vercel/next.js/v16.2.9`) |
| tailwindcss | 4.3.3 (installed) | `@custom-variant` redefinition of `motion-safe`/`motion-reduce`; `--row-height` token | Already the project's styling engine; v4 configures variants in CSS, not `tailwind.config.js` (none exists in repo) |
| argon2 | (installed, via `apps/control-plane/src/auth/password-hasher.ts`) | Verify current password server-side | Already wired as Better Auth's `password.verify`; `verifyPassword({ hash, password })` is directly importable and reusable for SET-02's confirmation step, no new dependency |
| zod | (installed, project-wide) | `preferences` object schema, name/email input schemas | Already the project's validation library everywhere else |

**No new npm packages are required for this phase.** Every capability (password change, DNS lookup, cookie read, Tailwind variants) is covered by already-installed dependencies or Node built-ins (`node:dns/promises`).

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:dns/promises` (`Resolver` class) | Node built-in | MX/A domain resolution for D-03 | Only in `apps/control-plane` (never `packages/domain`, per the I/O ban); inject the `Resolver` instance (or a narrow interface wrapping `resolveMx`/`resolve4`) so tests substitute a fake, never touching the real network — no precedent for this in the repo yet, so this phase establishes the pattern |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom `/api/account/profile` endpoint for name+email | Better Auth's native `changeEmail`/`updateUser` | `changeEmail` requires `emailVerification.sendVerificationEmail` to be configured or the change silently requires a verification flow this project has no mailer for (confirmed via Context7: `user.changeEmail.enabled` + `sendChangeEmailConfirmation`/`sendVerificationEmail` callbacks are the only documented activation path). `updateUser` (name) has no built-in current-password confirmation, so D-02 would still need a custom wrapper around it — simpler to route both name and email through one custom, transactional endpoint that verifies the password once |
| `verifyPassword` direct hash check | `auth.api.signInEmail` to confirm current password | `signInEmail` creates a brand-new session as a side effect (Better Auth's sign-in flow issues a session token) — confirming a password must not silently mint an extra session or reset `absoluteExpiresAt`; a direct `verifyPassword({ hash, password })` read-only check against the `accounts.password` column has no such side effect and is already the exact function Better Auth itself uses internally |
| Injectable `Resolver` class | `dns.promises.resolveMx` (module-level, non-injectable) | The module-level function can't be swapped for a fake in tests without `vi.mock`, which fights this repo's stated preference (ADR 0004) for measuring/injecting rather than mocking Node's DNS behavior; `new dns.Resolver()` instances support `setServers()` and can be wrapped in a narrow `DnsChecker` interface for real dependency injection |
| Tailwind `@custom-variant` in CSS | A `tailwind.config.ts` with `addVariant` | Tailwind v4 is CSS-first (confirmed by `theme.css`'s own header comment referencing "Tailwind v4 CSS-first `@theme` binding"); no `tailwind.config.*` file exists in the repo, so introducing one now would fork the config style the rest of the project already committed to — `@custom-variant` in `packages/ui/tokens.css` or `theme.css` is the only variant-authoring path already in use |

**Installation:** No installation step — all dependencies are already present.

**Version verification:**
```bash
cat apps/control-plane/package.json | grep -i "better-auth\|drizzle"
# better-auth: 1.7.4, drizzle-orm: 0.45.2, drizzle-kit: 0.31.10
cat apps/web/package.json | grep -i "next\|tailwind"
# next: 16.3.5, tailwindcss: 4.3.3, @tailwindcss/postcss: 4.3.3
```
Confirmed directly from `package.json`/`pnpm-lock.yaml` in this repo — `[VERIFIED: local package.json/pnpm-lock.yaml]`.

## Package Legitimacy Audit

No new external packages are introduced by this phase — every capability is covered by already-installed dependencies (`better-auth`, `drizzle-orm`, `next`, `tailwindcss`, `argon2`, `zod`) or Node built-ins (`node:dns/promises`). The Package Legitimacy Gate is not applicable; this section is intentionally empty.

**Packages removed due to slopcheck [SLOP] verdict:** none (no packages evaluated — none proposed).
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
Browser (Settings screen)
  │
  │ 1. User clicks "Edit" on Name/Email row → Sheet opens (existing packages/ui/src/Sheet.tsx)
  │ 2. User fills field + Current password → Save
  ▼
apps/web (Next.js, same-origin proxy per ADR 0006)
  │  apiSend('PATCH', '/api/account/profile', { name?, email?, currentPassword })
  ▼
apps/control-plane  /api/account/* (inside requireSession-guarded api-scope.ts)
  │
  ├─ routes/account.ts (Zod body validation, actor from request.actor)
  │    │
  │    ▼
  ├─ services/update-account-profile.ts
  │    1. Load users+accounts row for actor.id
  │    2. verifyPassword({ hash: accounts.password, password: currentPassword })
  │       → fail INVALID_CREDENTIAL if false (no session created, no hash re-read elsewhere)
  │    3. If email present: validateEmail (packages/domain) → format check
  │    4. If email present: dnsChecker.hasMxOrA(domain) with explicit timeout
  │       → fail EMAIL_DOMAIN_UNRESOLVABLE if neither MX nor A record found
  │    5. UPDATE users SET name = ?, email = ? WHERE id = ? (Drizzle, one transaction)
  │    6. writeActivityEvent('account.name_changed' | 'account.email_changed', metadata: new value only)
  ▼
Postgres (users table, existing schema + no new columns for profile)
  │
  ▼ (response 200 { name, email })
apps/web session-user.ts revalidates GET /api/auth/get-session (D-04)
  ▼
AccountMenu (packages/ui) re-renders with fresh name/email — no page reload


─────────────────────────────────────────────────────────────────────────

Password change (SET-03):
Browser → apiSend('POST', '/api/account/password', {currentPassword,newPassword})
  → apps/control-plane routes/account.ts thin wrapper
  → auth.api.changePassword({ body: { currentPassword, newPassword, revokeOtherSessions: true },
                               headers: toFetchHeaders(request.headers) })
  → Better Auth: verifies currentPassword itself, hashes newPassword (argon2, password-hasher.ts),
    revokes every other session row, keeps the calling session's token valid
  → routes/account.ts writes account.password_changed activity event with sessions_revoked count
     from Better Auth's own response shape (see Open Questions #1)
  → Settings shows Notice (D-06); other tabs' next require-session/get-session poll gets 401
    → redirect to /login?reason=password-changed (D-07)

─────────────────────────────────────────────────────────────────────────

Theme/motion/density (SET-04/SET-05), first paint:
Browser requests any page
  ▼
apps/web root layout (NOW an async Server Component)
  │  const prefs = await cookies().then(c => c.get('noodara-prefs'))
  │  parse+validate prefs JSON (fallback to auto/system/comfortable on missing/malformed)
  ▼
<html data-theme="dark|light" data-motion="reduce|allow" data-density="compact"> ← set server-side,
  already correct in the FIRST byte of HTML — no bootstrap <script> race, no client flash
  ▼
Browser hydrates; ThemeToggle-descended SegmentedControl reads current value from
  `session-user`-adjacent preferences fetch, writes changes through the ONE extended write-path
  function (cookie + localStorage + data-theme, still ThemeToggle's file) AND
  PATCH /api/account/preferences (server = source of truth, D-09/D-10)
```

### Recommended Project Structure

```
apps/control-plane/src/
├── routes/
│   └── account.ts                  # NEW: /api/account/profile, /password, /preferences
├── services/
│   ├── update-account-profile.ts   # NEW: name/email + current-password verification
│   ├── change-account-password.ts  # NEW: thin wrapper around auth.api.changePassword
│   └── update-account-preferences.ts  # NEW: preferences JSONB write + cookie value builder
├── auth/
│   └── dns-checker.ts              # NEW: injectable MX/A resolver wrapper (node:dns/promises)
├── db/
│   ├── schema/auth.ts              # MODIFIED: add `preferences` jsonb column to users
│   └── migrations/0004_*.sql       # NEW: add preferences column, default '{}'::jsonb

packages/domain/src/
├── validators/
│   └── identity.ts                 # MODIFIED: add validateName (1-80 chars, no control chars)
└── preferences/
    └── preferences-schema.ts       # NEW: Zod schema for { theme, reduceMotion, density }

apps/web/src/
├── app/
│   └── layout.tsx                  # MODIFIED: becomes async, reads noodara-prefs cookie via cookies()
├── lib/
│   ├── settings-rows.ts            # MODIFIED: add EditableAccountRow type (sibling, not shared with SettingsRow)
│   ├── preferences-cookie.ts       # NEW: parse/serialize noodara-prefs, shared shape with backend
│   └── session-user.ts             # MODIFIED: revalidation helper reused after profile save (D-04)
├── components/
│   └── SettingsGroups.tsx          # MODIFIED: Account group (Sheet-driven rows) + Appearance rewritten with 3 SegmentedControls

packages/ui/src/
├── ThemeToggle.tsx                 # MODIFIED: exports an explicit-value write function; UI no longer cycles via this component's own click
├── tokens.css                      # MODIFIED: --row-height default 44px, redefined under [data-density="compact"]
└── theme.css                       # MODIFIED: @custom-variant motion-safe / motion-reduce redefinitions
```

### Pattern 1: Custom account-mutation endpoint that verifies current password without creating a session

**What:** Read the user's `accounts.password` hash directly and call the exported `verifyPassword` — the exact function Better Auth's own `emailAndPassword.password.verify` config points to — rather than routing through any Better Auth endpoint that would issue a new session.
**When to use:** Every SET-02 profile mutation (name, email) that D-02 requires a current-password confirmation for, and is not itself a Better Auth-native endpoint.
**Example:**
```typescript
// Source: apps/control-plane/src/auth/password-hasher.ts (existing file, already exported)
import { verifyPassword } from '../auth/password-hasher.js';

// services/update-account-profile.ts (new)
const [account] = await db
  .select({ password: accounts.password })
  .from(accounts)
  .where(eq(accounts.userId, actor.id))
  .limit(1);

if (!account?.password || !(await verifyPassword({ hash: account.password, password: currentPassword }))) {
  return { ok: false, code: 'INVALID_CREDENTIAL', message: 'Current password is incorrect' };
}
```

### Pattern 2: Better Auth server-side call from a Fastify route, with headers bridged

**What:** `auth.api.*` server calls require a Fetch-standard `Headers` object, not Fastify's raw `IncomingHttpHeaders`. This repo already has the bridge.
**When to use:** The password-change endpoint delegating to `auth.api.changePassword`, and anywhere else `auth.api.getSession` is already called (`routes/api-scope.ts`).
**Example:**
```typescript
// Source: apps/control-plane/src/auth/fetch-headers.ts (existing, reused verbatim)
import { toFetchHeaders } from '../auth/fetch-headers.js';
import { auth } from '../auth/auth.js';

const result = await auth.api.changePassword({
  body: { currentPassword, newPassword, revokeOtherSessions: true },
  headers: toFetchHeaders(request.headers),
});
```
Confirmed shape via Context7 (`/better-auth/better-auth`, `docs/content/docs/concepts/users-accounts.mdx` + `packages/better-auth/src/api/routes/update-user.ts`): `changePassword` is `createAuthEndpoint('/change-password', { body: z.object({ newPassword, currentPassword, revokeOtherSessions: z.boolean().optional() }) })`.

### Pattern 3: Tailwind v4 `@custom-variant` combining a media query and an attribute selector

**What:** Redefine `motion-safe`/`motion-reduce` to satisfy either the OS media query or an explicit `data-motion` override, so every existing call site (`motion-safe:transition-...`, `motion-reduce:opacity-...`) keeps working unchanged.
**When to use:** D-13's requirement that a user-forced "On"/"Off" override behaves identically to the OS-level preference for every already-built fallback.
**Example (Tailwind v4 CSS-first syntax — verify exact selector-combination syntax with Context7 during planning, since this repo has zero prior `@custom-variant` usage to pattern-match against):**
```css
/* packages/ui/theme.css or tokens.css — illustrative, not yet verified against a real build */
@custom-variant motion-safe (&:where(:not([data-motion="reduce"])):is([data-motion="allow"], :not([data-motion])) @media (prefers-reduced-motion: no-preference));
```
**This exact syntax is unverified — flagged in Open Questions. The planner must budget a research/spike task to confirm Tailwind v4's supported `@custom-variant` grammar for OR-combining a media query with an attribute selector before committing to implementation.**

### Pattern 4: `--row-height` token consumed by three components, one CSS writer

**What:** Replace `ListRow.tsx`'s hardcoded `ROW_HEIGHT_PX = 44` inline style with `var(--row-height)`, defined once in `tokens.css` and overridden under `html[data-density="compact"]`.
**When to use:** D-14.
**Example:**
```css
/* tokens.css */
:root { --row-height: 44px; }
html[data-density="compact"] { --row-height: 36px; }
```
```tsx
/* ListRow.tsx — remove ROW_HEIGHT_PX constant and inline style, use a class instead */
<div className={cn(ROW_CLASSES, 'h-[var(--row-height)]')} data-testid={testId}>
```
Note: `ListRow.tsx` currently also sets `data-height={ROW_HEIGHT_PX}` for tests — that attribute either needs to read the live computed style or tests need to shift to asserting the CSS variable/class instead of a literal `44`.

### Anti-Patterns to Avoid

- **A second `localStorage`/`data-theme` writer:** any new Settings theme control that writes `localStorage.setItem('noodara-theme', ...)` or `document.documentElement.setAttribute('data-theme', ...)` directly, instead of calling into `ThemeToggle`'s extended single write-path function, silently reintroduces Pitfall 17 (flash-of-wrong-theme) through the new UI surface while the old one stays fixed.
- **Calling `auth.api.signInEmail` to "verify" the current password:** creates a real new session as a side effect — never use it as a password-confirmation check.
- **Relying on Better Auth's native `changeEmail`/`updateUser` for SET-02:** `changeEmail` silently requires `sendVerificationEmail`/`sendChangeEmailConfirmation` configuration (a mailer) to actually apply; without it the email either never changes or the endpoint errors — always confirm which via a spike before trusting this research's classification (see Open Questions #2).
- **A module-level `dns.promises.resolveMx` call with no injection point:** makes DNS tests either network-dependent (ADR 0004's exact anti-pattern) or forces `vi.mock`, which this repo avoids for I/O boundaries in favor of real dependency injection (see `SessionResolver`/`getSession` pattern in `require-session.ts`).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Password change + multi-session revocation | A manual "delete all sessions except mine" SQL query + separate password-hash update | Better Auth's native `POST /change-password` with `revokeOtherSessions: true` | Already handles atomicity between password update and session revocation; hand-rolling risks a race where a session outlives the password change |
| Password strength/common-password checks | A second policy check inside the new profile/password service | `packages/domain/src/validators/password.ts` (`PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`, `COMMON_PASSWORDS`) unchanged | Already implements exactly v0.1's policy; SET-03 explicitly reuses it |
| Email format validation | A new regex in a route handler | `packages/domain/src/validators/identity.ts`'s existing `validateEmail` | Already validates format + lowercases + enforces max length; extend only with the DNS check, which must live outside `packages/domain` |
| Fastify → Fetch `Headers` conversion for `auth.api.*` calls | A new headers-bridging helper | `apps/control-plane/src/auth/fetch-headers.ts`'s existing `toFetchHeaders` | Already the exact, tested bridge `require-session.ts`/`api-scope.ts` use for `auth.api.getSession` |
| Argon2id password verification | A new hash-check function | `apps/control-plane/src/auth/password-hasher.ts`'s existing `verifyPassword` | Already the function Better Auth itself calls; returns `false` (never throws) on a malformed hash, matching this phase's need for a safe boolean confirmation check |

**Key insight:** Nearly everything this phase needs to build is a thin service/route layer around functions this codebase already has (`verifyPassword`, `toFetchHeaders`, `validateEmail`, `validators/password.ts`, `writeActivityEvent`) plus one genuinely new piece of infrastructure (server-authoritative preferences + SSR cookie read) that has no existing precedent to copy — that piece deserves its own careful task breakdown, not treatment as "just another settings row."

## Runtime State Inventory

Not applicable — this phase adds new columns/endpoints, it does not rename or migrate existing identifiers, keys, or external service configuration. Skipped per the greenfield/non-refactor exemption.

## Common Pitfalls

### Pitfall 1: DNS MX/A check becomes flaky or network-dependent in CI

**What goes wrong:** A domain validation test that calls the real `dns.promises.resolveMx('example.com')` passes locally (good network) and fails in CI (sandboxed/offline runner), or vice versa for a domain that legitimately has no MX record but does have an A record.
**Why it happens:** No existing pattern in this codebase injects a DNS resolver — the closest precedent (ADR 0004) is about SSH/`ssh2`'s host-key verifier and Docker CLI output, not `node:dns`. Building this fresh risks reaching for the module-level `dns.promises.resolveMx` function out of habit, which cannot be swapped for a fake.
**How to avoid:** Define a narrow `DnsChecker` interface (`hasMxOrA(domain: string): Promise<boolean>`) backed by an injectable class wrapping `new dns.promises.Resolver()` (supports `setServers()` for a test-only fake resolver, or accept the `Resolver` instance itself as a constructor parameter so tests substitute a stub with canned `resolveMx`/`resolve4` responses). Apply an explicit timeout (`Promise.race` or `AbortSignal`-based, matching the SSH/Docker/Git timeout convention CLAUDE.md §2.3 requires). Never assert a specific real-world domain's DNS shape in a test — only assert the code's own branching logic against injected fixtures.
**Warning signs:** A test importing `node:dns` directly instead of the injected checker; a test asserting a real domain like `gmail.com` resolves (this will eventually flake or rate-limit).

### Pitfall 2: Better Auth's `changeEmail` silently does nothing without mailer config

**What goes wrong:** A route calls `authClient.changeEmail({ newEmail })` expecting an immediate update, but Better Auth's documented flow only applies the change after a verification link is clicked — with no `sendVerificationEmail`/`sendChangeEmailConfirmation` configured (this project has no mailer), the request may error, silently no-op, or leave the change pending forever depending on the exact installed version's behavior.
**Why it happens:** The native endpoint is designed around an email-verification loop this project deliberately doesn't have in v0.2 (per CONTEXT.md D-03's "no se envía correo").
**How to avoid:** Do not call `authClient.changeEmail`/`auth.api.changeEmail` for SET-02 at all. Route email changes through the custom `/api/account/profile` endpoint that verifies the current password and updates `users.email` directly via Drizzle, exactly like the name field.
**Warning signs:** A plan task that imports `changeEmail` from Better Auth's client/server API.

### Pitfall 3: Root layout becoming `async` breaks static rendering assumptions

**What goes wrong:** Reading `cookies()` in the root layout (required for D-09's SSR no-flash requirement) forces every route under it into dynamic rendering — `/login` and `/setup`, previously implicitly eligible for static optimization, now render per-request on the server.
**Why it happens:** Next.js's dynamic-APIs rule: any use of `cookies()`/`headers()` in a Server Component opts the entire request into dynamic rendering (confirmed via Context7 Next.js docs — `cookies()` reads the incoming request, which by definition cannot be pre-rendered at build time).
**How to avoid:** Treat this as an accepted, documented tradeoff (this is a local-admin control panel, not a public marketing site — dynamic rendering has no meaningful cost here) rather than something to work around with `suspense`/`generateStaticParams` tricks. Confirm the app has no build step relying on static export for these routes (`apps/web/package.json`'s `next build`/`next start` scripts show no `output: 'export'`, so this is safe) — flagged for the planner to note explicitly, not silently absorb.
**Warning signs:** A `next build` output that previously listed `/login`/`/setup` as `○ (Static)` now listing them as `ƒ (Dynamic)` — expected and correct after this phase, not a regression to chase.

### Pitfall 4: `--row-height` token change breaks existing pixel-exact tests

**What goes wrong:** `ListRow.test.tsx` (and possibly `Skeleton.tsx`'s `SkeletonRow`, which the codebase comments say matches "ListRow's own 44px tall") assert the literal `44` via `data-height` or computed style; switching to a CSS variable changes how jsdom (no real CSS engine) resolves that value in unit tests.
**Why it happens:** jsdom doesn't compute CSS custom properties from stylesheets the way a real browser does — a unit test asserting `getComputedStyle(row).height === '44px'` will not reflect a `var(--row-height)` value unless the test environment explicitly sets that custom property.
**How to avoid:** Keep `ListRow`'s `data-height`/`data-testid` attributes as explicit props derived from a shared constant (default 44, compact 36) for unit-test assertions, while the actual visual height comes from the CSS variable for real browser/E2E rendering — don't rely on jsdom to resolve the CSS cascade. Verify `Skeleton.tsx`'s hardcoded "44px tall" comment/behavior is updated in the same task, not left stale.
**Warning signs:** A unit test that stubs `document.documentElement.style.setProperty('--row-height', ...)` to make jsdom cooperate — a sign the test is fighting the environment rather than testing the real DOM/CSS contract, which belongs in E2E instead.

### Pitfall 5 (inherited, P17): Theme-override flicker via a new write path

See PITFALLS.md's own Pitfall 17, entirely applicable here — repeated as a first-class pitfall of this phase because the new Settings `SegmentedControl` is a second UI surface that could tempt a second, parallel `localStorage`/`data-theme` write implementation. Mitigation: extend `ThemeToggle`'s exported function rather than duplicating its logic (see Anti-Patterns above).

### Pitfall 6: `/login`'s silent-failure branch (noted in CONTEXT.md's Specifics)

**What goes wrong:** A non-401/429 failure on `/login` (e.g., `FORBIDDEN_ORIGIN` from a misconfigured `NOODARA_PUBLIC_URL`) renders no banner at all today — `genericFailureMessage` falls through to `copyForErrorCode(code)`, which may have no entry for that code.
**Why it happens:** Documented in `08-deferred-items.md` as a real gap found during G3 review, explicitly candidate for "Phase 9's auth work" since this phase touches `/login` anyway (for `?reason=password-changed`, D-07).
**How to avoid:** While adding the `?reason=password-changed` Notice, also verify `copyForErrorCode` has a fallback branch that always renders a banner for any code, per the deferred item's suggested fix.
**Warning signs:** A code review that adds the new Notice branch without touching `copyForErrorCode`'s fallback — the old gap persists silently.

## Code Examples

### Verified: Better Auth `changePassword` client call

```typescript
// Source: Context7 /better-auth/better-auth, docs/content/docs/concepts/session-management.mdx
import { authClient } from "@/lib/auth-client"

await authClient.changePassword({
    newPassword: newPassword,
    currentPassword: currentPassword,
    revokeOtherSessions: true,
})
```

### Verified: Better Auth `changePassword` server endpoint shape

```typescript
// Source: Context7 /better-auth/better-auth, packages/better-auth/src/api/routes/update-user.ts
export const changePassword = createAuthEndpoint(
  "/change-password",
  {
    method: "POST",
    body: z.object({
      newPassword: z.string(),
      currentPassword: z.string(),
      revokeOtherSessions: z.boolean().optional(),
    }),
    use: [sensitiveSessionMiddleware],
  },
  // ...
);
```
**Open question:** the exact response body shape (does it return a revoked-session count?) was not found in the fetched Context7 snippets — see Open Questions #1. Plan must spike this against the installed 1.7.4 version directly (call the endpoint in a scratch integration test and log the raw response) rather than assume a shape.

### Verified: `auth.api.getSession` server call with headers, existing repo pattern

```typescript
// Source: apps/control-plane/src/routes/api-scope.ts (existing file, this exact pattern already runs in production)
const requireSession = createRequireSession({
  getSession: (headers) => auth.api.getSession({ headers }),
});
```
```typescript
// Source: apps/control-plane/src/auth/fetch-headers.ts (existing)
export function toFetchHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) { for (const entry of value) result.append(key, entry); }
    else { result.set(key, value); }
  }
  return result;
}
```

### Verified: Next.js 16 async `cookies()` in a Server Component

```typescript
// Source: Context7 /vercel/next.js/v16.2.9, docs/01-app/03-api-reference/04-functions/cookies.mdx
import { cookies } from 'next/headers'

export default async function Page() {
  const cookieStore = await cookies()
  const theme = cookieStore.get('theme')
  return '...'
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `apps/web/src/lib/theme-script.ts`'s inline `<script>` reading `localStorage` before hydration | Root layout reads `noodara-prefs` cookie via `await cookies()` before any HTML is sent | This phase (SET-04, D-09) | `theme-script.ts`'s `THEME_BOOTSTRAP_SCRIPT` becomes dead code once the cookie path is authoritative — plan must explicitly decide whether to delete it or keep it as a genuinely-no-cookie fallback (e.g., first-ever visit before any preference was ever saved, so no cookie exists yet) |
| `ListRow.tsx`'s `ROW_HEIGHT_PX` numeric constant | `--row-height` CSS custom property, overridden per `data-density` | This phase (SET-05, D-14) | Every consumer of the old constant must be located and migrated in the same task, not left half-converted |
| Cyclic click-to-cycle `ThemeToggle` (light→dark→system) | Explicit-value `SegmentedControl` (Auto/Light/Dark) as the primary UI, `ThemeToggle`'s underlying write function retained but its own cyclic click UI removed from the account menu (already done in phase 8 G3) | This phase (SET-04, D-12) | `ThemeToggle.tsx`'s public component may become internal-only (exporting the write function, not the `<Button>` UI) — confirm with the planner whether `ThemeToggle` the component still renders anywhere, or only its logic survives |

**Deprecated/outdated:**
- `theme-script.ts`'s bootstrap-script approach for first paint — superseded by SSR cookie read for the theme, though it may remain relevant as a same-load client-side fallback for `data-motion`/`data-density` if those ever need a non-cookie-derived OS-preference default before the server preference loads (matches D-10's "server wins once loaded" — implying a brief OS-default window before hydration is acceptable for motion/density but NOT for theme, which D-09 says must have zero flash). **This is itself an open question** — see Open Questions #3.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Better Auth 1.7.4's `changePassword` response includes (or can be made to include, via a hook) a revoked-session count usable for D-06's Notice copy | Code Examples, Architecture Patterns Pattern 2 | If it doesn't, D-06's "with the number of sessions revoked if the API returns it" degrades to the no-count variant of the Notice — not a blocker (CONTEXT.md already anticipates this as optional), but the planner should not assume the count is always available without a spike |
| A2 | Tailwind v4's `@custom-variant` syntax supports OR-combining a media query and an attribute selector in one variant definition | Architecture Patterns Pattern 3 | If the grammar differs from the illustrative snippet, the whole motion/density CSS approach needs a different mechanism (e.g., two separate variant names, or a build-time PostCSS plugin) — flagged explicitly as unverified, not stated as fact |
| A3 | `dns.promises.Resolver`'s `resolveMx`/`resolve4` methods are sufficient (no need for a full DNS-over-HTTPS or third-party verification service) to satisfy D-03's "resolves MX or A" check | Common Pitfalls #1, Standard Stack | Low risk — this is standard Node DNS API usage, but the exact timeout/error-handling shape (what `resolveMx` throws for NXDOMAIN vs. timeout vs. no-MX-but-has-A) needs empirical verification in a Wave 0 spike, following this repo's own ADR-0004 precedent of measuring before assuming |
| A4 | `theme-script.ts` becomes at least partially obsolete once SSR cookie reading lands | State of the Art | If a no-cookie-yet client path is still needed as a fallback (first-ever visit), deleting the bootstrap script entirely could reintroduce a flash for that one edge case — needs explicit design decision, not silent removal |
| A5 | `ListRow.tsx`'s `data-height={ROW_HEIGHT_PX}` test attribute is safe to keep as a prop-driven value (not derived from the CSS variable) for unit-test purposes | Common Pitfalls #4 | If any downstream code reads `data-height` expecting it to reflect the *actual rendered* height (not just the intended token value), a compact-density regression could go undetected by that specific test |

## Open Questions

1. **Does Better Auth 1.7.4's `changePassword` response body include a revoked-session count?**
   - What we know: The endpoint accepts `revokeOtherSessions: boolean` and documentedly revokes all other sessions when true (verified via Context7 across three independent doc/source snippets).
   - What's unclear: None of the fetched Context7 snippets show the endpoint's actual response schema/count field.
   - Recommendation: Spike this in a Wave 0 integration test — call `auth.api.changePassword` directly against a real test session with two active sessions, log the raw response, and assert its actual shape before writing the Notice-copy logic that depends on a count.

2. **Does `auth.api.changePassword` throwing/returning-error for a wrong `currentPassword` map cleanly onto this repo's `{ ok: false, code, message }` service-result convention, or does it throw a Better Auth `APIError`?**
   - What we know: `login-guard.ts` already imports `APIError`/`isAPIError` from `better-auth/api`, meaning this repo has an established pattern for catching Better Auth's own error type.
   - What's unclear: The exact error code/status `changePassword` throws for a wrong current password specifically (vs. a weak new password, vs. a missing session).
   - Recommendation: Reuse the `isAPIError` catch pattern already established in `login-guard.ts`; verify the specific error code empirically in the same Wave 0 spike as Open Question 1.

3. **Does D-09's "zero flash with or without JS" for theme also apply to motion/density, or is a brief post-hydration correction acceptable for those two?**
   - What we know: D-09's decisions text is specific to theme; D-13/D-14 don't repeat the "zero flash" language as explicitly, though they use the same `data-*` attribute mechanism on `<html>`.
   - What's unclear: Whether the SSR cookie read must set all three attributes (`data-theme`, `data-motion`, `data-density`) in the same server-rendered pass, or whether motion/density can tolerate `theme-script.ts`-style bootstrap correction.
   - Recommendation: Default to setting all three from the same SSR cookie read (simpler, one code path, no partial-flash edge case to reason about) unless discuss-phase / the planner decides the added complexity of a fully unified cookie parse isn't worth it for the two lower-visual-impact preferences.

4. **Exact Tailwind v4 `@custom-variant` syntax for the motion override — unresolved, see Assumption A2 / Pitfall context.**
   - Recommendation: Before implementation, run a small isolated Tailwind v4 build (or consult the Tailwind v4 `@custom-variant` docs directly via Context7's `tailwindcss` library ID during planning) to confirm the working selector syntax, rather than trusting this research's illustrative (unverified) example.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL | `users.preferences` migration, all account services | ✓ (existing dev/CI setup, used by every prior phase) | per `docker-compose.yml` | — |
| Node `dns` module | Email domain MX/A check | ✓ (Node built-in) | matches project's Node 22 target | — |
| Better Auth 1.7.4 | Password change delegation | ✓ (already installed and running) | 1.7.4 | — |
| Drizzle Kit | Migration 0004 generation | ✓ (already installed) | 0.31.10 | — |
| Tailwind CSS 4 | `@custom-variant`, `--row-height` token | ✓ (already installed) | 4.3.3 | — |

No missing dependencies — this phase requires no new external tools or services beyond what every prior phase already relies on.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (unit + integration via Testcontainers), Playwright (E2E) — both already configured project-wide |
| Config file | `vitest.config.ts` (apps/control-plane, apps/web, packages/*), `playwright.config.ts` (repo root/tests) |
| Quick run command | `pnpm test` (Vitest, unit only) |
| Full suite command | `pnpm test && pnpm test:integration && pnpm test:e2e` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|--------------------|--------------|
| SET-02 | Name/email edit rejects wrong current password | unit | `vitest run apps/control-plane/src/services/update-account-profile.test.ts` | ❌ Wave 0 |
| SET-02 | Email domain with no MX/A rejected; DNS check has explicit timeout | unit + integration | `vitest run apps/control-plane/src/auth/dns-checker.test.ts` (injected fake resolver) | ❌ Wave 0 |
| SET-02 | Profile update persists and shell reflects it without reload | integration (Testcontainers+Supertest) + E2E | `vitest run tests/integration/account/profile.test.ts`; `playwright test tests/e2e/settings.spec.ts -g "profile edit"` | ❌ Wave 0 |
| SET-03 | Password change under v0.1 policy revokes other sessions, keeps current one | integration (Testcontainers, two sessions) + E2E (two browser contexts) | `vitest run tests/integration/account/password.test.ts`; `playwright test tests/e2e/settings.spec.ts -g "password change revokes"` | ❌ Wave 0 |
| SET-03 | `account.password_changed` activity event carries only `sessions_revoked`, never a hash/token | unit | `vitest run packages/domain/src/activity/activity-event.test.ts` (extend existing suite) | Existing file, extend |
| SET-04 | First-paint HTML already carries the correct `data-theme` (no flash) | E2E | `playwright test tests/e2e/settings.spec.ts -g "no theme flash"` | ❌ Wave 0 |
| SET-04 | Manual override always wins over OS preference, even after reload | E2E | same file, additional case | ❌ Wave 0 |
| SET-04 | Preference identical in a second browser after login (server wins, D-10) | E2E (two browser contexts) | same file | ❌ Wave 0 |
| SET-05 | Reduce-motion System/On/Off correctly gates `motion-safe:`/`motion-reduce:` styled elements | E2E (extends `a11y-fallbacks.spec.ts`) | `playwright test tests/e2e/a11y-fallbacks.spec.ts -g "forced reduce motion preference"` | Existing file, extend |
| SET-05 | Density compact/comfortable changes row height only, not spacing/typography | unit (`ListRow`/`InsetGroup` snapshot of class/style) + E2E | `vitest run packages/ui/src/ListRow.test.tsx`; `playwright test tests/e2e/settings.spec.ts -g "density"` | Existing unit file, extend; E2E new |
| SET-06 | `SettingsRow` type structurally rejects an `onEdit` prop | unit (type test) | `vitest run apps/web/src/lib/settings-rows.test-d.ts` (or `.test.ts` with `@ts-expect-error`) | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test` (Vitest unit only, fast)
- **Per wave merge:** `pnpm test && pnpm test:integration && pnpm lint && pnpm typecheck`
- **Phase gate:** Full suite green (`pnpm test`, `pnpm test:integration`, `pnpm test:e2e`) before `/gsd:verify-work`, plus `pnpm boundaries` (domain purity) and `pnpm security:scan-leaks` given this phase handles password confirmation and preference cookies.

### Wave 0 Gaps

- [ ] `apps/control-plane/src/services/update-account-profile.test.ts` — covers SET-02
- [ ] `apps/control-plane/src/auth/dns-checker.test.ts` — covers SET-02's DNS check, with a fake/injected resolver
- [ ] `tests/integration/account/profile.test.ts` — covers SET-02 end-to-end against Testcontainers Postgres
- [ ] `tests/integration/account/password.test.ts` — covers SET-03's session revocation via real Better Auth against Testcontainers
- [ ] `tests/e2e/settings.spec.ts` — new file covering profile edit, password change + second-context revocation, no-flash theme, motion/density
- [ ] `apps/web/src/lib/settings-rows.test.ts` (or a `.test-d.ts` type-test file) — the `@ts-expect-error` proof for SET-06
- [ ] A spike/scratch integration test (not necessarily committed) answering Open Questions #1/#2 about `changePassword`'s real response/error shape against the installed 1.7.4 version, before the Notice-copy and error-mapping code is written against an assumed shape

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|-------------------|
| V2 Authentication | yes | Current-password re-confirmation for every sensitive account mutation (D-02); Better Auth's argon2id hashing unchanged |
| V3 Session Management | yes | `revokeOtherSessions: true` on password change; existing `require-session.ts`/heartbeat pattern for propagating revocation; no new session-creating side effect from a "verify password" check (Anti-Patterns) |
| V4 Access Control | yes | All `/api/account/*` routes registered inside `api-scope.ts`'s `requireSession`-guarded scope; a user can only ever mutate `request.actor.id`'s own row (no `userId` accepted from the request body) |
| V5 Input Validation | yes | Zod schemas for profile/preferences request bodies; `packages/domain` validators for email format/name length; DNS check as a second validation layer beyond format |
| V6 Cryptography | yes | Never hand-roll — reuse `argon2`-backed `hashPassword`/`verifyPassword` from `password-hasher.ts` unchanged |
| V9 (implicit — Data Protection / logging) | yes | Current password, new password, and the argon2 hash must never appear in logs, activity metadata, or API error messages (D-08's explicit "never passwords, hashes, tokens"); `SensitiveMetadataError`'s existing guard in `activity-event.ts` should be extended if new forbidden-key names are needed |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Timing attack distinguishing "email exists" from "wrong password" during profile edit | Information Disclosure | `verifyPassword` (argon2, already constant-time by the underlying primitive) applied uniformly; never short-circuit with a cheaper `email !== actor.email` string check before hashing — always run the password verify first, matching the login flow's own non-revealing behavior |
| Enumeration via DNS-check error message ("this domain doesn't exist") | Information Disclosure | The DNS-failure error code can safely reveal "domain unresolvable" (it's about the domain, not the specific email/account) — but must never differ in wording between "domain has no MX/A" and "email already taken by another account" in a way that helps enumerate existing users; there is only one admin user in v0.1 scope, so cross-user enumeration risk is currently theoretical but the error vocabulary should stay generic regardless |
| Cookie tampering on `noodara-prefs` (non-HttpOnly, client-writable) | Tampering | The cookie carries only `{theme, reduceMotion, density}` from a closed enum — the server-side Zod schema in `packages/domain` must re-validate any value read from the cookie (never trust it blindly even though it's also the mirror the server wrote), falling back to safe defaults on an invalid/tampered value; this is explicitly non-sensitive data (D-09 says "sin datos sensibles"), so tampering risk is limited to a cosmetic self-inflicted UI bug, not a security boundary |
| CSRF on `/api/account/*` mutations | Tampering | Already covered by the existing `origin-guard.ts` (strict `Origin` equality check on every mutating request) registered ahead of `requireSession` in `api-scope.ts` — no new CSRF work needed, just confirm the new routes are registered inside that same scope |

## Sources

### Primary (HIGH confidence)
- Context7 `/better-auth/better-auth` — `changePassword`/`changeEmail`/`updateUser`/`revokeOtherSessions`/`getSession` endpoint shapes and requirements
- Context7 `/vercel/next.js/v16.2.9` — `cookies()` async API in Server Components, dynamic rendering implications
- This repository, direct read: `apps/control-plane/src/auth/auth.ts`, `auth/origin-guard.ts`, `auth/fetch-headers.ts`, `auth/require-session.ts`, `auth/password-hasher.ts`, `auth/login-guard.ts`, `routes/auth.ts`, `routes/api-scope.ts`, `routes/servers.ts`, `services/edit-server.ts`, `db/schema/auth.ts`, `db/migrations/0000-0003`, `drizzle.config.ts` — HIGH confidence, verified by direct read
- This repository, direct read: `packages/ui/src/ThemeToggle.tsx`, `ListRow.tsx`, `InsetGroup.tsx`, `SegmentedControl.tsx`, `theme.css`, `tokens.css`; `apps/web/src/lib/theme-script.ts`, `app/layout.tsx`, `lib/settings-rows.ts`, `lib/session-user.ts`, `lib/require-session.ts`, `app/login/page.tsx`, `lib/api-client.ts` — HIGH confidence, verified by direct read
- This repository, direct read: `packages/domain/src/validators/identity.ts`, `validators/password.ts`, `validators/network.ts`, `activity/activity-event.ts`, `purity.test.ts` (BANNED_SPECIFIERS list) — HIGH confidence, verified by direct read
- This repository, direct read: `docs/adr/0004-ssh-adapter-empirical-contracts.md`, `docs/adr/0006-web-app-same-origin-proxy-and-ports.md`, `.planning/phases/08-redise-o-de-la-app/deferred-items.md`, `docs/ui/APPROVAL.md`, `scripts/check-ui-safety.mjs` — HIGH confidence, verified by direct read

### Secondary (MEDIUM confidence)
- Package versions cross-checked against both `package.json` and `pnpm-lock.yaml` directly (better-auth 1.7.4, next 16.3.5, tailwindcss 4.3.3, drizzle-orm 0.45.2) — MEDIUM-HIGH, since Context7's Better Auth docs were fetched against the general `/better-auth/better-auth` library (latest docs branch), not a version-pinned snapshot exactly matching 1.7.4; the endpoint shapes shown (body schema for `changePassword`/`changeEmail`) are from the library's `main` branch source file, which is a strong but not version-locked signal

### Tertiary (LOW confidence)
- The illustrative Tailwind v4 `@custom-variant` syntax combining a media query and attribute selector (Architecture Patterns Pattern 3) — not verified against Tailwind v4's actual documented grammar in this research session; explicitly flagged as needing a Context7/spike verification pass during planning, not to be implemented as written without confirmation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every dependency is already installed and version-confirmed directly from `package.json`/`pnpm-lock.yaml`; no new packages needed
- Architecture (account endpoints): HIGH — directly modeled on existing, tested repo patterns (`edit-server.ts`, `require-session.ts`, `fetch-headers.ts`)
- Architecture (SSR preferences): MEDIUM — the overall approach (cookie + `cookies()` read) is standard Next.js practice confirmed via Context7, but this repo has zero prior implementation to pattern-match against, and the exact Tailwind `@custom-variant` grammar is unverified
- Pitfalls: HIGH for the DNS/email/session pitfalls (grounded in this repo's own stated architecture rules); MEDIUM for the Tailwind variant pitfall (grammar unverified)

**Research date:** 2026-09-27
**Valid until:** 30 days (stable stack, no fast-moving dependencies; re-verify Better Auth's exact `changePassword` response shape empirically regardless of this validity window, since it was never directly confirmed — see Open Questions #1)
